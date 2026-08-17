import { describe, expect, it } from "bun:test";
import {
	DEFAULT_ANTIGRAVITY_VERSION,
	getAntigravityUserAgent,
	getAntigravityVersion,
	parseAntigravityManifestVersion,
} from "../src/wire/gemini-headers";

describe("antigravity User-Agent wire parity", () => {
	it("generates exact decompiled Hub format: os_type -> arch -> aidev_client -> cl -> auth_method=oauth", () => {
		const ua = getAntigravityUserAgent();
		expect(ua).toBe(
			`antigravity/hub/${DEFAULT_ANTIGRAVITY_VERSION} (os_type=darwin; arch=arm64; aidev_client; cl=963137146; auth_method=oauth)`,
		);
	});

	it("honors env overrides for version, cl, os, and arch", () => {
		const origEnv = { ...process.env };
		try {
			process.env.PI_AI_ANTIGRAVITY_VERSION = "2.9.0";
			process.env.PI_AI_ANTIGRAVITY_OS = "windows";
			process.env.PI_AI_ANTIGRAVITY_ARCH = "amd64";
			process.env.PI_AI_ANTIGRAVITY_CL = "999888777";

			expect(getAntigravityVersion()).toBe("2.9.0");
			expect(getAntigravityUserAgent()).toBe(
				"antigravity/hub/2.9.0 (os_type=windows; arch=amd64; aidev_client; cl=999888777; auth_method=oauth)",
			);
		} finally {
			process.env = origEnv;
		}
	});

	it("parses version correctly from update manifest YAML", () => {
		expect(parseAntigravityManifestVersion("version: 2.8.1\nfiles: []")).toBe("2.8.1");
		expect(parseAntigravityManifestVersion("version: '2.8.1'\n")).toBe("2.8.1");
		expect(parseAntigravityManifestVersion('version: "2.8.1"\n')).toBe("2.8.1");
		expect(parseAntigravityManifestVersion("invalid yaml")).toBeNull();
	});
});
