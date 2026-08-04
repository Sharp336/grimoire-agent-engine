import { BrowserContractError } from "../runtime/host";

export const MAX_CHATGPT_BROWSER_TABS = 5;

export interface BrowserLeaseSlot {
	readonly id: string;
	release(): void;
}

export class BrowserLeaseLimiter {
	readonly #active = new Map<string, BrowserLeaseSlot>();

	get activeCount(): number {
		return this.#active.size;
	}

	acquire(id: string): BrowserLeaseSlot {
		if (!id || this.#active.has(id)) {
			throw new BrowserContractError("profile_conflict", "duplicate_browser_lease");
		}
		if (this.#active.size >= MAX_CHATGPT_BROWSER_TABS) {
			throw new BrowserContractError("browser_unavailable", "browser_lease_limit");
		}
		let released = false;
		const slot = Object.freeze({
			id,
			release: (): void => {
				if (released) return;
				released = true;
				if (this.#active.get(id) === slot) this.#active.delete(id);
			},
		});
		this.#active.set(id, slot);
		return slot;
	}

	close(): void {
		for (const slot of [...this.#active.values()]) slot.release();
	}
}
