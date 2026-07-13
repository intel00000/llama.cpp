<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { ChatMessage, ChatMessageUserPending } from '$lib/components/app';
	import { MessageRole, MessageType } from '$lib/enums';
	import { CompactionService } from '$lib/services';
	import { agenticStore, chatStore, conversationsStore, settingsStore } from '$lib/stores';
	import type { ChatMessageActions } from '$lib/types';
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

	let { messages = [], onMessagesReady, onUserAction }: Props = $props();

	let allConversationMessages = $state<DatabaseMessage[]>([]);

	// Recap nodes whose folded original messages are currently revealed inline.
	const expandedRecaps = new SvelteSet<string>();
	let recapConversationId: string | null = null;
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

	const currentConfig = settingsStore.config;

	const chatActions: ChatMessageActions = {
		continueAssistantMessage: async (message: DatabaseMessage) => {
			onUserAction?.();
			await chatStore.continueAssistantMessage(message.id);
			refreshAllMessages();
		},

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

		editUserMessagePreserveResponses: async (
			message: DatabaseMessage,
			newContent: string,
			newExtras?: DatabaseMessageExtra[]
		) => {
			onUserAction?.();
			await chatStore.editUserMessagePreserveResponses(message.id, newContent, newExtras);
			refreshAllMessages();
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

		forkConversation: async (
			message: DatabaseMessage,
			options: { name: string; includeAttachments: boolean }
		) => {
			await conversationsStore.forkConversation(message.id, options);
		},

		navigateToSibling: async (siblingId: string) => {
			await conversationsStore.navigateToSibling(siblingId);
		},

		regenerateWithBranching: async (message: DatabaseMessage, modelOverride?: string) => {
			onUserAction?.();
			await chatStore.regenerateMessageWithBranching(message.id, modelOverride);
			refreshAllMessages();
		}
	};

	function refreshAllMessages() {
		const conversation = conversationsStore.activeConversation;

		if (conversation) {
			conversationsStore.getConversationMessages(conversation.id).then((messages) => {
				allConversationMessages = messages;
			});
		} else {
			allConversationMessages = [];
		}
	}

	// Refresh messages whenever the active conversation changes
	$effect(() => {
		const conversation = conversationsStore.activeConversation;
		const currentId = conversation?.id ?? null;
		if (currentId !== recapConversationId) {
			recapConversationId = currentId;
			expandedRecaps.clear(); // recap reveal state is per-conversation
		}
		if (conversation) {
			refreshAllMessages();
		}
	});

	$effect(() => {
		void allConversationMessages;

		onMessagesReady?.(displayMessages.length);
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
				currentIndex: 0,
				message: msg,
				siblingIds: [msg.id],
				totalSiblings: 1
			};

			result.push({
				isLastAssistantMessage: false,
				isLastUserMessage: false,
				message: msg,
				nextAssistantMessage: null,
				siblingInfo,
				toolMessages
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

<div>
	{#each displayMessages as { isLastAssistantMessage, isLastUserMessage, message, nextAssistantMessage, siblingInfo, toolMessages } (message.id)}
		<ChatMessage
			class="mx-auto mt-12 w-full max-w-3xl"
			{chatActions}
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

	{#if conversationsStore.activeConversation && agenticStore.pendingSteeringMessageContent(conversationsStore.activeConversation!.id)}
		{@const convId = conversationsStore.activeConversation!.id}
		{@const pendingContent = agenticStore.pendingSteeringMessageContent(convId)}

		{#if pendingContent}
			<ChatMessageUserPending
				class="mx-auto mt-12 w-full max-w-[48rem]"
				content={pendingContent}
				extras={agenticStore.pendingSteeringMessageExtras(convId)}
				onSendImmediately={() => chatStore.abortCurrentFlow(convId)}
				onEdit={(newContent, extras) =>
					agenticStore.injectSteeringMessage(convId, newContent, extras)}
				onDelete={() => agenticStore.clearSteeringMessage(convId)}
			/>
		{/if}
	{:else if conversationsStore.activeConversation && chatStore.pendingMessageContent(conversationsStore.activeConversation!.id)}
		{@const convId = conversationsStore.activeConversation!.id}
		{@const pendingContent = chatStore.pendingMessageContent(convId)}

		{#if pendingContent}
			<ChatMessageUserPending
				class="mx-auto mt-12 w-full max-w-[48rem]"
				content={pendingContent}
				extras={chatStore.pendingMessageExtras(convId)}
				onSendImmediately={() => chatStore.abortCurrentFlow(convId)}
				onEdit={(newContent, extras) => chatStore.injectPendingMessage(convId, newContent, extras)}
				onDelete={() => chatStore.clearPendingMessage(convId)}
			/>
		{/if}
	{/if}
</div>
