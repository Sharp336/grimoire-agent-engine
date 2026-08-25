import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveModels } from "@oh-my-pi/pi-coding-agent/cli/tiny-models-cli";
import { getTinyLocalModelSpec, isFoundationModelsSpec } from "@oh-my-pi/pi-coding-agent/tiny/models";
import type { TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import {
	AFM_CORE_SIDECAR_ENV,
	completeAfmCore,
	foundationModelsUnavailableReason,
	probeAfmCore,
	resolveBundledSidecarPath,
} from "../src/tiny/apple-fm";
import { startTinyTitleWorker } from "../src/tiny/worker";

const previousSidecar = process.env[AFM_CORE_SIDECAR_ENV];

afterEach(() => {
	if (previousSidecar === undefined) delete process.env[AFM_CORE_SIDECAR_ENV];
	else process.env[AFM_CORE_SIDECAR_ENV] = previousSidecar;
});

function writeFakeSidecar(dir: string, script: string): string {
	const sidecar = path.join(dir, "fake-afm");
	fs.writeFileSync(sidecar, script);
	fs.chmodSync(sidecar, 0o755);
	return sidecar;
}

function bunSidecar(body: string): string {
	return `#!/usr/bin/env bun
${body}
`;
}

describe("afm-core title registry", () => {
	it("registers a Darwin-only foundation-models engine", () => {
		const spec = getTinyLocalModelSpec("afm-core");
		expect(spec).toBeDefined();
		expect(isFoundationModelsSpec(spec)).toBe(true);
		expect(spec?.repo).toBe("apple.SystemLanguageModel");
		if (process.platform === "darwin") {
			expect(spec?.unsupportedReason).toBeUndefined();
		} else {
			expect(spec?.unsupportedReason).toBe("Apple Foundation Models is macOS-only");
		}
	});

	it("lets OMP_APPLE_FM_SIDECAR bypass the platform gate", () => {
		const spec = getTinyLocalModelSpec("afm-core");
		expect(spec).toBeDefined();
		if (!spec) return;
		delete process.env[AFM_CORE_SIDECAR_ENV];
		if (process.platform !== "darwin") {
			expect(foundationModelsUnavailableReason(spec)).toBe("Apple Foundation Models is macOS-only");
		}
		process.env[AFM_CORE_SIDECAR_ENV] = "/tmp/does-not-need-to-exist-for-this-check";
		expect(foundationModelsUnavailableReason(spec)).toBeUndefined();
	});

	it("keeps afm-core out of download all even when Darwin-ready", () => {
		expect(resolveModels("all")).not.toContain("afm-core");
		expect(resolveModels("afm-core")).toEqual(["afm-core"]);
	});

	it("resolves a Bun file-loader emit against the module dir, not cwd", () => {
		expect(resolveBundledSidecarPath("./omp-apple-fm-py3pdx4g.", "/pkg/dist")).toBe(
			path.join("/pkg/dist", "omp-apple-fm-py3pdx4g."),
		);
	});
});

describe("AFM sidecar runner", () => {
	it("probes and completes through an env-overridden sidecar", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
const cmd = process.argv[2];
if (cmd === "status") {
	process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
	process.exit(0);
}
const raw = await Bun.stdin.text();
const req = JSON.parse(raw);
if (!req.prompt) throw new Error("missing prompt");
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			await expect(probeAfmCore()).resolves.toEqual({ available: true, reason: undefined, contextSize: 8192 });
			await expect(completeAfmCore({ instructions: "title", prompt: "fix the login button" })).resolves.toBe(
				"<title>Fix login button</title>",
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces sidecar error payloads", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "modelNotReady" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;
			await expect(probeAfmCore()).rejects.toThrow("apple_fm_failed: modelNotReady");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("tiny worker AFM titles", () => {
	it("generates a title without loading transformers", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
const cmd = process.argv[2];
if (cmd === "status") {
	process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
	process.exit(0);
}
process.stdout.write(JSON.stringify({ text: "<title>Fix login button</title>" }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;

			const outbound: TinyTitleWorkerOutbound[] = [];
			let inbound: ((message: TinyTitleWorkerInbound) => void) | undefined;
			const seen = Promise.withResolvers<void>();
			startTinyTitleWorker({
				send(message) {
					outbound.push(message);
					if (message.type === "title" || message.type === "error" || message.type === "downloaded") {
						seen.resolve();
					}
				},
				onMessage(handler) {
					inbound = handler;
					return () => {
						inbound = undefined;
					};
				},
			});
			inbound?.({
				type: "generate",
				id: "1",
				modelKey: "afm-core",
				message: "the login button is broken on mobile",
			});
			await seen.promise;
			expect(outbound.some(message => message.type === "title" && message.title === "Fix login button")).toBe(true);
			expect(outbound.some(message => message.type === "error")).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats download as a readiness probe", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ available: true, contextSize: 8192 }) + "\\n");
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;

			const outbound: TinyTitleWorkerOutbound[] = [];
			let inbound: ((message: TinyTitleWorkerInbound) => void) | undefined;
			const seen = Promise.withResolvers<void>();
			startTinyTitleWorker({
				send(message) {
					outbound.push(message);
					if (message.type === "downloaded" || message.type === "error") seen.resolve();
				},
				onMessage(handler) {
					inbound = handler;
					return () => {
						inbound = undefined;
					};
				},
			});
			inbound?.({ type: "download", id: "2", modelKey: "afm-core" });
			await seen.promise;
			expect(outbound.some(message => message.type === "downloaded" && message.id === "2")).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns no title on modelNotReady instead of a worker error", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-afm-"));
		try {
			const sidecar = writeFakeSidecar(
				dir,
				bunSidecar(`
process.stdout.write(JSON.stringify({ error: "apple_fm_failed", reason: "modelNotReady" }) + "\\n");
process.exit(1);
`),
			);
			process.env[AFM_CORE_SIDECAR_ENV] = sidecar;

			const outbound: TinyTitleWorkerOutbound[] = [];
			let inbound: ((message: TinyTitleWorkerInbound) => void) | undefined;
			const seen = Promise.withResolvers<void>();
			startTinyTitleWorker({
				send(message) {
					outbound.push(message);
					if (message.type === "title" || message.type === "error") seen.resolve();
				},
				onMessage(handler) {
					inbound = handler;
					return () => {
						inbound = undefined;
					};
				},
			});
			inbound?.({ type: "generate", id: "3", modelKey: "afm-core", message: "fix the login button" });
			await seen.promise;
			expect(outbound.some(message => message.type === "title" && message.title === null)).toBe(true);
			expect(outbound.some(message => message.type === "error")).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
