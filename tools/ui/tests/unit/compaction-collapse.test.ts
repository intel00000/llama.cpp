import { describe, it, expect } from 'vitest';
import { CompactionService } from '$lib/services/compaction.service';
import { MessageRole, MessageType } from '$lib/enums';
import type { DatabaseMessage } from '$lib/types';

/**
 * collapseForSend: the pure request-time transform. A branch carrying recap node(s)
 * collapses to [...system, widest-coverage recap, ...retained tail], dropping exactly the
 * turns that emitted recap folds (transitively), and NEVER reordering the tail (so an
 * assistant with tool_calls stays adjacent to its tool results - the mid-run reseed relies
 * on this).
 */

let n = 0;
function msg(
	role: MessageRole,
	over: Partial<DatabaseMessage> & { id?: string } = {}
): DatabaseMessage {
	n++;
	return {
		id: over.id ?? `m${n}`,
		convId: 'c1',
		type: over.type ?? MessageType.TEXT,
		role,
		content: over.content ?? '',
		toolCalls: over.toolCalls ?? '',
		parent: null,
		children: [],
		timestamp: n,
		...over
	};
}

function recap(id: string, summarizedMessageIds: string[]): DatabaseMessage {
	return msg(MessageRole.USER, {
		id,
		type: MessageType.COMPACTION,
		content: 'recap',
		compaction: { summarizedMessageIds, tokensBefore: 0, tokensAfter: 0 }
	});
}

describe('CompactionService.collapseForSend', () => {
	it('returns the branch unchanged when there is no checkpoint (feature inert)', () => {
		const branch = [msg(MessageRole.SYSTEM), msg(MessageRole.USER), msg(MessageRole.ASSISTANT)];
		expect(CompactionService.collapseForSend(branch)).toBe(branch);
	});

	it('emits the widest-coverage recap even when a shallower recap has a newer timestamp', () => {
		// Cross-branch hazard: editing an early folded turn forks a sibling whose kept turn gets
		// a fresh Date.now(), so a SHALLOW recap (folds fewer turns) can carry a LATER timestamp
		// than a DEEP recap; withApplicableRecap may re-attach both onto one branch. Selecting by
		// timestamp would emit the shallow recap yet drop the deep recap's extra turns (u2/a2)
		// with nothing summarizing them - silent context loss. Emit the DEEP recap instead.
		const sys = msg(MessageRole.SYSTEM, { id: 'sys' });
		const rDeep = msg(MessageRole.USER, {
			id: 'rdeep',
			type: MessageType.COMPACTION,
			timestamp: 50, // older
			compaction: {
				summarizedMessageIds: ['u1', 'a1', 'u2', 'a2'],
				tokensBefore: 0,
				tokensAfter: 0
			}
		});
		const u3 = msg(MessageRole.USER, { id: 'u3' });
		const rShallow = msg(MessageRole.USER, {
			id: 'rshallow',
			type: MessageType.COMPACTION,
			timestamp: 100, // newer, but covers less
			compaction: {
				summarizedMessageIds: ['u1', 'a1'],
				tokensBefore: 0,
				tokensAfter: 0
			}
		});
		const out = CompactionService.collapseForSend([sys, rDeep, u3, rShallow]).map((m) => m.id);
		// rDeep emitted (covers u1,a1,u2,a2); the newer-but-shallow rShallow is not chosen.
		expect(out).toEqual(['sys', 'rdeep', 'u3']);
	});

	it('re-sends a turn folded only by a non-emitted (disjoint) recap instead of dropping it', () => {
		// Two recaps folding DISJOINT regions can co-exist after withApplicableRecap re-attaches
		// an off-branch recap (each recap's folded ids are present on the branch). Only one recap
		// is emitted; a turn the emitted recap does NOT summarize must survive (re-sent in full),
		// never be dropped by a recap that never covered it.
		const sys = msg(MessageRole.SYSTEM, { id: 'sys' });
		const u1 = msg(MessageRole.USER, { id: 'u1' });
		const a1 = msg(MessageRole.ASSISTANT, { id: 'a1' });
		const u2 = msg(MessageRole.USER, { id: 'u2' });
		const a2 = msg(MessageRole.ASSISTANT, { id: 'a2' });
		const rEmit = recap('remit', ['u1', 'a1']);
		const rOther = recap('rother', ['u2', 'a2']); // created later -> newer ts -> wins the tie
		const out = CompactionService.collapseForSend([sys, u1, a1, u2, a2, rEmit, rOther]).map(
			(m) => m.id
		);
		// rOther emitted (tie broken by newer ts) drops only u2,a2; u1,a1 (folded solely by the
		// non-emitted rEmit) are re-sent, not silently lost.
		expect(out).toEqual(['sys', 'rother', 'u1', 'a1']);
	});

	it('drops the folded messages and emits [system, recap, ...tail]', () => {
		const sys = msg(MessageRole.SYSTEM, { id: 'sys' });
		const u1 = msg(MessageRole.USER, { id: 'u1' });
		const a1 = msg(MessageRole.ASSISTANT, { id: 'a1' });
		const r = recap('r1', ['u1', 'a1']);
		const u2 = msg(MessageRole.USER, { id: 'u2' });
		const a2 = msg(MessageRole.ASSISTANT, { id: 'a2' });
		const out = CompactionService.collapseForSend([sys, u1, a1, r, u2, a2]).map((m) => m.id);
		expect(out).toEqual(['sys', 'r1', 'u2', 'a2']);
	});

	it('keeps an assistant with tool_calls adjacent to its tool results (no reorder)', () => {
		const sys = msg(MessageRole.SYSTEM, { id: 'sys' });
		const u1 = msg(MessageRole.USER, { id: 'u1' });
		const a1 = msg(MessageRole.ASSISTANT, { id: 'a1' });
		const r = recap('r1', ['u1', 'a1']);
		// Retained agentic turn: user -> assistant(tool_calls) -> tool result -> assistant(final)
		const u2 = msg(MessageRole.USER, { id: 'u2' });
		const a2 = msg(MessageRole.ASSISTANT, { id: 'a2', toolCalls: '[{"id":"t"}]' });
		const t1 = msg(MessageRole.TOOL, { id: 't1' });
		const a2b = msg(MessageRole.ASSISTANT, { id: 'a2b' });
		const out = CompactionService.collapseForSend([sys, u1, a1, r, u2, a2, t1, a2b]).map(
			(m) => m.id
		);
		// system first, recap next, then the tail in its original order - pairing intact.
		expect(out).toEqual(['sys', 'r1', 'u2', 'a2', 't1', 'a2b']);
	});

	it('unions summarizedMessageIds across all recaps and shows the latest', () => {
		const sys = msg(MessageRole.SYSTEM, { id: 'sys' });
		const u1 = msg(MessageRole.USER, { id: 'u1' });
		const a1 = msg(MessageRole.ASSISTANT, { id: 'a1' });
		const r1 = recap('r1', ['u1', 'a1']);
		const u2 = msg(MessageRole.USER, { id: 'u2' });
		const a2 = msg(MessageRole.ASSISTANT, { id: 'a2' });
		// A second recap that absorbed r1 + turn 2; its set carries r1's id, not u1/a1.
		const r2 = recap('r2', ['r1', 'u2', 'a2']);
		const u3 = msg(MessageRole.USER, { id: 'u3' });
		const a3 = msg(MessageRole.ASSISTANT, { id: 'a3' });
		const out = CompactionService.collapseForSend([sys, u1, a1, r1, u2, a2, r2, u3, a3]).map(
			(m) => m.id
		);
		// latest recap (r2) shown; every folded id (u1,a1 via r1, and u2,a2) dropped; r1 (compaction) never in tail.
		expect(out).toEqual(['sys', 'r2', 'u3', 'a3']);
	});

	it('keeps every system message at the front', () => {
		const sys1 = msg(MessageRole.SYSTEM, { id: 'sys1' });
		const u1 = msg(MessageRole.USER, { id: 'u1' });
		const a1 = msg(MessageRole.ASSISTANT, { id: 'a1' });
		const r = recap('r1', ['u1', 'a1']);
		const u2 = msg(MessageRole.USER, { id: 'u2' });
		const out = CompactionService.collapseForSend([sys1, u1, a1, r, u2]).map((m) => m.id);
		expect(out[0]).toBe('sys1');
		expect(out).toEqual(['sys1', 'r1', 'u2']);
	});
});
