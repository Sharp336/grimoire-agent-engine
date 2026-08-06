import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseAgent, writeAgentAdvisors } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("writeAgentAdvisors", () => {
	let tempHome: string;
	let userAgentsDir: string;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-files-"));
		userAgentsDir = path.join(tempHome, ".omp", "agent", "agents");
		await fs.mkdir(userAgentsDir, { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(tempHome);
	});

	test("edits a user-dir agent file in place, adding advisors without touching unrelated keys or the body", async () => {
		const filePath = path.join(userAgentsDir, "scout.md");
		const original = [
			"---",
			"name: scout",
			"description: Read-only scout for repo research.",
			"tools:",
			"  - read",
			"  - grep",
			"customKey: keep-me",
			"---",
			"Body line one.",
			"Body line two.",
			"",
		].join("\n");
		await fs.writeFile(filePath, original);

		const result = await writeAgentAdvisors(
			parseAgent(filePath, original, "user"),
			["reviewer", "librarian"],
			userAgentsDir,
		);

		expect(result.filePath).toBe(filePath);
		expect(result.shadowed).toBe(false);

		const updated = await fs.readFile(filePath, "utf8");
		const originalTail = original.slice(original.indexOf("\n---", 3));
		expect(updated.slice(updated.indexOf("\n---", 3))).toBe(originalTail);
		expect(updated).toContain("customKey: keep-me");

		const reparsed = parseAgent(filePath, updated, "user");
		expect(reparsed.advisors).toEqual(["reviewer", "librarian"]);
		expect(reparsed.tools).toEqual(["read", "grep", "yield"]);
		expect(reparsed.systemPrompt).toBe("Body line one.\nBody line two.");
	});

	test("second write with an empty advisor list removes the advisors key", async () => {
		const filePath = path.join(userAgentsDir, "scout.md");
		const original = [
			"---",
			"name: scout",
			"description: Read-only scout for repo research.",
			"advisors:",
			"  - reviewer",
			"---",
			"Scout body.",
		].join("\n");
		await fs.writeFile(filePath, original);

		const agent = parseAgent(filePath, original, "user");
		await writeAgentAdvisors(agent, ["librarian"], userAgentsDir);
		await writeAgentAdvisors(agent, [], userAgentsDir);

		const updated = await fs.readFile(filePath, "utf8");
		expect(updated).not.toContain("advisors");
		expect(parseAgent(filePath, updated, "user").advisors).toBeUndefined();
	});

	test("shadows a bundled embedded agent into the user agents dir", async () => {
		const agent: AgentDefinition = {
			name: "scout",
			description: "Read-only scout for repo research.",
			systemPrompt: "You are a read-only scout.",
			tools: ["read", "grep", "glob"],
			readSummarize: false,
			source: "bundled",
			filePath: "embedded:scout.md",
		};

		const result = await writeAgentAdvisors(agent, ["reviewer"], userAgentsDir);
		const target = path.join(userAgentsDir, "scout.md");

		expect(result.filePath).toBe(target);
		expect(result.shadowed).toBe(true);

		const written = await fs.readFile(target, "utf8");
		expect(written.endsWith("\n")).toBe(true);
		// Frontmatter key order: name, description, tools, advisors, then remaining set fields.
		const frontmatterLines = written
			.slice(4, written.indexOf("\n---", 3))
			.split("\n")
			.filter(line => line !== "" && !line.startsWith(" "));
		expect(frontmatterLines).toEqual([
			"name: scout",
			"description: Read-only scout for repo research.",
			"tools: ",
			"advisors: ",
			"readSummarize: false",
		]);

		const reparsed = parseAgent(target, written, "user");
		expect(reparsed.name).toBe("scout");
		expect(reparsed.description).toBe(agent.description);
		expect(reparsed.systemPrompt).toBe(agent.systemPrompt);
		expect(reparsed.advisors).toEqual(["reviewer"]);
		expect(reparsed.tools).toEqual(["read", "grep", "glob", "yield"]);
		expect(reparsed.readSummarize).toBe(false);
	});

	test("shadows a plugin-dir agent file, preserving its body and keys", async () => {
		const pluginDir = path.join(tempHome, "plugins", "node_modules", "loom", "agents");
		await fs.mkdir(pluginDir, { recursive: true });
		const filePath = path.join(pluginDir, "loom.md");
		const original = [
			"---",
			"name: loom",
			"description: Verifies the loom spec.",
			"tools:",
			"  - read",
			"pluginKey: plugin-value",
			"---",
			"Plugin body, first line.",
			"Plugin body, second line.",
		].join("\n");
		await fs.writeFile(filePath, original);

		const result = await writeAgentAdvisors(parseAgent(filePath, original, "user"), ["reviewer"], userAgentsDir);

		expect(result.filePath).toBe(path.join(userAgentsDir, "loom.md"));
		expect(result.shadowed).toBe(true);
		expect(await fs.readFile(filePath, "utf8")).toBe(original);

		const written = await fs.readFile(result.filePath, "utf8");
		expect(written.slice(written.indexOf("\n---", 3))).toBe(original.slice(original.indexOf("\n---", 3)));
		const reparsed = parseAgent(result.filePath, written, "user");
		expect(reparsed.advisors).toEqual(["reviewer"]);
		expect(reparsed.tools).toEqual(["read", "yield"]);
		expect(reparsed.systemPrompt).toBe("Plugin body, first line.\nPlugin body, second line.");
	});

	test("edits a project .omp/agents file in place even outside the user agents dir", async () => {
		const projectAgentsDir = path.join(tempHome, "project", ".omp", "agents");
		await fs.mkdir(projectAgentsDir, { recursive: true });
		const filePath = path.join(projectAgentsDir, "proj-agent.md");
		const original = ["---", "name: proj-agent", "description: Project-local agent.", "---", "Project body."].join(
			"\n",
		);
		await fs.writeFile(filePath, original);

		const result = await writeAgentAdvisors(parseAgent(filePath, original, "project"), ["scout"], userAgentsDir);

		expect(result.filePath).toBe(filePath);
		expect(result.shadowed).toBe(false);
		expect(parseAgent(filePath, await fs.readFile(filePath, "utf8"), "project").advisors).toEqual(["scout"]);
	});
});
