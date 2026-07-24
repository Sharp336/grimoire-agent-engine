const CLINEPASS_WIRE_PREFIX = "cline-pass/";

/**
 * ClinePass (Cline's flat-rate subscription gateway at `api.cline.bot`) namespaces
 * every model under a `cline-pass/` prefix on the wire (`cline-pass/glm-5.2`,
 * `cline-pass/deepseek-v4-pro`, …). We keep the friendly bare public id
 * (`glm-5.2`) in the catalog — so selection stays `clinepass/glm-5.2` rather than
 * the doubled `clinepass/cline-pass/glm-5.2` — and translate to the wire form at
 * request time via `wireModelIdMode: "clinepass"`. Idempotent: a value that
 * already carries the prefix is returned unchanged.
 */
export function toClinepassWireModelId(modelId: string): string {
	return modelId.startsWith(CLINEPASS_WIRE_PREFIX) ? modelId : `${CLINEPASS_WIRE_PREFIX}${modelId}`;
}

/** Strip the `cline-pass/` wire prefix to recover the friendly public id. */
export function toClinepassPublicModelId(modelId: string): string {
	return modelId.startsWith(CLINEPASS_WIRE_PREFIX) ? modelId.slice(CLINEPASS_WIRE_PREFIX.length) : modelId;
}
