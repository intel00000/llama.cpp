import { describe, it, expect } from 'vitest';
import { CompactionService } from '$lib/services/compaction.service';
import { filterByLeafNodeId } from '$lib/utils/branching';
import { MessageRole, MessageType } from '$lib/enums';
import type { ChatMessageTimings, DatabaseMessage } from '$lib/types';

/**
 * Repro robustness for the recap-parenting invariant.
 *
 * Compaction persists a recap node and later sends rely on that recap being on
 * the RESOLVED branch (filterByLeafNodeId -> collapseForSend). This models the
 * real tree ops - createMessageBranch parenting, filterByLeafNodeId resolution,
 * collapseForSend - to check whether the recap survives the next appended turn.
 */

let clock = 0;
const store: DatabaseMessage[] = [];

function tick(): number {
	clock += 10;
	return clock;
}

/** Mirror of DatabaseService.createMessageBranch tree wiring (parent/children). */
function createMessageBranch(
	msg: Partial<DatabaseMessage> & { role: MessageRole; type: MessageType },
	parentId: string | null,
	timestamp = tick()
): DatabaseMessage {
	const node: DatabaseMessage = {
		id: `m${store.length + 1}`,
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
	// Put it all in prompt_n so occupancyTokens = total.
	return { prompt_n: total, cache_n: 0, predicted_n: 0 } as ChatMessageTimings;
}

/** addMessage('-1') parents on the last message of the resolved active branch. */
function activeLeafParent(currNode: string): string {
	const branch = filterByLeafNodeId(store, currNode, false) as DatabaseMessage[];
	return branch[branch.length - 1].id;
}

describe('compaction recap parenting on the tree', () => {
	it('recap is orphaned when the next turn parents on the retained tail', () => {
		store.length = 0;
		clock = 0;

		// root -> system -> u1 -> a1(50) -> u2 -> a2(90)   (nCtx 100, threshold 80)
		const root = createMessageBranch({ role: MessageRole.USER, type: MessageType.ROOT }, null);
		const sys = createMessageBranch(
			{ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' },
			root.id
		);
		const u1 = createMessageBranch(
			{ role: MessageRole.USER, type: MessageType.TEXT, content: 'u1' },
			sys.id
		);
		const a1 = createMessageBranch(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a1', timings: timings(50) },
			u1.id
		);
		const u2 = createMessageBranch(
			{ role: MessageRole.USER, type: MessageType.TEXT, content: 'u2' },
			a1.id
		);
		const a2 = createMessageBranch(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a2', timings: timings(90) },
			u2.id
		);

		let currNode = a2.id;

		// Plan + persist a recap over the resolved branch (retain 20% of 100 = 20).
		const branch = filterByLeafNodeId(store, currNode, false) as DatabaseMessage[];
		const plan = CompactionService.planCompaction([...branch], 100, 20, true);
		expect(plan.fold).toBe(true);
		if (!plan.fold) return;

		const foldLast = plan.foldMessages[plan.foldMessages.length - 1];
		const keepFirst = plan.keepMessages[0];
		const mid = Math.floor((foldLast.timestamp + keepFirst.timestamp) / 2);
		const recapTs =
			mid > foldLast.timestamp && mid < keepFirst.timestamp ? mid : keepFirst.timestamp;

		const recap = createMessageBranch(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: CompactionService.formatRecap('recap'),
				compaction: {
					summarizedMessageIds: plan.foldMessages.map((m) => m.id),
					tokensBefore: 90,
					tokensAfter: 30
				}
			},
			currNode, // linear child of the current leaf (a2)
			recapTs
		);
		currNode = recap.id;

		// Next user turn via addMessage('-1'): parents on the resolved-branch tail.
		const u3Parent = activeLeafParent(currNode);
		const u3 = createMessageBranch(
			{ role: MessageRole.USER, type: MessageType.TEXT, content: 'u3' },
			u3Parent
		);
		currNode = u3.id;

		// What actually gets sent:
		const sendBranch = filterByLeafNodeId(store, currNode, false) as DatabaseMessage[];
		const collapsed = CompactionService.collapseForSend([...sendBranch]);
		const ids = collapsed.map((m) => m.id);

		// BUG: u3 parented on a2 (retained tail), recap siblings it -> recap not on the
		// branch -> collapseForSend is inert -> folded u1/a1 are STILL sent.
		expect(u3Parent).toBe(a2.id);
		expect(ids).toContain(u1.id);
		expect(ids).toContain(a1.id);
		expect(ids).not.toContain(recap.id);
	});

	it('planCompaction declines when only a recap would fold (summary-of-summary, no wasted call)', () => {
		store.length = 0;
		clock = 0;
		const root = createMessageBranch({ role: MessageRole.USER, type: MessageType.ROOT }, null);
		const sys = createMessageBranch(
			{ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' },
			root.id
		);
		const recap = createMessageBranch(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: CompactionService.formatRecap('recap'),
				compaction: {
					summarizedMessageIds: ['old1', 'old2'],
					tokensBefore: 5000,
					tokensAfter: 1000
				}
			},
			sys.id
		);
		const u = createMessageBranch({ role: MessageRole.USER, type: MessageType.TEXT }, recap.id);
		const a = createMessageBranch(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(8000) },
			u.id
		);
		const branch = filterByLeafNodeId(store, a.id, false) as DatabaseMessage[];
		const plan = CompactionService.planCompaction([...branch], 10000, 20, true);
		expect(plan.fold).toBe(false);
	});

	it('recap survives when the next turn parents on the recap (currNode)', () => {
		store.length = 0;
		clock = 0;

		const root = createMessageBranch({ role: MessageRole.USER, type: MessageType.ROOT }, null);
		const sys = createMessageBranch(
			{ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' },
			root.id
		);
		const u1 = createMessageBranch(
			{ role: MessageRole.USER, type: MessageType.TEXT, content: 'u1' },
			sys.id
		);
		const a1 = createMessageBranch(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a1', timings: timings(50) },
			u1.id
		);
		const u2 = createMessageBranch(
			{ role: MessageRole.USER, type: MessageType.TEXT, content: 'u2' },
			a1.id
		);
		const a2 = createMessageBranch(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a2', timings: timings(90) },
			u2.id
		);

		let currNode = a2.id;

		const branch = filterByLeafNodeId(store, currNode, false) as DatabaseMessage[];
		const plan = CompactionService.planCompaction([...branch], 100, 20, true);
		expect(plan.fold).toBe(true);
		if (!plan.fold) return;

		const foldLast = plan.foldMessages[plan.foldMessages.length - 1];
		const keepFirst = plan.keepMessages[0];
		const mid = Math.floor((foldLast.timestamp + keepFirst.timestamp) / 2);
		const recapTs =
			mid > foldLast.timestamp && mid < keepFirst.timestamp ? mid : keepFirst.timestamp;

		const recap = createMessageBranch(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: CompactionService.formatRecap('recap'),
				compaction: {
					summarizedMessageIds: plan.foldMessages.map((m) => m.id),
					tokensBefore: 90,
					tokensAfter: 30
				}
			},
			currNode,
			recapTs
		);
		currNode = recap.id;

		// FIX: parent the next user turn on currNode (the recap), not the tail.
		const u3 = createMessageBranch(
			{ role: MessageRole.USER, type: MessageType.TEXT, content: 'u3' },
			currNode
		);
		currNode = u3.id;

		const sendBranch = filterByLeafNodeId(store, currNode, false) as DatabaseMessage[];
		const collapsed = CompactionService.collapseForSend([...sendBranch]);
		const ids = collapsed.map((m) => m.id);

		// Recap on the branch, folded turns dropped, retained tail + new turn kept.
		expect(ids).toContain(recap.id);
		expect(ids).not.toContain(u1.id);
		expect(ids).not.toContain(a1.id);
		expect(ids).toContain(u2.id);
		expect(ids).toContain(a2.id);
		expect(ids).toContain(u3.id);
		// Order: system, recap, retained tail, new turn.
		expect(ids).toEqual([sys.id, recap.id, u2.id, a2.id, u3.id]);
	});
});
