import { Editor, type KeyId, matchesKey, parseKittySequence } from "@oh-my-pi/pi-tui";
import type { AppAction } from "../../config/keybindings";

type AppActionHandler = {
	keys: KeyId[];
	handler: () => void;
};

/**
 * Custom editor that dispatches coding-agent app actions before editor defaults.
 */
export class CustomEditor extends Editor {
	onEscape?: () => void;
	shouldBypassAutocompleteOnEscape?: () => boolean;
	onQuestionMark?: () => void;
	onCapsLock?: () => void;
	onAltP?: () => void;

	#appActionHandlers = new Map<AppAction, AppActionHandler>();
	#customKeyHandlers = new Map<KeyId, () => void>();

	setAppActionHandler(action: AppAction, keys: KeyId[], handler: (() => void) | undefined): void {
		if (!handler || keys.length === 0) {
			this.#appActionHandlers.delete(action);
			return;
		}
		this.#appActionHandlers.set(action, { keys, handler });
	}

	removeAppActionHandler(action: AppAction): void {
		this.#appActionHandlers.delete(action);
	}

	clearAppActionHandlers(): void {
		this.#appActionHandlers.clear();
	}

	/**
	 * Register a custom key handler. Extensions use this for shortcuts.
	 */
	setCustomKeyHandler(key: KeyId, handler: () => void): void {
		this.#customKeyHandlers.set(key, handler);
	}

	/**
	 * Remove a custom key handler.
	 */
	removeCustomKeyHandler(key: KeyId): void {
		this.#customKeyHandlers.delete(key);
	}

	/**
	 * Clear all custom key handlers.
	 */
	clearCustomKeyHandlers(): void {
		this.#customKeyHandlers.clear();
	}

	#matchesAnyKey(data: string, keys: KeyId[]): boolean {
		for (const key of keys) {
			if (matchesKey(data, key)) {
				return true;
			}
		}
		return false;
	}

	#handleAppAction(data: string): boolean {
		for (const [action, { keys, handler }] of this.#appActionHandlers) {
			if (!this.#matchesAnyKey(data, keys)) {
				continue;
			}

			// Escape keeps its autocomplete-cancel behavior unless interrupt explicitly wins.
			if (
				action === "interrupt" &&
				(matchesKey(data, "escape") || matchesKey(data, "esc")) &&
				this.isShowingAutocomplete() &&
				!this.shouldBypassAutocompleteOnEscape?.()
			) {
				continue;
			}

			handler();
			return true;
		}

		return false;
	}

	handleInput(data: string): void {
		const parsed = parseKittySequence(data);
		if (parsed && (parsed.modifier & 64) !== 0 && this.onCapsLock) {
			// Caps Lock is modifier bit 64
			this.onCapsLock();
			return;
		}

		if (this.#handleAppAction(data)) {
			return;
		}

		if (matchesKey(data, "alt+p") && this.onAltP) {
			this.onAltP();
			return;
		}

		if (data === "?" && this.getText().length === 0 && this.onQuestionMark) {
			this.onQuestionMark();
			return;
		}

		for (const [keyId, handler] of this.#customKeyHandlers) {
			if (matchesKey(data, keyId)) {
				handler();
				return;
			}
		}

		super.handleInput(data);
	}
}
