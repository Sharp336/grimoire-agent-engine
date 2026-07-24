import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatHashlineHeader, Patch, Patcher } from "@oh-my-pi/hashline";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@oh-my-pi/pi-coding-agent/edit/file-snapshot-store";
import { HashlineFilesystem } from "@oh-my-pi/pi-coding-agent/edit/hashline/filesystem";
import { writethroughNoop } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/;

describe("write tool hashline header", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-hashline-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("inserts a fresh [path#TAG] header that maps to the written content", async () => {
		const filePath = path.join(tmpDir, "module.ts");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const content = "export const value = 42;\nexport const flag = true;\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		const lines = resultText(result).split("\n");

		// First line is the hashline header; subsequent text is the byte count.
		const match = HASHLINE_HEADER_LINE.exec(lines[0] ?? "");
		expect(match).not.toBeNull();
		const [, headerPath, tag] = match!;
		expect(headerPath).toBe(path.relative(tmpDir, filePath));
		expect(lines[1]).toBe(`Successfully wrote ${content.length} bytes to ${headerPath}`);

		// The tag must address a snapshot whose content matches what we wrote so a
		// follow-up edit can land without an extra `read` round-trip.
		const snapshot = getFileSnapshotStore(session).byHash(canonicalSnapshotKey(filePath), tag!);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.text).toBe(content);
	});

	it("makes the post-write tag usable by the hashline patcher", async () => {
		const filePath = path.join(tmpDir, "config.ts");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const content = "export const enabled = false;\n";

		const writeResult = await tool.execute("call-1", { path: filePath, content });
		const headerLine = resultText(writeResult).split("\n")[0] ?? "";
		expect(HASHLINE_HEADER_LINE.test(headerLine)).toBe(true);

		// Apply a hashline patch immediately, using only the tag the write tool
		// returned — no intervening `read`.
		const patchInput = `${headerLine}\nSWAP 1.=1:\n+export const enabled = true;\n`;
		const patch = Patch.parse(patchInput, { cwd: tmpDir });
		expect(patch.sections).toHaveLength(1);

		const filesystem = new HashlineFilesystem({
			session,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: () => {
				throw new Error("deferred diagnostics unused with writethroughNoop");
			},
		});
		const patcher = new Patcher({ fs: filesystem, snapshots: getFileSnapshotStore(session) });
		const section = patch.sections[0];
		if (!section) throw new Error("expected one parsed hashline section");
		const prepared = await patcher.prepare(section);
		const sectionResult = await patcher.commit(prepared);
		expect(sectionResult.op).toBe("update");

		const final = await fs.readFile(filePath, "utf8");
		expect(final).toBe("export const enabled = true;\n");
	});

	it("omits the hashline header when the edit mode is not hashline", async () => {
		const filePath = path.join(tmpDir, "plain.txt");
		const session = createSession(tmpDir);
		session.settings.set("edit.mode", "replace");
		const tool = new WriteTool(session);
		const content = "no anchors here\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		const text = resultText(result);
		expect(text.startsWith("[")).toBe(false);
		expect(text).toBe(`Successfully wrote ${content.length} bytes to ${path.relative(tmpDir, filePath)}`);
	});

	it("hashes the escaped logical text and makes the returned header immediately reusable", async () => {
		const filePath = path.join(tmpDir, "unicode.ts");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const writeResult = await tool.execute("call-1", { path: filePath, content: "export const value = 1;\n" });
		const firstHeader = resultText(writeResult).split("\n")[0] ?? "";
		const filesystem = new HashlineFilesystem({
			session,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: () => {
				throw new Error("deferred diagnostics unused with writethroughNoop");
			},
		});
		const patcher = new Patcher({ fs: filesystem, snapshots: getFileSnapshotStore(session) });
		const rawSurrogate = "\ud800";
		const firstPatch = Patch.parse(`${firstHeader}\nSWAP 1.=1:\n+export const value = "${rawSurrogate}";\n`, {
			cwd: tmpDir,
		});
		const firstSection = firstPatch.sections[0];
		if (!firstSection) throw new Error("expected one Unicode hashline section");
		const firstResult = await patcher.commit(await patcher.prepare(firstSection));

		expect(firstResult.escapedCodeUnits).toBe(1);
		expect(await Bun.file(filePath).text()).toBe(`${String.raw`export const value = "\uD800";`}\n`);
		expect(firstResult.header).toMatch(HASHLINE_HEADER_LINE);

		const secondPatch = Patch.parse(`${firstResult.header}\nSWAP 1.=1:\n+export const value = "reused";\n`, {
			cwd: tmpDir,
		});
		const secondSection = secondPatch.sections[0];
		if (!secondSection) throw new Error("expected one reusable hashline section");
		const secondResult = await patcher.commit(await patcher.prepare(secondSection));

		expect(secondResult.op).toBe("update");
		expect(await Bun.file(filePath).text()).toBe('export const value = "reused";\n');
	});

	it("uses destination format for hashline moves and reuses every returned header", async () => {
		const session = createSession(tmpDir);
		const snapshots = getFileSnapshotStore(session);
		const filesystem = new HashlineFilesystem({
			session,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: () => {
				throw new Error("deferred diagnostics unused with writethroughNoop");
			},
		});
		const patcher = new Patcher({ fs: filesystem, snapshots });
		const seedHeader = async (relativePath: string) => {
			const logical = await filesystem.readText(relativePath);
			const tag = snapshots.record(filesystem.canonicalPath(relativePath), logical);
			return formatHashlineHeader(relativePath, tag);
		};
		const commit = async (patchText: string) => {
			const parsed = Patch.parse(patchText, { cwd: tmpDir });
			const section = parsed.sections[0];
			if (!section) throw new Error("expected one cross-format move section");
			return patcher.commit(await patcher.prepare(section));
		};
		const notebookJson = (source: string, identity: string) =>
			JSON.stringify(
				{
					cells: [{ cell_type: "markdown", metadata: { cell: identity }, source: [source] }],
					metadata: { identity },
					nbformat: 4,
					nbformat_minor: 5,
				},
				null,
				1,
			);

		await Bun.write(path.join(tmpDir, "notebook-source.ipynb"), notebookJson("notebook old", "preserve"));
		const notebookMove = await commit(
			`${await seedHeader("notebook-source.ipynb")}\nSWAP 2.=2:\n+notebook moved\nMV notebook-moved.ipynb\n`,
		);
		const movedNotebook = JSON.parse(await Bun.file(path.join(tmpDir, "notebook-moved.ipynb")).text()) as {
			metadata: Record<string, unknown>;
		};
		expect(movedNotebook.metadata.identity).toBe("preserve");
		const notebookReuse = await commit(`${notebookMove.header}\nSWAP 2.=2:\n+notebook reused\n`);
		expect(notebookReuse.op).toBe("update");

		await Bun.write(path.join(tmpDir, "plain-source.txt"), "# %% [markdown]\nplain old");
		const plainMove = await commit(
			`${await seedHeader("plain-source.txt")}\nSWAP 2.=2:\n+plain moved\nMV plain-moved.ipynb\n`,
		);
		const plainNotebook = JSON.parse(await Bun.file(path.join(tmpDir, "plain-moved.ipynb")).text()) as {
			cells: unknown[];
			nbformat: number;
		};
		expect(plainNotebook.nbformat).toBe(4);
		expect(plainNotebook.cells).toHaveLength(1);
		const plainReuse = await commit(`${plainMove.header}\nSWAP 2.=2:\n+plain reused\n`);
		expect(plainReuse.op).toBe("update");

		await Bun.write(path.join(tmpDir, "to-plain.ipynb"), notebookJson("virtual old", "to-plain"));
		const toPlainMove = await commit(
			`${await seedHeader("to-plain.ipynb")}\nSWAP 2.=2:\n+virtual moved\nMV virtual.txt\n`,
		);
		const plainText = await Bun.file(path.join(tmpDir, "virtual.txt")).text();
		expect(plainText).toBe("# %% [markdown] cell:0\nvirtual moved");
		expect(plainText).not.toContain("nbformat");
		const toPlainReuse = await commit(`${toPlainMove.header}\nSWAP 2.=2:\n+virtual reused\n`);
		expect(toPlainReuse.op).toBe("update");
		expect(await Bun.file(path.join(tmpDir, "virtual.txt")).text()).toContain("virtual reused");
	});
});
