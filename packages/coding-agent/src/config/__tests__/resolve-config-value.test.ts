import { beforeEach, describe, expect, it, mock } from "bun:test";

// Mock @oh-my-pi/pi-natives before importing the module under test.
// We provide a controllable executeShell so tests don't require native bindings.
const executeShellMock = mock(
	(_opts: { command: string; timeoutMs: number }, cb: (err: unknown, chunk: string) => void) => {
		// Default: simulate a successful shell command that writes to stdout.
		cb(null, "mocked-output\n");
		return Promise.resolve({ timedOut: false, exitCode: 0 });
	},
);

mock.module("@oh-my-pi/pi-natives", () => ({
	executeShell: executeShellMock,
}));

// Must import after mocking.
const { ConfigSource, resolveConfigValue, resolveHeaders, clearConfigValueCache } = await import(
	"../resolve-config-value"
);

beforeEach(() => {
	clearConfigValueCache();
	executeShellMock.mockClear();
});

describe("resolveConfigValue", () => {
	it("allows !-prefix shell execution for ConfigSource.User", async () => {
		executeShellMock.mockImplementation(
			(_opts: { command: string; timeoutMs: number }, cb: (err: unknown, chunk: string) => void) => {
				cb(null, "hello\n");
				return Promise.resolve({ timedOut: false, exitCode: 0 });
			},
		);

		const result = await resolveConfigValue("!echo hello", ConfigSource.User);
		expect(result).toBe("hello");
	});

	it("rejects !-prefix shell execution for ConfigSource.Project", async () => {
		await expect(resolveConfigValue("!echo hello", ConfigSource.Project)).rejects.toThrow("not allowed");
		expect(executeShellMock.mock.calls.length).toBe(0);
	});

	it("still resolves environment variables for ConfigSource.Project", async () => {
		const key = "TEST_RESOLVE_CONFIG_VALUE_ENV_VAR";
		process.env[key] = "from-env";
		try {
			const result = await resolveConfigValue(key, ConfigSource.Project);
			expect(result).toBe("from-env");
		} finally {
			delete process.env[key];
		}
	});

	it("returns literal values unchanged for ConfigSource.Project", async () => {
		const result = await resolveConfigValue("literal-value", ConfigSource.Project);
		expect(result).toBe("literal-value");
	});

	it("defaults to ConfigSource.User when source is omitted", async () => {
		executeShellMock.mockImplementation(
			(_opts: { command: string; timeoutMs: number }, cb: (err: unknown, chunk: string) => void) => {
				cb(null, "default-user\n");
				return Promise.resolve({ timedOut: false, exitCode: 0 });
			},
		);

		const result = await resolveConfigValue("!echo default-user");
		expect(result).toBe("default-user");
	});
});

describe("resolveHeaders", () => {
	it("propagates ConfigSource.Project to reject !-prefix headers", async () => {
		await expect(resolveHeaders({ "x-key": "!echo val" }, ConfigSource.Project)).rejects.toThrow("not allowed");
		expect(executeShellMock.mock.calls.length).toBe(0);
	});

	it("resolves literal headers for ConfigSource.Project", async () => {
		const result = await resolveHeaders({ "x-key": "val" }, ConfigSource.Project);
		expect(result).toEqual({ "x-key": "val" });
	});

	it("allows !-prefix headers for ConfigSource.User", async () => {
		executeShellMock.mockImplementation(
			(_opts: { command: string; timeoutMs: number }, cb: (err: unknown, chunk: string) => void) => {
				cb(null, "resolved-header\n");
				return Promise.resolve({ timedOut: false, exitCode: 0 });
			},
		);

		const result = await resolveHeaders({ "x-key": "!echo resolved-header" }, ConfigSource.User);
		expect(result).toEqual({ "x-key": "resolved-header" });
	});

	it("returns undefined for undefined headers", async () => {
		const result = await resolveHeaders(undefined, ConfigSource.Project);
		expect(result).toBeUndefined();
	});
});
