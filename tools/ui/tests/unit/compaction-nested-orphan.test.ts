import { describe, it, expect } from 'vitest';
import { CompactionService } from '$lib/services/compaction.service';
import { filterByLeafNodeId } from '$lib/utils/branching';
import { MessageRole, MessageType } from '$lib/enums';
import type { ChatMessageTimings, DatabaseMessage } from '$lib/types';

/**
 * End-to-end regression for the nested-orphan coverage leak:
 *
 *   fold #1 -> regenerate a kept turn (fork ABOVE the recap, orphaning it) ->
 *   keep chatting -> fold #2 (folds the re-attached orphan) -> plain send.
 *
 * Fold #2's recap must record the orphan's TRANSITIVE coverage
 * (transitiveFoldIds), and the send path must rediscover applicable off-branch
 * recaps (indexed recap query + withApplicableRecapNodes). Either mechanism
 * alone keeps the folded turns out of the payload; without both, they re-enter
 * every send.
 */

let clock = 0;
const store: DatabaseMessage[] = [];

function tick(): number {
	clock += 10;
	return clock;
}

function add(
	msg: Partial<DatabaseMessage> & { role: MessageRole; type: MessageType },
	parentId: string | null,
	timestamp = tick()
): DatabaseMessage {
	const node: DatabaseMessage = {
		id: msg.content ? String(msg.content) : `m${store.length + 1}`,
		convId: 'c1',
		content: '',
		toolCalls: '',
		children: [],
		parent: parentId,
		timestamp,
		...msg
	};
	store.push(node);
	if (parentId) {
		const parent = store.find((m) => m.id === parentId);
		if (parent) parent.children = [...parent.children, node.id];
	}
	return node;
}

function timings(total: number): ChatMessageTimings {
	return { prompt_n: total, cache_n: 0, predicted_n: 0 } as ChatMessageTimings;
}

/** 30 whitespace words, so the estimate path sizes the turn at 30. */
const words30 = Array(30).fill('w').join(' ');

/**
 * Build the forked-after-fold tree:
 * root -> sys -> u1 -> a1 -> u2 -> a2 -> u3 -> a3 (+R1 child of a3, folds u1..a2)
 * and the fork: u3 -> a3p -> u4 -> a4.
 */
function buildForkedTree() {
	store.length = 0;
	clock = 0;
	const root = add({ role: MessageRole.USER, type: MessageType.ROOT, id: 'root' }, null);
	const sys = add({ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' }, root.id);
	const u1 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u1' }, sys.id);
	const a1 = add(
		{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a1', timings: timings(40) },
		u1.id
	);
	const u2 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u2' }, a1.id);
	const a2 = add(
		{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a2', timings: timings(80) },
		u2.id
	);
	const u3 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u3' }, a2.id, 70);
	u3.content = words30;
	u3.id = 'u3';
	const a3 = add(
		{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a3', timings: timings(95) },
		'u3',
		80
	);
	const r1 = add(
		{
			role: MessageRole.USER,
			type: MessageType.COMPACTION,
			id: 'R1',
			content: CompactionService.formatRecap('summary one'),
			compaction: {
				summarizedMessageIds: [u1.id, a1.id, u2.id, a2.id],
				tokensBefore: 80,
				tokensAfter: 25,
				createdAt: 85
			}
		},
		a3.id,
		65
	);
	const a3p = add(
		{
			role: MessageRole.ASSISTANT,
			type: MessageType.TEXT,
			content: words30,
			id: 'a3p',
			timings: timings(30)
		},
		'u3',
		90
	);
	const u4 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u4' }, 'a3p', 100);
	const a4 = add(
		{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a4', timings: timings(90) },
		u4.id,
		110
	);
	return { root, sys, u1, a1, u2, a2, u3, a3, r1, a3p, u4, a4 };
}

/** streamChatCompletion's payload assembly with indexed recap discovery. */
function simulateSend(leafId: string): string[] {
	let allMessages = filterByLeafNodeId(store, leafId, false) as DatabaseMessage[];
	const recaps = store.filter((m) => m.type === MessageType.COMPACTION);
	if (recaps.length > 0) {
		allMessages = CompactionService.withApplicableRecapNodes(
			allMessages,
			recaps,
			new Set(store.map((m) => m.id))
		);
	}
	return CompactionService.mergeRecapIntoNextUser(
		CompactionService.collapseForSend(allMessages)
	).map((m) => m.id);
}

/** Fold #2 exactly as compactConversation does, recording transitive coverage. */
function secondFold(leafId: string): DatabaseMessage {
	const branch = CompactionService.withApplicableRecap(
		filterByLeafNodeId(store, leafId, false) as DatabaseMessage[],
		store
	);
	const collapsed = CompactionService.collapseForSend(branch);
	const plan = CompactionService.planCompaction(collapsed, 100, 20, true);
	expect(plan.fold).toBe(true);
	if (!plan.fold) throw new Error('unreachable');
	expect(plan.foldMessages.map((m) => m.id)).toEqual(['R1', 'u3', 'a3p']);
	return add(
		{
			role: MessageRole.USER,
			type: MessageType.COMPACTION,
			id: 'R2',
			content: CompactionService.formatRecap('summary two'),
			compaction: {
				summarizedMessageIds: CompactionService.transitiveFoldIds(plan.foldMessages, store),
				tokensBefore: 90,
				tokensAfter: 30,
				createdAt: 115
			}
		},
		leafId,
		95
	);
}

describe('CompactionService.transitiveFoldIds', () => {
	it('expands folded recap nodes to their transitive coverage, keeping node ids', () => {
		const t = buildForkedTree();
		const out = CompactionService.transitiveFoldIds([t.r1, t.u3, t.a3p], store);
		expect(new Set(out)).toEqual(new Set(['R1', 'u3', 'a3p', 'u1', 'a1', 'u2', 'a2']));
	});

	it('plain turns pass through unchanged', () => {
		const t = buildForkedTree();
		const out = CompactionService.transitiveFoldIds([t.u1, t.a1], store);
		expect(new Set(out)).toEqual(new Set(['u1', 'a1']));
	});
});

describe('nested-orphan coverage leak (fold -> fork -> fold -> send)', () => {
	it('sends between the fork and the second fold stay collapsed', () => {
		const t = buildForkedTree();
		expect(simulateSend(t.a4.id)).toEqual(['sys', 'u3', 'a3p', 'u4', 'a4']);
	});

	it('a plain send after the second fold keeps the transitively folded turns out', () => {
		const t = buildForkedTree();
		secondFold(t.a4.id);
		// currNode moved to R2; the next user message parents on it.
		const u5 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u5' }, 'R2', 120);
		const sent = simulateSend(u5.id);
		expect(sent).not.toContain('u1');
		expect(sent).not.toContain('a1');
		expect(sent).not.toContain('u2');
		expect(sent).not.toContain('a2');
		expect(sent).toEqual(['sys', 'u4', 'a4', 'u5']);
	});

	it('legacy second recap (direct ids only) self-heals through the widened gate', () => {
		const t = buildForkedTree();
		// A recap recorded by the pre-fix code: the orphan R1's NODE id, no coverage.
		add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				id: 'R2',
				content: CompactionService.formatRecap('summary two'),
				compaction: {
					summarizedMessageIds: ['R1', 'u3', 'a3p'],
					tokensBefore: 90,
					tokensAfter: 30
				}
			},
			t.a4.id,
			95
		);
		const u5 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u5' }, 'R2', 120);
		// Indexed discovery surfaces the off-branch R1 (referenced by R2's legacy
		// non-transitive list), recovery re-attaches it, and collapseForSend
		// expands R2's coverage through it.
		const sent = simulateSend(u5.id);
		expect(sent).not.toContain('u1');
		expect(sent).not.toContain('a1');
		expect(sent).not.toContain('u2');
		expect(sent).not.toContain('a2');
		expect(sent).toEqual(['sys', 'u4', 'a4', 'u5']);
	});
});
