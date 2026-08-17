import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	loadRemoteRuntimeConfig,
	parseRemoteRuntimeConfig,
	REMOTE_RUNTIME_PROTOCOL_VERSION,
} from "@oh-my-pi/pi-coding-agent/remote-runtime/config";
import { TempDir } from "@oh-my-pi/pi-utils";

function validConfig(): Record<string, unknown> {
	return {
		version: REMOTE_RUNTIME_PROTOCOL_VERSION,
		socketPath: "/var/run/omp-runtime.sock",
		controllerId: "controller-a",
		executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		rootExecutionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		parentExecutionId: null,
		assignmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		depth: 0,
		revision: "a".repeat(40),
		grantId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
		policyDigest: `sha256:${"b".repeat(64)}`,
		budgetRef: "budget:root-1",
		schemaRef: "schema:root-1",
		requestTimeoutMs: 5_000,
	};
}

describe("sealed remote runtime config", () => {
	it("parses the single explicit CLI descriptor without environment inference", () => {
		const parsed = parseArgs(["--remote-runtime-config", "/tmp/runtime.json", "work"]);
		expect(parsed.remoteRuntimeConfig).toBe("/tmp/runtime.json");
		expect(parsed.messages).toEqual(["work"]);
		expect(parseArgs([]).remoteRuntimeConfig).toBeUndefined();
	});

	it("freezes a complete bounded authority descriptor", () => {
		const config = parseRemoteRuntimeConfig(validConfig());
		expect(Object.isFrozen(config)).toBe(true);
		expect(config.revision).toBe("a".repeat(40));
		expect(config.policyDigest).toBe(`sha256:${"b".repeat(64)}`);
	});

	it("rejects partial and unknown credential-bearing config", () => {
		const partial = validConfig();
		delete partial.grantId;
		expect(() => parseRemoteRuntimeConfig(partial)).toThrow("missing required field grantId");
		expect(() => parseRemoteRuntimeConfig({ ...validConfig(), token: "do-not-admit" })).toThrow("unknown fields");
		let failure: unknown;
		try {
			parseRemoteRuntimeConfig({ ...validConfig(), "/Users/private/token": "secret" });
		} catch (error) {
			failure = error;
		}
		expect(String(failure)).toContain("unknown fields");
		expect(String(failure)).not.toContain("/Users/private");
		expect(String(failure)).not.toContain("secret");
	});

	it("rejects relative, NUL, Windows-style, and overlong socket paths", () => {
		for (const socketPath of ["runtime.sock", "/tmp/runtime\0.sock", "C:\\runtime.sock", `/${"x".repeat(101)}`]) {
			expect(() => parseRemoteRuntimeConfig({ ...validConfig(), socketPath })).toThrow();
		}
	});

	it("rejects relative and NUL descriptor paths before filesystem access", async () => {
		await expect(loadRemoteRuntimeConfig("runtime.json")).rejects.toThrow("absolute Unix path");
		await expect(loadRemoteRuntimeConfig("/tmp/runtime\u0000.json")).rejects.toThrow("absolute Unix path");
	});

	it.skipIf(process.platform === "win32")("requires a current-user-owned private descriptor", async () => {
		using tempDir = TempDir.createSync("@omp-remote-config-");
		const configPath = path.join(tempDir.path(), "runtime.json");
		await fs.writeFile(configPath, JSON.stringify(validConfig()), { mode: 0o600 });
		expect((await loadRemoteRuntimeConfig(configPath)).executionId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
		for (const mode of [0o640, 0o644]) {
			await fs.chmod(configPath, mode);
			await expect(loadRemoteRuntimeConfig(configPath)).rejects.toThrow("current-user-owned, private");
		}
	});

	it("rejects mutable revisions, malformed digests and ULIDs, and inconsistent lineage", () => {
		expect(() => parseRemoteRuntimeConfig({ ...validConfig(), revision: "main" })).toThrow("immutable");
		expect(() => parseRemoteRuntimeConfig({ ...validConfig(), policyDigest: "sha256:not-a-digest" })).toThrow(
			"SHA-256",
		);
		expect(() => parseRemoteRuntimeConfig({ ...validConfig(), executionId: "execution-a" })).toThrow("ULID");
		expect(() =>
			parseRemoteRuntimeConfig({
				...validConfig(),
				depth: 1,
				parentExecutionId: null,
			}),
		).toThrow("requires parentExecutionId");
	});

	it("rejects unbounded timeouts and non-logical schema or budget references", () => {
		expect(() => parseRemoteRuntimeConfig({ ...validConfig(), requestTimeoutMs: 0 })).toThrow("between 100");
		expect(() => parseRemoteRuntimeConfig({ ...validConfig(), budgetRef: "/private/budget.json" })).toThrow(
			"logical reference",
		);
		expect(() => parseRemoteRuntimeConfig({ ...validConfig(), schemaRef: "../schema.json" })).toThrow(
			"logical reference",
		);
	});
});
