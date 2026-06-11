import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { writethroughNoop } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { executeHashlineSingle } from "../../src/edit/hashline/execute";
import { HASHLINE_EDIT_INPUT_GUIDANCE } from "../../src/edit/hashline/guidance";
import { parseHashlineEditInput } from "../../src/edit/hashline/parse-input";

const tools = ["read", "search", "find", "edit", "write", "bash"];
const scriptedRules = DEFAULT_BASH_INTERCEPTOR_RULES.filter(
	r => r.tool === "edit" && (r.pattern.includes("python") || r.pattern.includes("node|nodejs|bun")),
);
const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/;

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
	} as ToolSession;
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

function deferredDiagnosticsStub() {
	return {
		onDeferredDiagnostics: () => {},
		signal: new AbortController().signal,
		finalize: () => {},
	};
}

describe("Grok hashline steering integration", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grok-hashline-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("blocks python -c file write with shared HASHLINE_EDIT_INPUT_GUIDANCE", () => {
		const cmd = "python -c \"open('target.ts','w').write('x')\"";
		const result = checkBashInterception(cmd, tools, scriptedRules);
		expect(result.block).toBe(true);
		expect(result.message).toContain(HASHLINE_EDIT_INPUT_GUIDANCE);
		expect(result.suggestedTool).toBe("edit");
	});

	it("applies hashline edit after write tag (Grok happy path)", async () => {
		const filePath = path.join(tmpDir, "target.ts");
		const session = createSession(tmpDir);
		const writeTool = new WriteTool(session);
		const content = 'export const GROK_HASHLINE_MARKER = "before-grok-edit";\n';
		const writeResult = await writeTool.execute("w1", { path: filePath, content });
		const headerLine = resultText(writeResult).split("\n")[0] ?? "";
		expect(HASHLINE_HEADER_LINE.test(headerLine)).toBe(true);

		const input = `${headerLine}\nreplace 1..1:\n+export const GROK_HASHLINE_MARKER = "after-grok-hashline-edit";`;
		await executeHashlineSingle({
			session,
			input,
			writethrough: writethroughNoop,
			beginDeferredDiagnosticsForPath: deferredDiagnosticsStub,
		});
		const after = await fs.readFile(filePath, "utf8");
		expect(after).toContain("after-grok-hashline-edit");
	});

	it("rejects prose-only edit input with guidance (Grok failure mode)", () => {
		try {
			parseHashlineEditInput("please change target.ts for me", tmpDir);
			expect(true).toBe(false);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).toContain(HASHLINE_EDIT_INPUT_GUIDANCE);
		}
	});
});
