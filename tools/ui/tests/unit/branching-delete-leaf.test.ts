import { describe, it, expect } from 'vitest';
import { replacementLeafAfterDelete } from '$lib/utils/branching';
import { MessageRole, MessageType } from '$lib/enums';
import type { DatabaseMessage } from '$lib/types';

/**
 * Tests for replacementLeafAfterDelete - the currNode a cascade delete must fall
 * back to. It must be computed on the POST-delete tree: resolving a leaf on the
 * pre-delete tree can descend into the doomed subtree and persist a dangling
 * currNode, which the next send then uses as a parent ("Parent message not found").
 */

const store: DatabaseMessage[] = [];

function add(
	msg: Partial<DatabaseMessage> & { role: MessageRole; type: MessageType },
	parentId: string | null,
	timestamp: number
): DatabaseMessage {
	const node: DatabaseMessage = {
		id: msg.content ? String(msg.content) : `m${store.length + 1}`,
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

/** root -> sys -> u1 -> a1 -> u2 -> a2 */
function base() {
	store.length = 0;
	add({ role: MessageRole.USER, type: MessageType.ROOT, id: 'root' }, null, 10);
	add({ role: MessageRole.SYSTEM, type: MessageType.TEXT, content: 'sys' }, 'root', 20);
	add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u1' }, 'sys', 30);
	add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a1' }, 'u1', 40);
	add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u2' }, 'a1', 50);
	add({ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a2' }, 'u2', 60);
}

describe('replacementLeafAfterDelete', () => {
	it('deleting the last message with no siblings falls back to its parent, not a doomed id', () => {
		base();
		expect(replacementLeafAfterDelete(store, 'a2')).toBe('u2');
	});

	it('the doomed subtree is excluded even when it hangs deeper', () => {
		base();
		// A recap hangs off the leaf: deleting a2 dooms the recap too; the pre-delete
		// walk u2 -> a2 -> recap would land exactly on the doomed recap node.
		add({ role: MessageRole.USER, type: MessageType.COMPACTION, id: 'R' }, 'a2', 55);
		expect(replacementLeafAfterDelete(store, 'a2')).toBe('u2');
	});

	it('prefers the latest surviving sibling and resolves to its leaf', () => {
		base();
		const a2b = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a2b' },
			'u2',
			70
		);
		add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u3' }, a2b.id, 80);
		expect(replacementLeafAfterDelete(store, 'a2')).toBe('u3');
	});

	it('a doomed last child does not stop descent into a surviving earlier sibling branch', () => {
		base();
		// u2's children become [a2, a2b]; deleting a2b must resolve through a2's subtree.
		const a2b = add(
			{ role: MessageRole.ASSISTANT, type: MessageType.TEXT, content: 'a2b' },
			'u2',
			70
		);
		add({ role: MessageRole.USER, type: MessageType.TEXT, content: 'u3' }, 'a2', 80);
		expect(replacementLeafAfterDelete(store, a2b.id)).toBe('u3');
	});

	it('returns null for a message with no parent', () => {
		base();
		expect(replacementLeafAfterDelete(store, 'root')).toBeNull();
	});
});
