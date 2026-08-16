import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDreamDiaryPath, runDream } from "@oh-my-pi/pi-coding-agent/dream";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

interface DreamFixture {
	agentDir: string;
	sessionDir: string;
	settings: Settings;
	session: any;
}

let sharedRoot: TempDir | undefined;

beforeAll(async () => {
	sharedRoot = await TempDir.create(`@dream-runner-${Snowflake.next()}`);
});

afterAll(async () => {
	if (sharedRoot) {
		await Bun.sleep(0);
		await sharedRoot.remove();
	}
	sharedRoot = undefined;
});

async function makeTempDir(prefix: string): Promise<string> {
	const base = sharedRoot?.path() ?? os.tmpdir();
	const dir = path.join(base, `${prefix}-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

function createModel(id = "test-model"): Model {
	return {
		provider: "openai",
		id,
		name: id,
		contextWindow: 32_000,
	} as Model;
}

async function createFixture(overrides?: Partial<Record<string, unknown>>): Promise<DreamFixture> {
	const agentDir = await makeTempDir("dream-runner-agent");
	const sessionDir = path.join(agentDir, "sessions");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "current-session.jsonl");
	await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "current-thread", cwd: agentDir })}\n`);

	const settings = Settings.isolated({
		"memory.backend": "local",
		"memories.minRolloutIdleHours": 0,
		"dream.minSessionIdleHours": 0,
		...(overrides ?? {}),
	});
	const model = createModel();
	const modelRegistry = {
		find: vi.fn(() => model),
		getAll: vi.fn(() => [model]),
		getApiKey: vi.fn(async () => "test-api-key"),
		resolver: vi.fn(() => async () => "test-api-key"),
	};
	const session = {
		sessionId: "current-thread",
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionDir: () => sessionDir,
			getSessionId: () => "current-thread",
			getCwd: () => agentDir,
		},
		settings,
		model,
		modelRegistry,
		refreshBaseSystemPrompt: vi.fn(async () => {}),
	};
	return { agentDir, sessionDir, settings, session };
}

async function writeRollout(fx: DreamFixture, threadId: string): Promise<void> {
	const rows = [
		{ type: "session", id: threadId, cwd: fx.agentDir },
		{ type: "message", message: { role: "user", content: "summarize this rollout" } },
	];
	await fs.writeFile(
		path.join(fx.sessionDir, `${threadId}.jsonl`),
		`${rows.map(r => JSON.stringify(r)).join("\n")}\n`,
	);
}

function stage1Response(summary: string): any {
	return {
		stopReason: "end_turn",
		content: [
			{
				type: "text",
				text: JSON.stringify({
					rollout_summary: summary,
					rollout_slug: "slug",
					raw_memory: `Raw memory for ${summary}`,
				}),
			},
		],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
	};
}

function consolidationResponse(): any {
	return {
		stopReason: "end_turn",
		content: [
			{
				type: "text",
				text: JSON.stringify({
					memory_md: "# Memory\n\nDreamed body",
					memory_summary: "Dreamed summary",
					skills: [],
				}),
			},
		],
	};
}

function reflectionResponse(text: string): any {
	return { stopReason: "end_turn", content: [{ type: "text", text }] };
}

describe("dream runner", () => {
	let savedXdgData: string | undefined;
	let savedXdgState: string | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		savedXdgData = process.env.XDG_DATA_HOME;
		savedXdgState = process.env.XDG_STATE_HOME;
		process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
		process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env.XDG_DATA_HOME = savedXdgData;
		process.env.XDG_STATE_HOME = savedXdgState;
	});

	test("no memory backend → skipped, and nothing is written", async () => {
		const fx = await createFixture({ "memory.backend": "off" });
		const completeSpy = vi.spyOn(ai, "completeSimple");

		const result = await runDream({
			session: fx.session,
			settings: fx.settings,
			agentDir: fx.agentDir,
			cwd: fx.agentDir,
			trigger: "manual",
			signal: new AbortController().signal,
		});

		expect(result.outcome).toBe("skipped");
		expect(result.diaryPath).toBeUndefined();
		expect(completeSpy).not.toHaveBeenCalled();
		expect(await Bun.file(getDreamDiaryPath(fx.agentDir, fx.agentDir)).exists()).toBe(false);
	});

	test("nothing new to consolidate → nothing_new with zero model calls and no diary entry", async () => {
		const fx = await createFixture();
		const completeSpy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("must not be called"));

		const result = await runDream({
			session: fx.session,
			settings: fx.settings,
			agentDir: fx.agentDir,
			cwd: fx.agentDir,
			trigger: "idle",
			signal: new AbortController().signal,
		});

		expect(result.outcome).toBe("nothing_new");
		expect(completeSpy).not.toHaveBeenCalled();
		expect(await Bun.file(getDreamDiaryPath(fx.agentDir, fx.agentDir)).exists()).toBe(false);
	});

	test("new session material → dreamt: memory consolidated, diary entry with reflection, live prompt untouched", async () => {
		const fx = await createFixture();
		await writeRollout(fx, "thread-a");
		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(stage1Response("Rollout summary A"))
			.mockResolvedValueOnce(consolidationResponse())
			.mockResolvedValueOnce(reflectionResponse("I remembered the refactor."));

		const result = await runDream({
			session: fx.session,
			settings: fx.settings,
			agentDir: fx.agentDir,
			cwd: fx.agentDir,
			trigger: "manual",
			signal: new AbortController().signal,
		});

		expect(result.outcome).toBe("dreamt");
		const memoryRoot = getMemoryRoot(fx.agentDir, fx.agentDir);
		expect((await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8")).trim()).toBe("# Memory\n\nDreamed body");

		const diaryPath = getDreamDiaryPath(fx.agentDir, fx.agentDir);
		expect(result.diaryPath).toBe(diaryPath);
		const diary = await fs.readFile(diaryPath, "utf8");
		expect(diary).toContain("— manual dream");
		expect(diary).toContain("Sessions reviewed: 1 (1 yielded new memories)");
		expect(diary).toContain("I remembered the refactor.");
		expect(diary).toContain("- Rollout summary A");

		// Dreams must stay prompt-cache neutral: unlike the startup pipeline, a
		// dream pass never refreshes the live session's base system prompt.
		expect(fx.session.refreshBaseSystemPrompt).not.toHaveBeenCalled();
	});

	test("dream.diary off → still consolidates but writes no diary and skips the reflection call", async () => {
		const fx = await createFixture({ "dream.diary": false });
		await writeRollout(fx, "thread-b");
		const completeSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(stage1Response("Rollout summary B"))
			.mockResolvedValueOnce(consolidationResponse());

		const result = await runDream({
			session: fx.session,
			settings: fx.settings,
			agentDir: fx.agentDir,
			cwd: fx.agentDir,
			trigger: "manual",
			signal: new AbortController().signal,
		});

		expect(result.outcome).toBe("dreamt");
		expect(result.diaryPath).toBeUndefined();
		expect(completeSpy).toHaveBeenCalledTimes(2);
		expect(await Bun.file(getDreamDiaryPath(fx.agentDir, fx.agentDir)).exists()).toBe(false);
		const memoryRoot = getMemoryRoot(fx.agentDir, fx.agentDir);
		expect((await fs.readFile(path.join(memoryRoot, "MEMORY.md"), "utf8")).trim()).toBe("# Memory\n\nDreamed body");
	});
});
