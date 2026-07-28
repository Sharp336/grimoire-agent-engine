import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { enableProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";

const packageRoot = path.resolve(import.meta.dir, "..");
let tempRoot: string | undefined;

afterEach(async () => {
	enableProvider("omp-plugins");
	clearOmpExtensionCliRoots();
	clearFsCache();
	if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

describe("OMP 17.1 compatibility", () => {
	test("discovers the packaged Anima task-agent roles from an extension root", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anima-omp-compat-"));
		const projectDir = path.join(tempRoot, "project");
		await fs.mkdir(projectDir, { recursive: true });
		injectOmpExtensionCliRoots([packageRoot], tempRoot, projectDir);

		const { agents } = await discoverAgents(projectDir, tempRoot);
		const packaged = agents.filter(
			agent =>
				agent.filePath !== undefined && path.resolve(agent.filePath).startsWith(path.join(packageRoot, "agents")),
		);

		expect(packaged.map(agent => agent.name).sort()).toEqual([
			"claude-implementer",
			"claude-researcher",
			"claude-reviewer",
		]);
		expect(packaged.every(agent => (agent.tools?.length ?? 0) > 0)).toBe(true);
	});
});
