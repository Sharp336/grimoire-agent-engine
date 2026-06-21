import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { closeCodemapDb } from "../db";
import { initSchema } from "../schema";
import { DeleteFileSummaryTool, GetFileSummaryTool, GetTaskContextTool, SetFileSummaryTool } from "../tools";

// --- Test fixtures ----------------------------------------------------------

let tmpDir: string;
let cwd: string;
let dbPath: string;
let client: Client;

beforeAll(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-tools-"));
	cwd = path.join(tmpDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	dbPath = path.join(tmpDir, "codemap-test.db");
	client = createClient({ url: `file:${dbPath}` });
	await initSchema(client);
});

afterAll(async () => {
	await closeCodemapDb(client);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// Best-effort — Windows may hold libSQL handles.
	}
});

function makeSession(settings: Settings): ToolSession {
	// The tool's getClient reads settings + opens a DB at dbPath.
	// We point dbPath at our temp DB so execute() uses a real client.
	return { settings, cwd } as unknown as ToolSession;
}

function enabledSettings(): Settings {
	return Settings.isolated({ "codemap.enabled": true, "codemap.dbPath": dbPath });
}

function disabledSettings(): Settings {
	return Settings.isolated({ "codemap.enabled": false });
}

const TOOL_CREATE_IF = [
	SetFileSummaryTool.createIf,
	GetFileSummaryTool.createIf,
	GetTaskContextTool.createIf,
	DeleteFileSummaryTool.createIf,
] as const;

// --- createIf gating --------------------------------------------------------

describe("codemap tools — createIf gating", () => {
	it("returns null for all four tools when codemap.enabled is false", () => {
		const session = makeSession(disabledSettings());
		for (const createIf of TOOL_CREATE_IF) {
			expect(createIf(session)).toBeNull();
		}
	});

	it("returns a tool instance for all four tools when codemap.enabled is true", () => {
		const session = makeSession(enabledSettings());
		for (const createIf of TOOL_CREATE_IF) {
			const tool = createIf(session);
			expect(tool).not.toBeNull();
			expect(typeof tool!.execute).toBe("function");
		}
	});

	it("returned instances expose the expected tool name", () => {
		const session = makeSession(enabledSettings());
		expect(SetFileSummaryTool.createIf(session)?.name).toBe("set_file_summary");
		expect(GetFileSummaryTool.createIf(session)?.name).toBe("get_file_summary");
		expect(GetTaskContextTool.createIf(session)?.name).toBe("get_task_context");
		expect(DeleteFileSummaryTool.createIf(session)?.name).toBe("delete_file_summary");
	});
});

// --- toStoredPath path-traversal guard --------------------------------------
// toStoredPath is private but runs at the START of each execute() (before
// getClient), so traversal attempts must throw before any DB access.

describe("codemap tools — path traversal guard rejects escapes", () => {
	it("rejects ../../etc/passwd via SetFileSummaryTool", async () => {
		const tool = SetFileSummaryTool.createIf(makeSession(enabledSettings()))!;
		expect(tool.execute("id", { file: "../../etc/passwd", summary: "x" })).rejects.toThrow(
			/outside the project directory/,
		);
	});

	it("rejects absolute /etc/passwd via GetFileSummaryTool", async () => {
		const tool = GetFileSummaryTool.createIf(makeSession(enabledSettings()))!;
		expect(tool.execute("id", { file: "/etc/passwd" })).rejects.toThrow(/outside the project directory/);
	});

	it("rejects deeply nested src/../../../etc/shadow via DeleteFileSummaryTool", async () => {
		const tool = DeleteFileSummaryTool.createIf(makeSession(enabledSettings()))!;
		expect(tool.execute("id", { file: "src/../../../etc/shadow" })).rejects.toThrow(/outside the project directory/);
	});
});

describe("codemap tools — toStoredPath accepts in-bounds paths", () => {
	it("stores and retrieves a summary for a normal relative path", async () => {
		// Write a real file so the content hash is non-empty.
		const filePath = "src/auth.ts";
		await fs.promises.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.promises.writeFile(path.join(cwd, filePath), "export function login() {}");

		const session = makeSession(enabledSettings());
		const setTool = SetFileSummaryTool.createIf(session)!;
		const setResult = await setTool.execute("id", { file: filePath, summary: "JWT verification logic." });
		expect(setResult.details).toHaveProperty("id");

		const getTool = GetFileSummaryTool.createIf(session)!;
		const getResult = await getTool.execute("id", { file: filePath });
		expect(getResult.details).toMatchObject({ found: true, stale: false });
	});

	it("accepts a path with internal .. that stays within cwd", async () => {
		// "src/../lib/utils.ts" resolves to "lib/utils.ts" — inside cwd.
		await fs.promises.mkdir(path.join(cwd, "lib"), { recursive: true });
		await fs.promises.writeFile(path.join(cwd, "lib", "utils.ts"), "export const x = 1;");

		const session = makeSession(enabledSettings());
		const setTool = SetFileSummaryTool.createIf(session)!;
		const setResult = await setTool.execute("id", { file: "src/../lib/utils.ts", summary: "Utility helpers." });
		expect(setResult.details).toHaveProperty("id");

		// The stored path should be normalized to "lib/utils.ts".
		const getTool = GetFileSummaryTool.createIf(session)!;
		const getResult = await getTool.execute("id", { file: "lib/utils.ts" });
		expect(getResult.details).toMatchObject({ found: true });
	});
});
