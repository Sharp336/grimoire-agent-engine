/**
 * Tests for skill invocation tracking hooks added in:
 *   - packages/coding-agent/src/tools/read.ts  (#handleInternalUrl)
 *   - packages/coding-agent/src/modes/controllers/input-controller.ts (#invokeSkillCommand)
 *
 * All tests use spy-based isolation — no real DB is opened.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { InternalUrlRouter } from "../src/internal-urls";
import { resetActiveSkillsForTests, setActiveSkills } from "../src/extensibility/skills";
import type { ToolSession } from "../src/tools";
import { ReadTool } from "../src/tools/read";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import type { AgentStorage } from "../src/session/agent-storage";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeFakeStorage(): AgentStorage & { _calls: string[] } {
	const calls: string[] = [];
	return {
		_calls: calls,
		recordSkillUsage(skillName: string) {
			calls.push(skillName);
		},
	} as unknown as AgentStorage & { _calls: string[] };
}

// ---------------------------------------------------------------------------
// Read tool — skill:// tracking
// ---------------------------------------------------------------------------

function createReadSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

describe("read tool skill:// tracking", () => {
	let tmpDir: string;
	let skillDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-track-read-"));
		skillDir = path.join(tmpDir, "my-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "# my-skill\nDoes things.\n");
		await fs.writeFile(path.join(skillDir, "helper.md"), "# helper\nExtra context.\n");

		// Register the skill globally so SkillProtocolHandler can find it
		setActiveSkills([
			{
				name: "my-skill",
				description: "A test skill",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);

		// Reset the router singleton so the test gets a clean handler map
		InternalUrlRouter.resetForTests();
	});

	afterEach(async () => {
		resetActiveSkillsForTests();
		InternalUrlRouter.resetForTests();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("root skill:// read records skill usage", async () => {
		const session = createReadSession(tmpDir);
		const storage = makeFakeStorage();
		spyOn(session.settings, "getStorage").mockReturnValue(storage);

		const tool = new ReadTool(session);
		await tool.execute("t1", { path: "skill://my-skill" });

		expect(storage._calls).toEqual(["my-skill"]);
	});

	it("sub-path skill://foo/bar.md read does NOT record usage", async () => {
		const session = createReadSession(tmpDir);
		const storage = makeFakeStorage();
		spyOn(session.settings, "getStorage").mockReturnValue(storage);

		const tool = new ReadTool(session);
		await tool.execute("t2", { path: "skill://my-skill/helper.md" });

		expect(storage._calls).toEqual([]);
	});

	it("failed skill:// resolve (unknown skill) does NOT record usage", async () => {
		const session = createReadSession(tmpDir);
		const storage = makeFakeStorage();
		spyOn(session.settings, "getStorage").mockReturnValue(storage);

		const tool = new ReadTool(session);
		await expect(tool.execute("t3", { path: "skill://no-such-skill" })).rejects.toThrow();

		expect(storage._calls).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// InputController — /skill:<name> tracking via handleFollowUp() public path
// ---------------------------------------------------------------------------

/**
 * Build a minimal InteractiveModeContext sufficient for handleFollowUp().
 * The editor returns whatever `editorText` is set to.
 */
function buildInputCtx(params: {
	storage: (AgentStorage & { _calls: string[] }) | null;
	skillCommands: Map<string, string>;
	editorText: string;
	onPromptCustomMessage?: (msg: unknown) => Promise<void>;
}): { ctx: InteractiveModeContext; settings: Settings } {
	const settings = Settings.isolated();
	if (params.storage) {
		spyOn(settings, "getStorage").mockReturnValue(params.storage);
	}

	const ctx: InteractiveModeContext = {
		editor: {
			getText: () => params.editorText,
			addToHistory: () => {},
			setText: () => {},
		},
		ui: { requestRender: () => {} },
		session: {
			isStreaming: false,
			isCompacting: false,
			promptCustomMessage: params.onPromptCustomMessage ?? (async () => {}),
			prompt: async () => {},
		},
		settings,
		skillCommands: params.skillCommands,
		showError: () => {},
		updatePendingMessagesDisplay: () => {},
		// Required by handleFollowUp's non-skill fallthrough path
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
		locallySubmittedUserSignatures: new Set<string>(),
		recordLocalSubmission: () => () => {},
	} as unknown as InteractiveModeContext;

	return { ctx, settings };
}

describe("InputController /skill: tracking via handleFollowUp", () => {
	let tmpDir: string;
	let skillFile: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-track-ic-"));
		skillFile = path.join(tmpDir, "SKILL.md");
		await fs.writeFile(skillFile, "# my-skill\nDoes things.\n");
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("/skill:foo dispatches and records skill usage", async () => {
		const storage = makeFakeStorage();
		const skillCommands = new Map([["skill:my-skill", skillFile]]);
		const { ctx } = buildInputCtx({ storage, skillCommands, editorText: "/skill:my-skill" });

		const controller = new InputController(ctx);
		await controller.handleFollowUp();

		expect(storage._calls).toEqual(["my-skill"]);
	});

	it("unknown /skill:missing returns without recording usage", async () => {
		const storage = makeFakeStorage();
		const skillCommands = new Map<string, string>(); // no skills registered
		const { ctx } = buildInputCtx({ storage, skillCommands, editorText: "/skill:missing" });

		const controller = new InputController(ctx);
		await controller.handleFollowUp();

		expect(storage._calls).toEqual([]);
	});

	it("/skill:foo with trailing args records usage once", async () => {
		const storage = makeFakeStorage();
		const skillCommands = new Map([["skill:my-skill", skillFile]]);
		const prompted: unknown[] = [];
		const { ctx } = buildInputCtx({
			storage,
			skillCommands,
			editorText: "/skill:my-skill some extra args",
			onPromptCustomMessage: async (msg: unknown) => {
				prompted.push(msg);
			},
		});

		const controller = new InputController(ctx);
		await controller.handleFollowUp();

		expect(storage._calls).toEqual(["my-skill"]);
		expect(prompted).toHaveLength(1);
	});
});
