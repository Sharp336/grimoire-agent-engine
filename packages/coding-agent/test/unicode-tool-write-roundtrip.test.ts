import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type ToolCall, validateToolArguments } from "@oh-my-pi/pi-ai";
import { finalizeToolCallArgumentsDone } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { XdevRegistry } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { type ArchiveMemberContent, readArchiveEntries } from "@oh-my-pi/pi-coding-agent/utils/zip";
import { parseStreamingJson, removeWithRetries } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

// Lone UTF-16 surrogate code units used across the suite.
const LONE_HIGH = "\ud800";
const LONE_LOW = "\udc00";
const REPLACEMENT_BYTES = [0xef, 0xbf, 0xbd] as const;

function createSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		...overrides,
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("\n");
}

function containsReplacementBytes(bytes: Uint8Array): boolean {
	for (let i = 0; i + 2 < bytes.length; i++) {
		if (
			bytes[i] === REPLACEMENT_BYTES[0] &&
			bytes[i + 1] === REPLACEMENT_BYTES[1] &&
			bytes[i + 2] === REPLACEMENT_BYTES[2]
		) {
			return true;
		}
	}
	return false;
}

describe("unicode file-tool persistence", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "unicode-write-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("carries raw lone surrogates through streamed JSON finalization and escapes them at the sink", async () => {
		const filePath = path.join(tmpDir, "note.txt");
		// Wire JSON with two independent `\uXXXX` escapes plus valid Hangul/emoji.
		const wire = `{"path":${JSON.stringify(filePath)},"content":"한 ${String.raw`\uD800`} 😀 ${String.raw`\uDC00`} 끝"}`;

		const block: ToolCall & { [kStreamingPartialJson]: string } = {
			type: "toolCall",
			id: "call-1",
			name: "write",
			arguments: {},
			[kStreamingPartialJson]: "",
		};
		for (let i = 0; i < wire.length; i += 3) {
			block[kStreamingPartialJson] += wire.slice(i, i + 3);
			parseStreamingJson(block[kStreamingPartialJson]);
		}
		finalizeToolCallArgumentsDone(block, block[kStreamingPartialJson]);
		const tool = new WriteTool(createSession(tmpDir));
		const validated = validateToolArguments(tool, block);
		if (typeof validated.path !== "string" || typeof validated.content !== "string") {
			throw new Error("write arguments were not finalized as strings");
		}
		const args = { path: validated.path, content: validated.content };

		// At dispatch the lone surrogates are still raw code units, not escapes or U+FFFD.
		expect(args.content.includes(LONE_HIGH)).toBe(true);
		expect(args.content.includes(LONE_LOW)).toBe(true);
		expect(args.content.includes("\ufffd")).toBe(false);
		expect(args.content.includes("한")).toBe(true);
		expect(args.content.includes("😀")).toBe(true);

		const result = await tool.execute("call-1", args);

		const bytes = await Bun.file(filePath).bytes();
		expect(containsReplacementBytes(bytes)).toBe(false);
		const onDisk = new TextDecoder().decode(bytes);
		expect(onDisk.includes(String.raw`\uD800`)).toBe(true);
		expect(onDisk.includes(String.raw`\uDC00`)).toBe(true);
		expect(onDisk.includes("한")).toBe(true);
		expect(onDisk.includes("😀")).toBe(true);
		expect(result.details?.escapedCodeUnits).toBe(2);
		expect(resultText(result)).toContain(`Escaped 2 invalid Unicode code unit(s) before writing`);
	});

	it("keeps valid Unicode byte-identical with a zero count and no notice", async () => {
		const filePath = path.join(tmpDir, "valid.txt");
		const content = ["한", "\u1112\u1161\u11ab", "\u314e\u314f\u3134", "😀", String.raw`literal \uD800`, "�"].join(
			"\n",
		);
		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-1", { path: filePath, content });

		expect(await Bun.file(filePath).text()).toBe(content);
		expect(result.details?.escapedCodeUnits).toBe(0);
		expect(resultText(result)).not.toContain("invalid Unicode code unit");
	});

	it("writes raw .ipynb content verbatim without invoking virtual-cell serialization", async () => {
		const filePath = path.join(tmpDir, "book.ipynb");
		const notebook = {
			cells: [
				{ cell_type: "markdown", metadata: {}, source: ["# 제목 한글\n", "본문 😀"] },
				{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["print('한')\n"] },
			],
			metadata: { kernelspec: { name: "python3" } },
			nbformat: 4,
			nbformat_minor: 5,
		};
		const raw = JSON.stringify(notebook, null, 1);
		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-1", { path: filePath, content: raw });

		// Byte-identical: WriteTool never rewraps a notebook payload as a virtual cell.
		expect(await Bun.file(filePath).text()).toBe(raw);
		const parsed = JSON.parse(await Bun.file(filePath).text());
		expect(parsed.cells).toHaveLength(2);
		expect(parsed.cells[0].cell_type).toBe("markdown");
		expect(parsed.cells[1].cell_type).toBe("code");
		expect(parsed.nbformat).toBe(4);
		// No cell-marker header leaked in — proof virtual serialization was not run.
		expect(await Bun.file(filePath).text()).not.toContain("# %% [");
		expect(result.details?.escapedCodeUnits).toBe(0);
	});

	it("escapes raw surrogate code units inside notebook JSON without changing its container", async () => {
		const filePath = path.join(tmpDir, "broken-book.ipynb");
		const encoded = JSON.stringify({
			cells: [{ cell_type: "markdown", metadata: {}, source: ["broken \ud800"] }],
			metadata: { identity: "raw-write" },
			nbformat: 4,
			nbformat_minor: 5,
		});
		const rawSurrogateJson = encoded.replace(String.raw`\ud800`, LONE_HIGH);
		expect(rawSurrogateJson.includes(LONE_HIGH)).toBe(true);

		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-broken-book", { path: filePath, content: rawSurrogateJson });
		const persistedText = await Bun.file(filePath).text();
		const persisted = JSON.parse(persistedText) as {
			cells: Array<{ source: string[] }>;
			metadata: Record<string, unknown>;
		};

		expect(persisted.metadata.identity).toBe("raw-write");
		expect(persisted.cells[0]?.source[0]?.charCodeAt(7)).toBe(0xd800);
		expect(persistedText).toContain(String.raw`\uD800`);
		expect(persistedText).not.toContain("# %% [");
		expect(result.details?.escapedCodeUnits).toBe(1);
		expect(resultText(result).match(/Escaped 1 invalid Unicode/g)).toHaveLength(1);
	});
	it("persists SQLite string values with shielded surrogate escapes, not U+FFFD", async () => {
		const dbPath = path.join(tmpDir, "app.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
		db.close();

		const tool = new WriteTool(createSession(tmpDir));
		// JSON5 with comments, a literal-backslash control, and raw lone surrogates.
		const content = `{
			// leading comment ${LONE_HIGH} (in a comment, must not count)
			body: "start ${LONE_HIGH} mid \\\\ end ${LONE_LOW}",
		}`;
		const result = await tool.execute("call-1", { path: `${dbPath}:notes`, content });

		const readDb = new Database(dbPath, { readonly: true });
		const row = readDb.prepare<{ body: string }, []>("SELECT body FROM notes LIMIT 1").get();
		readDb.close();

		expect(row).not.toBeNull();
		const body = row?.body ?? "";
		expect(body.includes("\ufffd")).toBe(false);
		expect(body.includes(String.raw`\uD800`)).toBe(true);
		expect(body.includes(String.raw`\uDC00`)).toBe(true);
		// The literal backslash pair survives without being double-decoded.
		expect(body.includes("\\")).toBe(true);
		// Only the two surrogates inside the persisted string value count; the one in the comment does not.
		expect(result.details?.escapedCodeUnits).toBe(2);
		expect(resultText(result)).toContain("Escaped 2 invalid Unicode code unit(s) before writing");
	});

	it("shields single-quoted and permissively escaped JSON5 surrogate values", async () => {
		const dbPath = path.join(tmpDir, "quotes.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE payloads (id INTEGER PRIMARY KEY, body TEXT NOT NULL, title TEXT NOT NULL)");
		db.close();
		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-quotes", {
			path: `${dbPath}:payloads`,
			content: `{ body: 'single ${LONE_LOW}', title: "escaped \\${LONE_HIGH}" }`,
		});

		const readDb = new Database(dbPath, { readonly: true });
		const row = readDb.prepare<{ body: string; title: string }, []>("SELECT body, title FROM payloads LIMIT 1").get();
		readDb.close();
		expect(row?.body).toBe(`single ${String.raw`\uDC00`}`);
		expect(row?.title).toBe(`escaped ${String.raw`\uD800`}`);
		expect(result.details?.escapedCodeUnits).toBe(2);
		expect(resultText(result).match(/Escaped 2 invalid Unicode/g)).toHaveLength(1);
	});

	it("preserves valid surrogate pairs after permissive JSON5 escapes", async () => {
		const dbPath = path.join(tmpDir, "emoji.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE payloads (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
		db.close();
		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-emoji", {
			path: `${dbPath}:payloads`,
			content: `{ body: "escaped \\😀" }`,
		});

		const readDb = new Database(dbPath, { readonly: true });
		const row = readDb.prepare<{ body: string }, []>("SELECT body FROM payloads LIMIT 1").get();
		readDb.close();
		expect(row?.body).toBe("escaped 😀");
		expect(result.details?.escapedCodeUnits).toBe(0);
		expect(resultText(result)).not.toContain("invalid Unicode code unit");
	});

	it("forwards xd:// device payloads verbatim with no escape count or notice", async () => {
		const captureSchema = type({ value: "string" });
		let received: string | undefined;
		const captureTool: AgentTool<typeof captureSchema> = {
			name: "capture",
			label: "Capture",
			description: "records the payload it receives",
			parameters: captureSchema,
			execute: async (_id, args) => {
				received = args.value;
				return { content: [{ type: "text", text: "captured" }] };
			},
		};
		const session = createSession(tmpDir, { xdevRegistry: new XdevRegistry([captureTool]) });
		const tool = new WriteTool(session);

		const deviceContent = JSON.stringify({ value: `a${LONE_HIGH}b` });
		const result = await tool.execute("call-1", { path: "xd://capture", content: deviceContent });

		// The wrapped device sees the identical raw code unit (no escape, no U+FFFD).
		expect(received).toBeDefined();
		expect(received?.charCodeAt(1)).toBe(0xd800);
		expect(received?.includes(String.raw`\uD800`)).toBe(false);
		// Delegated route: no persistence claim.
		expect(result.details?.escapedCodeUnits).toBeUndefined();
		expect(resultText(result)).not.toContain("invalid Unicode code unit");
	});

	it("escapes archive member content before packing while leaving valid text intact", async () => {
		const archivePath = path.join(tmpDir, "bundle.zip");
		const tool = new WriteTool(createSession(tmpDir));

		const good = await tool.execute("call-good", {
			path: `${archivePath}:docs/한글.txt`,
			content: "한글 본문 😀\n",
		});
		expect(good.details?.escapedCodeUnits).toBe(0);

		const bad = await tool.execute("call-bad", {
			path: `${archivePath}:docs/broken.txt`,
			content: `x${LONE_HIGH}y`,
		});
		expect(bad.details?.escapedCodeUnits).toBe(1);
		expect(resultText(bad)).toContain("Escaped 1 invalid Unicode code unit(s) before writing");

		const members = await readArchiveEntries(archivePath);
		const decode = async (member: ArchiveMemberContent | undefined): Promise<string> => {
			if (member === undefined) return "";
			if (typeof member === "string") return member;
			if (member instanceof Blob) return member.text();
			return new TextDecoder().decode(member);
		};
		expect(await decode(members.get("docs/한글.txt"))).toBe("한글 본문 😀\n");
		// The lone surrogate landed as its literal escape, never U+FFFD.
		expect(await decode(members.get("docs/broken.txt"))).toBe(String.raw`x\uD800y`);
	});

	// JSON5 accepts CR, LS (U+2028) and PS (U+2029) as line terminators, so a `//`
	// comment closed by any of them still leaves the following property live.
	for (const [label, terminator] of [
		["a carriage return", "\r"],
		["a line separator", "\u2028"],
		["a paragraph separator", "\u2029"],
	] as const) {
		it(`shields surrogates after a JSON5 comment closed by ${label}`, async () => {
			const dbPath = path.join(tmpDir, `${label.replaceAll(" ", "-")}.db`);
			const db = new Database(dbPath);
			db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
			db.close();

			const tool = new WriteTool(createSession(tmpDir));
			const result = await tool.execute("call-term", {
				path: `${dbPath}:notes`,
				content: `{ // note${terminator}body: "v ${LONE_HIGH}" }`,
			});

			const readDb = new Database(dbPath, { readonly: true });
			const row = readDb.prepare<{ body: string }, []>("SELECT body FROM notes LIMIT 1").get();
			readDb.close();

			expect(row?.body).toBe(`v ${String.raw`\uD800`}`);
			expect(result.details?.escapedCodeUnits).toBe(1);
		});
	}

	it("shields a lone surrogate spelled as a JSON5 \\uXXXX escape", async () => {
		const dbPath = path.join(tmpDir, "escaped-lone.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
		db.close();

		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-escaped-lone", {
			path: `${dbPath}:notes`,
			content: String.raw`{ body: "lone \uD800" }`,
		});

		const readDb = new Database(dbPath, { readonly: true });
		const row = readDb.prepare<{ body: string }, []>("SELECT body FROM notes LIMIT 1").get();
		readDb.close();

		// Persisted as the literal escape it already spelled — never U+FFFD.
		expect(row?.body).toBe(`lone ${String.raw`\uD800`}`);
		expect(result.details?.escapedCodeUnits).toBe(1);
		expect(resultText(result)).toContain("Escaped 1 invalid Unicode code unit(s) before writing");
	});

	it("leaves a well-formed \\uXXXX surrogate pair intact", async () => {
		const dbPath = path.join(tmpDir, "escaped-pair.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
		db.close();

		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-escaped-pair", {
			path: `${dbPath}:notes`,
			content: String.raw`{ body: "emoji \uD83D\uDE00" }`,
		});

		const readDb = new Database(dbPath, { readonly: true });
		const row = readDb.prepare<{ body: string }, []>("SELECT body FROM notes LIMIT 1").get();
		readDb.close();

		expect(row?.body).toBe("emoji 😀");
		expect(result.details?.escapedCodeUnits).toBe(0);
		expect(resultText(result)).not.toContain("invalid Unicode code unit");
	});

	// A surrogate pair is a pair whatever each half was spelled as: shielding
	// must decide on the decoded code unit, never on the source form.
	const HIGH_EMOJI = "\ud83d";
	const LOW_EMOJI = "\ude00";
	for (const [label, body] of [
		["raw high with escaped low", `${HIGH_EMOJI}${String.raw`\uDE00`}`],
		["escaped high with raw low", `${String.raw`\uD83D`}${LOW_EMOJI}`],
	] as const) {
		it(`leaves a mixed-form surrogate pair intact — ${label}`, async () => {
			const dbPath = path.join(tmpDir, `mixed-${label.replace(/\s+/g, "-")}.db`);
			const db = new Database(dbPath);
			db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
			db.close();

			const tool = new WriteTool(createSession(tmpDir));
			const result = await tool.execute("call-mixed-pair", {
				path: `${dbPath}:notes`,
				content: `{ body: "mixed ${body}" }`,
			});

			const readDb = new Database(dbPath, { readonly: true });
			const row = readDb.prepare<{ body: string }, []>("SELECT body FROM notes LIMIT 1").get();
			readDb.close();

			expect(row?.body).toBe("mixed 😀");
			expect(result.details?.escapedCodeUnits).toBe(0);
			expect(resultText(result)).not.toContain("invalid Unicode code unit");
		});
	}

	it("counts an escaped high surrogate beside a raw high surrogate as two lone units", async () => {
		const dbPath = path.join(tmpDir, "mixed-two-highs.db");
		const db = new Database(dbPath);
		db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
		db.close();

		const tool = new WriteTool(createSession(tmpDir));
		const result = await tool.execute("call-mixed-lone", {
			path: `${dbPath}:notes`,
			content: `{ body: "lone ${String.raw`\uD83D`}${HIGH_EMOJI}" }`,
		});

		const readDb = new Database(dbPath, { readonly: true });
		const row = readDb.prepare<{ body: string }, []>("SELECT body FROM notes LIMIT 1").get();
		readDb.close();

		// Neither high surrogate pairs with anything, so both persist as literal escapes.
		expect(row?.body).toBe(`lone ${String.raw`\uD83D\uD83D`}`);
		expect(result.details?.escapedCodeUnits).toBe(2);
		expect(resultText(result)).toContain("Escaped 2 invalid Unicode code unit(s) before writing");
	});
});
