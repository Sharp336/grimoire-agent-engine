import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applyPatch,
	EditTool,
	executeReplaceSingle,
	type FileSystem,
	type PrepareWriteArgs,
} from "@oh-my-pi/pi-coding-agent/edit";
import {
	readEditFileText,
	type SerializedEditFileText,
	toPersistedEdit,
} from "@oh-my-pi/pi-coding-agent/edit/read-file";
import { writethroughNoop } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const LONE_HIGH = "\ud800";
const LONE_LOW = "\udc00";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
	};
}

function notebook(source: string, metadata: Record<string, unknown> = {}): string {
	return JSON.stringify(
		{
			cells: [
				{
					cell_type: "markdown",
					metadata: { preserved: "cell" },
					source: [source],
				},
			],
			metadata,
			nbformat: 4,
			nbformat_minor: 5,
		},
		null,
		1,
	);
}

function textFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n");
}

class RecordingFileSystem implements FileSystem {
	readonly files = new Map<string, string>();
	readonly preparedCalls: PrepareWriteArgs[] = [];
	readonly writes: Array<{ path: string; content: string }> = [];

	async exists(filePath: string): Promise<boolean> {
		return this.files.has(filePath);
	}

	async read(filePath: string): Promise<string> {
		const value = this.files.get(filePath);
		if (value === undefined) throw Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
		return value;
	}

	async prepareWrite(args: PrepareWriteArgs): Promise<SerializedEditFileText> {
		this.preparedCalls.push(args);
		return toPersistedEdit(args.candidate);
	}

	async write(filePath: string, content: string): Promise<void> {
		this.writes.push({ path: filePath, content });
		this.files.set(filePath, content);
	}

	async delete(filePath: string): Promise<void> {
		this.files.delete(filePath);
	}

	async mkdir(): Promise<void> {}
}

describe("Unicode edit persistence boundary", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "unicode-edit-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("prepares injected patch adapters during dry-run and writes only prepared physical text on commit", async () => {
		const adapter = new RecordingFileSystem();
		const target = path.join(tmpDir, "memory.txt");
		adapter.files.set(target, "old\n");
		const input = {
			path: "memory.txt",
			op: "update" as const,
			diff: `@@\n-old\n+new ${LONE_HIGH}`,
		};

		const preview = await applyPatch(input, { cwd: tmpDir, dryRun: true, fs: adapter });
		expect(adapter.preparedCalls).toHaveLength(1);
		expect(adapter.preparedCalls[0]?.sourcePath).toBe(target);
		expect(adapter.preparedCalls[0]?.targetPath).toBe(target);
		expect(adapter.writes).toHaveLength(0);
		expect(preview.change.newContent).toBe(`${String.raw`new \uD800`}\n`);
		expect(preview.change.prepared?.escapedCodeUnits).toBe(1);
		expect(adapter.files.get(target)).toBe("old\n");

		const committed = await applyPatch(input, { cwd: tmpDir, fs: adapter });
		expect(adapter.preparedCalls).toHaveLength(2);
		expect(adapter.writes).toEqual([{ path: target, content: `${String.raw`new \uD800`}\n` }]);
		expect(committed.change.newContent).toBe(preview.change.newContent);
		expect(adapter.files.get(target)).toBe(`${String.raw`new \uD800`}\n`);
	});

	it("replace mode preserves notebook metadata while diffing and reporting virtual text", async () => {
		const filePath = path.join(tmpDir, "book.ipynb");
		await Bun.write(filePath, notebook("hello", { owner: "unicode-test" }));
		const session = createSession(tmpDir);
		const result = await executeReplaceSingle({
			session,
			path: "book.ipynb",
			params: { old_text: "hello", new_text: `한 ${LONE_HIGH} 😀` },
			allowFuzzy: false,
			fuzzyThreshold: 1,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: () => {
				throw new Error("deferred diagnostics are unused with writethroughNoop");
			},
		});

		const persisted = JSON.parse(await Bun.file(filePath).text()) as {
			cells: Array<{ metadata: Record<string, unknown>; source: string[] }>;
			metadata: Record<string, unknown>;
		};
		expect(persisted.metadata.owner).toBe("unicode-test");
		expect(persisted.cells[0]?.metadata.preserved).toBe("cell");
		expect(persisted.cells[0]?.source.join("")).toBe(`한 ${String.raw`\uD800`} 😀`);
		expect(result.details?.escapedCodeUnits).toBe(1);
		expect(result.details?.newText).toContain(`한 ${String.raw`\uD800`} 😀`);
		expect(result.details?.newText).not.toContain("nbformat");
		expect(result.details?.diff).not.toContain('"cells"');
		expect(result.details?.diff).not.toContain("nbformat");
		expect(textFromResult(result)).toContain("Escaped 1 invalid Unicode code unit(s) before writing book.ipynb.");
	});

	it("patch mode prepares notebook JSON physically but returns logical virtual text", async () => {
		const filePath = path.join(tmpDir, "patch-book.ipynb");
		await Bun.write(filePath, notebook("before", { preserved: true }));

		const result = await applyPatch(
			{
				path: "patch-book.ipynb",
				op: "update",
				diff: `@@\n-before\n+after ${LONE_LOW}`,
			},
			{ cwd: tmpDir },
		);

		expect(result.change.type).toBe("update");
		expect(result.change.newContent).toContain(String.raw`after \uDC00`);
		expect(result.change.newContent).not.toContain("nbformat");
		expect(result.change.prepared?.escapedCodeUnits).toBe(1);
		expect(result.change.prepared?.content).toContain('"nbformat": 4');
		const persisted = JSON.parse(await Bun.file(filePath).text()) as {
			cells: Array<{ source: string[] }>;
			metadata: Record<string, unknown>;
		};
		expect(persisted.metadata.preserved).toBe(true);
		expect(persisted.cells[0]?.source.join("")).toBe(String.raw`after \uDC00`);
		expect(await readEditFileText(filePath, "patch-book.ipynb")).toBe(result.change.newContent ?? "");
	});

	it("uses destination format for patch moves in every direction", async () => {
		const notebookSource = path.join(tmpDir, "source.ipynb");
		await Bun.write(notebookSource, notebook("notebook text", { identity: "keep-me" }));
		const notebookMove = await applyPatch(
			{
				path: "source.ipynb",
				rename: "moved.ipynb",
				op: "update",
				diff: "@@\n-notebook text\n+notebook moved",
			},
			{ cwd: tmpDir },
		);
		const movedNotebookPath = path.join(tmpDir, "moved.ipynb");
		const movedNotebook = JSON.parse(await Bun.file(movedNotebookPath).text()) as {
			metadata: Record<string, unknown>;
		};
		expect(movedNotebook.metadata.identity).toBe("keep-me");
		expect(await readEditFileText(movedNotebookPath, "moved.ipynb")).toContain("notebook moved");
		expect(notebookMove.change.newContent).not.toContain("nbformat");

		const plainSource = path.join(tmpDir, "plain.txt");
		await Bun.write(plainSource, "# %% [markdown]\nplain text\n");
		await applyPatch(
			{
				path: "plain.txt",
				rename: "plain-to-notebook.ipynb",
				op: "update",
				diff: "@@\n-plain text\n+plain moved",
			},
			{ cwd: tmpDir },
		);
		const plainToNotebook = path.join(tmpDir, "plain-to-notebook.ipynb");
		const plainNotebookJson = JSON.parse(await Bun.file(plainToNotebook).text()) as {
			nbformat: number;
			cells: unknown[];
		};
		expect(plainNotebookJson.nbformat).toBe(4);
		expect(plainNotebookJson.cells).toHaveLength(1);
		expect(await readEditFileText(plainToNotebook, "plain-to-notebook.ipynb")).toContain("plain moved");

		const toPlain = path.join(tmpDir, "notebook-to-plain.ipynb");
		await Bun.write(toPlain, notebook("original virtual"));
		const notebookToPlain = await applyPatch(
			{
				path: "notebook-to-plain.ipynb",
				rename: "notebook.txt",
				op: "update",
				diff: "@@\n-original virtual\n+plain virtual",
			},
			{ cwd: tmpDir },
		);
		const plainDestination = path.join(tmpDir, "notebook.txt");
		expect(await Bun.file(plainDestination).text()).toBe(notebookToPlain.change.newContent ?? "");
		expect(await Bun.file(plainDestination).text()).toContain("plain virtual");
		expect(await Bun.file(plainDestination).text()).not.toContain("nbformat");
	});

	it("sums same-path child escape counts while retaining exactly one notice per committed edit", async () => {
		const filePath = path.join(tmpDir, "same-path.txt");
		await Bun.write(filePath, "one\ntwo\n");
		const session = createSession(tmpDir);
		session.settings.set("edit.mode", "replace");
		const tool = new EditTool(session);
		const result = await tool.execute("same-path-unicode", {
			path: "same-path.txt",
			edits: [
				{ old_text: "one", new_text: `one ${LONE_HIGH}` },
				{ old_text: "two", new_text: `two ${LONE_LOW}` },
			],
		});
		const text = textFromResult(result);

		expect(await Bun.file(filePath).text()).toBe(`one ${String.raw`\uD800`}\ntwo ${String.raw`\uDC00`}\n`);
		expect(result.details?.escapedCodeUnits).toBe(2);
		expect(text.match(/Escaped 1 invalid Unicode/g)).toHaveLength(2);
		expect(text).not.toContain("Escaped 2 invalid Unicode");
	});
});
