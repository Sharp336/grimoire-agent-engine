import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canonicalSnapshotKey } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import type { RenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import type {
	ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Text } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../../src/internal-urls";
import type { ProtocolHandler } from "../../src/internal-urls/types";
import { grepToolRenderer } from "../../src/tools/grep";
import type { ReadTargetOutcome } from "../../src/tools/read";
import { executeReadBatch, type ReadBatchPartDetails } from "../../src/tools/read-batch";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "astGrep.enabled": true, "astEdit.enabled": true, "tools.xdev": false }),
		...overrides,
	};
}

const plainTheme = {
	fg: (_color: unknown, text: string) => text,
	styledSymbol: () => "…",
	sep: { dot: " • " },
	format: { bracketLeft: "[", bracketRight: "]" },
} as unknown as Theme;

const renderOptions: RenderResultOptions = {
	expanded: false,
	isPartial: true,
};

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

async function createSearchFixture(rootDir: string): Promise<void> {
	const targets = ["apps", "packages", "phases"] as const;
	for (const target of targets) {
		await fs.mkdir(path.join(rootDir, target), { recursive: true });
	}
	await fs.mkdir(path.join(rootDir, "other"), { recursive: true });
	await fs.mkdir(path.join(rootDir, "folder with spaces"), { recursive: true });

	await Bun.write(path.join(rootDir, "apps", "grep.txt"), "shared-needle apps\n");
	await Bun.write(path.join(rootDir, "packages", "grep.txt"), "shared-needle packages\n");
	await Bun.write(path.join(rootDir, "phases", "grep.txt"), "shared-needle phases\n");
	await Bun.write(path.join(rootDir, "other", "grep.txt"), "shared-needle other\n");
	await Bun.write(path.join(rootDir, "folder with spaces", "note.txt"), "space-needle\n");

	await Bun.write(
		path.join(rootDir, "apps", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(appsValue, appsArg);\n",
	);
	await Bun.write(
		path.join(rootDir, "packages", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(packagesValue, packagesArg);\n",
	);
	await Bun.write(
		path.join(rootDir, "phases", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(phasesValue, phasesArg);\n",
	);
	await Bun.write(
		path.join(rootDir, "other", "ast.ts"),
		"const providerOptions = {};\nlegacyWrap(otherValue, otherArg);\n",
	);
}
async function makeJsonlSessionFile(dirPath: string, entries: object[]): Promise<string> {
	const filePath = path.join(dirPath, "session.jsonl");
	await Bun.write(filePath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return filePath;
}

function makeSubagentRegistry(sessions: ObservableSession[]): SessionObserverRegistry {
	return {
		getSessions: () => sessions,
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => sessions.filter(session => session.status === "active").length,
	} as unknown as SessionObserverRegistry;
}

let treeEntryCounter = 0;
function makeMessageNode(message: AgentMessage, parentId: string | null = null): SessionTreeNode {
	const entry: SessionEntry = {
		type: "message",
		id: `entry-${treeEntryCounter++}`,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function renderTree(tree: SessionTreeNode[], currentLeafId: string): string {
	const selector = new TreeSelectorComponent(
		tree,
		currentLeafId,
		60,
		() => {},
		() => {},
	);
	return Bun.stripANSI(selector.render(120).join("\n"));
}

describe("tool path arrays", () => {
	let tempDir: string;

	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await createSearchFixture(tempDir);
	});

	beforeEach(() => {
		treeEntryCounter = 0;
	});

	afterAll(async () => {
		await removeWithRetries(tempDir);
		resetSettingsForTest();
	});

	it("search accepts a semicolon-delimited path list", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-path-array", {
			pattern: "shared-needle",
			path: "apps/; packages/; phases/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# packages\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# phases\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toContain("shared-needle");
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps/, packages/, phases/");
	});

	it("search accepts JSON-array string paths in direct execute", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-json-array-string-paths", {
			pattern: "shared-needle",
			path: JSON.stringify(["apps/", "packages/", "phases/"]),
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# packages\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# phases\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps/, packages/, phases/");
	});

	it("search expands delimited path entries", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		for (const [name, entry] of [
			["comma", "apps/grep.txt, packages/grep.txt"],
			["semicolon", "apps/grep.txt;packages/grep.txt"],
			["space", "apps/grep.txt packages/grep.txt"],
		] as const) {
			const result = await tool.execute(`search-delimited-${name}`, {
				pattern: "shared-needle",
				path: entry,
			});
			const text = getText(result);
			const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

			expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
			expect(text).toMatch(/^# packages\/\n## grep\.txt#[0-9A-F]{4}/m);
			expect(text).not.toContain("phases");
			expect(text).not.toContain("other");
			expect(details?.fileCount).toBe(2);
			expect(details?.scopePath).toBe("apps/grep.txt, packages/grep.txt");
		}
	});

	it("search keeps comma-delimited surviving entries when peers are missing", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-delimited-missing", {
			pattern: "shared-needle",
			path: "missing.txt, packages/grep.txt",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; missingPaths?: string[] } | undefined;

		expect(text).toMatch(/^\[packages\/grep\.txt#[0-9A-F]{4}\]/m);
		expect(text).toContain("Skipped missing paths: missing.txt");
		expect(text).not.toContain("apps");
		expect(details?.fileCount).toBe(1);
		expect(details?.missingPaths).toEqual(["missing.txt"]);
	});

	it("records hashline snapshots for matched files", async () => {
		const session = createTestSession(tempDir);
		const tools = await createTools(session);
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-records-snapshot", {
			pattern: "shared-needle",
			path: "apps/",
		});
		const text = getText(result);
		const tag = /^# apps\/\n## grep\.txt#([0-9A-F]{4})/m.exec(text)?.[1];
		expect(tag).toBeDefined();
		if (!tag) throw new Error("Missing search snapshot tag");

		const snapshot = session.fileSnapshotStore?.byHash(
			canonicalSnapshotKey(path.join(tempDir, "apps", "grep.txt")),
			tag,
		);
		expect(snapshot?.text).toBe("shared-needle apps\n");
	});

	it("search accepts a single string path through tool validation", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "search-single-string-path",
			name: tool.name,
			arguments: {
				pattern: "space-needle",
				path: "folder with spaces/",
			},
		});
		const result = await tool.execute("search-single-string-path", args);
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("note.txt");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("folder with spaces");
	});
	it("search resolves bracketed literal paths (Next.js routes) when they exist", async () => {
		// Create `apps/[id]/page.tsx` — `[id]` is glob char-class syntax but here it
		// is a literal directory name. The literal path must take precedence over
		// the glob interpretation, otherwise the lookup returns no matches.
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await fs.mkdir(path.join(tmp, "apps", "[id]"), { recursive: true });
		await Bun.write(path.join(tmp, "apps", "[id]", "page.tsx"), "bracket-needle\n");

		const tools = await createTools(createTestSession(tmp));
		const tool = tools.find(entry => entry.name === "grep");
		if (!tool) throw new Error("Missing grep tool");

		const single = await tool.execute("search-bracket-literal-single", {
			pattern: "bracket-needle",
			path: "apps/[id]/page.tsx",
		});
		expect(getText(single)).toContain("bracket-needle");

		const dir = await tool.execute("search-bracket-literal-dir", {
			pattern: "bracket-needle",
			path: "apps/[id]",
		});
		expect(getText(dir)).toContain("bracket-needle");
		await removeWithRetries(tmp);
	});

	it("grep pending renderer accepts a single string path", () => {
		const component = grepToolRenderer.renderCall(
			{ pattern: "space-needle", paths: "folder with spaces/" },
			renderOptions,
			plainTheme,
		);

		expect(component).toBeInstanceOf(Text);
		expect((component as Text).getText()).toContain("in folder with spaces/");
	});
	it("agent hub chat renders a single-string grep path summary", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		const sessionFile = await makeJsonlSessionFile(tmp, [
			{ type: "session", version: 3, id: "search-overlay-session", timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "grep", timestamp: 1 },
			},
			{
				type: "message",
				id: "msg-assistant-1",
				parentId: "msg-user-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "search-call-1",
							name: "grep",
							arguments: { pattern: "space-needle", paths: "folder with spaces/" },
						},
					],
					api: "test",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 2,
				},
			},
		]);
		const observers = makeSubagentRegistry([
			{
				id: "search-overlay-session",
				kind: "subagent",
				label: "Search Overlay",
				status: "active",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);
		const agents = new AgentRegistry();
		agents.register({
			id: "search-overlay-session",
			displayName: "search-overlay-session",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});

		const viewer = new AgentTranscriptViewer({
			agentId: "search-overlay-session",
			registry: agents,
			observers,
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
			cwd: tmp,
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+s"],
			requestRender: () => {},
			onClose: () => {},
			onHubClose: () => {},
		});
		const rendered = Bun.stripANSI(viewer.render(120).join("\n"));
		viewer.dispose();

		// The hub chat now renders through grepToolRenderer.renderCall; the
		// single-string `paths` arg shows up as the "in <paths>" scope meta on the
		// pending call line (a completed result merges the call line away).
		expect(rendered).toContain("in folder with spaces/");
		await removeWithRetries(tmp);
	});

	it("tree selector renders a single-string grep path summary", () => {
		const root = makeMessageNode({ role: "user", content: "grep", timestamp: 1 });
		const assistant = makeMessageNode(
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "search-call-1",
						name: "grep",
						arguments: { pattern: "space-needle", paths: "folder with spaces/" },
					},
				],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
				stopReason: "stop",
			} as AgentMessage,
			root.entry.id,
		);
		const toolResult = makeMessageNode(
			{
				role: "toolResult",
				toolCallId: "search-call-1",
				toolName: "grep",
				content: [{ type: "text", text: "note.txt" }],
				isError: false,
				timestamp: 3,
			} as AgentMessage,
			assistant.entry.id,
		);
		root.children.push(assistant);
		assistant.children.push(toolResult);

		const rendered = renderTree([root], toolResult.entry.id);

		expect(rendered).toContain("[grep: /space-needle/ in folder with spaces/]");
		expect(rendered).not.toContain("[grep: /space-needle/ in .]");
	});

	it("tree selector renders native read arrays as separate paths", () => {
		const root = makeMessageNode({ role: "user", content: "read", timestamp: 1 });
		const assistant = makeMessageNode(
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "read-call-1",
						name: "read",
						arguments: { path: ["first.ts:1-2", "second.ts:3-4"] },
					},
				],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
				stopReason: "stop",
			} as AgentMessage,
			root.entry.id,
		);
		const toolResult = makeMessageNode(
			{
				role: "toolResult",
				toolCallId: "read-call-1",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
				timestamp: 3,
			} as AgentMessage,
			assistant.entry.id,
		);
		root.children.push(assistant);
		assistant.children.push(toolResult);

		const rendered = renderTree([root], toolResult.entry.id);

		expect(rendered).toContain("[read: first.ts:1-2, second.ts:3-4]");
	});

	it("search keeps a single path that contains spaces", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-space-directory", {
			pattern: "space-needle",
			path: "folder with spaces/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("note.txt");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("folder with spaces");
	});

	it("search accepts quoted directory paths", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("search-quoted-path", {
			pattern: "shared-needle",
			path: '"packages/"',
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("grep.txt");
		expect(text).not.toContain("other");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("packages");
	});

	it("search formats absolute in-cwd paths relative to cwd", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const absoluteAppsPath = path.join(tempDir, "apps");
		const result = await tool.execute("search-absolute-in-cwd", {
			pattern: "shared-needle",
			path: absoluteAppsPath,
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toContain("shared-needle");
		expect(text).not.toContain(tempDir);
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("apps");
	});

	it("write reports absolute in-cwd targets relative to cwd", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		const tools = await createTools(createTestSession(tmp));
		const tool = tools.find(entry => entry.name === "write");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing write tool");

		const absoluteTarget = path.join(tmp, "written.txt");
		const result = await tool.execute("write-absolute-in-cwd", {
			path: absoluteTarget,
			content: "written\n",
		});
		const text = getText(result);

		expect(text).toContain("Successfully wrote 8 bytes to written.txt");
		expect(text).not.toContain(tmp);
		expect(await Bun.file(absoluteTarget).text()).toBe("written\n");
		await removeWithRetries(tmp);
	});

	it("read expands comma-delimited paths", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-delimited", {
			path: "apps/grep.txt, packages/grep.txt",
		});
		const text = getText(result);
		const details = result.details as { notes?: string[] } | undefined;

		expect(text).toContain("Note: interpreted as 2 paths: apps/grep.txt, packages/grep.txt");
		expect(text).toContain("shared-needle apps");
		expect(text).toContain("shared-needle packages");
		expect(details?.notes).toEqual(["Note: interpreted as 2 paths: apps/grep.txt, packages/grep.txt"]);
	});

	it("read keeps readable delimited paths when peers are missing", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-delimited-missing", {
			path: "missing.txt, packages/grep.txt",
		});
		const text = getText(result);
		const details = result.details as { notes?: string[] } | undefined;

		expect(text).toContain("Note: interpreted as 2 paths: missing.txt, packages/grep.txt");
		expect(text).toContain("shared-needle packages");
		expect(text).toContain("[Could not read missing.txt: Path 'missing.txt' not found]");
		expect(details?.notes).toEqual([
			"Note: interpreted as 2 paths: missing.txt, packages/grep.txt",
			"Could not read missing.txt: Path 'missing.txt' not found",
		]);
	});

	it("read accepts path arrays through validation and preserves input order", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const paths = ["packages/grep.txt", "missing.txt", "apps/grep.txt"];
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "read-path-array",
			name: tool.name,
			arguments: { path: paths },
		});
		expect(args).toEqual({ path: paths });

		const result = await tool.execute("read-path-array", args);
		const text = getText(result);
		const details = result.details as
			| {
					notes?: string[];
					displayReadTargets?: string[];
					readTargetOutcomes?: Array<{ path: string; status: string; resolvedPath?: string }>;
			  }
			| undefined;
		const packagesIndex = text.indexOf("shared-needle packages");
		const missingIndex = text.indexOf("[Could not read missing.txt: Path 'missing.txt' not found]");
		const appsIndex = text.indexOf("shared-needle apps");

		expect(text).toContain("Note: read 3 paths: packages/grep.txt, missing.txt, apps/grep.txt");
		expect(text.startsWith("Note: read 3 paths: packages/grep.txt, missing.txt, apps/grep.txt\n\n[")).toBe(true);
		expect(packagesIndex).toBeGreaterThan(-1);
		expect(missingIndex).toBeGreaterThan(packagesIndex);
		expect(appsIndex).toBeGreaterThan(missingIndex);
		expect(details?.displayReadTargets).toEqual(paths);
		expect(details?.notes).toEqual([
			"Note: read 3 paths: packages/grep.txt, missing.txt, apps/grep.txt",
			"Could not read missing.txt: Path 'missing.txt' not found",
		]);
		expect(
			details?.readTargetOutcomes?.map(({ path: targetPath, status }) => ({ path: targetPath, status })),
		).toEqual([
			{ path: "packages/grep.txt", status: "success" },
			{ path: "missing.txt", status: "error" },
			{ path: "apps/grep.txt", status: "success" },
		]);
		expect(details?.readTargetOutcomes?.[0]?.resolvedPath).toBe(path.join(tempDir, "packages", "grep.txt"));
		expect(details?.readTargetOutcomes?.[2]?.resolvedPath).toBe(path.join(tempDir, "apps", "grep.txt"));
	});

	it("treats each native array entry as one target instead of recursively expanding encoded arrays", async () => {
		const encodedArrayName = '["alpha.txt","beta.txt"]';
		await Promise.all([
			Bun.write(path.join(tempDir, encodedArrayName), "literal encoded-array filename\n"),
			Bun.write(path.join(tempDir, "alpha.txt"), "nested alpha should stay unread\n"),
			Bun.write(path.join(tempDir, "beta.txt"), "nested beta should stay unread\n"),
		]);
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const scalarResult = await tool.execute("read-json-looking-filename", { path: encodedArrayName });
		expect(getText(scalarResult)).toContain("literal encoded-array filename");
		expect(getText(scalarResult)).not.toContain("nested alpha should stay unread");

		const result = await tool.execute("read-flat-native-array", {
			path: [encodedArrayName, "packages/grep.txt"],
		});
		const text = getText(result);
		const details = result.details as { readTargetOutcomes?: Array<{ path: string; status: string }> } | undefined;

		expect(text).toContain("literal encoded-array filename");
		expect(text).toContain("shared-needle packages");
		expect(text).not.toContain("nested alpha should stay unread");
		expect(text).not.toContain("nested beta should stay unread");
		expect(details?.readTargetOutcomes).toHaveLength(2);
		expect(details?.readTargetOutcomes?.map(outcome => outcome.path)).toEqual([
			encodedArrayName,
			"packages/grep.txt",
		]);
	});

	it("keeps delimiter expansion scalar-only for one-element native arrays", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");
		await Promise.all([
			Bun.write(path.join(tempDir, "scalar-one.txt"), "scalar one\n"),
			Bun.write(path.join(tempDir, "scalar-two.txt"), "scalar two\n"),
			Bun.write(path.join(tempDir, "literal-one.txt; literal-two.txt"), "literal combined target\n"),
		]);

		const scalar = await tool.execute("read-scalar-delimited", {
			path: "scalar-one.txt; scalar-two.txt",
		});
		expect(getText(scalar)).toContain("scalar one");
		expect(getText(scalar)).toContain("scalar two");
		expect(getText(scalar)).not.toContain("literal combined target");
		expect(scalar.details?.readTargetOutcomes).toHaveLength(2);

		const array = await tool.execute("read-array-literal", {
			path: ["literal-one.txt; literal-two.txt"],
		});
		expect(getText(array)).toContain("literal combined target");
		expect(getText(array)).not.toContain("scalar one");
		expect(array.details?.readTargetOutcomes?.map((outcome: ReadTargetOutcome) => outcome.path)).toEqual([
			"literal-one.txt; literal-two.txt",
		]);

		await fs.rm(path.join(tempDir, "literal-one.txt; literal-two.txt"));
		const missingArray = await tool.execute("read-array-missing-literal", {
			path: ["literal-one.txt; literal-two.txt"],
		});
		expect(missingArray.isError).toBe(true);
		expect(getText(missingArray)).not.toContain("scalar one");
		expect(missingArray.details?.readTargetOutcomes).toEqual([
			{
				path: "literal-one.txt; literal-two.txt",
				status: "error",
				message: "Path 'literal-one.txt; literal-two.txt' not found",
			},
		]);
	});

	it("preserves recursive mixed-delimiter recovery for scalar paths", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");
		await Promise.all([
			Bun.write(path.join(tempDir, "nested-one.txt"), "nested one\n"),
			Bun.write(path.join(tempDir, "nested-two.txt"), "nested two\n"),
			Bun.write(path.join(tempDir, "nested-three.txt"), "nested three\n"),
		]);

		const result = await tool.execute("read-scalar-mixed-delimiters", {
			path: "nested-one.txt; nested-two.txt, nested-three.txt",
		});
		const text = getText(result);

		expect(result.isError).not.toBe(true);
		expect(text).toContain("nested one");
		expect(text).toContain("nested two");
		expect(text).toContain("nested three");
		expect(result.details?.readTargetOutcomes?.map((outcome: ReadTargetOutcome) => outcome.path)).toEqual([
			"nested-one.txt",
			"nested-two.txt",
			"nested-three.txt",
		]);
	});

	it("preserves selectors when suffix recovery corrects a batched path", async () => {
		await fs.mkdir(path.join(tempDir, "nested-correction"), { recursive: true });
		await Bun.write(
			path.join(tempDir, "nested-correction", "unique-corrected-target.txt"),
			"selected line\nsecond line\n",
		);
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-corrected-array", {
			path: ["unique-corrected-target.txt:1-1", "packages/grep.txt:1-1"],
		});
		const corrected = result.details?.readTargetOutcomes?.[0];
		expect(corrected?.path).toBe("nested-correction/unique-corrected-target.txt:1-1");
		expect(corrected?.requestedPath).toBe("unique-corrected-target.txt");
		expect(corrected?.resolvedPath).toBe(path.join(tempDir, "nested-correction", "unique-corrected-target.txt"));
		expect(getText(result)).toContain("selected line");
	});

	it("preserves SQLite row selectors when suffix recovery corrects a batched database path", async () => {
		const correctedDir = path.join(tempDir, "sqlite-correction");
		const databasePath = path.join(correctedDir, "structured-corrected.db");
		await fs.mkdir(correctedDir, { recursive: true });
		const database = new Database(databasePath);
		try {
			database.exec(`
				CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
				INSERT INTO notes (body) VALUES ('corrected structured target');
			`);
		} finally {
			database.close();
		}

		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-corrected-structured-array", {
			path: ["structured-corrected.db:notes:1"],
		});
		const corrected = result.details?.readTargetOutcomes?.[0];
		expect(corrected?.path).toBe("sqlite-correction/structured-corrected.db:notes:1");
		expect(corrected?.requestedPath).toBe("structured-corrected.db");
		expect(corrected?.resolvedPath).toBe(databasePath);
		expect(getText(result)).toContain("corrected structured target");
	});

	it("rejects empty and oversized native path arrays", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		await expect(tool.execute("read-empty-array", { path: [] })).rejects.toThrow(
			"At least one read path is required",
		);
		await expect(
			tool.execute("read-oversized-array", {
				path: Array.from({ length: 33 }, (_, index) => `path-${index}.txt`),
			}),
		).rejects.toThrow("Read accepts at most 32 paths per call");
	});

	it("runs native array targets concurrently while preserving result order", async () => {
		const router = InternalUrlRouter.instance();
		const scheme = "readbatchconcurrency";
		const firstWaveStarted = Promise.withResolvers<void>();
		const releaseFirstWave = Promise.withResolvers<void>();
		let active = 0;
		let maxActive = 0;
		const handler: ProtocolHandler = {
			scheme,
			immutable: true,
			async resolve(url) {
				active += 1;
				maxActive = Math.max(maxActive, active);
				if (active === 4) firstWaveStarted.resolve();
				await releaseFirstWave.promise;
				const index = Number(url.rawHost.replace("target-", ""));
				active -= 1;
				return {
					url: url.rawHref ?? url.href,
					content: `ordered-target-${index}`,
					contentType: "text/plain",
				};
			},
		};
		router.register(handler);

		try {
			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "read");
			expect(tool).toBeDefined();
			if (!tool) throw new Error("Missing read tool");
			const targets = Array.from({ length: 8 }, (_, index) => `${scheme}://target-${index}`);
			const pendingResult = tool.execute("read-concurrent-array", { path: targets });
			await firstWaveStarted.promise;
			expect(maxActive).toBe(4);
			releaseFirstWave.resolve();
			const result = await pendingResult;
			const text = getText(result);

			for (let index = 1; index < targets.length; index++) {
				expect(text.indexOf(`ordered-target-${index - 1}`)).toBeLessThan(text.indexOf(`ordered-target-${index}`));
			}
		} finally {
			releaseFirstWave.resolve();
			router.unregister(scheme);
		}
	});

	it("keeps filling the bounded completion queue behind a slow first target", async () => {
		const router = InternalUrlRouter.instance();
		const scheme = "readbatchhead";
		const releaseFirst = Promise.withResolvers<void>();
		const allTargetsStarted = Promise.withResolvers<void>();
		const started = new Set<number>();
		const handler: ProtocolHandler = {
			scheme,
			immutable: true,
			async resolve(url) {
				const index = Number(url.rawHost.replace("target-", ""));
				started.add(index);
				if (started.size === 8) allTargetsStarted.resolve();
				if (index === 0) await releaseFirst.promise;
				return {
					url: url.rawHref ?? url.href,
					content: `head-target-${index}`,
					contentType: "text/plain",
				};
			},
		};
		router.register(handler);

		try {
			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "read");
			expect(tool).toBeDefined();
			if (!tool) throw new Error("Missing read tool");
			const targets = Array.from({ length: 8 }, (_, index) => `${scheme}://target-${index}`);
			const pendingResult = tool.execute("read-head-of-line-array", { path: targets });
			await allTargetsStarted.promise;
			expect(started).toEqual(new Set(Array.from({ length: 8 }, (_, index) => index)));
			releaseFirst.resolve();
			const result = await pendingResult;
			expect(result.isError).not.toBe(true);
		} finally {
			releaseFirst.resolve();
			router.unregister(scheme);
		}
	});

	it("incorporates ordered results before releasing completed-buffer reservations", async () => {
		const parts = Array.from({ length: 22 }, (_, index) => `custom-part-${index}`);
		const releaseFirst = Promise.withResolvers<void>();
		const releaseLast = Promise.withResolvers<void>();
		const completionQueueSaturated = Promise.withResolvers<void>();
		const lastPartStarted = Promise.withResolvers<void>();
		const started = new Set<number>();
		let firstDetailsAccessed = false;
		let firstDetailsAccessedWhenLastStarted = false;
		const firstDetails: ReadBatchPartDetails = {
			get notes() {
				firstDetailsAccessed = true;
				return ["custom-part-0 incorporated"];
			},
		};

		const pendingResult = executeReadBatch<ReadBatchPartDetails>({
			parts,
			notice: "custom batch",
			enforceAggregateBudget: true,
			async readPart(part) {
				const index = Number(part.slice("custom-part-".length));
				started.add(index);
				if (started.size === 20) completionQueueSaturated.resolve();
				if (index === 0) await releaseFirst.promise;
				if (index === parts.length - 1) {
					firstDetailsAccessedWhenLastStarted = firstDetailsAccessed;
					lastPartStarted.resolve();
					await releaseLast.promise;
				}
				return {
					content: [{ type: "text", text: `ordered-custom-part-${index}` }],
					details: index === 0 ? firstDetails : undefined,
				};
			},
		});

		try {
			await completionQueueSaturated.promise;
			const lastStartedBeforeFirstRelease = started.has(parts.length - 1);
			releaseFirst.resolve();
			await lastPartStarted.promise;
			releaseLast.resolve();
			const result = await pendingResult;
			const text = getText(result);

			expect(lastStartedBeforeFirstRelease).toBe(false);
			expect(firstDetailsAccessedWhenLastStarted).toBe(true);
			expect(result.isError).not.toBe(true);
			expect(result.details?.readTargetOutcomes?.map(outcome => outcome.path)).toEqual(parts);
			for (let index = 1; index < parts.length; index++) {
				expect(text.indexOf(`ordered-custom-part-${index - 1}`)).toBeLessThan(
					text.indexOf(`ordered-custom-part-${index}`),
				);
			}
		} finally {
			releaseFirst.resolve();
			releaseLast.resolve();
		}
	});

	it("bounds aggregate batched-read text and reports per-target truncation", async () => {
		const largeText = `${"x".repeat(100)}\n`.repeat(400);
		await Promise.all([
			Bun.write(path.join(tempDir, "large-a.txt"), largeText),
			Bun.write(path.join(tempDir, "large-b.txt"), largeText),
		]);
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-bounded-array", {
			path: ["large-a.txt:raw", "large-b.txt:raw"],
		});
		const text = getText(result);
		const details = result.details as
			| {
					notes?: string[];
					readTargetOutcomes?: Array<{ path: string; status: string }>;
			  }
			| undefined;

		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(details?.notes?.filter(note => note.includes("batch text budget was exhausted"))).toHaveLength(1);
		expect(
			details?.readTargetOutcomes?.map(({ path: targetPath, status }) => ({ path: targetPath, status })),
		).toEqual([
			{ path: "large-a.txt:raw", status: "success" },
			{ path: "large-b.txt:raw", status: "warning" },
		]);
	});

	it("attributes final aggregate-cap truncation to the target whose text was cut", async () => {
		const targets = ["owner-large.txt:raw", "owner-missing.txt"];
		const notice = `Note: read 2 paths: ${targets.join(", ")}`;
		const largeText = "o".repeat(50 * 1024 - Buffer.byteLength(notice, "utf8") - 10);
		await Bun.write(path.join(tempDir, "owner-large.txt"), largeText);
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-cap-owner-array", { path: targets });
		expect(Buffer.byteLength(getText(result), "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(result.details?.readTargetOutcomes?.map((outcome: ReadTargetOutcome) => outcome.status)).toEqual([
			"warning",
			"error",
		]);
		expect(result.details?.readTargetOutcomes?.[0]?.message).toContain("aggregate batch text cap");
	});

	it("keeps legacy scalar-delimited batches on their prior uncapped output path", async () => {
		const legacyA = `${"a".repeat(40_000)}\nlegacy-a-end`;
		const legacyB = `${"b".repeat(40_000)}\nlegacy-b-end`;
		await Promise.all([
			Bun.write(path.join(tempDir, "legacy-large-a.txt"), legacyA),
			Bun.write(path.join(tempDir, "legacy-large-b.txt"), legacyB),
		]);
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-legacy-delimited-large", {
			path: "legacy-large-a.txt:raw; legacy-large-b.txt:raw",
		});
		const text = getText(result);
		expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(64 * 1024);
		expect(text).toContain("legacy-a-end");
		expect(text).toContain("legacy-b-end");
		expect(text).not.toContain("Batch text output capped");
		expect(result.details?.readTargetOutcomes?.map((outcome: ReadTargetOutcome) => outcome.status)).toEqual([
			"success",
			"success",
		]);
	});

	it("preserves non-error semantics when every legacy delimited target is missing", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-legacy-delimited-all-missing", {
			path: "legacy-missing-a.txt; legacy-missing-b.txt",
		});

		expect(result.isError).not.toBe(true);
		expect(result.details?.readTargetOutcomes?.map((outcome: ReadTargetOutcome) => outcome.status)).toEqual([
			"error",
			"error",
		]);
		expect(getText(result)).toContain("Could not read legacy-missing-a.txt");
		expect(getText(result)).toContain("Could not read legacy-missing-b.txt");
	});

	it("bounds aggregate native-array image output and reports dropped images", async () => {
		const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const imagePaths = Array.from({ length: 5 }, (_, index) => `batch-image-${index}.png`);
		await Promise.all(
			imagePaths.map(async (imagePath, index) => {
				const bytes = Buffer.alloc(index === imagePaths.length - 1 ? 6_000_000 : 4_000_000, index + 1);
				pngMagic.copy(bytes);
				await Bun.write(path.join(tempDir, imagePath), bytes);
			}),
		);
		const tools = await createTools(
			createTestSession(tempDir, {
				settings: Settings.isolated({
					"astGrep.enabled": true,
					"astEdit.enabled": true,
					"tools.xdev": false,
					"inspect_image.mode": "off",
					"images.autoResize": false,
				}),
			}),
		);
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");

		const result = await tool.execute("read-bounded-images", { path: imagePaths });
		const imageBlocks = result.content.filter(block => block.type === "image");
		const decodedBytes = imageBlocks.reduce((total, block) => total + Buffer.byteLength(block.data, "base64"), 0);
		expect(decodedBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
		expect(imageBlocks).toHaveLength(4);
		expect(result.details?.notes?.filter((note: string) => note.includes("image budget was exhausted"))).toHaveLength(
			1,
		);
		expect(result.details?.readTargetOutcomes?.map((outcome: ReadTargetOutcome) => outcome.status)).toEqual([
			"success",
			"success",
			"success",
			"success",
			"warning",
		]);
	});

	it("marks a batch as failed when no target can be read", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");
		const missingPaths = Array.from({ length: 32 }, (_, index) => `missing-${index}.txt`);

		const result = await tool.execute("read-all-missing", { path: missingPaths });
		const details = result.details as { readTargetOutcomes?: Array<{ path: string; status: string }> } | undefined;

		expect(result.isError).toBe(true);
		expect(details?.readTargetOutcomes).toHaveLength(32);
		expect(details?.readTargetOutcomes?.every(outcome => outcome.status === "error")).toBe(true);
		expect(Buffer.byteLength(getText(result), "utf8")).toBeLessThanOrEqual(50 * 1024);
	});

	it("aborts a native read batch instead of returning partial success", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "read");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing read tool");
		const controller = new AbortController();
		controller.abort();

		await expect(
			tool.execute("read-aborted-array", { path: ["packages/grep.txt", "apps/grep.txt"] }, controller.signal),
		).rejects.toThrow();
	});

	it("ast_grep accepts quoted path and glob filters", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_grep tool");

		const result = await tool.execute("ast-grep-quoted-path", {
			pat: "providerOptions",
			path: '"packages/**/*.ts"',
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("ast.ts");
		expect(text).not.toContain("other");
		expect(details?.fileCount).toBe(1);
		expect(details?.scopePath).toBe("packages");
	});

	it("ast_grep accepts a semicolon-delimited path list", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_grep tool");

		const result = await tool.execute("ast-grep-path-array", {
			pat: "providerOptions",
			path: "apps/**/*.ts; packages/**/*.ts; phases/**/*.ts",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## ast\.ts#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# packages\/\n## ast\.ts#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# phases\/\n## ast\.ts#[0-9A-F]{4}/m);
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps/**/*.ts, packages/**/*.ts, phases/**/*.ts");
	});

	it("ast_grep expands delimited path entries", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_grep tool");

		for (const [name, entry] of [
			["comma", "apps/**/*.ts, packages/**/*.ts"],
			["semicolon", "apps/**/*.ts;packages/**/*.ts"],
			["space", "apps/**/*.ts packages/**/*.ts"],
		] as const) {
			const result = await tool.execute(`ast-grep-delimited-${name}`, {
				pat: "providerOptions",
				path: entry,
			});
			const text = getText(result);
			const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

			expect(text).toMatch(/^# apps\/\n## ast\.ts#[0-9A-F]{4}/m);
			expect(text).toMatch(/^# packages\/\n## ast\.ts#[0-9A-F]{4}/m);
			expect(text).not.toContain("# phases");
			expect(text).not.toContain("# other");
			expect(details?.fileCount).toBe(2);
			expect(details?.scopePath).toBe("apps/**/*.ts, packages/**/*.ts");
		}
	});

	it("ast_edit applies across an explicit path array", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await createSearchFixture(tmp);
		const queue = new ToolChoiceQueue();
		const tools = await createTools(
			createTestSession(tmp, {
				getToolChoiceQueue: () => queue,
				buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
				steer: () => {},
			}),
		);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing ast_edit tool");

		const preview = await tool.execute("ast-edit-path-array", {
			ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
			paths: ["apps/**/*.ts", "packages/**/*.ts", "phases/**/*.ts"],
		});
		const text = getText(preview);
		const details = preview.details as { totalReplacements?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## ast\.ts#[0-9A-F]{4} \(\d+ replacement/m);
		expect(text).toMatch(/^# packages\/\n## ast\.ts#[0-9A-F]{4} \(\d+ replacement/m);
		expect(text).toMatch(/^# phases\/\n## ast\.ts#[0-9A-F]{4} \(\d+ replacement/m);
		expect(text).not.toContain("# other");
		expect(details?.totalReplacements).toBe(3);
		expect(details?.scopePath).toBe("apps/**/*.ts, packages/**/*.ts, phases/**/*.ts");

		const invoker = queue.peekPendingInvoker();
		if (!invoker) throw new Error("Expected pending resolve invoker");
		await invoker({ action: "apply", reason: "apply multi-path ast edit" });

		expect(await Bun.file(path.join(tmp, "apps", "ast.ts")).text()).toContain("modernWrap(appsValue, appsArg)");
		expect(await Bun.file(path.join(tmp, "packages", "ast.ts")).text()).toContain(
			"modernWrap(packagesValue, packagesArg)",
		);
		expect(await Bun.file(path.join(tmp, "phases", "ast.ts")).text()).toContain("modernWrap(phasesValue, phasesArg)");
		expect(await Bun.file(path.join(tmp, "other", "ast.ts")).text()).toContain("legacyWrap(otherValue, otherArg)");
		await removeWithRetries(tmp);
	});

	it("find accepts a semicolon-delimited path list", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		const result = await tool.execute("find-path-array", {
			path: "apps/; packages/; phases/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string; files?: string[] } | undefined;

		expect(text).toMatch(/^# apps\/\n(?:ast\.ts|grep\.txt)\n(?:ast\.ts|grep\.txt)$/m);
		expect(text).toMatch(/^# packages\/\n(?:ast\.ts|grep\.txt)\n(?:ast\.ts|grep\.txt)$/m);
		expect(text).toMatch(/^# phases\/\n(?:ast\.ts|grep\.txt)\n(?:ast\.ts|grep\.txt)$/m);
		expect(details?.files).toEqual(
			expect.arrayContaining([
				"apps/ast.ts",
				"packages/ast.ts",
				"phases/ast.ts",
				"apps/grep.txt",
				"packages/grep.txt",
				"phases/grep.txt",
			]),
		);
		expect(text).not.toContain("other/ast.ts");
		expect(details?.fileCount).toBe(6);
		expect(details?.scopePath).toBe("apps/, packages/, phases/");
	});

	it("find expands delimited path entries", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		for (const [name, entry] of [
			["comma", "apps/grep.txt, packages/grep.txt"],
			["semicolon", "apps/grep.txt;packages/grep.txt"],
			["space", "apps/grep.txt packages/grep.txt"],
		] as const) {
			const result = await tool.execute(`find-delimited-${name}`, {
				path: entry,
			});
			const text = getText(result);
			const details = result.details as { fileCount?: number; scopePath?: string; files?: string[] } | undefined;

			expect(text).toMatch(/^# apps\/\ngrep\.txt$/m);
			expect(text).toMatch(/^# packages\/\ngrep\.txt$/m);
			expect(text).not.toContain("phases");
			expect(text).not.toContain("other");
			expect(details?.fileCount).toBe(2);
			expect(details?.files).toEqual(expect.arrayContaining(["apps/grep.txt", "packages/grep.txt"]));
			expect(details?.scopePath).toBe("apps/grep.txt, packages/grep.txt");
		}
	});

	it("find keeps comma-delimited surviving entries when peers are missing", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		const result = await tool.execute("find-delimited-missing", {
			path: "missing.txt, packages/grep.txt",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; missingPaths?: string[]; files?: string[] } | undefined;

		expect(text).toMatch(/^# packages\/\ngrep\.txt$/m);
		expect(text).toContain("Skipped missing paths: missing.txt");
		expect(text).not.toContain("apps");
		expect(details?.fileCount).toBe(1);
		expect(details?.files).toEqual(["packages/grep.txt"]);
		expect(details?.missingPaths).toEqual(["missing.txt"]);
	});

	it("find keeps a single path that contains spaces", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		const result = await tool.execute("find-space-directory", {
			path: "folder with spaces/",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string; files?: string[] } | undefined;

		expect(text).toMatch(/^# folder with spaces\/\nnote\.txt$/m);
		expect(details?.fileCount).toBe(1);
		expect(details?.files).toEqual(["folder with spaces/note.txt"]);
		expect(details?.scopePath).toBe("folder with spaces");
	});

	it("find accepts quoted directory patterns", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "glob");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing glob tool");

		const result = await tool.execute("find-quoted-pattern", {
			path: '"packages/"',
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toContain("ast.ts");
		expect(text).toContain("grep.txt");
		expect(text).not.toContain("other/ast.ts");
		expect(details?.fileCount).toBe(2);
		expect(details?.scopePath).toBe("packages");
	});

	it("find keeps paths outside cwd absolute", async () => {
		const outsideDir = await fs.mkdtemp(path.join(path.dirname(tempDir), "find-outside-"));
		try {
			await Bun.write(path.join(outsideDir, "outside.txt"), "outside\n");
			const tools = await createTools(createTestSession(tempDir));
			const tool = tools.find(entry => entry.name === "glob");
			expect(tool).toBeDefined();
			if (!tool) throw new Error("Missing glob tool");

			const result = await tool.execute("find-outside-cwd", {
				path: outsideDir,
			});
			const text = getText(result);
			const expectedPath = path.join(outsideDir, "outside.txt").replace(/\\/g, "/");
			const details = result.details as { fileCount?: number; scopePath?: string; files?: string[] } | undefined;

			expect(text).toContain(`# ${outsideDir.replace(/\\/g, "/")}/\noutside.txt`);
			expect(text).not.toContain("../");
			expect(details?.fileCount).toBe(1);
			expect(details?.files).toEqual([expectedPath]);
			expect(details?.scopePath).toBe(outsideDir.replace(/\\/g, "/"));
		} finally {
			await removeWithRetries(outsideDir);
		}
	});

	it("grep accepts a bare semicolon-delimited directory list", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-bare-path-array", {
			pattern: "shared-needle",
			path: "apps; packages; phases",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# apps\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# packages\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# phases\/\n## grep\.txt#[0-9A-F]{4}/m);
		expect(text).not.toContain("# other");
		expect(details?.fileCount).toBe(3);
		expect(details?.scopePath).toBe("apps, packages, phases");
	});

	it("grep keeps explicit files exact", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await fs.mkdir(path.join(tmp, "nested"), { recursive: true });
		await Bun.write(path.join(tmp, "alpha.txt"), "exact-needle alpha\n");
		await Bun.write(path.join(tmp, "beta.txt"), "exact-needle beta\n");
		await Bun.write(path.join(tmp, "nested", "alpha.txt"), "exact-needle nested alpha\n");
		await Bun.write(path.join(tmp, "nested", "beta.txt"), "exact-needle nested beta\n");

		const tools = await createTools(createTestSession(tmp));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-exact-file-array", {
			pattern: "exact-needle",
			path: "alpha.txt; beta.txt",
		});
		const text = getText(result);
		const details = result.details as { fileCount?: number; scopePath?: string } | undefined;

		expect(text).toMatch(/^# alpha\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^# beta\.txt#[0-9A-F]{4}/m);
		expect(text).toContain("exact-needle alpha");
		expect(text).toContain("exact-needle beta");
		expect(text).not.toContain("nested");
		expect(details?.fileCount).toBe(2);
		expect(details?.scopePath).toBe("alpha.txt, beta.txt");
		await removeWithRetries(tmp);
	});

	it("grep renders only file headings that have child lines", async () => {
		const tools = await createTools(createTestSession(tempDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-no-empty-headings", {
			pattern: "shared-needle",
			path: "apps/; packages/; phases/",
		});
		const lines = getText(result).split("\n");

		for (let index = 0; index < lines.length; index += 1) {
			if (!lines[index].startsWith("#")) continue;
			const nextIndex = lines.findIndex((line, candidateIndex) => candidateIndex > index && line.trim().length > 0);
			expect(nextIndex, `heading ${lines[index]} should have rendered children`).toBeGreaterThan(index);
			if (lines[index].startsWith("##")) {
				expect(lines[nextIndex].startsWith("#")).toBe(false);
			} else if (!lines[nextIndex].startsWith("##")) {
				expect(lines[nextIndex].startsWith("#")).toBe(false);
			}
		}
	});

	it("grep explains match and context gutters with new format", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "search-path-lists-"));
		await Bun.write(path.join(tmp, "context.txt"), "#if FLAG\nneedle\n#endif\n");

		const tools = await createTools(
			createTestSession(tmp, {
				settings: Settings.isolated({ "grep.contextBefore": 1, "grep.contextAfter": 1 }),
			}),
		);
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();
		if (!tool) throw new Error("Missing grep tool");

		const result = await tool.execute("grep-context-label", {
			pattern: "needle",
			path: "context.txt",
		});
		const text = getText(result);

		expect(text).toMatch(/ 1:#if FLAG/);
		expect(text).toMatch(/\*2:needle/);
		expect(text).toMatch(/ 3:#endif/);
		await removeWithRetries(tmp);
	});
});
