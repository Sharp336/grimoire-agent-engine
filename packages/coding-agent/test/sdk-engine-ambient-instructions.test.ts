import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("Engine SDK instruction isolation", () => {
	it("ignores ambient instructions, retains explicit arrays, and leaves non-Engine discovery intact", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-engine-ambient-"));
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const configDir = path.join(cwd, ".omp");
		fs.mkdirSync(path.join(configDir, "skills", "ambient-skill"), { recursive: true });
		fs.mkdirSync(path.join(configDir, "prompts"), { recursive: true });
		fs.mkdirSync(path.join(configDir, "commands"), { recursive: true });
		fs.mkdirSync(agentDir);
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "AMBIENT_CONTEXT_MARKER\n");
		fs.writeFileSync(path.join(configDir, "RULES.md"), "AMBIENT_RULE_MARKER\n");
		fs.writeFileSync(
			path.join(configDir, "skills", "ambient-skill", "SKILL.md"),
			"---\nname: ambient-skill\ndescription: AMBIENT_SKILL_MARKER\n---\nAmbient skill.\n",
		);
		fs.writeFileSync(path.join(configDir, "prompts", "ambient-prompt.md"), "AMBIENT_PROMPT_MARKER\n");
		fs.writeFileSync(path.join(configDir, "commands", "ambient-slash.md"), "AMBIENT_SLASH_MARKER\n");

		let auth: AuthStorage | undefined;
		let managed: AgentSession | undefined;
		let explicit: AgentSession | undefined;
		let normal: AgentSession | undefined;
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const manager = new AsyncJobManager({ requireAttemptId: true });
		const ircBus = new IrcBus(registry, lifecycle);
		try {
			auth = await AuthStorage.create(path.join(root, "auth.db"));
			const modelRegistry = new ModelRegistry(auth, path.join(root, "models.yml"));
			const settings = await Settings.loadReadOnly({
				cwd,
				agentDir,
				overrides: {
					disabledProviders: [],
					disabledExtensions: [],
					"skills.enabled": true,
					"skills.enablePiProject": true,
					"skills.enableCodexUser": false,
					"skills.enableClaudeUser": false,
					"skills.enableClaudeProject": false,
					"skills.enablePiUser": false,
					"skills.enableAgentsUser": false,
					"skills.enableAgentsProject": false,
				},
			});
			const base = {
				cwd,
				agentDir,
				settings,
				modelRegistry,
				enableMCP: false,
				enableLsp: false,
				disableExtensionDiscovery: true,
			};
			const engine = {
				engineMode: true,
				agentRegistry: registry,
				agentLifecycle: lifecycle,
				asyncJobManager: manager,
				ircBus,
			};

			managed = (await createAgentSession({
				...base,
				...engine,
				agentId: "Managed",
				attemptId: "attempt-managed",
				sessionManager: SessionManager.inMemory(cwd),
			})).session;
			const managedPrompt = managed.systemPrompt.join("\n");
			expect(managedPrompt).not.toContain("AMBIENT_CONTEXT_MARKER");
			expect(managedPrompt).not.toContain("AMBIENT_RULE_MARKER");
			expect(managed.skills.some(skill => skill.name === "ambient-skill")).toBeFalse();
			expect(managed.promptTemplates.some(template => template.name === "ambient-prompt")).toBeFalse();
			expect(managed.slashCommands.some(command => command.name === "ambient-slash")).toBeFalse();

			const canonicalPath = path.join(root, "canonical.md");
			const canonicalSkill = {
				name: "canonical-skill",
				description: "CANONICAL_SKILL_MARKER",
				filePath: canonicalPath,
				baseDir: root,
				source: "custom" as const,
			};
			explicit = (await createAgentSession({
				...base,
				...engine,
				agentId: "Explicit",
				attemptId: "attempt-explicit",
				sessionManager: SessionManager.inMemory(cwd),
				contextFiles: [{ path: canonicalPath, content: "CANONICAL_CONTEXT_MARKER" }],
				skills: [canonicalSkill],
				promptTemplates: [{
					name: "canonical-prompt",
					description: "canonical",
					content: "CANONICAL_PROMPT_MARKER",
					source: "(project)",
				}],
				slashCommands: [{
					name: "canonical-slash",
					description: "canonical",
					content: "CANONICAL_SLASH_MARKER",
					source: "(project)",
				}],
				rules: [{
					name: "canonical-rule",
					path: canonicalPath,
					content: "CANONICAL_RULE_MARKER",
					alwaysApply: true,
					_source: { provider: "test", providerName: "test", path: canonicalPath, level: "project" },
				}],
			})).session;
			const explicitPrompt = explicit.systemPrompt.join("\n");
			expect(explicitPrompt).toContain("CANONICAL_CONTEXT_MARKER");
			expect(explicitPrompt).toContain("CANONICAL_RULE_MARKER");
			expect(explicitPrompt).not.toContain("AMBIENT_CONTEXT_MARKER");
			expect(explicitPrompt).not.toContain("AMBIENT_RULE_MARKER");
			expect(explicit.skills.some(skill => skill.name === canonicalSkill.name)).toBeTrue();
			expect(explicit.promptTemplates.some(template => template.content === "CANONICAL_PROMPT_MARKER")).toBeTrue();
			expect(explicit.slashCommands.some(command => command.content === "CANONICAL_SLASH_MARKER")).toBeTrue();

			normal = (await createAgentSession({
				...base,
				agentRegistry: registry,
				agentLifecycle: lifecycle,
				ircBus,
				agentId: "Normal",
				sessionManager: SessionManager.inMemory(cwd),
			})).session;
			const normalPrompt = normal.systemPrompt.join("\n");
			expect(normalPrompt).toContain("AMBIENT_CONTEXT_MARKER");
			expect(normalPrompt).toContain("AMBIENT_RULE_MARKER");
			expect(
				normal.skills.some(skill => skill.name === "ambient-skill" && skill.description.includes("AMBIENT_SKILL_MARKER")),
			).toBeTrue();
			expect(normal.promptTemplates.some(template => template.content.includes("AMBIENT_PROMPT_MARKER"))).toBeTrue();
			expect(normal.slashCommands.some(command => command.content.includes("AMBIENT_SLASH_MARKER"))).toBeTrue();
		} finally {
			await normal?.dispose();
			await explicit?.dispose();
			await managed?.dispose();
			await lifecycle.dispose();
			await manager.dispose({ timeoutMs: 1_000 });
			auth?.close();
			removeSyncWithRetries(root);
		}
	}, 60_000);
});
