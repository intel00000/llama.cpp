/**
 * contextStatsStore - Context window usage stats for the active conversation
 *
 * Combines token usage persisted in message timings metadata with
 * server-originating data: model context size from /props (modelsStore)
 * and live processing state while streaming (chatStore).
 */

import { MessageRole } from '$lib/enums';
import { CompactionService } from '$lib/services/compaction.service';
// direct imports between stores, not via the barrel, to avoid circular deps
import { agenticStore } from '$lib/stores/agentic.svelte';
import { chatStore } from '$lib/stores/chat.svelte';
import { conversationsStore } from '$lib/stores/conversations.svelte';
import { modelsStore } from '$lib/stores/models.svelte';
import { serverStore } from '$lib/stores/server.svelte';
import type { ApiProcessingState, DatabaseMessage } from '$lib/types';

interface LiveStats {
	freshTokens: number;
	promptTokens: number;
	cacheTokens: number;
	outputTokens: number;
}

function deriveLiveStats(state: ApiProcessingState | null): LiveStats | null {
	if (!state || (state.status !== 'preparing' && state.status !== 'generating')) {
		return null;
	}

	const promptTokens = state.promptTokens ?? 0;
	const cacheTokens = state.cacheTokens ?? 0;

	return {
		cacheTokens,
		freshTokens: promptTokens,
		outputTokens: state.outputTokensUsed ?? 0,
		promptTokens: promptTokens + cacheTokens
	};
}

class ContextStatsStore {
	// The canonical resolution lives in modelsStore.activeModelId.
	activeModelId = $derived(modelsStore.activeModelId);

	isActiveModelLoaded = $derived(
		this.activeModelId !== null &&
			(!serverStore.isRouterMode || modelsStore.isModelLoaded(this.activeModelId))
	);

	isActiveModelLoading = $derived(
		this.activeModelId !== null && modelsStore.isModelOperationInProgress(this.activeModelId)
	);

	contextTotal = $derived.by(() => {
		void modelsStore.propsCacheVersion;

		return this.activeModelId ? modelsStore.getModelContextSize(this.activeModelId) : null;
	});

	private liveStats = $derived(deriveLiveStats(chatStore.activeProcessingState));

	// Recover a recap orphaned off the branch by a fork above it, then resolve the
	// fold-aware measured assistant ONCE per branch change and share it across
	// every reading + the occupancy fallback.
	private recoveredBranch = $derived(
		CompactionService.withApplicableRecap(
			conversationsStore.activeMessages as DatabaseMessage[],
			conversationsStore.activeAllMessages as DatabaseMessage[]
		)
	);

	private measured = $derived(CompactionService.latestMeasuredAssistant(this.recoveredBranch));

	private measuredTimings = $derived(this.measured?.timings);

	currentRead = $derived.by(() => {
		const timings = this.measuredTimings;

		let read = 0;

		if (timings) {
			read = (timings.prompt_n ?? 0) + (timings.cache_n ?? 0);
		}

		// live.promptTokens is already the combined reading (prompt + cache),
		// so do not also add live.cacheTokens.
		if (this.liveStats && this.liveStats.promptTokens > 0) {
			read = Math.max(read, this.liveStats.promptTokens);
		}

		return read;
	});

	currentFresh = $derived.by(() => {
		const timings = this.measuredTimings;
		const fresh = timings?.prompt_n ?? 0;

		return Math.max(fresh, this.liveStats?.freshTokens ?? 0);
	});

	currentCache = $derived.by(() => {
		const timings = this.measuredTimings;
		const cached = timings?.cache_n ?? 0;

		if (this.liveStats && this.liveStats.promptTokens > 0) {
			return Math.max(cached, this.liveStats.cacheTokens);
		}

		return cached;
	});

	currentOutput = $derived.by(() => {
		if (this.liveStats && this.liveStats.outputTokens > 0) return this.liveStats.outputTokens;

		const timings = this.measuredTimings;

		return timings?.predicted_n ?? 0;
	});

	kvTotal = $derived(this.currentRead + this.currentOutput);

	// Fold-aware occupancy from the SAME shared measured assistant.
	private postFoldOccupancy = $derived(
		this.measured
			? CompactionService.occupancyTokens(this.measured.timings)
			: CompactionService.latestRecapTokensAfter(this.recoveredBranch)
	);

	contextUsed = $derived(
		this.liveStats
			? this.currentRead + this.currentOutput
			: (this.postFoldOccupancy ?? this.currentRead + this.currentOutput)
	);

	contextAvailable = $derived(
		this.contextTotal !== null ? this.contextTotal - this.contextUsed : null
	);

	contextPercent = $derived.by(() => {
		if (this.contextTotal === null || this.contextTotal <= 0) return null;

		return Math.round((this.contextUsed / this.contextTotal) * 100);
	});

	private cumulative = $derived.by(() => {
		const messages = conversationsStore.activeMessages as DatabaseMessage[];
		const convId = conversationsStore.activeConversation?.id;
		// A running agentic flow stamps llm totals on messages only when it
		// exits, so read its live session totals instead.
		const liveLlm = convId ? agenticStore.getLiveLlmTotals(convId) : null;

		if (liveLlm) {
			const outputMs = liveLlm.predicted_ms;
			const averageTokensPerSecond =
				outputMs > 0 && liveLlm.predicted_n > 0 ? (liveLlm.predicted_n / outputMs) * 1000 : null;

			return {
				averageTokensPerSecond,
				cacheTotal: 0,
				output: liveLlm.predicted_n,
				read: liveLlm.prompt_n
			};
		}

		// Agentic sessions stamp the same agentic.llm totals onto every
		// assistant message; cache_n is never per-turn so cache_total stays 0.
		const agenticMessages = messages.filter(
			(m) => m.role === MessageRole.ASSISTANT && m.timings?.agentic?.llm?.predicted_n != null
		);

		if (agenticMessages.length > 0) {
			const llm = agenticMessages[agenticMessages.length - 1].timings!.agentic!.llm;
			const output = llm.predicted_n ?? 0;
			const outputMs = llm.predicted_ms ?? 0;
			const averageTokensPerSecond = outputMs > 0 && output > 0 ? (output / outputMs) * 1000 : null;

			return {
				averageTokensPerSecond,
				cacheTotal: 0,
				output,
				read: llm.prompt_n ?? 0
			};
		}

		let read = 0;
		let output = 0;
		let outputMs = 0;
		let cacheTotal = 0;

		for (const m of messages) {
			if (m.role !== MessageRole.ASSISTANT || !m.timings) continue;

			read += m.timings.prompt_n ?? 0;
			cacheTotal += m.timings.cache_n ?? 0;
			output += m.timings.predicted_n ?? 0;
			outputMs += m.timings.predicted_ms ?? 0;
		}
		const averageTokensPerSecond = outputMs > 0 && output > 0 ? (output / outputMs) * 1000 : null;

		return { averageTokensPerSecond, cacheTotal, output, read };
	});

	cumulativeRead = $derived(this.cumulative.read);

	cumulativeOutput = $derived(this.cumulative.output);

	cumulativeCacheTotal = $derived(this.cumulative.cacheTotal);

	averageTokensPerSecond = $derived(this.cumulative.averageTokensPerSecond);
}

export const contextStatsStore = new ContextStatsStore();
