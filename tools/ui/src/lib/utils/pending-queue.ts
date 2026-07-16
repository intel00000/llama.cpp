import { uuid } from '$lib/utils/uuid';

export interface PendingEntry {
	id: string;
	content: string;
	extras?: DatabaseMessageExtra[];
	kind: 'held' | 'parked' | 'queued';
}

/**
 * Per-conversation pending-message state machine.
 *
 *  - held:   the send in flight behind a pre-send compaction; dispatched only
 *            by its owning flow (takeHeld) and immune to Stop cleanup.
 *  - parked: stranded (conversation switch); manual bubble actions only.
 *  - queued: auto-dispatched when the active stream completes; a Stop while
 *            streaming deliberately cancels these.
 *
 * The bubble UI renders and acts on the head entry; hold() inserts at the head
 * so the in-flight message is the one displayed. The backing map is supplied by
 * the caller (the chat store passes a SvelteMap for reactivity).
 */
export class PendingMessageQueue {
	constructor(private store: Map<string, PendingEntry[]>) {}

	private set(convId: string, list: PendingEntry[]): void {
		if (list.length === 0) this.store.delete(convId);
		else this.store.set(convId, list);
	}

	has(convId: string): boolean {
		return (this.store.get(convId)?.length ?? 0) > 0;
	}

	head(convId: string): PendingEntry | null {
		return this.store.get(convId)?.[0] ?? null;
	}

	/** Hold the in-flight send at the head; returns the handle for takeHeld. */
	hold(convId: string, content: string, extras?: DatabaseMessageExtra[]): string {
		const id = uuid();
		const list = this.store.get(convId) ?? [];
		this.set(convId, [{ id, content, extras, kind: 'held' }, ...list]);
		return id;
	}

	park(convId: string, content: string, extras?: DatabaseMessageExtra[]): void {
		const list = this.store.get(convId) ?? [];
		this.set(convId, [...list, { id: uuid(), content, extras, kind: 'parked' }]);
	}

	enqueue(convId: string, content: string, extras?: DatabaseMessageExtra[]): void {
		const list = this.store.get(convId) ?? [];
		this.set(convId, [...list, { id: uuid(), content, extras, kind: 'queued' }]);
	}

	/** Remove and return a held entry by handle - null when the user deleted it. */
	takeHeld(convId: string, id: string): PendingEntry | null {
		const list = this.store.get(convId) ?? [];
		const entry = list.find((m) => m.id === id && m.kind === 'held');
		if (!entry) return null;
		this.set(
			convId,
			list.filter((m) => m.id !== id)
		);
		return entry;
	}

	/** Remove and return the first queued entry; held and parked never auto-dispatch. */
	takeNextQueued(convId: string): PendingEntry | null {
		const list = this.store.get(convId) ?? [];
		const entry = list.find((m) => m.kind === 'queued');
		if (!entry) return null;
		this.set(
			convId,
			list.filter((m) => m.id !== entry.id)
		);
		return entry;
	}

	/** Remove and return the head entry regardless of kind - explicit user action. */
	takeHead(convId: string): PendingEntry | null {
		const list = this.store.get(convId) ?? [];
		const entry = list[0];
		if (!entry) return null;
		this.set(convId, list.slice(1));
		return entry;
	}

	/** Replace the head entry in place (bubble Edit), keeping its id and kind. */
	replaceHead(convId: string, content: string, extras?: DatabaseMessageExtra[]): void {
		const list = this.store.get(convId);
		if (!list || list.length === 0) {
			this.park(convId, content, extras);
			return;
		}
		this.set(convId, [{ ...list[0], content, extras }, ...list.slice(1)]);
	}

	/** Drop the head entry (bubble Delete); a dropped held entry cancels its send. */
	dropHead(convId: string): void {
		const list = this.store.get(convId) ?? [];
		this.set(convId, list.slice(1));
	}

	/** Promote the parked head for dispatch; held entries keep Stop-immunity. */
	promoteParked(convId: string): void {
		const list = this.store.get(convId) ?? [];
		this.set(
			convId,
			list.map((m, i) => (i === 0 && m.kind === 'parked' ? { ...m, kind: 'queued' } : m))
		);
	}

	/** Drop queued entries on stream stop; held and parked entries survive. */
	clearQueued(convId: string): void {
		const list = this.store.get(convId) ?? [];
		this.set(
			convId,
			list.filter((m) => m.kind !== 'queued')
		);
	}
}
