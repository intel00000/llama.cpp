import { MessageRole, MessageType } from '$lib/enums';
import type { ChatMessageTimings, DatabaseMessage } from '$lib/types';

const RECAP_PREFIX = 'Summary of the earlier conversation (compacted to save context):';

/**
 * Token cost of one attachment, used only when estimating a turn the server
 * never measured (an image is many tokens but zero whitespace-words). Coarse on
 * purpose - it is a fallback, and overflow-recovery backstops any under-estimate.
 */
const EST_TOKENS_PER_ATTACHMENT = 2048;

/** Result of planning a compaction over a branch. */
export type CompactionPlan =
	| { fold: false; reason: string }
	| {
			fold: true;
			system: DatabaseMessage[];
			/** older turns to summarize into the recap and exclude from future sends */
			foldMessages: DatabaseMessage[];
			/** recent turns kept verbatim */
			keepMessages: DatabaseMessage[];
	  };

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

	/**
	 * Group a branch body (non-system messages) into whole turns.
	 *
	 * A turn starts at a USER message. A recap node is `role: 'user'`, so it
	 * starts one too, and the assistant/tool messages answering it attach to
	 * the same turn. Whole-turn boundaries are what keep an assistant's
	 * `tool_calls` adjacent to their results.
	 */
	static groupIntoTurns(body: DatabaseMessage[]): DatabaseMessage[][] {
		const turns: DatabaseMessage[][] = [];
		for (const m of body) {
			if (m.role === MessageRole.USER || turns.length === 0) {
				turns.push([m]);
			} else {
				turns[turns.length - 1].push(m);
			}
		}
		return turns;
	}

	/**
	 * Ids a new recap must record for a fold: every folded message id plus, for a
	 * folded recap node, its transitive coverage. The new recap is then
	 * self-contained, so a later fork that strands the older recap off-branch
	 * cannot leak its folded turns back into sends.
	 */
	static transitiveFoldIds(
		foldMessages: DatabaseMessage[],
		allMessages: DatabaseMessage[]
	): string[] {
		const recapById = new Map(
			allMessages.filter((m) => m.type === MessageType.COMPACTION).map((m) => [m.id, m])
		);
		const ids = new Set<string>();
		for (const m of foldMessages) {
			ids.add(m.id);
			if (m.type === MessageType.COMPACTION) {
				for (const id of CompactionService.coverageOf(m, recapById)) ids.add(id);
			}
		}
		return [...ids];
	}

	/**
	 * Decide what to fold. Keeps the newest whole turns that fit `retainPercent` of
	 * `nCtx` and folds everything older. Sizes come from server-measured cumulative
	 * occupancy (history is never re-tokenized).
	 *
	 * a whitespace + per-attachment estimate is used ONLY for turns the server
	 * didn't measure (imported conversations), never mixed into the exact server
	 * numbers.
	 *
	 * `force` (overflow / manual / already over threshold) folds at least
	 * the oldest turn even when sizing thinks the branch already fits.
	 */
	static planCompaction(
		branch: DatabaseMessage[],
		nCtx: number,
		retainPercent: number,
		force = false
	): CompactionPlan {
		const system = branch.filter((m) => m.role === MessageRole.SYSTEM);
		const body = branch.filter((m) => m.role !== MessageRole.SYSTEM);
		const turns = CompactionService.groupIntoTurns(body);

		if (turns.length < 2) return { fold: false, reason: 'No older turns to fold.' };

		// Cumulative occupancy through each turn.
		//
		// A turn's exact server timing is trusted only when its assistant was measured
		// BELOW the latest recap (i.e. AFTER the fold).
		//
		// A retained-tail turn measured BEFORE the fold still counts the folded region,
		// so its recorded reading is stale-high.
		//
		// Thus it is sized by estimate instead, like an unmeasured turn.
		const byId = new Map(branch.map((m) => [m.id, m]));
		const recaps = body.filter((m) => m.type === MessageType.COMPACTION);
		const latestRecap = recaps.length
			? recaps.reduce((a, b) => (b.timestamp > a.timestamp ? b : a))
			: undefined;
		const belowRecap = (turn: DatabaseMessage[]): boolean => {
			if (!latestRecap) return true;
			for (let i = turn.length - 1; i >= 0; i--) {
				if (turn[i].role !== MessageRole.ASSISTANT) continue;
				if (CompactionService.occupancyTokens(turn[i].timings) == null) continue;
				const createdAt = latestRecap.compaction?.createdAt;
				if (createdAt != null && turn[i].timestamp > createdAt) return true;
				let cur: DatabaseMessage | undefined = turn[i];
				while (cur) {
					if (cur.id === latestRecap.id) return true;
					cur = cur.parent ? byId.get(cur.parent) : undefined;
				}
				return false;
			}
			return false;
		};
		const cum: number[] = [];
		let running = 0;
		for (let t = 0; t < turns.length; t++) {
			const exact = CompactionService.turnCumulative(turns[t]);
			running =
				exact != null && belowRecap(turns[t])
					? exact
					: running + CompactionService.estimateTurnTokens(turns[t]);
			cum[t] = running;
		}
		const total = CompactionService.currentOccupancy(branch) ?? cum[turns.length - 1];

		const retainBudget = Math.floor((retainPercent / 100) * nCtx);
		if (total - retainBudget <= 0 && !force) {
			return { fold: false, reason: 'Already within the retain budget.' };
		}

		// Fold the fewest oldest turns so the kept tail fits the budget, never fold the
		// last (current) turn.
		let k = 1;
		for (let i = 0; i < turns.length - 1; i++) {
			k = i + 1;
			if (total - cum[i] <= retainBudget) break;
		}

		let foldMessages = turns.slice(0, k).flat();
		// A fold of only recap nodes cannot reduce the context. After any prior
		// fold turns[0] is the hoisted recap alone, so `force` (overflow/manual)
		// must extend past it or overflow recovery dead-ends on every retry.
		while (
			force &&
			k < turns.length - 1 &&
			foldMessages.every((m) => m.type === MessageType.COMPACTION)
		) {
			k += 1;
			foldMessages = turns.slice(0, k).flat();
		}
		if (foldMessages.every((m) => m.type === MessageType.COMPACTION)) {
			return { fold: false, reason: 'Nothing new to fold.' };
		}

		return {
			fold: true,
			system,
			foldMessages,
			keepMessages: turns.slice(k).flat()
		};
	}

	/** Recap node content: a fixed prefix followed by the generated summary. */
	static formatRecap(summary: string): string {
		return `${RECAP_PREFIX}\n\n${summary.trim()}`;
	}

	/** Token estimate for generated text (whitespace words, chars/4 floor). */
	static estimateTextTokens(text: string): number {
		return CompactionService.wordCount(text);
	}

	/** Cumulative occupancy of a turn - its last assistant's timings, or null. */
	private static turnCumulative(turn: DatabaseMessage[]): number | null {
		for (let i = turn.length - 1; i >= 0; i--) {
			if (turn[i].role !== MessageRole.ASSISTANT) continue;
			const used = CompactionService.occupancyTokens(turn[i].timings);
			if (used != null) return used;
		}
		return null;
	}

	/**
	 * Estimate size of a turn the server didn't measure: whitespace-token count
	 * of the text content and tool-call JSON, plus a flat constant per attachment.
	 */
	private static estimateTurnTokens(turn: DatabaseMessage[]): number {
		let n = 0;
		for (const m of turn) {
			n += CompactionService.wordCount(m.content) + CompactionService.wordCount(m.toolCalls);
			n += (m.extra?.length ?? 0) * EST_TOKENS_PER_ATTACHMENT;
		}
		return n;
	}

	private static wordCount(text: string | undefined): number {
		if (!text) return 0;
		const trimmed = text.trim();
		if (!trimmed) return 0;
		// Whitespace tokens under-count CJK / whitespace-poor text by 1-2 orders of
		// magnitude (a whole CJK paragraph splits into ~1 "word"), which would let an
		// imported non-whitespace conversation dodge sizing. Fall back to a chars/4
		// token estimate.
		return Math.max(trimmed.split(/\s+/).length, Math.ceil(trimmed.length / 4));
	}
}
