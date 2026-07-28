/** Vibe mode session-level state, mirroring {@link ../plan-mode/state.ts}. */
export interface VibeModeState {
	enabled: boolean;
	/**
	 * Pre-vibe enabled toolset captured on enter so it can be restored on exit.
	 * Set by the ACP/RPC `/vibe` handler (which lacks the TUI's private
	 * `#vibeModePreviousTools` field); the TUI path keeps using its own field
	 * and leaves this undefined.
	 */
	previousTools?: string[];
}
