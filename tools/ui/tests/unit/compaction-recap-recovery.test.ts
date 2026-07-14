import { describe, it, expect } from 'vitest';
import { CompactionService } from '$lib/services/compaction.service';
import { filterByLeafNodeId } from '$lib/utils/branching';
import { MessageRole, MessageType } from '$lib/enums';
import type { ChatMessageTimings, DatabaseMessage } from '$lib/types';

/**
 * Tests for CompactionService.withApplicableRecap - the recap-recovery that keeps a
 * fold in effect when a send path resolves the branch from an INTERMEDIATE node
 * (regenerate / edit / continue of the retained tail) and would otherwise miss a
 * recap hanging off a sibling leaf. Paired with collapseForSend at every such path.
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
	return { prompt_n: total, cache_n: 0, predicted_n: 0 } as ChatMessageTimings;
}

/** Build root -> sys -> u1 -> a1(50) -> u2 -> a2(90), fold {u1,a1,u2,a2}, keep {}. */
function buildFoldedTree() {
	store.length = 0;
	clock = 0;
	const root = add({ role: MessageRole.USER, type: MessageType.ROOT }, null);
	const sys = add({ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' }, root.id);
	const u1 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u1' }, sys.id);
	const a1 = add(
		{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a1', timings: timings(50) },
		u1.id
	);
	const u2 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u2' }, a1.id);
	const a2 = add(
		{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a2', timings: timings(90) },
		u2.id
	);
	return { root, sys, u1, a1, u2, a2 };
}

function foldRecap(parentLeafId: string, summarizedIds: string[], ts: number): DatabaseMessage {
	return add(
		{
			role: MessageRole.USER,
			type: MessageType.COMPACTION,
			content: CompactionService.formatRecap('recap'),
			compaction: {
				summarizedMessageIds: summarizedIds,
				tokensBefore: 90,
				tokensAfter: 30
			}
		},
		parentLeafId,
		ts
	);
}

describe('CompactionService.withApplicableRecap', () => {
	it('is inert when there are no recaps', () => {
		const { sys, u1, a1 } = buildFoldedTree();
		const branch = [sys, u1, a1];
		expect(CompactionService.withApplicableRecap(branch, store)).toBe(branch);
	});

	it('is inert when the recap is already on the branch', () => {
		const t = buildFoldedTree();
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id, t.u2.id, t.a2.id], 55);
		const branch = filterByLeafNodeId(store, recap.id, false) as DatabaseMessage[];
		expect(branch.some((m) => m.id === recap.id)).toBe(true);
		expect(CompactionService.withApplicableRecap(branch, store)).toBe(branch);
	});

	it('splices a recap that hangs off a sibling leaf when its folded turns are all present', () => {
		const t = buildFoldedTree();
		// Fold only the older {u1,a1}, keep {u2,a2}; recap is a child of a2 (the leaf).
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id], 45);
		// Regenerate a2 -> resolve from its parent u2; the recap (child of a2) is NOT on
		// this parent-walk, but everything it folded ({u1,a1}) is.
		const raw = filterByLeafNodeId(store, t.u2.id, false) as DatabaseMessage[];
		expect(raw.some((m) => m.id === recap.id)).toBe(false);
		const recovered = CompactionService.withApplicableRecap(raw, store);
		expect(recovered.some((m) => m.id === recap.id)).toBe(true);
		// Collapsing the recovered branch drops the folded turns and keeps recap + u2.
		const collapsed = CompactionService.collapseForSend(recovered).map((m) => m.id);
		expect(collapsed).not.toContain(t.u1.id);
		expect(collapsed).not.toContain(t.a1.id);
		expect(collapsed).toEqual([t.sys.id, recap.id, t.u2.id]);
	});

	it('does NOT splice a recap whose folded turns are not all on the branch (edit before the fold)', () => {
		const t = buildFoldedTree();
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id, t.u2.id, t.a2.id], 55);
		// Editing u1 branches from sys; the recap folded u2/a2 which are NOT on this branch.
		const raw = filterByLeafNodeId(store, t.sys.id, false) as DatabaseMessage[];
		const recovered = CompactionService.withApplicableRecap(raw, store);
		expect(recovered.some((m) => m.id === recap.id)).toBe(false);
		expect(recovered).toBe(raw);
	});

	it('recap-node ids in the folded list do not block applicability', () => {
		const t = buildFoldedTree();
		// R1 folds {u1,a1}; R2 folds {R1, u1, a1} (transitive coverage). Both hang off
		// the leaf a2. Regenerating a2 resolves from u2: R1 and R2 are both off-branch,
		// and R2's list contains the off-branch recap-node id R1.
		const r1 = foldRecap(t.a2.id, [t.u1.id, t.a1.id], 45);
		const r2 = foldRecap(t.a2.id, [r1.id, t.u1.id, t.a1.id], 46);
		const raw = filterByLeafNodeId(store, t.u2.id, false) as DatabaseMessage[];
		const recovered = CompactionService.withApplicableRecap(raw, store);
		// R1's id is a structural reference, not turn content: it must not stop R2.
		expect(recovered.some((m) => m.id === r2.id)).toBe(true);
	});

	it('non-recap folded ids that exist but are off-branch still block', () => {
		const t = buildFoldedTree();
		const r1 = foldRecap(t.a2.id, [t.u1.id, t.a1.id], 45);
		const r2 = foldRecap(t.a2.id, [r1.id, t.u1.id, t.a1.id, t.u2.id, t.a2.id], 46);
		// Editing u1 branches from sys: u2/a2 exist in the store but are not on this
		// branch, so R2 must be refused (same contract as the edit-before-the-fold test).
		const raw = filterByLeafNodeId(store, t.sys.id, false) as DatabaseMessage[];
		const recovered = CompactionService.withApplicableRecap(raw, store);
		expect(recovered.some((m) => m.id === r2.id)).toBe(false);
	});

	it('ids of deleted messages do not block applicability', () => {
		const t = buildFoldedTree();
		// The recap folded {u1, a1, ghost}; ghost was deleted and exists nowhere. It can
		// never re-enter a send, so it must not stop the recap from applying.
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id, 'ghost'], 45);
		const raw = filterByLeafNodeId(store, t.u2.id, false) as DatabaseMessage[];
		const recovered = CompactionService.withApplicableRecap(raw, store);
		expect(recovered.some((m) => m.id === recap.id)).toBe(true);
	});

	it('regenerate-after-Compact-now: the fold is preserved end to end', () => {
		// Tree: ... a2 -> u3 -> a3 ; Compact now folds {u1,a1,u2,a2}, keeps {u3,a3};
		// recap is a child of a3 (the leaf).
		const t = buildFoldedTree();
		const u3 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u3' }, t.a2.id);
		const a3 = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a3', timings: timings(95) },
			u3.id
		);
		const recap = foldRecap(a3.id, [t.u1.id, t.a1.id, t.u2.id, t.a2.id], 55);

		// User clicks Regenerate on a3: new branch resolves from a3.parent = u3.
		const raw = filterByLeafNodeId(store, u3.id, false) as DatabaseMessage[];
		const path = CompactionService.withApplicableRecap(raw, store);
		const sent = CompactionService.collapseForSend(path).map((m) => m.id);

		// Folded turns dropped, recap + retained u3 kept, in order.
		expect(sent).toEqual([t.sys.id, recap.id, u3.id]);
		expect(sent).not.toContain(t.u1.id);
		expect(sent).not.toContain(t.a1.id);
		expect(sent).not.toContain(t.a2.id);
	});
});

describe('withApplicableRecap tip guard', () => {
	it('does NOT splice a recap whose coverage contains the branch tip (Continue at the fold boundary)', () => {
		const t = buildFoldedTree();
		// The recap folded everything up to and including a2 and hangs off a2.
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id, t.u2.id, t.a2.id], 55);
		void recap;
		// Continue on a2 resolves the branch AT a2: collapsing would drop the very
		// message being continued, so the recap must not attach.
		const raw = filterByLeafNodeId(store, t.a2.id, false) as DatabaseMessage[];
		const recovered = CompactionService.withApplicableRecap(raw, store);
		expect(recovered).toBe(raw);
		const sent = CompactionService.collapseForSend(recovered).map((m) => m.id);
		expect(sent).toContain(t.a2.id);
	});

	it('still splices when the branch extends beyond the coverage', () => {
		const t = buildFoldedTree();
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id], 45);
		const raw = filterByLeafNodeId(store, t.u2.id, false) as DatabaseMessage[];
		const recovered = CompactionService.withApplicableRecap(raw, store);
		expect(recovered.some((m) => m.id === recap.id)).toBe(true);
	});
});

describe('CompactionService.withApplicableRecapNodes', () => {
	it('newer off-branch recap attaches even when an older on-branch recap is complete (masking regression)', () => {
		// fold #1 -> R1 -> conversation continues THROUGH R1 -> fold #2 -> R2 ->
		// regenerate a kept turn between the folds. R1 stays on the branch with all
		// its folded ids present (the old needsRecapRecovery gate short-circuited
		// here and lost R2); R2 is orphaned and must still be discovered.
		const t = buildFoldedTree();
		const r1 = foldRecap(t.a2.id, [t.u1.id, t.a1.id], 45);
		const u3 = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u3' }, r1.id);
		const a3 = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a3', timings: timings(95) },
			u3.id
		);
		const r2 = foldRecap(a3.id, [r1.id, t.u1.id, t.a1.id, t.u2.id, t.a2.id], 57);

		// Regenerate a3: the branch resolves from u3 and carries R1 (u3's parent) but not R2.
		const raw = filterByLeafNodeId(store, u3.id, false) as DatabaseMessage[];
		expect(raw.some((m) => m.id === r1.id)).toBe(true);
		expect(raw.some((m) => m.id === r2.id)).toBe(false);

		const recaps = store.filter((m) => m.type === MessageType.COMPACTION);
		const recovered = CompactionService.withApplicableRecapNodes(
			raw,
			recaps,
			new Set(store.map((m) => m.id))
		);
		expect(recovered.some((m) => m.id === r2.id)).toBe(true);
		// collapseForSend picks R2 (widest transitive coverage) and keeps the tail.
		const sent = CompactionService.collapseForSend(recovered).map((m) => m.id);
		expect(sent).toEqual([t.sys.id, r2.id, u3.id]);
	});

	it('deleted folded ids do not block applicability under a restricted existence universe', () => {
		const t = buildFoldedTree();
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id, 'ghost'], 45);
		const raw = filterByLeafNodeId(store, t.u2.id, false) as DatabaseMessage[];
		// Mirror the send path: existence = branch ids + bulkGet probe results
		// ('ghost' does not exist, so it is absent from the set).
		const existingIds = new Set(raw.map((m) => m.id));
		const recovered = CompactionService.withApplicableRecapNodes(raw, [recap], existingIds);
		expect(recovered.some((m) => m.id === recap.id)).toBe(true);
	});

	it('non-recap folded ids that exist but are off-branch still block', () => {
		const t = buildFoldedTree();
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id, t.u2.id, t.a2.id], 55);
		// Editing u1 branches from sys: u2/a2 exist (present in the universe) but are
		// not on this branch, so the recap must be refused.
		const raw = filterByLeafNodeId(store, t.sys.id, false) as DatabaseMessage[];
		const existingIds = new Set(store.map((m) => m.id));
		const recovered = CompactionService.withApplicableRecapNodes(raw, [recap], existingIds);
		expect(recovered.some((m) => m.id === recap.id)).toBe(false);
	});

	it('an appended recap does not masquerade as the tip on a second recovery pass', () => {
		// Two sibling folds off the same leaf: R_a covers the whole branch through
		// the real tip a2; R_b covers only {u1,a1}. Pass 1 (at tip a2) refuses R_a
		// (tip in coverage) and appends R_b. A second pass over that result must
		// STILL refuse R_a: the appended recap R_b is not a send target and must
		// not shadow the real tip.
		const t = buildFoldedTree();
		const rA = foldRecap(t.a2.id, [t.u1.id, t.a1.id, t.u2.id, t.a2.id], 55);
		const rB = foldRecap(t.a2.id, [t.u1.id, t.a1.id], 56);
		const universe = new Set(store.map((m) => m.id));
		const recaps = [rA, rB];

		const raw = filterByLeafNodeId(store, t.a2.id, false) as DatabaseMessage[];
		const pass1 = CompactionService.withApplicableRecapNodes(raw, recaps, universe);
		expect(pass1.some((m) => m.id === rA.id)).toBe(false);
		expect(pass1.some((m) => m.id === rB.id)).toBe(true);

		const pass2 = CompactionService.withApplicableRecapNodes(pass1, recaps, universe);
		expect(pass2.some((m) => m.id === rA.id)).toBe(false);
		// The real tip survives collapse.
		const sent = CompactionService.collapseForSend(pass2).map((m) => m.id);
		expect(sent).toContain(t.a2.id);
	});
});
