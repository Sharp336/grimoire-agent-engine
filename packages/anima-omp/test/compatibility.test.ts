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
import { AnimaExecutorController } from "../src/executor";
import type { AnimaControl } from "../src/protocol";

const packageRoot = path.resolve(import.meta.dir, "..");
let tempRoot: string | undefined;

afterEach(async () => {
	enableProvider("omp-plugins");
	clearOmpExtensionCliRoots();
	clearFsCache();
	if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
	tempRoot = undefined;
});

function codingAgentPeerRange(manifest: unknown): unknown {
	if (!manifest || typeof manifest !== "object" || !("peerDependencies" in manifest)) return undefined;
	const peerDependencies = manifest.peerDependencies;
	if (!peerDependencies || typeof peerDependencies !== "object") return undefined;
	return "@oh-my-pi/pi-coding-agent" in peerDependencies ? peerDependencies["@oh-my-pi/pi-coding-agent"] : undefined;
}

describe("OMP executor-host compatibility", () => {
	test("assumes the executor APIs first publish in 17.2.0 and excludes unpatched 17.1.5", async () => {
		const animaManifest: unknown = await Bun.file(path.join(packageRoot, "package.json")).json();
		const swarmManifest: unknown = await Bun.file(
			path.resolve(packageRoot, "../swarm-extension/package.json"),
		).json();

		expect(codingAgentPeerRange(animaManifest)).toBe(">=17.2.0 <18");
		expect(codingAgentPeerRange(swarmManifest)).toBe(">=17.2.0 <18");
	});

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

	test("does not claim a same-named project agent that shadows a packaged role", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anima-omp-shadow-"));
		const projectDir = path.join(tempRoot, "project");
		const projectAgentsDir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(projectAgentsDir, { recursive: true });
		const projectReviewer = path.join(projectAgentsDir, "claude-reviewer.md");
		await fs.writeFile(
			projectReviewer,
			["---", "name: claude-reviewer", "description: Project-owned reviewer", "---", "Review locally."].join("\n"),
		);
		injectOmpExtensionCliRoots([packageRoot], tempRoot, projectDir);

		const { agents } = await discoverAgents(projectDir, tempRoot);
		const selected = agents.find(agent => agent.name === "claude-reviewer");
		expect(selected?.filePath).toBe(projectReviewer);
		const controller = new AnimaExecutorController({
			client: {} as AnimaControl,
			agentRoot: path.join(packageRoot, "agents"),
		});
		expect(selected && controller.executor.claim(selected)).toBe(false);

		const linkedReviewer = path.join(tempRoot, "linked-claude-reviewer.md");
		await fs.symlink(path.join(packageRoot, "agents", "claude-reviewer.md"), linkedReviewer);
		expect(selected && controller.executor.claim({ ...selected, filePath: linkedReviewer })).toBe(true);
		expect(
			selected &&
				controller.executor.claim({
					...selected,
					filePath: path.join(packageRoot, "agents", "claude-implementer.md"),
				}),
		).toBe(false);
		expect(
			selected &&
				controller.executor.claim({
					...selected,
					filePath: path.join(packageRoot, "agents", "nested", "claude-reviewer.md"),
				}),
		).toBe(false);
		const packagedImplementer = agents.find(
			agent =>
				agent.name === "claude-implementer" &&
				agent.filePath !== undefined &&
				path.resolve(agent.filePath).startsWith(path.join(packageRoot, "agents")),
		);
		expect(packagedImplementer && controller.executor.claim(packagedImplementer)).toBe(true);
	});
});
