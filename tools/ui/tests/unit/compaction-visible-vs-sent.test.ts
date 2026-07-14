import { describe, it, expect } from 'vitest';
import { CompactionService } from '$lib/services/compaction.service';
import { filterByLeafNodeId } from '$lib/utils/branching';
import { MessageRole, MessageType } from '$lib/enums';
import type { DatabaseMessage } from '$lib/types';

/**
 * The transcript and the payload must fold the SAME turns. Both derive from the
 * recovered branch (applicable off-branch recaps re-attached), so an
 * edit/regenerate fork above a recap keeps the divider and the folded turns
 * hidden while the send stays collapsed.
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

/**
 * Mirror of ChatMessages.svelte's displayMessages fold-hiding derivation:
 * applicable off-branch recaps are recovered first (same as the send path),
 * then a recap hides its folded members unless it is itself still visible AND
 * expanded.
 */
function visibleIds(branch: DatabaseMessage[], expandedRecaps = new Set<string>()): string[] {
	const recovered = CompactionService.withApplicableRecap(branch, store);
	const source =
		recovered === branch
			? branch
			: [...recovered].sort((a, b) => {
					if (a.role === MessageRole.SYSTEM && b.role !== MessageRole.SYSTEM) return -1;
					if (a.role !== MessageRole.SYSTEM && b.role === MessageRole.SYSTEM) return 1;
					return a.timestamp - b.timestamp;
				});
	const recaps = source
		.filter((m) => m.type === MessageType.COMPACTION)
		.sort((a, b) => b.timestamp - a.timestamp);
	const foldedIds = new Set<string>();
	for (const r of recaps) {
		if (!foldedIds.has(r.id) && expandedRecaps.has(r.id)) continue;
		for (const id of r.compaction?.summarizedMessageIds ?? []) foldedIds.add(id);
	}
	return source.filter((m) => !foldedIds.has(m.id)).map((m) => m.id);
}

/** Mirror of the send path: indexed recap discovery + collapse + payload merge. */
function sentIds(branch: DatabaseMessage[]): string[] {
	const recaps = store.filter((m) => m.type === MessageType.COMPACTION);
	const recovered =
		recaps.length > 0
			? CompactionService.withApplicableRecapNodes(branch, recaps, new Set(store.map((m) => m.id)))
			: branch;
	return CompactionService.mergeRecapIntoNextUser(CompactionService.collapseForSend(recovered)).map(
		(m) => m.id
	);
}

describe('visible transcript vs sent payload (orphaned recap)', () => {
	it('on-branch recap: transcript and payload agree', () => {
		store.length = 0;
		clock = 0;
		const root = add({ role: MessageRole.USER, type: MessageType.ROOT }, null);
		const sys = add(
			{ role: MessageRole.SYSTEM, type: MessageType.SYSTEM, content: 'sys' },
			root.id
		);
		const u1 = add({ role: MessageRole.USER, type: MessageType.TEXT }, sys.id);
		const a1 = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, u1.id);
		const u2 = add({ role: MessageRole.USER, type: MessageType.TEXT }, a1.id);
		const a2 = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, u2.id);
		const recap = add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: CompactionService.formatRecap('r'),
				compaction: {
					summarizedMessageIds: [u1.id, a1.id],
					tokensBefore: 90,
					tokensAfter: 30
				}
			},
			a2.id,
			45
		);
		const branch = filterByLeafNodeId(store, recap.id, false) as DatabaseMessage[];
		const visible = visibleIds(branch);
		const sent = sentIds(branch);
		// Both hide the folded turns.
		expect(visible).not.toContain(u1.id);
		expect(sent).not.toContain(u1.id);
	});

	it('orphaned recap (fork above the fold): transcript and payload still agree', () => {
		store.length = 0;
		clock = 0;
		const root = add({ role: MessageRole.USER, type: MessageType.ROOT }, null);
		const sys = add(
			{ role: MessageRole.SYSTEM, type: MessageType.SYSTEM, content: 'sys' },
			root.id
		);
		const u1 = add({ role: MessageRole.USER, type: MessageType.TEXT }, sys.id);
		const a1 = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, u1.id);
		const u2 = add({ role: MessageRole.USER, type: MessageType.TEXT }, a1.id);
		const a2 = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, u2.id);
		add(
			{
				role: MessageRole.USER,
				type: MessageType.COMPACTION,
				content: CompactionService.formatRecap('r'),
				compaction: {
					summarizedMessageIds: [u1.id, a1.id],
					tokensBefore: 90,
					tokensAfter: 30
				}
			},
			a2.id,
			45
		);
		// Regenerate a2: the new branch resolves from u2 and the recap is orphaned.
		const a2b = add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT }, u2.id);
		const branch = filterByLeafNodeId(store, a2b.id, false) as DatabaseMessage[];

		const visible = visibleIds(branch);
		const sent = sentIds(branch);

		// The payload folds u1/a1 via off-branch recovery, and the transcript
		// hides them behind the recovered recap's divider just the same.
		expect(sent).not.toContain(u1.id);
		expect(sent).not.toContain(a1.id);
		expect(visible).not.toContain(u1.id);
		expect(visible).not.toContain(a1.id);
	});
});
