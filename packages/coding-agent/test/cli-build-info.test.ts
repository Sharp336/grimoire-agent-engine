import { afterEach, describe, expect, it, vi } from "bun:test";
import { runCli } from "../src/cli";

const SOURCE_COMMIT = "a".repeat(40);

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

describe("--build-info", () => {
	const originalSourceCommit = process.env.PI_SOURCE_COMMIT;
	const originalCompiled = process.env.PI_COMPILED;
	const originalExitCode = process.exitCode;

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv("PI_SOURCE_COMMIT", originalSourceCommit);
		restoreEnv("PI_COMPILED", originalCompiled);
		process.exitCode = originalExitCode ?? 0;
	});

	it("rejects a source run even when its environment names a valid commit", async () => {
		process.env.PI_SOURCE_COMMIT = SOURCE_COMMIT;
		process.env.PI_COMPILED = "true";
		process.exitCode = 0;
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runCli(["--build-info"]);

		expect(process.exitCode).toBe(1);
		expect(stdout).not.toHaveBeenCalled();
		expect(stderr).toHaveBeenCalledWith(
			"error: runtime build info is unavailable because no valid source commit was embedded\n",
		);
	});
});
