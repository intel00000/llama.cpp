import { describe, it, expect } from 'vitest';
import { PendingMessageQueue } from '$lib/utils/pending-queue';

/**
 * Tests for PendingMessageQueue - the pending-message state machine behind the
 * chat store. Three kinds with distinct lifecycles:
 *  - held:   the send in flight behind a pre-send compaction; dispatched only by
 *            its owning flow (takeHeld) and immune to Stop cleanup.
 *  - parked: stranded (conversation switch); manual bubble actions only.
 *  - queued: auto-dispatched when the active stream completes; a Stop while
 *            streaming deliberately cancels these.
 */

function queue() {
	return new PendingMessageQueue(new Map());
}

describe('PendingMessageQueue', () => {
	it('hold inserts at the head so the bubble shows the in-flight message', () => {
		const q = queue();
		q.park('c1', 'stranded');
		const id = q.hold('c1', 'in-flight');
		expect(q.head('c1')?.id).toBe(id);
		expect(q.head('c1')?.content).toBe('in-flight');
	});

	it('dropping the held head cancels the in-flight send (takeHeld misses)', () => {
		const q = queue();
		const id = q.hold('c1', 'in-flight');
		q.dropHead('c1');
		expect(q.takeHeld('c1', id)).toBeNull();
	});

	it('replaceHead keeps id and kind so the owning flow picks up the edit', () => {
		const q = queue();
		const id = q.hold('c1', 'typo');
		q.replaceHead('c1', 'fixed');
		const taken = q.takeHeld('c1', id);
		expect(taken?.content).toBe('fixed');
	});

	it('promoteParked never touches a held entry', () => {
		const q = queue();
		const id = q.hold('c1', 'in-flight');
		q.promoteParked('c1');
		q.clearQueued('c1');
		expect(q.takeHeld('c1', id)?.content).toBe('in-flight');
	});

	it('promoteParked turns the parked head into a queued entry', () => {
		const q = queue();
		q.park('c1', 'stranded');
		q.promoteParked('c1');
		expect(q.takeNextQueued('c1')?.content).toBe('stranded');
	});

	it('clearQueued drops queued entries only', () => {
		const q = queue();
		const id = q.hold('c1', 'in-flight');
		q.park('c1', 'stranded');
		q.enqueue('c1', 'follow-up');
		q.clearQueued('c1');
		expect(q.takeNextQueued('c1')).toBeNull();
		expect(q.takeHeld('c1', id)).not.toBeNull();
		expect(q.head('c1')?.content).toBe('stranded');
	});

	it('takeNextQueued skips held and parked entries', () => {
		const q = queue();
		q.hold('c1', 'in-flight');
		q.park('c1', 'stranded');
		q.enqueue('c1', 'follow-up');
		expect(q.takeNextQueued('c1')?.content).toBe('follow-up');
		expect(q.takeNextQueued('c1')).toBeNull();
	});

	it('takeHead takes any kind (explicit user action)', () => {
		const q = queue();
		q.park('c1', 'stranded');
		expect(q.takeHead('c1')?.content).toBe('stranded');
		expect(q.has('c1')).toBe(false);
	});

	it('park re-inserts an entry for a conversation that is no longer active', () => {
		const q = queue();
		q.enqueue('c1', 'follow-up');
		const taken = q.takeNextQueued('c1')!;
		q.park('c1', taken.content, taken.extras);
		expect(q.head('c1')?.kind).toBe('parked');
	});

	it('conversations are independent and empty lists are removed', () => {
		const q = queue();
		q.enqueue('c1', 'a');
		q.enqueue('c2', 'b');
		q.takeNextQueued('c1');
		expect(q.has('c1')).toBe(false);
		expect(q.has('c2')).toBe(true);
	});
});
