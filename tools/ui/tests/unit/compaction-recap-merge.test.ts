import { describe, it, expect } from 'vitest';
import { CompactionService } from '$lib/services/compaction.service';
import { AttachmentType, MessageRole, MessageType } from '$lib/enums';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types';

/**
 * Tests for CompactionService.mergeRecapIntoNextUser - the payload-boundary pass
 * that folds a recap node into the user message after it. collapseForSend emits
 * [system, recap(user), ...tail] with a user-started tail, and strict-alternation
 * chat templates (Mistral, Gemma 2 style) reject two consecutive user messages.
 */

let n = 0;

function msg(
	role: MessageRole,
	type: MessageType,
	content: string,
	extra?: DatabaseMessageExtra[]
): DatabaseMessage {
	n += 1;
	return {
		id: `m${n}`,
		convId: 'c1',
		role,
		type,
		content,
		toolCalls: '',
		children: [],
		parent: null,
		timestamp: n * 10,
		...(extra ? { extra } : {})
	};
}

const recap = (content: string): DatabaseMessage => {
	const m = msg(MessageRole.USER, MessageType.COMPACTION, content);
	m.compaction = {
		summarizedMessageIds: ['x'],
		tokensBefore: 100,
		tokensAfter: 20
	};
	return m;
};

describe('CompactionService.mergeRecapIntoNextUser', () => {
	it('returns the same array instance when no recap is present', () => {
		const input = [
			msg(MessageRole.SYSTEM, MessageType.TEXT, 'sys'),
			msg(MessageRole.USER, MessageType.TEXT, 'hi')
		];
		expect(CompactionService.mergeRecapIntoNextUser(input)).toBe(input);
	});

	it('merges the recap into the following user message, keeping its identity', () => {
		const extras: DatabaseMessageExtra[] = [
			{ type: AttachmentType.TEXT, name: 'f.txt', content: 'x' }
		];
		const sys = msg(MessageRole.SYSTEM, MessageType.TEXT, 'sys');
		const r = recap('recap text');
		const u = msg(MessageRole.USER, MessageType.TEXT, 'user text', extras);
		const a = msg(MessageRole.ASSISTANT, MessageType.TEXT, 'answer');

		const out = CompactionService.mergeRecapIntoNextUser([sys, r, u, a]);

		expect(out.map((m) => m.id)).toEqual([sys.id, u.id, a.id]);
		expect(out[1].role).toBe(MessageRole.USER);
		expect(out[1].type).toBe(MessageType.TEXT);
		expect(out[1].content).toBe('recap text\n\nuser text');
		expect(out[1].extra).toBe(extras);
	});

	it('attachment-only user message: merged content is exactly the recap text', () => {
		const r = recap('recap text');
		const u = msg(MessageRole.USER, MessageType.TEXT, '', [
			{ type: AttachmentType.TEXT, name: 'f.txt', content: 'x' }
		]);
		const out = CompactionService.mergeRecapIntoNextUser([r, u]);
		expect(out).toHaveLength(1);
		expect(out[0].content).toBe('recap text');
	});

	it('recap followed by an assistant message stays a message of its own', () => {
		const r = recap('recap text');
		const a = msg(MessageRole.ASSISTANT, MessageType.TEXT, 'continue me');
		const out = CompactionService.mergeRecapIntoNextUser([r, a]);
		expect(out.map((m) => m.id)).toEqual([r.id, a.id]);
		expect(out[0].content).toBe('recap text');
	});

	it('trailing recap with nothing after it is left as-is', () => {
		const u = msg(MessageRole.USER, MessageType.TEXT, 'hi');
		const r = recap('recap text');
		const out = CompactionService.mergeRecapIntoNextUser([u, r]);
		expect(out.map((m) => m.id)).toEqual([u.id, r.id]);
	});

	it('does not mutate the input array or its messages', () => {
		const r = recap('recap text');
		const u = msg(MessageRole.USER, MessageType.TEXT, 'user text');
		const input = [r, u];
		CompactionService.mergeRecapIntoNextUser(input);
		expect(input).toHaveLength(2);
		expect(r.content).toBe('recap text');
		expect(u.content).toBe('user text');
	});

	it('composed with collapseForSend: no two consecutive same-role messages', () => {
		// [sys, u1, a1, u2, a2, recap(folds u1,a1)] resolved for send.
		const sys = msg(MessageRole.SYSTEM, MessageType.TEXT, 'sys');
		const u1 = msg(MessageRole.USER, MessageType.TEXT, 'u1');
		const a1 = msg(MessageRole.ASSISTANT, MessageType.TEXT, 'a1');
		const u2 = msg(MessageRole.USER, MessageType.TEXT, 'u2');
		const a2 = msg(MessageRole.ASSISTANT, MessageType.TEXT, 'a2');
		const r = recap('recap text');
		r.compaction!.summarizedMessageIds = [u1.id, a1.id];

		const sent = CompactionService.mergeRecapIntoNextUser(
			CompactionService.collapseForSend([sys, u1, a1, u2, a2, r])
		);

		for (let i = 1; i < sent.length; i++) {
			expect(sent[i].role).not.toBe(sent[i - 1].role);
		}
		expect(sent.map((m) => m.id)).toEqual([sys.id, u2.id, a2.id]);
		expect(sent[1].content).toBe('recap text\n\nu2');
	});
});
