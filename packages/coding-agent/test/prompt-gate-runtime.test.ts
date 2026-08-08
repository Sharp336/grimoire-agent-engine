import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { resolvePromptGateCapability } from "../src/prompt-gate/capability";
import { PromptGateBlockedError, runPromptGates } from "../src/prompt-gate/runtime";

const GATE_SCRIPT = String.raw`
const { createInterface } = require("node:readline");
const { writeFile } = require("node:fs/promises");
const [mode, recordPath] = process.argv.slice(-2);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
const first = await lines.next();
const input = JSON.parse(first.value);
const frame = value => process.stdout.write(JSON.stringify({ version: 1, integration_id: input.integration_id, ...value }) + "\n");
const sleep = ms => {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
};
if (mode === "allow") {
  await writeFile(recordPath, JSON.stringify({ input }));
  frame({ event: "prompt-gate-v1", decision: "allow" });
} else if (mode === "block") {
  frame({ event: "prompt-gate-v1", decision: "block", reason: "review cancelled" });
  process.stdin.destroy();
} else if (mode === "recovery-block") {
  frame({ event: "prompt-gate-v1", decision: "block", reason: "reviewing" });
  frame({ event: "prompt-gate-v1", decision: "block", reason: "review unavailable" });
  process.stdin.destroy();
} else if (mode === "stage") {
  if (input.text === "original") {
    frame({ event: "prompt-gate-v1", decision: "block", reason: "reviewing" });
    frame({ event: "stage_approved", text: "corrected", delivery_token: "delivery-1" });
    const second = await lines.next();
    await writeFile(recordPath, JSON.stringify({ input, acknowledgment: JSON.parse(second.value) }));
  } else {
    frame({ event: "prompt-gate-v1", decision: "allow" });
  }
} else if (mode === "empty-stage") {
  frame({ event: "prompt-gate-v1", decision: "block", reason: "reviewing" });
  frame({ event: "stage_approved", text: " ", delivery_token: "delivery-empty" });
} else if (mode === "malformed") {
  process.stdout.write("not-json\n");
} else if (mode === "timeout") {
  await lines.next();
  frame({ event: "prompt-gate-v1", decision: "allow" });
} else if (mode === "slow") {
  process.stdout.write('{"version":1,');
  await sleep(15);
  process.stdout.write('"event":"prompt-gate-v1",');
  await sleep(15);
  process.stdout.write('"integration_id":"omp-test","decision":"allow"}\n');
}
`;

const temporaryDirectories: string[] = [];
let executableDigest: string | undefined;

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = createReadStream(filePath);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	stream.on("data", chunk => hash.update(chunk));
	stream.on("error", reject);
	stream.on("end", resolve);
	await promise;
	return hash.digest("hex");
}

async function makeFixture(mode: string, options?: { digest?: string; timeoutMs?: number }) {
	const root = await mkdtemp(path.join(tmpdir(), "omp-prompt-gate-"));
	temporaryDirectories.push(root);
	const gateDirectory = path.join(root, "gates");
	await mkdir(gateDirectory);
	const recordPath = path.join(root, "record.json");
	executableDigest ??= await sha256File(process.execPath);
	await writeFile(
		path.join(gateDirectory, "bex.json"),
		JSON.stringify({
			version: 1,
			event: "prompt-gate-v1",
			integration_id: "omp-test",
			command: [process.execPath, "-e", GATE_SCRIPT, mode, recordPath],
			command_sha256: options?.digest ?? executableDigest,
			first_decision_timeout_ms: options?.timeoutMs ?? 1_000,
			on_error: "block",
		}),
	);
	return { root, gateDirectory, recordPath };
}

async function evaluate(gateDirectory: string, text = "original") {
	return runPromptGates({
		text,
		sessionId: "session-1",
		cwd: process.cwd(),
		source: "prompt",
		profile: "team",
		gateDirectory,
	});
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("prompt-gate-v1 capability", () => {
	it("reports canonical profile-scoped paths", () => {
		expect(
			resolvePromptGateCapability({ profile: "team", agentDir: "/tmp/omp-team/agent", cwd: "/tmp/workspace" }),
		).toEqual({
			capabilities: ["prompt-gate-v1"],
			profile: "team",
			agent_dir: "/tmp/omp-team/agent",
			gate_dir: "/tmp/omp-team/agent/prompt-gates",
			cwd: "/tmp/workspace",
		});
	});
});

describe("prompt-gate-v1 runtime", () => {
	it("allows unchanged prompts when no gates are installed", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "omp-prompt-gate-empty-"));
		temporaryDirectories.push(root);
		await expect(evaluate(path.join(root, "missing"))).resolves.toEqual({ text: "original" });
	});

	it("passes the bound prompt context to an allowing gate", async () => {
		const fixture = await makeFixture("allow");
		await expect(evaluate(fixture.gateDirectory)).resolves.toEqual({ text: "original" });
		const record = JSON.parse(await readFile(fixture.recordPath, "utf8"));
		expect(record.input).toEqual({
			version: 1,
			event: "prompt-gate-v1",
			integration_id: "omp-test",
			text: "original",
			images: [],
			session_id: "session-1",
			cwd: process.cwd(),
			profile: "team",
			source: "prompt",
		});
	});

	it("re-gates staged text and acknowledges only when the host delivers it", async () => {
		const fixture = await makeFixture("stage");
		const result = await evaluate(fixture.gateDirectory);
		expect(result.text).toBe("corrected");
		expect(result.delivery).toBeDefined();
		await expect(Bun.file(fixture.recordPath).exists()).resolves.toBe(false);
		await result.delivery?.acknowledge();
		const record = JSON.parse(await readFile(fixture.recordPath, "utf8"));
		expect(record.input.text).toBe("original");
		expect(record.acknowledgment).toEqual({
			version: 1,
			event: "stage_delivery",
			integration_id: "omp-test",
			delivery_token: "delivery-1",
			status: "delivered",
		});
	});

	it("cancels an unacknowledged staged delivery", async () => {
		const fixture = await makeFixture("stage");
		const result = await evaluate(fixture.gateDirectory);
		await result.delivery?.cancel();
		await expect(Bun.file(fixture.recordPath).exists()).resolves.toBe(false);
	});

	it("fails closed when review is cancelled", async () => {
		const fixture = await makeFixture("block");
		await expect(evaluate(fixture.gateDirectory)).rejects.toThrow("review cancelled");
	});

	it("fails closed with a gate's terminal recovery reason", async () => {
		const fixture = await makeFixture("recovery-block");
		await expect(evaluate(fixture.gateDirectory)).rejects.toThrow("review unavailable");
	});

	it("fails closed on malformed output and decision timeout", async () => {
		const malformed = await makeFixture("malformed");
		await expect(evaluate(malformed.gateDirectory)).rejects.toBeInstanceOf(PromptGateBlockedError);
		const timeout = await makeFixture("timeout", { timeoutMs: 20 });
		await expect(evaluate(timeout.gateDirectory)).rejects.toThrow("no decision within 20 ms");
	});

	it("applies the first-decision timeout to the whole frame", async () => {
		const fixture = await makeFixture("slow", { timeoutMs: 20 });
		await expect(evaluate(fixture.gateDirectory)).rejects.toThrow("no decision within 20 ms");
	});

	it("fails closed on an empty staged replacement", async () => {
		const fixture = await makeFixture("empty-stage");
		await expect(evaluate(fixture.gateDirectory)).rejects.toThrow("invalid staged approval");
	});

	it("fails closed when the configured command digest drifts", async () => {
		const fixture = await makeFixture("allow", { digest: "0".repeat(64) });
		await expect(evaluate(fixture.gateDirectory)).rejects.toThrow("gate command digest does not match");
	});
});
