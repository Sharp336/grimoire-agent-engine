/** Vibe mode session-level state, mirroring {@link ../plan-mode/state.ts}. */
export interface VibeModeState {
	enabled: boolean;
	/**
	 * Pre-vibe enabled toolset captured on enter so it can be restored on exit.
	 * Both the ACP/RPC `/vibe` handler and the TUI path populate this from
	 * `session.getEnabledToolNames()`, so the exit path's `?? []` fallback is
	 * purely defensive. The TUI also mirrors the value in its private
	 * `#vibeModePreviousTools` field for session-switch reconciliation.
	 */
	previousTools?: string[];
}
