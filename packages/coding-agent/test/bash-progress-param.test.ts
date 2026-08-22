import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { type AsyncJob, AsyncJobManager, type AsyncJobProgressInfo } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ProgressLines } from "@oh-my-pi/pi-coding-agent/async/progress-lines";
import { OutputSink } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { TempDir } from "@oh-my-pi/pi-utils";

const SETTINGS: Record<string, unknown> = {
	"async.enabled": true,
	"bash.autoBackground.enabled": false,
	"bash.autoBackground.thresholdMs": 60_000,
	"bashInterceptor.enabled": false,
	"astGrep.enabled": false,
	"astEdit.enabled": false,
	"grep.enabled": false,
	"glob.enabled": false,
};

function makeSession(manager: AsyncJobManager, overrides: Record<string, unknown> = {}): ToolSession {
	const settings = { ...SETTINGS, ...overrides };
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionId: () => "progress-test",
		getSessionFile: () => null,
		settings: {
			get: (key: string) => settings[key],
			getBashInterceptorRules: () => [],
			getShellConfig: () => ({}),
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

function collectProgress(manager: AsyncJobManager): string[] {
	const seen: string[] = [];
	manager.registerDeliverySink("Main", () => {});
	manager.registerProgressSink("Main", {
		deliver: (_jobId, text) => {
			seen.push(text);
		},
	});
	return seen;
}

describe("bash progress parameter", () => {
	test("defaults off", async () => {
		const manager = new AsyncJobManager({});
		const seen = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("default-off", { command: "printf 'one\\ntwo\\n'", async: true });
		await manager.waitForAll();

		expect(seen).toEqual([]);
	});

	test("reports complete non-empty lines and flushes the final partial line", async () => {
		const manager = new AsyncJobManager({});
		const seen = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("complete-lines", {
			command: "printf par; sleep 0.1; printf 'tial\\n\\n'",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();
		await tool.execute("final-partial", {
			command: "printf final",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();

		expect(seen).toEqual(["partial", "final"]);
	}, 10_000);

	test("bounds an unterminated output line before reporting it", async () => {
		const manager = new AsyncJobManager({});
		const seen = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("bounded-line", {
			command: "printf 'H%.0s' {1..300}; printf '%04400d' 0; printf 'T%.0s' {1..300}",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toHaveLength(500);
		expect(seen[0]).toBe(`${"H".repeat(250)}${"T".repeat(250)}`);
	});

	test("keeps the full raw stream in the same artifact referenced by bounded progress", async () => {
		using tempDir = TempDir.createSync("@omp-bash-progress-artifact-");
		const artifact = { id: "bash-progress-1", path: path.join(tempDir.path(), "output.txt") };
		const manager = new AsyncJobManager({});
		const seen: Array<{ text: string; info: AsyncJobProgressInfo; artifactText: string }> = [];
		manager.registerDeliverySink("Main", () => {});
		manager.registerProgressSink("Main", {
			deliver: async (_jobId, text, _job, _seq, info) => {
				seen.push({ text, info, artifactText: await Bun.file(artifact.path).text() });
			},
		});
		const session = makeSession(manager);
		session.allocateOutputArtifact = async () => artifact;
		const tool = new BashTool(session);

		await tool.execute("artifact-backed-line", {
			command: "printf 'H%.0s' {1..300}; printf '%04400d' 0; printf 'T%.0s' {1..300}",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();

		expect(seen).toEqual([
			{
				text: `${"H".repeat(250)}${"T".repeat(250)}`,
				info: { artifactId: artifact.id, truncated: true },
				artifactText: `${"H".repeat(300)}${"0".repeat(4_400)}${"T".repeat(300)}`,
			},
		]);
		expect(await Bun.file(artifact.path).text()).toBe(`${"H".repeat(300)}${"0".repeat(4_400)}${"T".repeat(300)}`);
	});

	test("rejects progress for a foreground command", async () => {
		const manager = new AsyncJobManager({});
		const tool = new BashTool(makeSession(manager));

		await expect(tool.execute("foreground", { command: "echo no", progress: "wake" })).rejects.toThrow(
			/requires `async: true`/,
		);
	});

	test("keeps a quick auto command inline without progress or completion delivery", async () => {
		const manager = new AsyncJobManager({});
		const progress = collectProgress(manager);
		const completions: string[] = [];
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});
		const tool = new BashTool(makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 2_000 }));

		const result = await tool.execute("auto-inline", {
			command: "printf 'quick-result\\n'",
			async: "auto",
			progress: "wake",
		});
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		expect(result.details?.async).toBeUndefined();
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("quick-result") }),
		);
		expect(progress).toEqual([]);
		expect(completions).toEqual([]);
		await manager.dispose();
	});

	test("promotes a slow auto command and delivers only later lines before completion", async () => {
		const manager = new AsyncJobManager({});
		const events: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				events.push(`progress:${text}`);
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			events.push(`completion:${text}`);
		});
		const tool = new BashTool(
			makeSession(manager, {
				"bash.autoBackground.thresholdMs": 2_000,
				"bash.asyncAuto.inlineGraceMs": 200,
			}),
		);

		const result = await tool.execute("auto-promote", {
			command: "printf 'before-promotion\\n'; sleep 0.5; printf 'after-promotion\\n'",
			async: "auto",
			progress: "wake",
		});

		expect(result.details?.async?.state).toBe("running");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("before-promotion") }),
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		expect(events[0]).toBe("progress:after-promotion");
		expect(events[1]).toContain("completion:");
		expect(events[1]).toContain("before-promotion");
		expect(events[1]).toContain("after-promotion");
		expect(events.join("\n").match(/progress:before-promotion/g)).toBeNull();
		await manager.dispose();
	}, 10_000);

	test("does not replay inline-shown partial output after promotion", async () => {
		const manager = new AsyncJobManager({});
		const events: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				events.push(`progress:${text}`);
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			events.push(`completion:${text}`);
		});
		const tool = new BashTool(
			makeSession(manager, {
				"bash.autoBackground.thresholdMs": 2_000,
				"bash.asyncAuto.inlineGraceMs": 100,
			}),
		);

		// One output line spans the promotion boundary: "before" is printed and
		// shown inline during the grace window; "after\n" completes the line
		// only after promotion. Progress must not replay the inline prefix.
		const result = await tool.execute("auto-promote-boundary", {
			command: "printf before; sleep 0.5; printf 'after\\n'",
			async: "auto",
			progress: "wake",
		});

		expect(result.details?.async?.state).toBe("running");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("before") }),
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		const progressEvents = events.filter(event => event.startsWith("progress:"));
		expect(progressEvents).toEqual(["progress:after"]);
		expect(events.at(-1)).toContain("completion:");
		expect(events.at(-1)).toContain("beforeafter");
		await manager.dispose();
	}, 10_000);

	test("never surfaces a sink-queued pre-promotion chunk as progress", async () => {
		// The exact wiring bash uses for auto-promotion: a mirror-mode sink
		// stamps each chunk with the sampler epoch at entry, and the sampler
		// drops stale-stamped chunks. The first chunk's delivery is still
		// queued behind the sink's artifact flush when the promotion boundary
		// resets the sampler, so without the stamp it would replay
		// inline-shown output as the first background progress event.
		const reported: string[] = [];
		const sampler = new ProgressLines(line => reported.push(line.text));
		const sink = new OutputSink({
			artifactWriteMode: "mirror",
			chunkStamp: () => sampler.epoch,
			onChunk: (chunk, stamp) => sampler.append(chunk, stamp),
		});

		sink.push("inline-shown\n");
		// Promotion boundary: activateProgress() resets the sampler while the
		// chunk above is still in the sink's delivery queue.
		sampler.reset();
		sink.push("post-promotion\n");
		await sink.dump();
		sampler.finish();

		expect(reported).toEqual(["post-promotion"]);
	});

	test("retains successful and failed exit values for completion delivery", async () => {
		const manager = new AsyncJobManager({});
		const completedJobs: AsyncJob[] = [];
		manager.registerDeliverySink("Main", (_jobId, _text, completedJob) => {
			if (completedJob) completedJobs.push(completedJob);
		});
		const tool = new BashTool(makeSession(manager));

		await tool.execute("exit-zero", { command: "exit 0", async: true });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });
		await tool.execute("exit-seven", { command: "exit 7", async: true });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });
		await tool.execute("timeout-job", { command: "sleep 5", async: true, timeout: 1 });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		expect(completedJobs.map(job => job.status)).toEqual(["completed", "failed", "failed"]);
		expect(completedJobs.map(job => job.latestDetails?.exitCode)).toEqual([0, 7, undefined]);
		expect(completedJobs.map(job => job.latestDetails?.timedOut === true)).toEqual([false, false, true]);
		await manager.dispose();
	});
});
