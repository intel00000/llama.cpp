import { describe, it, expect } from 'vitest';
import { CompactionService } from '$lib/services/compaction.service';
import { filterByLeafNodeId } from '$lib/utils/branching';
import { MessageRole, MessageType } from '$lib/enums';
import type { ChatMessageTimings, DatabaseMessage } from '$lib/types';

/**
 * Fold-awareness of CompactionService.currentOccupancy.
 *
 * A fold re-measures nothing, so straight after one the deepest assistant's timings
 * were taken against the full pre-fold context and read stale-high. currentOccupancy
 * must fall back to the recap's tokensAfter until a real post-fold send re-measures,
 * but must keep using a genuine post-fold reading once one exists.
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

const resolve = (leafId: string) => filterByLeafNodeId(store, leafId, false) as DatabaseMessage[];

/** root -> sys -> u1 -> a1(50) -> u2 -> a2(90). Returns the nodes. */
function baseConversation() {
	store.length = 0;
	clock = 0;
	const root = add({ role: MessageRole.USER, type: MessageType.ROOT }, null);
	const sys = add({ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' }, root.id);
	const u1 = add({ role: MessageRole.USER, type: MessageType.TEXT }, sys.id);
	const a1 = add(
		{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(50) },
		u1.id
	);
	const u2 = add({ role: MessageRole.USER, type: MessageType.TEXT }, a1.id);
	const a2 = add(
		{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(90) },
		u2.id
	);
	return { root, sys, u1, a1, u2, a2 };
}

/** Fold {u1,a1} into a recap hanging off leaf a2, tokensAfter=30, timestamp at the fold point. */
function foldOnto(t: ReturnType<typeof baseConversation>, createdAt?: number): DatabaseMessage {
	return add(
		{
			role: MessageRole.USER,
			type: MessageType.COMPACTION,
			content: 'recap',
			compaction: {
				summarizedMessageIds: [t.u1.id, t.a1.id],
				tokensBefore: 90,
				tokensAfter: 30,
				...(createdAt != null ? { createdAt } : {})
			}
		},
		t.a2.id,
		45 // between a1 (40) and u2 (50)
	);
}

describe('CompactionService.currentOccupancy fold-awareness', () => {
	it('un-compacted: returns the deepest assistant timings', () => {
		const t = baseConversation();
		expect(CompactionService.currentOccupancy(resolve(t.a2.id))).toBe(90);
	});

	it('after a fold with no new send: uses the recap tokensAfter, not the stale pre-fold reading', () => {
		const t = baseConversation();
		const recap = foldOnto(t);
		// Deepest assistant on the branch is a2 (retained, pre-fold reading 90); it sits
		// ABOVE the recap, so occupancy must be the recap's post-fold estimate.
		expect(CompactionService.currentOccupancy(resolve(recap.id))).toBe(30);
	});

	it('after a fold and a post-fold send: uses the real post-fold assistant reading', () => {
		const t = baseConversation();
		const recap = foldOnto(t);
		const u3 = add({ role: MessageRole.USER, type: MessageType.TEXT }, recap.id);
		const a3 = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(35) },
			u3.id
		);
		// a3 sits BELOW the recap -> measured on the collapsed context -> authoritative.
		expect(CompactionService.currentOccupancy(resolve(a3.id))).toBe(35);
	});

	it('recap present but no measured assistant: falls back to tokensAfter', () => {
		store.length = 0;
		clock = 0;
		const root = add({ role: MessageRole.USER, type: MessageType.ROOT }, null);
		const sys = add({ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' }, root.id);
		const u1 = add({ role: MessageRole.USER, type: MessageType.TEXT }, sys.id);
		const recap = add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: 'recap',
				compaction: {
					summarizedMessageIds: [],
					tokensBefore: 50,
					tokensAfter: 20
				}
			},
			u1.id
		);
		expect(CompactionService.currentOccupancy(resolve(recap.id))).toBe(20);
	});

	it('multi-recap: uses the LATEST recap tokensAfter, not a mid-chain assistant measured before it', () => {
		// root -> sys -> aFolded(50) -> recap1(after=35) -> Z(85) -> recap2(after=45).
		// Z was measured after recap1 but BEFORE recap2's fold, so its reading is stale for
		// the current context; occupancy must be recap2.tokensAfter, not Z's 85.
		store.length = 0;
		clock = 0;
		const root = add({ role: MessageRole.USER, type: MessageType.ROOT }, null, 10);
		const sys = add(
			{ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' },
			root.id,
			20
		);
		const aFolded = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(50) },
			sys.id,
			30
		);
		const recap1 = add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: 'r1',
				compaction: {
					summarizedMessageIds: [aFolded.id],
					tokensBefore: 50,
					tokensAfter: 35
				}
			},
			aFolded.id,
			35
		);
		const z = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(85) },
			recap1.id,
			50
		);
		const recap2 = add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: 'r2',
				compaction: {
					summarizedMessageIds: [recap1.id],
					tokensBefore: 85,
					tokensAfter: 45
				}
			},
			z.id,
			45
		);
		expect(CompactionService.currentOccupancy(resolve(recap2.id))).toBe(45);
	});

	it('orphaned recap (regenerate above the fold): uses the real measured tail, not the stale tokensAfter', () => {
		const t = baseConversation();
		const _recap = foldOnto(t); // folds {u1,a1}, hangs off a2, tokensAfter=30
		// Regenerate a2: a fresh sibling a2b under u2 (a2's parent). The recap now hangs off
		// the abandoned a2 (orphaned). a2b was re-measured on the collapsed context: reading 120.
		const a2b = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(120) },
			t.u2.id
		);
		// The branch resolved from a2b misses the recap (its parent-walk never reaches it);
		// withApplicableRecap re-attaches it by appending. Since the recap is not a structural
		// ancestor of a2b, occupancy must be the real measured tail (120), not tokensAfter (30).
		const branch = CompactionService.withApplicableRecap(resolve(a2b.id), store);
		expect(CompactionService.currentOccupancy(branch)).toBe(120);
	});

	it('orphaned recap with createdAt and only pre-fold readings: falls back to tokensAfter', () => {
		const t = baseConversation();
		// Fold created (wall-clock 65) after every existing measurement.
		const _recap = foldOnto(t, 65);
		// Edit a2 with branching: an UNMEASURED sibling forked above the recap. The only
		// measured assistant on the new branch is a1 (50), taken before the fold, so it
		// still counts the folded turns. Occupancy must be tokensAfter, not the stale 50.
		const a2b = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, t.u2.id, 70);
		const branch = CompactionService.withApplicableRecap(resolve(a2b.id), store);
		expect(CompactionService.currentOccupancy(branch)).toBe(30);
	});

	it('orphaned recap with createdAt and a post-fold reading: uses the real measurement', () => {
		const t = baseConversation();
		const _recap = foldOnto(t, 65);
		// Regenerated sibling measured AFTER the fold (timestamp 70 > createdAt 65): its
		// reading was taken on the collapsed context and is authoritative.
		const a2b = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(120) },
			t.u2.id,
			70
		);
		const branch = CompactionService.withApplicableRecap(resolve(a2b.id), store);
		expect(CompactionService.currentOccupancy(branch)).toBe(120);
	});

	it('sibling orphan (parent on branch, e.g. stale currNode tab): post-fold reading still wins', () => {
		const t = baseConversation();
		const _recap = foldOnto(t, 65); // child of a2, so its parent stays ON the branch
		// A send parented on a2 (stale currNode: another tab folded meanwhile) makes the
		// next turn the recap's SIBLING. The recap re-attaches as an orphan whose parent
		// is on the branch, but no assistant ever descends from it - the anchor walk must
		// not freeze occupancy at tokensAfter when a post-fold reading exists.
		const u3 = add({ role: MessageRole.USER, type: MessageType.TEXT }, t.a2.id, 70);
		const a3 = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(120) },
			u3.id,
			80
		);
		const branch = CompactionService.withApplicableRecap(resolve(a3.id), store);
		expect(branch.some((m) => m.id === _recap.id)).toBe(true);
		expect(CompactionService.currentOccupancy(branch)).toBe(120);
	});

	it('anchored recap: the structural rule still decides, createdAt changes nothing', () => {
		const t = baseConversation();
		const recap = foldOnto(t, 65);
		const u3 = add({ role: MessageRole.USER, type: MessageType.TEXT }, recap.id);
		const a3 = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, timings: timings(35) },
			u3.id
		);
		expect(CompactionService.currentOccupancy(resolve(a3.id))).toBe(35);
	});

	it('fresh conversation: null (compaction must not fire)', () => {
		store.length = 0;
		clock = 0;
		const root = add({ role: MessageRole.USER, type: MessageType.ROOT }, null);
		const sys = add({ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' }, root.id);
		const u1 = add({ role: MessageRole.USER, type: MessageType.TEXT }, sys.id);
		expect(CompactionService.currentOccupancy(resolve(u1.id))).toBeNull();
	});
});

describe('CompactionService.estimateTextTokens', () => {
	it('counts whitespace words when they dominate the chars/4 floor', () => {
		// 9 chars -> floor 3; 5 words win.
		expect(CompactionService.estimateTextTokens('a b c d e')).toBe(5);
	});

	it('falls back to chars/4 for whitespace-poor text', () => {
		// 40 chars, 1 whitespace word: the chars/4 floor (10) must win.
		expect(CompactionService.estimateTextTokens('a'.repeat(40))).toBe(10);
	});

	it('is 0 for empty/blank text', () => {
		expect(CompactionService.estimateTextTokens('')).toBe(0);
		expect(CompactionService.estimateTextTokens('   ')).toBe(0);
	});
});
