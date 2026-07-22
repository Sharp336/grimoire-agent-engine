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

	test("extracts a payload whose marker straddles the 8 MiB scan boundary", () => {
		// The scanner reads 8 MiB windows with a marker-length overlap so a
		// marker split across two windows is still found, and the payload read
		// starts at the right absolute offset whichever window carried the
		// marker. Pad a comment block so `="AGFzbQ` starts four bytes before
		// the boundary: the first window ends mid-marker and the payload runs
		// past it.
		const SCAN_CHUNK = 8 * 1024 * 1024;
		const payload = UNKNOWN_MODULE_BYTES;
		const base64 = payload.toString("base64");
		const markerStart = SCAN_CHUNK - 4;
		const pad = markerStart - "/*".length - "*/var agB".length;
		const content = `/*${"x".repeat(pad)}*/var agB="${base64}";`;
		expect(content.indexOf('="AGFzbQ')).toBe(markerStart);
		expect(markerStart + '="AGFzbQ'.length).toBeGreaterThan(SCAN_CHUNK);
		const straddling = path.join(tempDir, "qoder-worker-runtime.mjs");
		fs.writeFileSync(straddling, content);
		const extracted = extractQoderEmbeddedPayload(straddling);
		expect(extracted).not.toBeNull();
		expect(Buffer.compare(extracted as Buffer, payload)).toBe(0);
	});

	test("gives up on a payload whose base64 exceeds the 1 MiB hunt bound", () => {
		// The closing-quote hunt is bounded by MAX_PAYLOAD_BASE64_BYTES (1
		// MiB); a payload section longer than that must yield null — never an
		// unbounded read or a partial decode — and must not be accepted.
		const MAX_BASE64 = 1024 * 1024;
		const oversize = `var agB="AGFzbQ${"A".repeat(MAX_BASE64)}";`;
		const file = path.join(tempDir, "qoder-worker-runtime.mjs");
		fs.writeFileSync(file, oversize);
		expect(extractQoderEmbeddedPayload(file)).toBeNull();
		expect(locateKnownGoodQoderWasm([file])).toBe(false);
	});

	test("extracts the newest qodercli candidate and fails closed on its unknown hash", () => {
		// A qodercli bin dir holds one file per version; the locator must
		// extract the embedded payload from the file carrying one, find
		// nothing in the garbage siblings, and — walking the whole candidate
		// list — still fail closed: magic in the newest candidate never
		// satisfies the hash gate.
		// Seam note: the version comparator and directory enumeration are
		// module-private, and no-arg discovery also scans ~/.qoder (machine
		// state), so newest-first ordering itself has no hermetic seam; it is
		// not asserted here.
		const binDir = path.join(tempDir, "bin", "qodercli");
		fs.mkdirSync(binDir, { recursive: true });
		const payload = UNKNOWN_MODULE_BYTES;
		for (const name of ["qodercli-1.8.0", "qodercli-1.9.0"]) {
			fs.writeFileSync(path.join(binDir, name), "definitely not a wasm module");
		}
		const newest = path.join(binDir, "qodercli-1.10.0");
		fs.writeFileSync(newest, `var agB="${payload.toString("base64")}";`);
		const candidates: [string, string, string] = [
			newest,
			path.join(binDir, "qodercli-1.9.0"),
			path.join(binDir, "qodercli-1.8.0"),
		];
		const extracted = extractQoderEmbeddedPayload(candidates[0]);
		expect(extracted).not.toBeNull();
		expect(Buffer.compare(extracted as Buffer, payload)).toBe(0);
		expect(extractQoderEmbeddedPayload(candidates[1])).toBeNull();
		expect(locateKnownGoodQoderWasm(candidates)).toBe(false);
	});
});
