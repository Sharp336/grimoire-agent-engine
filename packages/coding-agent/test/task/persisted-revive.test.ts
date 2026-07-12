import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { TempDir } from "@oh-my-pi/pi-utils";

function makeContext(cwd: string) {
	return {
		session: {
			sessionManager: {
				getCwd: () => cwd,
				getArtifactManager: () => undefined,
			},
		} as unknown as AgentSession,
		authStorage: {} as never,
		modelRegistry: {} as never,
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function revivedSession() {
	return {
		setActiveToolsByName: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
	} as unknown as AgentSession;
}

function parkedRef(sessionFile: string) {
	return {
		id: "strict-revive",
		displayName: "Strict revive",
		parentId: MAIN_AGENT_ID,
		sessionFile,
	} as never;
}

describe("persisted subagent revival", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("cold-revives a strict contract with raw schema and lets SDK prepare it again", async () => {
		using tempDir = TempDir.createSync("@omp-persisted-strict-");
		const schema = {
			type: "object",
			properties: { accepted: { type: "boolean" } },
			required: ["accepted"],
		};
		vi.spyOn(SessionManager, "peekSessionInit").mockResolvedValue({
			cwd: tempDir.path(),
			init: {
				systemPrompt: "Return the requested shape.",
				task: "classify",
				tools: ["read", "yield"],
				outputSchema: schema,
				schemaMode: "strict",
				spawns: "",
			},
		});
		vi.spyOn(SessionManager, "open").mockResolvedValue({ adoptArtifactManager: () => {} } as never);
		const session = revivedSession();
		const create = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as never);

		const revive = await createPersistedSubagentReviverFactory(makeContext(tempDir.path()))(
			parkedRef(`${tempDir.path()}/strict.jsonl`),
		);
		if (!revive) throw new Error("Expected a reviver for the persisted strict contract");
		await revive();

		const options = create.mock.calls[0]?.[0];
		expect(options).toMatchObject({
			outputSchema: schema,
			schemaMode: "strict",
			requireYieldTool: true,
			toolNames: ["read", "yield"],
		});
		expect(options?.preparedOutputSchema).toBeUndefined();
	});

	it("restores legacy persisted contracts in permissive mode", async () => {
		using tempDir = TempDir.createSync("@omp-persisted-legacy-");
		vi.spyOn(SessionManager, "peekSessionInit").mockResolvedValue({
			cwd: tempDir.path(),
			init: {
				systemPrompt: "Legacy prompt.",
				task: "legacy",
				tools: ["read", "yield"],
				outputSchema: { type: "object" },
			},
		});
		vi.spyOn(SessionManager, "open").mockResolvedValue({ adoptArtifactManager: () => {} } as never);
		const create = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValue({ session: revivedSession() } as never);

		const revive = await createPersistedSubagentReviverFactory(makeContext(tempDir.path()))(
			parkedRef(`${tempDir.path()}/legacy.jsonl`),
		);
		if (!revive) throw new Error("Expected a reviver for the legacy persisted contract");
		await revive();

		expect(create.mock.calls[0]?.[0]?.schemaMode).toBe("permissive");
	});
});
