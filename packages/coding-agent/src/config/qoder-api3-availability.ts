/**
 * Qoder api3 availability gate.
 *
 * Qoder's api3 transport authenticates requests with a WASM signature, so the
 * six api3-only model families (cmodel, qmodel_preview, qmodel_latest,
 * kmodel_latest, gm51model, dfmodel, plus their context aliases) are usable
 * only when the user's installed qodercli auth WASM can be located and
 * hash-verified. Detection itself lives in pi-ai's bridge
 * (`@oh-my-pi/pi-ai/oauth/qoder-wasm`, memoized, fail-closed); this module is
 * the model-list half: drop the api3 rows when the bridge is unavailable,
 * leaving the legacy nine-family surface. Nothing here throws.
 *
 * `setQoderWasmBridgeAvailabilityForTests` overrides detection for hermetic
 * registry tests; locator/hash contract tests live beside the bridge in
 * packages/ai/test/qoder-wasm-locator.test.ts.
 */
import { hasQoderWasmBridge as detectQoderWasmBridge } from "@oh-my-pi/pi-ai/oauth/qoder-wasm";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";

/** Gate-local test override: `undefined` = real detection via the pi-ai bridge. */
let availabilityForTests: boolean | undefined;

/**
 * Whether a known-good Qoder auth WASM is available on this install. Lazy
 * (first call detects via the pi-ai bridge), cached for the process lifetime,
 * never throws.
 */
export function hasQoderWasmBridge(): boolean {
	return availabilityForTests ?? detectQoderWasmBridge();
}

/**
 * Test hook: force availability (`undefined` restores real detection).
 * Registry tests drive the gate through this; the locator itself is tested
 * against the bridge's parameterized seam, not through this module.
 */
export function setQoderWasmBridgeAvailabilityForTests(available: boolean | undefined): void {
	availabilityForTests = available;
}

/**
 * The api3 gate on the effective model list: identity when no api3 rows are
 * present or the bridge is available; otherwise drops every Qoder row whose
 * compat carries `api3: true` (the six api3-only bases and their aliases),
 * leaving the legacy nine-family surface. Runs once per registry load/refresh;
 * the per-row check is flag-only (materialized by `buildModel`, never detected
 * here).
 */
export function dropUnavailableQoderApi3Models(models: Model<Api>[]): Model<Api>[] {
	let gated = false;
	for (const model of models) {
		if (model.provider !== "qoder") continue;
		const compat = model.compat;
		if (typeof compat === "object" && compat !== null && "api3" in compat && compat.api3 === true) {
			gated = true;
			break;
		}
	}
	if (!gated || hasQoderWasmBridge()) return models;
	return models.filter(model => {
		if (model.provider !== "qoder") return true;
		const compat = model.compat;
		return !(typeof compat === "object" && compat !== null && "api3" in compat && compat.api3 === true);
	});
}
