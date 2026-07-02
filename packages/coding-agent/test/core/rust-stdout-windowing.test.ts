import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeAllRustKernelSessions,
	executeRust,
} from "@oh-my-pi/pi-coding-agent/eval/rs/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PAYLOAD_LINES = 200;
const PAYLOAD_X_PER_LINE = 1000;
const PAYLOAD_BATCHES = 20;
const PAYLOAD_LINES_PER_BATCH = PAYLOAD_LINES / PAYLOAD_BATCHES;
const EXPECTED_X_COUNT = PAYLOAD_LINES * PAYLOAD_X_PER_LINE;

async function writeFakeEvcxr(dir: string): Promise<string> {
	const fakePath = path.join(dir, "fake-evcxr-windowing.sh");
	const script = [
		"#!/bin/sh",
		"printf 'Welcome to evcxr 0.0.0\\n>> '",
		"while IFS= read -r line; do",
		"\tbatch=0",
		`\twhile [ "$batch" -lt ${PAYLOAD_BATCHES} ]; do`,
		`\t\tawk 'BEGIN{for(i=0;i<${PAYLOAD_LINES_PER_BATCH};i++){for(j=0;j<${PAYLOAD_X_PER_LINE};j++)printf "x"; printf "\\n"}}'`,
		"\t\tbatch=$((batch + 1))",
		"\t\tsleep 0.001",
		"\tdone",
		"\tprintf '\\302\\221\\n>> '",
		"done",
		"exit 0",
		"",
	].join("\n");

	await Bun.write(fakePath, script);
	await fs.chmod(fakePath, 0o755);
	return fakePath;
}

describe("Rust stdout live windowing", () => {
	let previousSkipCheck: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "tools.artifactHeadBytes": 512, "tools.outputMaxColumns": 0 },
		});
	});

	afterEach(async () => {
		if (previousSkipCheck === undefined) {
			delete Bun.env.PI_RUST_SKIP_CHECK;
		} else {
			Bun.env.PI_RUST_SKIP_CHECK = previousSkipCheck;
		}
		previousSkipCheck = undefined;
		await disposeAllRustKernelSessions();
		resetSettingsForTest();
	});

	function skipAvailabilityCheck(): void {
		previousSkipCheck = Bun.env.PI_RUST_SKIP_CHECK;
		Bun.env.PI_RUST_SKIP_CHECK = "1";
	}

	it("round-trips a large multi-chunk stdout payload before the evcxr marker", async () => {
		skipAvailabilityCheck();
		using tempDir = TempDir.createSync("@rust-stdout-windowing-");
		const tmp = tempDir.path();
		const fakePath = await writeFakeEvcxr(tmp);

		const result = await executeRust("go", {
			cwd: tmp,
			sessionId: `rust-stdout-windowing-${crypto.randomUUID()}`,
			interpreter: fakePath,
		});

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect((result.output.match(/x/g) ?? []).length).toBe(EXPECTED_X_COUNT);
		expect(/x{1000}/.test(result.output)).toBe(true);
	});
});
