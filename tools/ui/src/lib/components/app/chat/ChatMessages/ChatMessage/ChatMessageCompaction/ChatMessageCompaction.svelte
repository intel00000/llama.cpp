<script lang="ts">
	import { ChevronDown, Combine } from '@lucide/svelte';
	import { MarkdownContent } from '$lib/components/app';

	interface Props {
		class?: string;
		message: DatabaseMessage;
	}

	let { class: className = '', message }: Props = $props();

	const meta = $derived(message.compaction);
	const foldedCount = $derived(meta?.summarizedMessageIds.length ?? 0);
	const tokensFreed = $derived(meta ? Math.max(0, meta.tokensBefore - meta.tokensAfter) : 0);

	const label = $derived.by(() => {
		const bits: string[] = [];
		if (foldedCount > 0) bits.push(`${foldedCount} message${foldedCount === 1 ? '' : 's'}`);
		if (tokensFreed > 0) bits.push(`~${tokensFreed.toLocaleString()} tokens freed`);
		return bits.length ? `Compacted ${bits.join(', ')}` : 'Compacted';
	});

	let expanded = $state(false);
</script>

<div
	class="chat-message-compaction flex flex-col items-center gap-2 {className}"
	role="group"
	aria-label="Conversation compacted"
>
	<div class="flex w-full items-center gap-3 text-muted-foreground">
		<div class="h-px flex-1 bg-border"></div>

		<button
			type="button"
			class="flex items-center gap-1.5 rounded-full border border-dashed border-border/60 bg-muted/40 px-3 py-1 text-xs transition-colors hover:bg-muted"
			onclick={() => (expanded = !expanded)}
			aria-expanded={expanded}
		>
			<Combine class="h-3.5 w-3.5" />

			<span>{label}</span>

			{#if message.content.trim()}
				<ChevronDown class="h-3.5 w-3.5 transition-transform {expanded ? 'rotate-180' : ''}" />
			{/if}
		</button>

		<div class="h-px flex-1 bg-border"></div>
	</div>

	{#if expanded && message.content.trim()}
		<div
			class="w-full rounded-2xl border border-dashed border-border/50 bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
		>
			<MarkdownContent content={message.content} />
		</div>
	{/if}
</div>
