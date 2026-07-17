import { describe, it, expect } from 'vitest';
import { CompactionService } from '$lib/services/compaction.service';
import { filterByLeafNodeId } from '$lib/utils/branching';
import { MessageRole, MessageType } from '$lib/enums';
import type { ChatMessageTimings, DatabaseMessage } from '$lib/types';

/**
 * The unified effective-recap resolution: collapse, the occupancy anchor, the
 * tokensAfter fallback, and fork cloning must all agree on WHICH recap is in
 * effect (widest transitive coverage, tie -> newest fold epoch).
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

function recap(
	parentId: string,
	summarizedIds: string[],
	opts: { ts: number; createdAt?: number; tokensAfter?: number }
): DatabaseMessage {
	return add(
		{
			role: MessageRole.USER,
			type: MessageType.COMPACTION,
			content: CompactionService.formatRecap('r'),
			compaction: {
				summarizedMessageIds: summarizedIds,
				tokensBefore: 90,
				tokensAfter: opts.tokensAfter ?? 30,
				...(opts.createdAt != null ? { createdAt: opts.createdAt } : {})
			}
		},
		parentId,
		opts.ts
	);
}

/** root -> sys -> u1 -> a1 -> u2 -> a2 */
function base() {
	store.length = 0;
	clock = 0;
	const root = add({ role: MessageRole.USER, type: MessageType.ROOT }, null);
	const sys = add({ role: MessageRole.SYSTEM, type: MessageType.SYSTEM, content: 's' }, root.id);
	const u1 = add({ role: MessageRole.USER, type: MessageType.TEXT }, sys.id);
	const a1 = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, u1.id);
	const u2 = add({ role: MessageRole.USER, type: MessageType.TEXT }, a1.id);
	const a2 = add(
		{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(90) },
		u2.id
	);
	return { root, sys, u1, a1, u2, a2 };
}

describe('effectiveRecap tie-breaks', () => {
	it('equal coverage: newest createdAt wins over a newer backdated node timestamp', () => {
		const t = base();
		// rA has the NEWER node timestamp but the OLDER fold epoch.
		const rA = recap(t.a2.id, [t.u1.id, t.a1.id], { ts: 46, createdAt: 100 });
		const rB = recap(t.a2.id, [t.u1.id, t.a1.id], { ts: 45, createdAt: 200 });
		const byId = new Map([rA, rB].map((r) => [r.id, r] as const));
		expect(CompactionService.effectiveRecap([rA, rB], byId)?.id).toBe(rB.id);
	});
});

describe('occupancy reads follow the effective recap (dominance, not position)', () => {
	it('appended consumed orphan does not shadow the newer recap tokensAfter', () => {
		const t = base();
		const r1 = recap(t.a2.id, [t.u1.id, t.a1.id], { ts: 45, createdAt: 100, tokensAfter: 30 });
		// R2 on-branch, wider (covers R1 transitively), newer fold.
		const r2 = recap(t.a2.id, [r1.id, t.u1.id, t.a1.id, t.u2.id], {
			ts: 46,
			createdAt: 200,
			tokensAfter: 20
		});
		// Recovered-branch shape: branch through R2, orphan R1 appended LAST.
		const branch = [...(filterByLeafNodeId(store, r2.id, false) as DatabaseMessage[]), r1];
		expect(CompactionService.latestRecapTokensAfter(branch)).toBe(20);
		// No assistant measured after fold #2 -> occupancy falls back to R2's value.
		expect(CompactionService.currentOccupancy(branch)).toBe(20);
	});

	it('a sibling recap with an on-branch parent cannot hijack the anchor from the effective recap', () => {
		// Fork-clone shape: both R1c and R2c are children of the fork tip a2;
		// currNode resolves through R2c (wider). R1c's parent IS on the branch,
		// and it sits later in the array - the old positional scan anchored on it.
		const t = base();
		const r1c = recap(t.a2.id, [t.u1.id, t.a1.id], { ts: 47, createdAt: 100 });
		const r2c = recap(t.a2.id, [r1c.id, t.u1.id, t.a1.id, t.u2.id], { ts: 46, createdAt: 200 });
		const branch = filterByLeafNodeId(store, r2c.id, false) as DatabaseMessage[];
		// Simulate recovery appending the sibling orphan after everything.
		const recovered = [...branch, r1c];
		// A post-fork assistant measured under R2c must be found as the anchor tail.
		const u3 = add({ role: MessageRole.USER, type: MessageType.TEXT }, r2c.id, 300);
		const a3 = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(25) },
			u3.id,
			310
		);
		const full = [...recovered.filter((m) => m.id !== r1c.id), u3, a3, r1c];
		expect(CompactionService.latestMeasuredAssistant(full)?.id).toBe(a3.id);
		expect(CompactionService.currentOccupancy(full)).toBe(25);
	});
});

describe('planForkRecapClones', () => {
	it('every applicable orphan is cloned at its coverage boundary', () => {
		const t = base();
		// Both orphaned (hang off a2, path resolves from u2 after a regenerate).
		const r1 = recap(t.a2.id, [t.u1.id, t.a1.id], { ts: 45, createdAt: 100 });
		const r2 = recap(t.a2.id, [r1.id, t.u1.id, t.a1.id], { ts: 46, createdAt: 200 });
		const a2b = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, t.u2.id, 400);
		const path = filterByLeafNodeId(store, a2b.id, false) as DatabaseMessage[];
		const plan = CompactionService.planForkRecapClones(path, store);
		expect(new Set(plan.map((p) => p.recap.id))).toEqual(new Set([r1.id, r2.id]));
		// Boundary = deepest cloned path message the coverage includes: rewinding
		// the fork's tail below it can never cascade the fold away.
		for (const p of plan) expect(p.boundaryId).toBe(t.a1.id);
	});

	it('an orphan behind an ON-path recap still clones at its boundary', () => {
		const t = base();
		const r1 = recap(t.a2.id, [t.u1.id, t.a1.id], { ts: 45, createdAt: 100 });
		// Regenerate a2 -> orphan R1; then fold #2 lands ON the new branch.
		const a2b = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, t.u2.id, 400);
		const r2 = recap(a2b.id, [r1.id, t.u1.id, t.a1.id], { ts: 401, createdAt: 500 });
		const path = filterByLeafNodeId(store, r2.id, false) as DatabaseMessage[];
		const plan = CompactionService.planForkRecapClones(path, store);
		expect(plan.map((p) => p.recap.id)).toEqual([r1.id]);
		expect(plan[0].boundaryId).toBe(t.a1.id);
	});

	it('disjoint orphans clone at their own boundaries', () => {
		const t = base();
		const u3 = add({ role: MessageRole.USER, type: MessageType.TEXT }, t.a2.id, 60);
		const a3 = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, u3.id, 70);
		const rNarrow = recap(a3.id, [t.u1.id, t.a1.id], { ts: 45, createdAt: 100 });
		const rWide = recap(a3.id, [t.u2.id, t.a2.id, u3.id], { ts: 46, createdAt: 200 });
		// Fork at a3 via a fresh sibling regenerate (both recaps off-path).
		const a3b = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, u3.id, 500);
		const path = filterByLeafNodeId(store, a3b.id, false) as DatabaseMessage[];
		const plan = CompactionService.planForkRecapClones(path, store);
		const byRecap = new Map(plan.map((p) => [p.recap.id, p.boundaryId]));
		expect(byRecap.get(rNarrow.id)).toBe(t.a1.id);
		expect(byRecap.get(rWide.id)).toBe(u3.id);
	});

	it('no recaps / no applicable orphans -> no clones', () => {
		const t = base();
		const path = filterByLeafNodeId(store, t.a2.id, false) as DatabaseMessage[];
		expect(CompactionService.planForkRecapClones(path, store)).toEqual([]);
	});
});
