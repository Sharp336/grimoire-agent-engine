import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractQoderEmbeddedPayload, locateKnownGoodQoderWasm } from "@oh-my-pi/pi-ai/oauth/qoder-wasm";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Hermetic contract tests for the api3 auth-WASM locator. The pure
 * `locateKnownGoodQoderWasm(candidates)` seam never touches the production
 * cache or the machine's real discovery list, and extraction is asserted
 * byte-exact through the hash-agnostic `extractQoderEmbeddedPayload` seam, so
 * these run identically everywhere with no env mutation. Known-good-hash
 * ACCEPTANCE is deliberately not unit-tested: the allowlist pins Qoder's real
 * module and must not be injectable; the acceptance path is covered by the
 * live provider smoke instead.
 */
describe("Qoder WASM locator", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-test-qoder-wasm-locator-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	/** A valid-magic wasm payload that is NOT Qoder's auth module. */
	const UNKNOWN_MODULE_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 1, 2, 3, 4]);

	test("fails closed when no candidate exists", () => {
		expect(locateKnownGoodQoderWasm([])).toBe(false);
	});

	test("fails closed on a non-wasm candidate", () => {
		const garbage = path.join(tempDir, "garbage.bin");
		fs.writeFileSync(garbage, "definitely not a wasm module");
		expect(locateKnownGoodQoderWasm([garbage])).toBe(false);
	});

	test("extracts the embedded payload byte-exactly", () => {
		// The bundle/binary embedding shape: a minified JS module whose string
		// literal carries the base64 payload right after the `="AGFzbQ` marker.
		const payload = UNKNOWN_MODULE_BYTES;
		const fakeBundle = path.join(tempDir, "qoder-worker-runtime.mjs");
		fs.writeFileSync(fakeBundle, `var agB="${payload.toString("base64")}";export default agB;`);
		const extracted = extractQoderEmbeddedPayload(fakeBundle);
		expect(extracted).not.toBeNull();
		expect(Buffer.compare(extracted as Buffer, payload)).toBe(0);
	});

	test("rejects an extracted payload whose hash is not in the known-good set", () => {
		// Extraction succeeding (proven above) must never imply acceptance:
		// magic alone does not satisfy the gate.
		const payload = UNKNOWN_MODULE_BYTES;
		const fakeBundle = path.join(tempDir, "qoder-worker-runtime.mjs");
		fs.writeFileSync(fakeBundle, `var agB="${payload.toString("base64")}";export default agB;`);
		expect(locateKnownGoodQoderWasm([fakeBundle])).toBe(false);
	});

	test("rejects a direct-magic module whose hash is not in the known-good set", () => {
		const unknown = path.join(tempDir, "unknown.wasm");
		fs.writeFileSync(unknown, UNKNOWN_MODULE_BYTES);
		expect(locateKnownGoodQoderWasm([unknown])).toBe(false);
	});
});
