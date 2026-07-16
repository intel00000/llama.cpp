<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { beforeNavigate, afterNavigate } from '$app/navigation';
	import { ChatMessage, ChatMessageUserPending } from '$lib/components/app';
	import { setChatActionsContext } from '$lib/contexts';
	import { MessageRole, MessageType } from '$lib/enums';
	import { chatStore } from '$lib/stores/chat.svelte';
	import { CompactionService } from '$lib/services';
	import {
		chatHasPendingMessage,
		chatPendingMessageContent,
		chatPendingMessageExtras,
		chatClearPendingMessage,
		chatInjectPendingMessage
	} from '$lib/stores/chat.svelte';
	import { conversationsStore, activeConversation } from '$lib/stores/conversations.svelte';
	import { config } from '$lib/stores/settings.svelte';
	import {
		agenticHasPendingSteeringMessage,
		agenticPendingSteeringMessageContent,
		agenticPendingSteeringMessageExtras,
		agenticClearSteeringMessage,
		agenticInjectSteeringMessage
	} from '$lib/stores/agentic.svelte';
	import {
		buildSiblingInfoMap,
		copyToClipboard,
		formatMessageForClipboard,
		hasAgenticContent
	} from '$lib/utils';

	interface Props {
		messages?: DatabaseMessage[];
		onUserAction?: () => void;
		onMessagesReady?: (messageCount: number) => void;
	}

	let { messages = [], onUserAction, onMessagesReady }: Props = $props();

	let allConversationMessages = $state<DatabaseMessage[]>([]);
	let isVisible = $state(false);
	let previousConversationId = $state<string | null>(null);
	let previousRouteId = $state<string | null>(null);

	// Recap nodes whose folded original messages are currently revealed inline.
	const expandedRecaps = new SvelteSet<string>();
	function toggleRecap(recapId: string) {
		if (expandedRecaps.has(recapId)) expandedRecaps.delete(recapId);
		else expandedRecaps.add(recapId);
	}

	// The transcript must fold exactly what a send folds: recover applicable
	// off-branch recaps (edit/regenerate forks above a fold orphan them) and
	// re-sort so the divider lands at its fold point.
	const displaySource = $derived.by(() => {
		const recovered = CompactionService.withApplicableRecap(messages, allConversationMessages);
		if (recovered === messages) return messages;
		return [...recovered].sort((a, b) => {
			if (a.role === MessageRole.SYSTEM && b.role !== MessageRole.SYSTEM) return -1;
			if (a.role !== MessageRole.SYSTEM && b.role === MessageRole.SYSTEM) return 1;
			return a.timestamp - b.timestamp;
		});
	});

	// When a NEWER recap appears that folds an already-expanded recap, collapse that nested
	// recap so it re-appears as a divider rather than staying auto-revealed.
	let knownRecapIds = new Set<string>();
	$effect(() => {
		const recaps = displaySource.filter((m) => m.type === MessageType.COMPACTION);
		if (recaps.some((r) => !knownRecapIds.has(r.id))) expandedRecaps.clear();
		knownRecapIds = new Set(recaps.map((r) => r.id));
	});

	const currentConfig = config();

	setChatActionsContext({
		copy: async (message: DatabaseMessage) => {
			const asPlainText = Boolean(currentConfig.copyTextAttachmentsAsPlainText);
			const clipboardContent = formatMessageForClipboard(
				message.content,
				message.extra,
				asPlainText
			);
			await copyToClipboard(clipboardContent, 'Message copied to clipboard');
		},

		delete: async (message: DatabaseMessage) => {
			await chatStore.deleteMessage(message.id);
			refreshAllMessages();
		},

		navigateToSibling: async (siblingId: string) => {
			await conversationsStore.navigateToSibling(siblingId);
		},

		editWithBranching: async (
			message: DatabaseMessage,
			newContent: string,
			newExtras?: DatabaseMessageExtra[]
		) => {
			onUserAction?.();
			await chatStore.editMessageWithBranching(message.id, newContent, newExtras);
			refreshAllMessages();
		},

		editWithReplacement: async (
			message: DatabaseMessage,
			newContent: string,
			shouldBranch: boolean
		) => {
			onUserAction?.();
			await chatStore.editAssistantMessage(message.id, newContent, shouldBranch);
			refreshAllMessages();
		},

		editUserMessagePreserveResponses: async (
			message: DatabaseMessage,
			newContent: string,
			newExtras?: DatabaseMessageExtra[]
		) => {
			onUserAction?.();
			await chatStore.editUserMessagePreserveResponses(message.id, newContent, newExtras);
			refreshAllMessages();
		},

		regenerateWithBranching: async (message: DatabaseMessage, modelOverride?: string) => {
			onUserAction?.();
			await chatStore.regenerateMessageWithBranching(message.id, modelOverride);
			refreshAllMessages();
		},

		continueAssistantMessage: async (message: DatabaseMessage) => {
			onUserAction?.();
			await chatStore.continueAssistantMessage(message.id);
			refreshAllMessages();
		},

		forkConversation: async (
			message: DatabaseMessage,
			options: { name: string; includeAttachments: boolean }
		) => {
			await conversationsStore.forkConversation(message.id, options);
		}
	});

	function refreshAllMessages() {
		const conversation = activeConversation();

		if (conversation) {
			conversationsStore.getConversationMessages(conversation.id).then((messages) => {
				allConversationMessages = messages;
			});
		} else {
			allConversationMessages = [];
		}
	}

	// Track conversation changes to trigger transition even on same route
	$effect(() => {
		const conversation = activeConversation();
		const currentId = conversation?.id ?? null;

		if (currentId !== previousConversationId && previousConversationId !== null) {
			// Conversation changed - trigger fade out/in
			expandedRecaps.clear(); // recap reveal state is per-conversation
			isVisible = false;
			requestAnimationFrame(() => {
				refreshAllMessages();
				previousConversationId = currentId;
				requestAnimationFrame(() => {
					isVisible = true;
				});
			});
		} else {
			previousConversationId = currentId;
			if (conversation) {
				refreshAllMessages();
			}
		}
	});

	$effect(() => {
		void allConversationMessages;

		onMessagesReady?.(displayMessages.length);
	});

	onMount(() => {
		requestAnimationFrame(() => {
			isVisible = true;
		});
	});

	beforeNavigate((navigation) => {
		isVisible = false;
		previousRouteId = navigation.from?.route.id ?? null;
	});

	afterNavigate(() => {
		requestAnimationFrame(() => {
			isVisible = true;
		});
	});

	let siblingInfoByMessageId = $derived(buildSiblingInfoMap(allConversationMessages));

	let displayMessages = $derived.by(() => {
		if (!messages.length) {
			return [];
		}

		// Hide messages folded into a recap.
		// A recap hides its folded members unless it is itself still visible AND expanded.
		const recaps = displaySource
			.filter((m) => m.type === MessageType.COMPACTION)
			.sort((a, b) => b.timestamp - a.timestamp);
		// Transient and read-only below. plain Set avoids SvelteSet's per-op signal cost.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const foldedIds = new Set<string>();
		for (const r of recaps) {
			if (!foldedIds.has(r.id) && expandedRecaps.has(r.id)) continue;
			for (const id of r.compaction?.summarizedMessageIds ?? []) foldedIds.add(id);
		}
		// Single pass: drop folded messages and (unless shown) system messages.
		const showSystem = currentConfig.showSystemMessage;
		const filteredMessages =
			foldedIds.size === 0 && showSystem
				? displaySource
				: displaySource.filter(
						(m) => !foldedIds.has(m.id) && (showSystem || m.type !== MessageRole.SYSTEM)
					);

		// Build display entries, grouping agentic sessions into single entries.
		// An agentic session = assistant(with tool_calls) → tool → assistant → tool → ... → assistant(final)
		const result: Array<{
			message: DatabaseMessage;
			toolMessages: DatabaseMessage[];
			isLastAssistantMessage: boolean;
			isLastUserMessage: boolean;
			nextAssistantMessage: DatabaseMessage | null;
			siblingInfo: ChatMessageSiblingInfo;
		}> = [];

		for (let i = 0; i < filteredMessages.length; i++) {
			const msg = filteredMessages[i];

			// Skip tool messages - they're grouped with preceding assistant
			if (msg.role === MessageRole.TOOL) continue;

			const toolMessages: DatabaseMessage[] = [];
			if (msg.role === MessageRole.ASSISTANT && hasAgenticContent(msg)) {
				let j = i + 1;

				while (j < filteredMessages.length) {
					const next = filteredMessages[j];

					if (next.role === MessageRole.TOOL) {
						toolMessages.push(next);

						j++;
					} else if (next.role === MessageRole.ASSISTANT) {
						toolMessages.push(next);

						j++;
					} else {
						break;
					}
				}

				i = j - 1;
			} else if (msg.role === MessageRole.ASSISTANT) {
				let j = i + 1;

				while (j < filteredMessages.length && filteredMessages[j].role === MessageRole.TOOL) {
					toolMessages.push(filteredMessages[j]);
					j++;
				}
			}

			const siblingInfo = siblingInfoByMessageId.get(msg.id) ?? {
				message: msg,
				siblingIds: [msg.id],
				currentIndex: 0,
				totalSiblings: 1
			};

			result.push({
				message: msg,
				toolMessages,
				isLastAssistantMessage: false,
				isLastUserMessage: false,
				nextAssistantMessage: null,
				siblingInfo
			});
		}

		let lastAssistantIdx = -1;
		for (let i = result.length - 1; i >= 0; i--) {
			if (result[i].message.role === MessageRole.ASSISTANT) {
				result[i].isLastAssistantMessage = true;
				lastAssistantIdx = i;
				break;
			}
		}

		if (
			lastAssistantIdx > 0 &&
			result[lastAssistantIdx - 1].message.role === MessageRole.USER &&
			result[lastAssistantIdx - 1].message.type !== MessageType.COMPACTION
		) {
			result[lastAssistantIdx - 1].isLastUserMessage = true;
		}

		// exclude compaction messages from nextAssistantMessage linking
		for (let i = 0; i < result.length; i++) {
			if (
				result[i].message.role !== MessageRole.USER ||
				result[i].message.type === MessageType.COMPACTION
			)
				continue;

			for (let j = i + 1; j < result.length; j++) {
				if (result[j].message.role === MessageRole.ASSISTANT) {
					result[i].nextAssistantMessage = result[j].message;
					break;
				}
			}
		}

		return result;
	});
</script>

<div
	class="transition-opacity duration-500 ease-out
		{isVisible ? 'opacity-100' : 'opacity-0'}
		{previousRouteId === '/(chat)/chat/[id]' ? '' : 'delay-300'}"
>
	{#each displayMessages as { message, toolMessages, isLastAssistantMessage, isLastUserMessage, nextAssistantMessage, siblingInfo } (message.id)}
		<ChatMessage
			class="mx-auto mt-12 w-full max-w-3xl"
			{message}
			{toolMessages}
			{isLastAssistantMessage}
			{isLastUserMessage}
			{nextAssistantMessage}
			{siblingInfo}
			recapExpanded={expandedRecaps.has(message.id)}
			onToggleRecap={() => toggleRecap(message.id)}
		/>
	{/each}

	<!-- Gate on entry EXISTENCE: an attachment-only
	     pending message ('' content, extras present) must stay visible or it
	     auto-sends with no visual representation. -->
	{#if activeConversation() && agenticHasPendingSteeringMessage(activeConversation()!.id)}
		{@const convId = activeConversation()!.id}
		<ChatMessageUserPending
			class="mx-auto mt-12 w-full max-w-[48rem]"
			content={agenticPendingSteeringMessageContent(convId) ?? ''}
			extras={agenticPendingSteeringMessageExtras(convId)}
			onSendImmediately={() => chatStore.abortCurrentFlow(convId)}
			onEdit={(newContent, extras) => agenticInjectSteeringMessage(convId, newContent, extras)}
			onDelete={() => agenticClearSteeringMessage(convId)}
		/>
	{:else if activeConversation() && chatHasPendingMessage(activeConversation()!.id)}
		{@const convId = activeConversation()!.id}
		<ChatMessageUserPending
			class="mx-auto mt-12 w-full max-w-[48rem]"
			content={chatPendingMessageContent(convId) ?? ''}
			extras={chatPendingMessageExtras(convId)}
			onSendImmediately={() => chatStore.sendPendingNow(convId)}
			onEdit={(newContent, extras) => chatInjectPendingMessage(convId, newContent, extras)}
			onDelete={() => chatClearPendingMessage(convId)}
		/>
	{/if}
</div>
