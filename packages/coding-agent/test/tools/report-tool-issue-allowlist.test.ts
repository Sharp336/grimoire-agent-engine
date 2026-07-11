import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	__resetAutoQaConsentForTests,
	__resetAutoQaFlushStateForTests,
	createReportToolIssueTool,
} from "@oh-my-pi/pi-coding-agent/tools/report-tool-issue";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("createReportToolIssueTool allowlist", () => {
	let tempDir: TempDir;
	let dbPath: string;

	beforeEach(() => {
		__resetAutoQaConsentForTests();
		__resetAutoQaFlushStateForTests();
		tempDir = TempDir.createSync("@pi-report-tool-issue-allowlist-");
		dbPath = path.join(tempDir.path(), "autoqa.db");
		spyOn(piUtils, "getAutoQaDbDir").mockReturnValue(dbPath);
	});

	afterEach(async () => {
		__resetAutoQaConsentForTests();
		__resetAutoQaFlushStateForTests();
		await tempDir.remove();
	});

	function createSession(): ToolSession {
		return {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"dev.autoqa": true,
				"dev.autoqa.consent": "granted",
			}),
			getActiveModelString: () => "test-model",
		};
	}

	function readReports(tool: string): Array<{ tool: string; report: string }> {
		const db = new Database(dbPath);
		try {
			return db
				.prepare("SELECT tool, report FROM grievances WHERE tool = ? ORDER BY id ASC")
				.all(tool) as Array<{ tool: string; report: string }>;
		} finally {
			db.close();
		}
	}

	it("accepts generate_image when it is in the active reportable tool set", async () => {
		const tool = createReportToolIssueTool(createSession(), ["bash", "generate_image", "read"]);
		await tool.execute("call-1", {
			tool: "generate_image",
			report: "image generation failed before provider call",
		});
		expect(readReports("generate_image")).toEqual([
			{ tool: "generate_image", report: "image generation failed before provider call" },
		]);
	});

	it("rejects generate_image when the allowlist is non-empty and omits it", async () => {
		const tool = createReportToolIssueTool(createSession(), ["bash", "read"]);
		await tool.execute("call-2", {
			tool: "generate_image",
			report: "should not be recorded",
		});
		// Silent drop never opens the AutoQA DB, so the file stays absent.
		expect(await Bun.file(dbPath).exists()).toBe(false);
	});

	it("includes generate_image and tts in the schema enum when provided", () => {
		const tool = createReportToolIssueTool(createSession(), ["bash", "generate_image", "tts"]);
		const schema = tool.parameters as { toJsonSchema?: () => unknown };
		const json = typeof schema.toJsonSchema === "function" ? (schema.toJsonSchema() as any) : undefined;
		const toolSchema = json?.properties?.tool;
		const enumValues: string[] | undefined =
			toolSchema?.enum ??
			toolSchema?.anyOf?.flatMap((entry: { const?: string }) => (entry.const ? [entry.const] : []));
		expect(enumValues).toContain("generate_image");
		expect(enumValues).toContain("tts");
		expect(enumValues).toContain("bash");
	});
});
