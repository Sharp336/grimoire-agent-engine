/**
 * Regression for #1914: discoverAgents() must discover GitHub Copilot custom agents
 * from `.github/agents/` (project, nearest walking up) and `~/.copilot/agents/`
 * (user-global, relocatable via COPILOT_HOME). Gated on the `github` provider.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "../../src/capability";
import { clearCache as clearFsCache } from "../../src/capability/fs";
import { discoverAgents } from "../../src/task/discovery";

function writeAgent(dir: string, name: string, description: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${description}\n---\nBody for ${name}.\n`,
	);
}

describe("discoverAgents — GitHub Copilot agents", () => {
	let tempHome: string;
	let tempProject: string;
	let savedCopilotHome: string | undefined;

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-copilot-agents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-copilot-agents-proj-"));
		savedCopilotHome = process.env.COPILOT_HOME;
		delete process.env.COPILOT_HOME;
		enableProvider("github");
		clearFsCache();
	});

	afterEach(() => {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
		if (savedCopilotHome === undefined) delete process.env.COPILOT_HOME;
		else process.env.COPILOT_HOME = savedCopilotHome;
		enableProvider("github");
		clearFsCache();
	});

	test("discovers user-global ~/.copilot/agents/*.md", async () => {
		writeAgent(path.join(tempHome, ".copilot", "agents"), "copilot-user-agent", "A user-global Copilot agent");

		const { agents } = await discoverAgents(tempProject, tempHome);

		const found = agents.find(a => a.name === "copilot-user-agent");
		expect(found).toBeDefined();
		expect(found?.source).toBe("user");
	});

	test("discovers project .github/agents/*.md", async () => {
		writeAgent(path.join(tempProject, ".github", "agents"), "copilot-proj-agent", "A project Copilot agent");

		const { agents } = await discoverAgents(tempProject, tempHome);

		const found = agents.find(a => a.name === "copilot-proj-agent");
		expect(found).toBeDefined();
		expect(found?.source).toBe("project");
	});

	test("finds the nearest .github/agents walking up from a subdirectory", async () => {
		writeAgent(path.join(tempProject, ".github", "agents"), "repo-root-agent", "Repo-root Copilot agent");
		const subdir = path.join(tempProject, "packages", "sub");
		fs.mkdirSync(subdir, { recursive: true });

		const { agents } = await discoverAgents(subdir, tempHome);

		expect(agents.map(a => a.name)).toContain("repo-root-agent");
	});

	test("honors COPILOT_HOME for the user-global agents dir", async () => {
		const copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-copilot-home-"));
		try {
			writeAgent(path.join(copilotHome, "agents"), "relocated-agent", "Agent under COPILOT_HOME");
			process.env.COPILOT_HOME = copilotHome;

			const { agents } = await discoverAgents(tempProject, tempHome);

			expect(agents.map(a => a.name)).toContain("relocated-agent");
		} finally {
			fs.rmSync(copilotHome, { recursive: true, force: true });
		}
	});

	test("excludes Copilot agents when the github provider is disabled", async () => {
		writeAgent(path.join(tempHome, ".copilot", "agents"), "gated-user-agent", "user");
		writeAgent(path.join(tempProject, ".github", "agents"), "gated-proj-agent", "project");

		disableProvider("github");
		clearFsCache();
		const { agents } = await discoverAgents(tempProject, tempHome);

		const names = agents.map(a => a.name);
		expect(names).not.toContain("gated-user-agent");
		expect(names).not.toContain("gated-proj-agent");
	});

	test("project agent overrides home-dir agent of the same name", async () => {
		writeAgent(path.join(tempProject, ".github", "agents"), "shared", "project version");
		writeAgent(path.join(tempHome, ".copilot", "agents"), "shared", "home version");

		const { agents } = await discoverAgents(tempProject, tempHome);

		const found = agents.filter(a => a.name === "shared");
		expect(found).toHaveLength(1);
		expect(found[0].source).toBe("project");
		expect(found[0].description).toBe("project version");
	});

	test("derives the agent name from a *.agent.md filename when frontmatter omits name", async () => {
		const dir = path.join(tempHome, ".copilot", "agents");
		fs.mkdirSync(dir, { recursive: true });
		// No `name` in frontmatter — Copilot uses the filename (minus .agent.md) as identity.
		fs.writeFileSync(
			path.join(dir, "security-expert.agent.md"),
			"---\ndescription: Security review specialist\n---\nAudit code for vulnerabilities.\n",
		);

		const { agents } = await discoverAgents(tempProject, tempHome);

		const found = agents.find(a => a.name === "security-expert");
		expect(found).toBeDefined();
		expect(found?.description).toBe("Security review specialist");
	});

	test("dedupes across levels by file id, not frontmatter name (project shadows personal)", async () => {
		// Same filename in both levels but different frontmatter names: Copilot dedupes by
		// the file id (reviewer), so the project file shadows the personal one.
		const proj = path.join(tempProject, ".github", "agents");
		const user = path.join(tempHome, ".copilot", "agents");
		fs.mkdirSync(proj, { recursive: true });
		fs.mkdirSync(user, { recursive: true });
		fs.writeFileSync(
			path.join(proj, "reviewer.agent.md"),
			"---\nname: project-reviewer\ndescription: p\n---\nBody.\n",
		);
		fs.writeFileSync(
			path.join(user, "reviewer.agent.md"),
			"---\nname: personal-reviewer\ndescription: u\n---\nBody.\n",
		);

		const { agents } = await discoverAgents(tempProject, tempHome);

		expect(agents.find(a => a.name === "project-reviewer")).toBeDefined();
		expect(agents.find(a => a.name === "personal-reviewer")).toBeUndefined();
	});

	test("skips Copilot agents targeted at a non-Copilot environment (target: vscode)", async () => {
		const dir = path.join(tempProject, ".github", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "vsonly.agent.md"),
			"---\nname: vsonly\ndescription: d\ntarget: vscode\n---\nBody.\n",
		);
		fs.writeFileSync(
			path.join(dir, "cli.agent.md"),
			"---\nname: cli-agent\ndescription: d\ntarget: github-copilot\n---\nBody.\n",
		);

		const { agents } = await discoverAgents(tempProject, tempHome);

		expect(agents.find(a => a.name === "vsonly")).toBeUndefined();
		expect(agents.find(a => a.name === "cli-agent")).toBeDefined();
	});

	test("translates Copilot tool aliases to OMP tool names", async () => {
		const dir = path.join(tempHome, ".copilot", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "restricted.agent.md"),
			"---\nname: restricted\ndescription: d\ntools: [execute, read, agent]\n---\nBody.\n",
		);

		const { agents } = await discoverAgents(tempProject, tempHome);

		const found = agents.find(a => a.name === "restricted");
		expect(found?.tools).toContain("bash");
		expect(found?.tools).toContain("read");
		expect(found?.tools).toContain("task");
		expect(found?.tools).not.toContain("execute");
	});

	test("treats Copilot tools: ['*'] as unrestricted (all tools)", async () => {
		const dir = path.join(tempHome, ".copilot", "agents");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "alltools.agent.md"),
			"---\nname: alltools\ndescription: d\ntools: ['*']\n---\nBody.\n",
		);

		const { agents } = await discoverAgents(tempProject, tempHome);

		const found = agents.find(a => a.name === "alltools");
		expect(found).toBeDefined();
		expect(found?.tools).toBeUndefined();
	});
});
