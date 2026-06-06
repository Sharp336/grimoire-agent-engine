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
});
