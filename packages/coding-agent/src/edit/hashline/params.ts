/**
 * Arktype schema for the `edit` tool's hashline mode payload. The schema is
 * deliberately permissive (allows extra keys) so providers can attach extra
 * keys without rejection; only `input` is required. `_input` is accepted as a
 * provider-emitted alias for `input`.
 */
import { type } from "arktype";

const requiredInputSchema = type({ input: "string" });
// Declare only `input` so the JSON schema the model sees exposes a single
// field. `_input` is accepted as an undeclared extra key (ArkType allows
// extra keys by default) and promoted to `input` by the morph below — keeping
// the alias invisible to the model and out of strict-mode `required`/nullable
// wrapping. Declaring `_input?` here would surface it as a second required
// nullable property after strict normalization, confusing models (notably
// GLM-5.x via OpenRouter) into emitting `input: null` and burning cycles.
const inputAliasSchema = type({ "input?": "string" });

export const hashlineEditParamsSchema = inputAliasSchema
	.pipe(raw => {
		if (raw.input !== undefined || raw._input === undefined) return raw;
		return { ...raw, input: raw._input };
	})
	.pipe(requiredInputSchema);

export type HashlineParams = Parameters<typeof hashlineEditParamsSchema.assert>[0];
