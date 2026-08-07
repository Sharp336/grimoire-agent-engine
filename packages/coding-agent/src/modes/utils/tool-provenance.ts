/**
 * Resolve whether a session's tool registry entry for `name` came from a
 * built-in factory, tolerating implementations that cannot answer.
 *
 * Real sessions (`AgentSession`) answer from their tool-registry provenance
 * (`#builtInToolNames`), so a same-named custom/extension tool never claims
 * the built-in renderer while native built-ins keep theirs. Lightweight
 * view-session implementations (test doubles, read-only hosts) may omit
 * `hasBuiltInTool` entirely; they fall back to the pre-provenance default of
 * allowing the built-in renderer (mirroring `ChatTranscriptBuilder`'s
 * `isBuiltInTool?.(name) ?? true`), so a rebuild renders replayed tool
 * output the same way it rendered live.
 */

/** Minimal structural contract for querying tool provenance on a session-like object. */
export interface ToolProvenanceSource {
	/** Whether the named tool was registered by a built-in factory. */
	hasBuiltInTool?(name: string): boolean;
}

/**
 * True when the named tool is built-in — proven by the session, or assumed
 * when the source cannot answer. A source without `hasBuiltInTool` yields
 * the default instead of crashing, so partial view-session implementations
 * can drive the render path without implementing the full session surface.
 */
export function isBuiltInTool(session: ToolProvenanceSource, name: string): boolean {
	return session.hasBuiltInTool?.(name) ?? true;
}
