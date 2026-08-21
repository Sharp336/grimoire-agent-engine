/**
 * Extension-side ownership of `chrome.debugger` attachments.
 *
 * The relay only ever emits a `detach` RPC while it is still alive and a
 * downstream CDP client disconnects (`RelayBridge` cleanup). If the relay
 * process dies first, nobody can send `detach`, so the extension keeps the
 * attachment — and Chrome keeps showing the "started debugging this browser"
 * infobar indefinitely (#8930). The extension is the only party that always
 * outlives the relay, so it must reclaim its own attachments when the relay
 * connection stays down.
 *
 * This guard tracks which tabs the extension attached and schedules a
 * best-effort detach of all of them once the relay has been disconnected for a
 * grace period (a couple of reconnect backoff cycles). Reconnecting cancels the
 * pending sweep. An early detach is safe: the relay reconciles live attachments
 * from the next `hello` (`attachedTabIds`) and re-attaches any tab that still
 * has session holders.
 *
 * Pure and timer-injected so it can be unit-tested without a real Chrome or
 * wall-clock; the extension wires it to `setTimeout`/`clearTimeout` and
 * `chrome.debugger.detach`.
 */

export interface AttachmentGuardOptions<H> {
	/** How long the relay must stay disconnected before orphaned tabs are detached. */
	graceMs: number;
	setTimer: (fn: () => void, ms: number) => H;
	clearTimer: (handle: H) => void;
	/** Detach every listed tab. Never called with an empty list. */
	detachAll: (tabIds: number[]) => void;
}

export class AttachmentGuard<H> {
	readonly #attached = new Set<number>();
	#disconnected = false;
	#pending: H | null = null;

	constructor(private readonly options: AttachmentGuardOptions<H>) {}

	/** Record a tab the extension just attached. */
	track(tabId: number): void {
		this.#attached.add(tabId);
		this.#scheduleSweep();
	}

	/** Forget a tab that has been detached (explicit RPC, user cancel, or navigation). */
	untrack(tabId: number): void {
		this.#attached.delete(tabId);
		if (this.#attached.size === 0) this.#cancel();
	}

	/** Tabs currently believed to hold an extension-owned attachment. */
	attachedTabIds(): number[] {
		return [...this.#attached];
	}

	/** Relay connected (or reconnected): cancel any pending orphan sweep. */
	onConnected(): void {
		this.#disconnected = false;
		this.#cancel();
	}

	/** Relay connection lost: sweep orphaned attachments after the grace period. */
	onDisconnected(): void {
		this.#disconnected = true;
		this.#scheduleSweep();
	}

	/** Service worker suspending: detach immediately so nothing is orphaned. */
	onSuspend(): void {
		this.#cancel();
		this.#sweep();
	}

	#cancel(): void {
		if (this.#pending === null) return;
		this.options.clearTimer(this.#pending);
		this.#pending = null;
	}

	#scheduleSweep(): void {
		if (!this.#disconnected || this.#pending !== null || this.#attached.size === 0) return;
		this.#pending = this.options.setTimer(() => {
			this.#pending = null;
			this.#sweep();
		}, this.options.graceMs);
	}

	#sweep(): void {
		if (this.#attached.size === 0) return;
		const tabIds = [...this.#attached];
		this.#attached.clear();
		this.options.detachAll(tabIds);
	}
}
