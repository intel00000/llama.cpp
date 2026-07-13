<script lang="ts">
	import { Combine } from '@lucide/svelte';
	import { toast } from 'svelte-sonner';
	import { chatStore, conversationsStore } from '$lib/stores';
	import { colorLevelBgClass, colorLevelTextClass } from './context-gauge';
	import ContextGaugeDetails from './ContextGaugeDetails.svelte';
	import ContextGaugeLoadModel from './ContextGaugeLoadModel.svelte';
	import {
		gaugeCardEnter,
		gaugeCardLeave,
		gaugePopup,
		gaugePopupClose
	} from './gauge-popup.svelte';
	import { useContextGauge } from '$lib/hooks/use-context-gauge.svelte';
	import { formatParameters } from '$lib/utils/formatters';

	const gauge = useContextGauge();

	async function handleCompact() {
		const conv = conversationsStore.activeConversation;
		if (!conv) return;
		try {
			const result = await chatStore.compactConversation(conv.id, 'manual');
			if (result.compacted) toast.success('Conversation compacted');
			else if (result.reason) toast.info(result.reason);
		} catch (error) {
			// rethrows non-abort errors (server error).
			console.error('Manual compaction failed:', error);
			toast.error('Compaction failed. Please try again.');
		}
	}

	// The gauge hook wraps a processing state instance that only follows the
	// live stream while its own monitoring flag is set, so the card instance
	// starts monitoring like the dial does.
	$effect(() => {
		gauge.startMonitoring();
	});

	let cardEl = $state<HTMLElement | null>(null);

	// Any press outside the card and outside the dial closes the card.
	// Presses on the dial are excluded because the dial handles its own
	// toggle; the listener only exists while the card is open.
	$effect(() => {
		if (!gaugePopup.open) return;

		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;

			if (!(target instanceof Node)) return;

			if (cardEl?.contains(target)) return;

			if (target instanceof Element && target.closest('[data-context-gauge-trigger]')) return;

			gaugePopupClose();
		};

		document.addEventListener('pointerdown', onPointerDown, true);

		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	});

	const showProgressBar = $derived(
		gauge.contextTotal !== null &&
			gauge.contextTotal > 0 &&
			(gauge.activeModelId !== null || gauge.isActiveModelLoaded)
	);
</script>

{#if gaugePopup.open}
	<div
		role="status"
		bind:this={cardEl}
		class="absolute z-50 w-64 -translate-x-1/2 rounded-lg border border-border/50 bg-popover p-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10"
		style="left: {gaugePopup.centerX}px; bottom: {gaugePopup.bottom}px"
		onpointerenter={gaugeCardEnter}
		onpointerleave={gaugeCardLeave}
	>
		<div class="flex flex-col gap-2">
			<div class="flex items-center gap-2">
				<span class="font-medium">Context</span>
				<span class="text-muted-foreground">·</span>
				<span class="font-mono text-muted-foreground">
					{formatParameters(gauge.contextUsed)}
					/ {gauge.contextTotal !== null ? formatParameters(gauge.contextTotal) : '-'}
				</span>
			</div>

			{#if gauge.activeModelId !== null && !gauge.isActiveModelLoaded}
				<ContextGaugeLoadModel
					modelId={gauge.activeModelId}
					isLoading={gauge.isActiveModelLoading}
					onLoad={gauge.loadModel}
				/>
			{:else if showProgressBar}
				<div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
					<div
						class="h-full rounded-full transition-all duration-300 {colorLevelBgClass(
							gauge.colorLevel
						)}"
						style="width: {gauge.contextPercent}%"
					></div>
				</div>

				<div class="flex justify-between text-xs text-muted-foreground">
					<span>
						<span class={colorLevelTextClass(gauge.colorLevel)}>{gauge.contextPercent}%</span> used
					</span>
					<span>
						{formatParameters(gauge.contextAvailable ?? 0)} remaining
					</span>
				</div>
			{:else}
				<div class="text-xs text-muted-foreground">No context info available</div>
			{/if}

			{#if gauge.hasAnyUsage}
				<ContextGaugeDetails
					currentRead={gauge.currentRead}
					currentFresh={gauge.currentFresh}
					currentCache={gauge.currentCache}
					currentOutput={gauge.currentOutput}
					kvTotal={gauge.kvTotal}
					cumulativeRead={gauge.cumulativeRead}
					cumulativeOutput={gauge.cumulativeOutput}
					cumulativeCacheTotal={gauge.cumulativeCacheTotal}
					averageTokensPerSecond={gauge.averageTokensPerSecond}
					transientDetails={gauge.transientDetails}
				/>
			{/if}

			<!-- Imported conversations have no usage yet and need manual compaction to
			     get within budget before the first send, so gate on turns too. -->
			{#if conversationsStore.activeConversation && (gauge.hasAnyUsage || conversationsStore.activeMessages.length > 1)}
				{@const convId = conversationsStore.activeConversation!.id}
				<button
					type="button"
					class="mt-1 flex items-center justify-center gap-1.5 rounded-md border border-border/50 px-2 py-1 text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
					disabled={chatStore.isLoading ||
						chatStore.isStreaming() ||
						chatStore.isCompacting(convId)}
					onclick={handleCompact}
				>
					<Combine class="h-3 w-3" />
					<span>{chatStore.isCompacting(convId) ? 'Compacting...' : 'Compact now'}</span>
				</button>
			{/if}
		</div>
	</div>
{/if}
