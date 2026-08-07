import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { refreshAgentDiscovery, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const TEST_AGENTS = [
	{
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled" as const,
	},
];

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

describe("TaskTool.create discovery memo", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reuses one discovery scan across repeated creations with the same cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		const first = await TaskTool.create(createSession("/tmp"));
		const second = await TaskTool.create(createSession("/tmp"));

		expect(spy).toHaveBeenCalledTimes(1);
		expect(first.description).toBe(second.description);
	});

	it("rescans for a different cwd", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await TaskTool.create(createSession("/tmp"));
		await TaskTool.create(createSession("/tmp/omp-memo-other"));

		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("does not cache a rejected discovery", async () => {
		const spy = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue({ agents: TEST_AGENTS, projectAgentsDir: null });

		await expect(TaskTool.create(createSession("/tmp"))).rejects.toThrow("boom");
		const tool = await TaskTool.create(createSession("/tmp"));

		expect(tool.description).toContain("task");
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe("refreshAgentDiscovery", () => {
	let projectDir: string;
	let agentFile: string;

	const agentMd = (description: string) =>
		["---", "name: reload-probe", `description: ${description}`, "---", "", "Probe body."].join("\n");

	beforeAll(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-reload-"));
		agentFile = path.join(projectDir, ".omp", "agents", "reload-probe.md");
	});

	afterAll(async () => {
		await fs.rm(projectDir, { recursive: true, force: true });
	});

	it("republishes edited agent definitions to a live TaskTool", async () => {
		await Bun.write(agentFile, agentMd("PROBE_BEFORE"));
		const tool = await TaskTool.create(createSession(projectDir));
		expect(tool.description).toContain("PROBE_BEFORE");

		await Bun.write(agentFile, agentMd("PROBE_AFTER"));
		// Without a refresh the create-time scan is memoized for the process.
		expect((await TaskTool.create(createSession(projectDir))).description).toContain("PROBE_BEFORE");

		await refreshAgentDiscovery(projectDir);

		// The already-constructed tool — the one the running session holds — sees it.
		expect(tool.description).toContain("PROBE_AFTER");
		expect(tool.description).not.toContain("PROBE_BEFORE");
	});

	it("drops agents whose definition file was deleted", async () => {
		await Bun.write(agentFile, agentMd("PROBE_DOOMED"));
		await refreshAgentDiscovery(projectDir);
		const tool = await TaskTool.create(createSession(projectDir));
		expect(tool.description).toContain("reload-probe");

		await fs.rm(agentFile);
		await refreshAgentDiscovery(projectDir);

		expect(tool.description).not.toContain("reload-probe");
	});
});
