/**
 * Qoder api3 availability gate.
 *
 * Qoder's api3 transport authenticates requests with a WASM signature, so the
 * six api3-only model families (cmodel, qmodel_preview, qmodel_latest,
 * kmodel_latest, gm51model, dfmodel, plus their context aliases) are usable
 * only when a known-good auth WASM can be located and hash-verified. The
 * registry gate uses pi-ai's pure locator, which may warm the verified-byte
 * cache but never instantiates the module; bridge instantiation stays deferred
 * until the first api3 request.
 * Unavailable installs drop api3 rows, leaving the legacy nine-family surface.
 *
 * `setQoderWasmBridgeAvailabilityForTests` overrides detection for hermetic
 * registry tests; locator/hash contract tests live beside the bridge in
 * packages/ai/test/qoder-wasm-locator.test.ts.
 */
import { locateKnownGoodQoderWasm } from "@oh-my-pi/pi-ai/oauth/qoder-wasm";
import { type Api, isQoderApi3Model, type Model } from "@oh-my-pi/pi-ai/types";

/** Gate-local test override: `undefined` = real detection via the pi-ai bridge. */
let availabilityForTests: boolean | undefined;
let detectedAvailability: boolean | undefined;

/**
 * Whether a known-good Qoder auth WASM is available on this install. The first
 * call may scan and cache verified bytes; later registry refreshes reuse the
 * process-local result. Bridge instantiation remains deferred until api3
 * dispatch.
 */
export function hasQoderWasmBridge(): boolean {
	if (availabilityForTests !== undefined) return availabilityForTests;
	if (detectedAvailability === undefined) detectedAvailability = locateKnownGoodQoderWasm();
	return detectedAvailability;
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
	if (!models.some(isQoderApi3Model) || hasQoderWasmBridge()) return models;
	return models.filter(model => !isQoderApi3Model(model));
}
