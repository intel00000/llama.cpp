import { MessageRole, MessageType } from '$lib/enums';
import type { ChatMessageTimings, DatabaseMessage } from '$lib/types';

/**
 * Conversation auto-compaction.
 *
 * Summarizes older turns into a single recap message so a long conversation
 * keeps fitting the model context. The recap is a first-class tree node
 * (`type: 'compaction'`, `role: 'user'`).
 * On send the folded turns are dropped and replaced by that recap via
 * `collapseForSend`.
 *
 * Stateless pure logic: read-time collapse, recap selection, occupancy and
 * fold planning. The chat store owns triggering and persistence.
 */
export class CompactionService {
	/**
	 * Collapse a resolved branch for sending. When the branch carries compaction
	 * recap node(s), drop the messages they folded and emit
	 * `[...system, latest recap, ...retained tail]`.
	 *
	 * Returns the input unchanged when there is no checkpoint, so the feature is
	 * inert until a recap node exists on the branch.
	 */
	static collapseForSend(branch: DatabaseMessage[]): DatabaseMessage[] {
		const checkpoints = branch.filter((m) => m.type === MessageType.COMPACTION);
		if (checkpoints.length === 0) return branch;

		const recapById = new Map<string, DatabaseMessage>(checkpoints.map((c) => [c.id, c]));
		const latest = CompactionService.effectiveRecap(checkpoints, recapById)!;
		const summarized = CompactionService.coverageOf(latest, recapById);

		// Keep system messages, which are never folded, at the front of the branch.
		const system = branch.filter((m) => m.role === MessageRole.SYSTEM);

		// Keep the tail, filtering out the recap nodes and every turn the emitted recap folds.
		const tail = branch.filter(
			(m) =>
				m.role !== MessageRole.SYSTEM && m.type !== MessageType.COMPACTION && !summarized.has(m.id)
		);
		// return the system messages, the latest recap, and the retained tail (the kept turns)
		return [...system, latest, ...tail];
	}

	/**
	 * The recap in effect for a set of checkpoints: widest transitive coverage,
	 * tie broken by the newest fold epoch. Every consumer that must agree with
	 * what a send folds (collapse, occupancy anchor, tokensAfter fallback, fork
	 * cloning) resolves through this unified rule.
	 */
	static effectiveRecap(
		checkpoints: DatabaseMessage[],
		recapById: Map<string, DatabaseMessage>
	): DatabaseMessage | undefined {
		if (checkpoints.length === 0) return undefined;
		let best = checkpoints[0];
		let bestCoverage = CompactionService.coverageOf(best, recapById);
		for (const c of checkpoints.slice(1)) {
			const coverage = CompactionService.coverageOf(c, recapById);
			if (
				coverage.size > bestCoverage.size ||
				(coverage.size === bestCoverage.size &&
					CompactionService.foldEpoch(c) > CompactionService.foldEpoch(best))
			) {
				best = c;
				bestCoverage = coverage;
			}
		}
		return best;
	}

	/** Fold-ordering key: createdAt, the node timestamp is backdated. */
	private static foldEpoch(m: DatabaseMessage): number {
		return m.compaction?.createdAt ?? m.timestamp;
	}

	/**
	 * Transitive fold coverage of a recap: its summarizedMessageIds plus,
	 * recursively, the ids folded by any recap referenced within them.
	 */
	static coverageOf(start: DatabaseMessage, recapById: Map<string, DatabaseMessage>): Set<string> {
		const covered = new Set<string>();
		const stack = [...(start.compaction?.summarizedMessageIds ?? [])];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			if (covered.has(id)) continue;
			covered.add(id);
			const nested = recapById.get(id);
			if (nested) stack.push(...(nested.compaction?.summarizedMessageIds ?? []));
		}
		return covered;
	}

	/**
	 * Merge each recap node into the user message that directly follows it.
	 * collapseForSend emits [system, recap(user), ...tail] and the tail starts
	 * with a user turn, so the raw payload would carry two consecutive user
	 * messages, which strict-alternation chat templates reject. Payload-boundary
	 * only: planning and persistence keep the recap as its own node.
	 *
	 * Returns the input unchanged when no recap is present.
	 */
	static mergeRecapIntoNextUser(messages: DatabaseMessage[]): DatabaseMessage[] {
		if (!messages.some((m) => m.type === MessageType.COMPACTION)) return messages;
		const out: DatabaseMessage[] = [];
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			const next = messages[i + 1];
			if (
				m.type === MessageType.COMPACTION &&
				next?.role === MessageRole.USER &&
				next.type !== MessageType.COMPACTION
			) {
				// Keep the user message's identity (id, extras); prepend the recap text.
				out.push({
					...next,
					content: next.content ? `${m.content}\n\n${next.content}` : m.content
				});
				i++;
			} else {
				out.push(m);
			}
		}
		return out;
	}

	/**
	 * Re-attach a recap that logically folds this branch but is not physically on it,
	 * so `collapseForSend` still finds a checkpoint and folds the branch on send.
	 *
	 * A recap is stored as a leaf-CHILD of the retained tail (NOT as an ancestor of the
	 * turns it folds), and branch resolution is a pure parent-walk (`filterByLeafNodeId`).
	 * Compaction deliberately KEEPS the most recent turns (the retained tail) rather than
	 * folding everything, and editing or regenerating one of those kept turns forks a new
	 * branch ABOVE the recap. Example:
	 *
	 *   after a fold:    ... T3 -> T4 -> T5 -> T6 -> R    (R is a child of the leaf T6,
	 *                                                      and folds T1..T3)
	 *   regenerate T5:   ... T3 -> T4 -> T5'              (new branch; R hangs off old T6)
	 *
	 * T5' still carries T1..T3, so R should apply, but a parent-walk from T5' will not
	 * reach R, so `collapseForSend` would see no checkpoint and re-send T1..T3
	 * uncollapsed. Re-attaching R here prevents that (`collapseForSend` then drops the
	 * folded turns and hoists R into place).
	 */
	static withApplicableRecap(
		branch: DatabaseMessage[],
		allMessages: DatabaseMessage[]
	): DatabaseMessage[] {
		const recaps = allMessages.filter((m) => m.type === MessageType.COMPACTION);
		if (recaps.length === 0) return branch;
		const branchIds = new Set(branch.map((m) => m.id));
		// Recap-node ids inside a folded list are structural references (a recap that
		// folded an earlier recap), not turn content, and may sit off-branch. Ids of
		// deleted messages can never re-enter a send. Neither blocks applicability.
		const recapIds = new Set(recaps.map((m) => m.id));
		const allIds = new Set(allMessages.map((m) => m.id));
		const toAdd: DatabaseMessage[] = [];
		for (const m of recaps) {
			if (branchIds.has(m.id)) continue;
			const folded = (m.compaction?.summarizedMessageIds ?? []).filter(
				(id) => allIds.has(id) && !recapIds.has(id)
			);
			if (folded.length > 0 && folded.every((id) => branchIds.has(id))) toAdd.push(m);
		}
		if (toAdd.length === 0) return branch;
		toAdd.sort((a, b) => a.timestamp - b.timestamp);
		return [...branch, ...toAdd];
	}

	/**
	 * Whether a branch needs the full-tree recap recovery pass: it carries no recap
	 * at all, or an on-branch recap references a folded id that is not on the
	 * branch (a nested recap stranded by a fork, or a recap recorded before
	 * transitive coverage) so collapseForSend could not expand it locally.
	 */
	static needsRecapRecovery(branch: DatabaseMessage[]): boolean {
		if (!branch.some((m) => m.type === MessageType.COMPACTION)) return true;
		const ids = new Set(branch.map((m) => m.id));
		for (const m of branch) {
			if (m.type !== MessageType.COMPACTION) continue;
			for (const id of m.compaction?.summarizedMessageIds ?? []) {
				if (!ids.has(id)) return true;
			}
		}
		return false;
	}

	/**
	 * Context occupancy of a single turn's stored timings, in server-measured
	 * tokens: `prompt_n + cache_n + predicted_n`. `prompt_n` and `cache_n` are the
	 * disjoint fresh/cache-reused prompt read; `predicted_n` is the turn's output,
	 * which becomes prompt on the next request (so it counts toward occupancy).
	 * Returns `null` when the timings carry none of these counts.
	 */
	static occupancyTokens(timings: ChatMessageTimings | undefined): number | null {
		if (!timings) return null;
		const { prompt_n, cache_n, predicted_n } = timings;
		if (prompt_n == null && cache_n == null && predicted_n == null) return null;
		return (prompt_n ?? 0) + (cache_n ?? 0) + (predicted_n ?? 0);
	}

	/**
	 * The deepest ASSISTANT whose stored TOP-LEVEL timings reflect the CURRENT
	 * context. An assistant ABOVE the latest recap was measured before that fold
	 * and reads high (it still counts the turns the fold removed), so it is excluded.
	 *
	 * Returns undefined when none qualifies (imported, or right after a fold before
	 * the next send re-measures).
	 */
	static latestMeasuredAssistant(branch: DatabaseMessage[]): DatabaseMessage | undefined {
		// The anchor is the effective recap (the one a send would fold with), not
		// any recap that happens to have an on-branch parent.
		const checkpoints = branch.filter((m) => m.type === MessageType.COMPACTION);
		const byId = checkpoints.length ? new Map(branch.map((m) => [m.id, m])) : undefined;
		let anchorRecap: DatabaseMessage | undefined;
		let foldCutoff: number | undefined;
		if (byId) {
			const recapById = new Map(checkpoints.map((c) => [c.id, c]));
			const effective = CompactionService.effectiveRecap(checkpoints, recapById)!;
			if (effective.parent != null && byId.has(effective.parent)) {
				anchorRecap = effective;
			} else {
				foldCutoff = effective.compaction?.createdAt;
			}
		}
		const belowAnchorRecap = (m: DatabaseMessage): boolean => {
			if (!anchorRecap || !byId) return true;
			let cur = m.parent ? byId.get(m.parent) : undefined;
			while (cur) {
				if (cur.id === anchorRecap.id) return true;
				cur = cur.parent ? byId.get(cur.parent) : undefined;
			}
			return false;
		};
		const pick = (cutoff: number | undefined, useAnchor: boolean): DatabaseMessage | undefined => {
			for (let i = branch.length - 1; i >= 0; i--) {
				const m = branch[i];
				if (m.role !== MessageRole.ASSISTANT) continue;
				if (CompactionService.occupancyTokens(m.timings) == null) continue;
				if (cutoff != null && m.timestamp <= cutoff) continue;
				if (!useAnchor || belowAnchorRecap(m)) return m;
			}
			return undefined;
		};
		const measured = pick(foldCutoff, true);
		if (measured) return measured;
		if (anchorRecap?.compaction?.createdAt != null) {
			return pick(anchorRecap.compaction.createdAt, false);
		}
		return undefined;
	}

	/**
	 * Current context occupancy of a resolved branch, in server tokens. Either the
	 * latest recap's post-fold estimate (`tokensAfter`), or `null` (fresh/imported).
	 */
	static currentOccupancy(branch: DatabaseMessage[]): number | null {
		const measured = CompactionService.latestMeasuredAssistant(branch);
		if (measured) return CompactionService.occupancyTokens(measured.timings);
		return CompactionService.latestRecapTokensAfter(branch);
	}

	/** Post-fold token estimate of the effective recap on the branch, or null. */
	static latestRecapTokensAfter(branch: DatabaseMessage[]): number | null {
		const withTokens = branch.filter(
			(m) => m.type === MessageType.COMPACTION && m.compaction?.tokensAfter != null
		);
		if (withTokens.length === 0) return null;
		const recapById = new Map(
			branch.filter((m) => m.type === MessageType.COMPACTION).map((c) => [c.id, c] as const)
		);
		return CompactionService.effectiveRecap(withTokens, recapById)?.compaction?.tokensAfter ?? null;
	}

	/**
	 * Whether occupancy has reached `thresholdPercent` of `nCtx`.
	 *
	 * It never fires when either number is unknown or non-positive - e.g.
	 * `nCtx` is null before `/props` resolves, or `used` is null on a fresh conversation.
	 */
	static isOverThreshold(
		used: number | null,
		nCtx: number | null,
		thresholdPercent: number
	): boolean {
		if (used == null || nCtx == null || nCtx <= 0) return false;
		return used / nCtx >= thresholdPercent / 100;
	}
}
