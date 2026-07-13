<script lang="ts">
	import { chatStore } from '$lib/stores/chat.svelte';
	import { activeConversation } from '$lib/stores/conversations.svelte';
	import { Loader2 } from '@lucide/svelte';

	// Surfaced for every compaction trigger (manual, auto-before-send, overflow recovery,
	// and agentic mid-run) since they all set the per-conversation compacting flag.
	const conversation = $derived(activeConversation());
	const isCompacting = $derived(conversation ? chatStore.isCompacting(conversation.id) : false);
</script>

{#if isCompacting}
	<div
		class="pointer-events-auto mx-auto mt-2 mb-2 flex max-w-[48rem] items-center gap-2 rounded-md border border-amber-400/40 bg-amber-50/60 px-3 py-1.5 text-sm text-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
		role="status"
		aria-live="polite"
	>
		<Loader2 class="h-3.5 w-3.5 animate-spin" />
		<span>Compacting conversation...</span>
	</div>
{/if}
