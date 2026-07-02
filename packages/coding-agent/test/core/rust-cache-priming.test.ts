import { afterEach, describe, expect, it } from "bun:test";
import {
	disposeAllRustKernelSessions,
	executeRust,
} from "@oh-my-pi/pi-coding-agent/eval/rs/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeFakeEvcxr(dir: string, logName: string): Promise<{ fakePath: string; logPath: string }> {
	const fakePath = path.join(dir, `${logName}.sh`);
	const logPath = path.join(dir, `${logName}.stdin.log`);
	const script = [
		"#!/bin/sh",
		"printf 'Welcome to evcxr 0.0.0\\n>> '",
		"while IFS= read -r line; do",
		`\tprintf '%s\\n' "$line" >> ${shellSingleQuote(logPath)}`,
		"\tprintf '\\302\\221\\n>> '",
		"done",
		"exit 0",
		"",
	].join("\n");

	await Bun.write(fakePath, script);
	await fs.chmod(fakePath, 0o755);
	return { fakePath, logPath };
}

async function readLogLines(logPath: string): Promise<string[]> {
	const text = await fs.readFile(logPath, "utf8");
	return text.trimEnd().split("\n");
}

describe("Rust evcxr cache priming", () => {
	let previousSkipCheck: string | undefined;

	afterEach(async () => {
		if (previousSkipCheck === undefined) {
			delete Bun.env.PI_RUST_SKIP_CHECK;
		} else {
			Bun.env.PI_RUST_SKIP_CHECK = previousSkipCheck;
		}
		previousSkipCheck = undefined;
		await disposeAllRustKernelSessions();
	});

	function skipAvailabilityCheck(): void {
		previousSkipCheck = Bun.env.PI_RUST_SKIP_CHECK;
		Bun.env.PI_RUST_SKIP_CHECK = "1";
	}

	it("primes evcxr :cache when cacheMiB > 0", async () => {
		skipAvailabilityCheck();
		using tempDir = TempDir.createSync("@rust-cache-priming-");
		const tmp = tempDir.path();
		const { fakePath, logPath } = await writeFakeEvcxr(tmp, "cache-enabled");

		const result = await executeRust("let x = 1; x", {
			cwd: tmp,
			sessionId: "rust-cache-priming-enabled",
			interpreter: fakePath,
			cacheMiB: 512,
		});

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		const lines = await readLogLines(logPath);
		const cacheIndex = lines.indexOf(":cache 512");
		const userCellIndex = lines.indexOf("let x = 1; x");

		expect(cacheIndex).toBe(0);
		expect(userCellIndex).toBeGreaterThan(cacheIndex);
	});

	it("does NOT prime :cache when cacheMiB = 0", async () => {
		skipAvailabilityCheck();
		using tempDir = TempDir.createSync("@rust-cache-priming-");
		const tmp = tempDir.path();
		const { fakePath, logPath } = await writeFakeEvcxr(tmp, "cache-disabled");

		const result = await executeRust("let y = 2; y", {
			cwd: tmp,
			sessionId: "rust-cache-priming-disabled",
			interpreter: fakePath,
			cacheMiB: 0,
		});

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		const lines = await readLogLines(logPath);

		expect(lines.some(line => line.includes(":cache"))).toBe(false);
		expect(lines).toContain("let y = 2; y");
	});
});
