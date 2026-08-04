import type { ModelSpec, ResolvedCommandCodeCompat } from "../types";

/**
 * Resolve command-code compat. The Command Code gateway only accepts
 * `params.reasoning_effort` for models that publish an authored effort ladder
 * (CLI `EFFORTS_BY_MODEL` / `/effort`). Reasoning models without that ladder
 * (e.g. Qwen 3.7 Plus, Kimi K2.7 Code) still stream thinking tokens, but the
 * dial is absent — "Default" omits the wire field. Never fabricate an effort
 * ladder from identity for these models.
 */
export function buildCommandCodeCompat(_spec: ModelSpec<"command-code">): ResolvedCommandCodeCompat {
	return { trustExplicitThinkingOnly: true };
}
