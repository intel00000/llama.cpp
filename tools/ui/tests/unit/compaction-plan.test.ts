import { describe, it, expect } from 'vitest';
import { CompactionService } from '$lib/services/compaction.service';
import { filterByLeafNodeId } from '$lib/utils/branching';
import { MessageRole, MessageType } from '$lib/enums';
import type { ChatMessageTimings, DatabaseMessage } from '$lib/types';

/**
 * Tests for CompactionService.planCompaction - which whole turns to fold.
 *
 * The load-bearing case is REPEAT compaction: a retained-tail turn measured before an
 * earlier fold still counts the folded region in its stored timings, so its absolute
 * reads stale-high. planCompaction must size those stale turns by ESTIMATE (not by their
 * stale absolute) so cum[] stays on the same post-fold baseline as `total`, and the fold
 * loop keeps folding until the retained tail actually fits the budget (A1 #3).
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

const ids = (msgs: DatabaseMessage[]) => msgs.map((m) => m.id);

function reset() {
	store.length = 0;
	clock = 0;
	const root = add({ role: MessageRole.USER, type: MessageType.ROOT }, null);
	const sys = add({ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' }, root.id);
	return sys;
}

/** Append a user+assistant turn under `parent`; assistant carries `t` occupancy (or none). */
function turn(parent: DatabaseMessage, tag: string, t?: number) {
	const u = add({ role: MessageRole.USER, type: MessageType.TEXT, content: `u-${tag}` }, parent.id);
	const a = add(
		{
			role: MessageRole.ASSISTANT,
			type: MessageType.TEXT,
			content: `a-${tag}`,
			...(t != null ? { timings: timings(t) } : {})
		},
		u.id
	);
	return { u, a };
}

describe('CompactionService.planCompaction', () => {
	it('first compaction: folds the fewest oldest measured turns to fit the budget', () => {
		const sys = reset();
		let parent = sys;
		const t = [];
		for (let i = 1; i <= 5; i++) {
			const turnNodes = turn(parent, `${i}`, i * 1000);
			t.push(turnNodes);
			parent = turnNodes.a;
		}
		const branch = filterByLeafNodeId(store, parent.id, false) as DatabaseMessage[];
		// total 5000, budget 40% * 8000 = 3200: fold T1,T2 -> kept T3,T4,T5 = 3000 <= 3200.
		const plan = CompactionService.planCompaction(branch, 8000, 40);
		expect(plan.fold).toBe(true);
		if (!plan.fold) return;
		expect(ids(plan.keepMessages)).toEqual(ids([t[2].u, t[2].a, t[3].u, t[3].a, t[4].u, t[4].a]));
	});

	it('repeat compaction: stale pre-fold tail turns are sized by estimate so it folds enough (A1 #3)', () => {
		const sys = reset();
		// Retained tail from a PRIOR fold: measured pre-fold, so stale-high absolutes.
		let parent = sys;
		const stale = [turn(parent, 's0', 8000)];
		parent = stale[0].a;
		stale.push(turn(parent, 's1', 9000));
		parent = stale[1].a;
		stale.push(turn(parent, 's2', 10000));
		parent = stale[2].a;
		// The prior fold's recap: child of the retained-tail leaf.
		const recap = add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: CompactionService.formatRecap('older summary'),
				compaction: {
					summarizedMessageIds: [],
					tokensBefore: 10000,
					tokensAfter: 3500
				}
			},
			parent.id
		);
		parent = recap;
		// Fresh turns measured AFTER the fold (post-fold cumulative absolutes).
		const fresh = [];
		for (const [i, v] of [4200, 5000, 6000, 7500, 9000].entries()) {
			const turnNodes = turn(parent, `f${i}`, v);
			fresh.push(turnNodes);
			parent = turnNodes.a;
		}
		const collapsed = CompactionService.collapseForSend(
			CompactionService.withApplicableRecap(
				filterByLeafNodeId(store, parent.id, false) as DatabaseMessage[],
				store
			)
		);
		// nCtx 16000, retain 40% -> budget 6400; total = post-fold tail = 9000.
		const plan = CompactionService.planCompaction(collapsed, 16000, 40);
		expect(plan.fold).toBe(true);
		if (!plan.fold) return;
		// Must fold past ALL stale turns AND the first fresh turn (f0), keeping f1..f4
		// (real footprint 9000 - 4200 = 4800 <= 6400). The bug folds only recap + s0.
		expect(ids(plan.foldMessages)).toContain(stale[0].u.id);
		expect(ids(plan.foldMessages)).toContain(fresh[0].u.id);
		expect(ids(plan.keepMessages)).toEqual(
			ids([
				fresh[1].u,
				fresh[1].a,
				fresh[2].u,
				fresh[2].a,
				fresh[3].u,
				fresh[3].a,
				fresh[4].u,
				fresh[4].a
			])
		);
	});

	it('fork above the recap: turns measured after createdAt are sized exactly, not over-folded', () => {
		const sys = reset();
		// Pre-fold history: folded turn F, kept turn K (both measured pre-fold).
		const uF = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u-F' }, sys.id);
		const aF = add(
			{
				role: MessageRole.ASSISTANT,
				type: MessageType.TEXT,
				content: 'a-F',
				timings: timings(9000)
			},
			uF.id
		);
		const uK = add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u-K' }, aF.id);
		const aK = add(
			{
				role: MessageRole.ASSISTANT,
				type: MessageType.TEXT,
				content: 'a-K',
				timings: timings(10000)
			},
			uK.id
		);
		// The fold: recap child of the kept leaf aK, folding {uF, aF}; created at wall
		// clock 200, node timestamp backdated to the fold point.
		const recap = add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: CompactionService.formatRecap('older summary'),
				compaction: {
					summarizedMessageIds: [uF.id, aF.id],
					tokensBefore: 10000,
					tokensAfter: 3500,
					createdAt: 200
				}
			},
			aK.id,
			45
		);
		void recap;
		// Regenerate aK: post-fold sibling measured on the collapsed context, then three
		// more post-fold turns. All timestamps sit after createdAt.
		const aKb = add(
			{
				role: MessageRole.ASSISTANT,
				type: MessageType.TEXT,
				content: 'a-Kb',
				timings: timings(4200)
			},
			uK.id,
			210
		);
		let parent = aKb;
		const fresh = [];
		let ts = 220;
		for (const v of [5000, 6000, 7500]) {
			const u = add(
				{ role: MessageRole.USER, type: MessageType.TEXT, content: 'u' },
				parent.id,
				ts
			);
			const a = add(
				{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a', timings: timings(v) },
				u.id,
				ts + 5
			);
			fresh.push({ u, a });
			parent = a;
			ts += 10;
		}
		const collapsed = CompactionService.collapseForSend(
			CompactionService.withApplicableRecap(
				filterByLeafNodeId(store, parent.id, false) as DatabaseMessage[],
				store
			)
		);
		// nCtx 16000, retain 40% -> budget 6400; total = post-fold tail = 7500. The recap is
		// no structural ancestor on this fork, but every tail assistant was measured after
		// createdAt, so exact sizing applies: fold recap + the uK/aKb turn (7500 - 4200 =
		// 3300 <= 6400) and keep the three fresh turns. Estimate-only sizing would fold
		// everything but the last turn.
		const plan = CompactionService.planCompaction(collapsed, 16000, 40);
		expect(plan.fold).toBe(true);
		if (!plan.fold) return;
		expect(ids(plan.keepMessages)).toEqual(
			ids([fresh[0].u, fresh[0].a, fresh[1].u, fresh[1].a, fresh[2].u, fresh[2].a])
		);
	});

	it('CJK / whitespace-poor unmeasured turns are sized by chars, not one word (A5)', () => {
		const sys = reset();
		let parent = sys;
		// No timings anywhere (imported). CJK content, ~200 chars/message, no whitespace.
		for (let i = 0; i < 3; i++) {
			const u = add(
				{ role: MessageRole.USER, type: MessageType.TEXT, content: '你好'.repeat(100) },
				parent.id
			);
			const a = add(
				{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: '回答'.repeat(100) },
				u.id
			);
			parent = a;
		}
		const branch = filterByLeafNodeId(store, parent.id, false) as DatabaseMessage[];
		// nCtx 400, retain 40% -> budget 160. Each turn estimates ~ (200+200)/4 = 100 tokens,
		// so it folds WITHOUT force. The old one-word count sized each turn ~2 tokens and this
		// returned 'already within the retain budget'.
		const plan = CompactionService.planCompaction(branch, 400, 40, false);
		expect(plan.fold).toBe(true);
	});
});

describe('planCompaction force past a bare recap turn', () => {
	it('overflow on a previously-compacted branch extends the fold beyond the hoisted recap', () => {
		const sys = reset();
		// Collapsed branch shape: [sys, recap, kept tail] - the recap is turn 0.
		const recap = add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: CompactionService.formatRecap('r'),
				compaction: {
					summarizedMessageIds: ['x1'],
					tokensBefore: 900,
					tokensAfter: 300
				}
			},
			sys.id
		);
		const t1 = turn(recap, 'kept1', 1400);
		const t2 = turn(t1.a, 'kept2', 1500);
		const branch = filterByLeafNodeId(store, t2.a.id, false) as DatabaseMessage[];
		// total 1500, nCtx 8000, retain 20% -> budget 1600: within budget, so the
		// k-loop stops at the bare recap turn. force (overflow) must extend to a
		// real turn instead of returning 'Nothing new to fold'.
		const plan = CompactionService.planCompaction(branch, 8000, 20, true);
		expect(plan.fold).toBe(true);
		if (!plan.fold) return;
		expect(ids(plan.foldMessages)).toEqual(ids([recap, t1.u, t1.a]));
		expect(ids(plan.keepMessages)).toEqual(ids([t2.u, t2.a]));
	});

	it('force still declines when there is nothing but the recap to fold', () => {
		const sys = reset();
		const recap = add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: CompactionService.formatRecap('r'),
				compaction: {
					summarizedMessageIds: ['x1'],
					tokensBefore: 900,
					tokensAfter: 300
				}
			},
			sys.id
		);
		const t1 = turn(recap, 'only', 1400);
		const branch = filterByLeafNodeId(store, t1.a.id, false) as DatabaseMessage[];
		// Only the recap turn precedes the last (never-folded) turn.
		const plan = CompactionService.planCompaction(branch, 8000, 20, true);
		expect(plan.fold).toBe(false);
	});
});
