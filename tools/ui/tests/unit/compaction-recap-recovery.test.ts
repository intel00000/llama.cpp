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

describe('CompactionService.needsRecapRecovery', () => {
	it('no recap on the branch: recovery needed', () => {
		const t = buildFoldedTree();
		const branch = filterByLeafNodeId(store, t.a2.id, false) as DatabaseMessage[];
		expect(CompactionService.needsRecapRecovery(branch)).toBe(true);
	});

	it('on-branch recap with all folded ids on the branch: no recovery needed', () => {
		const t = buildFoldedTree();
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id], 45);
		const branch = filterByLeafNodeId(store, recap.id, false) as DatabaseMessage[];
		expect(CompactionService.needsRecapRecovery(branch)).toBe(false);
	});

	it('on-branch recap referencing an off-branch id: recovery needed', () => {
		const t = buildFoldedTree();
		// R1 hangs off the abandoned a2; R2 (on the fork branch) references it.
		const r1 = foldRecap(t.a2.id, [t.u1.id, t.a1.id], 45);
		const a2b = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a2b' },
			t.u2.id
		);
		const r2 = foldRecap(a2b.id, [r1.id, t.u2.id, a2b.id], 55);
		const branch = filterByLeafNodeId(store, r2.id, false) as DatabaseMessage[];
		expect(CompactionService.needsRecapRecovery(branch)).toBe(true);
	});

	it('recovered branch (orphan appended): no further recovery needed', () => {
		const t = buildFoldedTree();
		const recap = foldRecap(t.a2.id, [t.u1.id, t.a1.id], 45);
		void recap;
		const raw = filterByLeafNodeId(store, t.u2.id, false) as DatabaseMessage[];
		const recovered = CompactionService.withApplicableRecap(raw, store);
		expect(CompactionService.needsRecapRecovery(recovered)).toBe(false);
	});
});
