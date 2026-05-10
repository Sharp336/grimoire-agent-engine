import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvolutionBoardTool } from "@oh-my-pi/pi-coding-agent/tools/evolution-board";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

let tmpDir: string;

function createSessionInTmp(): ToolSession {
	return createSession({ cwd: tmpDir });
}

afterAll(async () => {
	if (tmpDir) {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
});

describe("EvolutionBoardTool", () => {
	it("returns error when no evolution board file exists", async () => {
		tmpDir = await fs.mkdtemp(path.join("/tmp", "evolution-board-test-"));
		const tool = new EvolutionBoardTool(createSessionInTmp());
		const result = await tool.execute("test-id", { action: "list" });
		expect((result.content[0] as { type: string; text: string }).text).toContain("No evolution board found");
	});

	describe("add action", () => {
		it("creates topic and saves to YAML", async () => {
			tmpDir = await fs.mkdtemp(path.join("/tmp", "evolution-board-add-"));
			const yamlPath = path.join(tmpDir, "docs", "evolution-board.yaml");
			await fs.mkdir(path.dirname(yamlPath), { recursive: true });
			await Bun.write(yamlPath, "topics: []");

			const tool = new EvolutionBoardTool(createSessionInTmp());
			const result = await tool.execute("test-id", {
				action: "add",
				topic: { name: "Test Feature", brief: "A test feature for evolution board" },
			});

			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("added successfully");
			expect(text).toContain("test-feature");

			const saved = await Bun.file(yamlPath).text();
			expect(saved).toContain("test-feature");
			expect(saved).toContain("Test Feature");
		});

		it("rejects duplicate ID", async () => {
			tmpDir = await fs.mkdtemp(path.join("/tmp", "evolution-board-dup-"));
			const yamlPath = path.join(tmpDir, "docs", "evolution-board.yaml");
			await fs.mkdir(path.dirname(yamlPath), { recursive: true });
			await Bun.write(yamlPath, "topics: []");

			const tool = new EvolutionBoardTool(createSessionInTmp());
			await tool.execute("test-id", {
				action: "add",
				topic: { name: "Duplicate Test", brief: "First one" },
			});

			const result = await tool.execute("test-id", {
				action: "add",
				topic: { name: "Duplicate Test", brief: "Second one" },
			});

			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("already exists");
		});

		it("requires topic parameter", async () => {
			tmpDir = await fs.mkdtemp(path.join("/tmp", "evolution-board-req-"));
			const yamlPath = path.join(tmpDir, "docs", "evolution-board.yaml");
			await fs.mkdir(path.dirname(yamlPath), { recursive: true });
			await Bun.write(yamlPath, "topics: []");

			const tool = new EvolutionBoardTool(createSessionInTmp());
			const result = await tool.execute("test-id", { action: "add" });

			const text = (result.content[0] as { type: string; text: string }).text;
			expect(text).toContain("topic is required");
		});

		it("sets default status to planned", async () => {
			tmpDir = await fs.mkdtemp(path.join("/tmp", "evolution-board-status-"));
			const yamlPath = path.join(tmpDir, "docs", "evolution-board.yaml");
			await fs.mkdir(path.dirname(yamlPath), { recursive: true });
			await Bun.write(yamlPath, "topics: []");

			const tool = new EvolutionBoardTool(createSessionInTmp());
			await tool.execute("test-id", {
				action: "add",
				topic: { name: "Status Test", brief: "Testing default status" },
			});

			const saved = await Bun.file(yamlPath).text();
			expect(saved).toContain("planned");
		});

		it("accepts optional fields", async () => {
			tmpDir = await fs.mkdtemp(path.join("/tmp", "evolution-board-fields-"));
			const yamlPath = path.join(tmpDir, "docs", "evolution-board.yaml");
			await fs.mkdir(path.dirname(yamlPath), { recursive: true });
			await Bun.write(yamlPath, "topics: []");

			const tool = new EvolutionBoardTool(createSessionInTmp());
			await tool.execute("test-id", {
				action: "add",
				topic: {
					name: "Full Feature",
					brief: "A feature with all fields",
					status: "in-progress",
					progress: 50,
					modules: ["auth", "api"],
					tags: ["backend", "security"],
					notes: "Priority feature",
					references: [{ name: "Spec", url: "https://example.com/spec" }],
				},
			});

			const saved = await Bun.file(yamlPath).text();
			expect(saved).toContain("in-progress");
			expect(saved).toContain("50");
			expect(saved).toContain("auth");
			expect(saved).toContain("backend");
			expect(saved).toContain("Priority feature");
			expect(saved).toContain("https://example.com/spec");
		});
	});
});
