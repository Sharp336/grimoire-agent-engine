import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AdvisorTool } from "@oh-my-pi/pi-coding-agent/tools";

const advisorModel = { provider: "openai", id: "gpt-x" } as unknown as Model<Api>;
const compactorModel = { provider: "google", id: "flash-lc" } as unknown as Model<Api>;

function adviceResponse(text: string) {
	return { stopReason: "end_turn", content: [{ type: "text", text }] };
}

interface SessionOpts {
	model?: Model<Api>;
	compactor?: Model<Api>;
	roles?: string[];
}

/** Minimal AgentSession exposing only the surface the advisor tool reaches. */
function createAgentSession(opts: SessionOpts = {}): AgentSession {
	const model = "model" in opts ? opts.model : advisorModel;
	const roles = opts.roles ?? [];
	return {
		resolveRoleModelWithThinking(role: string) {
			roles.push(role);
			if (role === "compactor") return { model: opts.compactor, explicitThinkingLevel: false };
			return { model, explicitThinkingLevel: false };
		},
		modelRegistry: {
			getApiKey: async () => "test-key",
			resolver: (m: Model<Api>) => `${m.provider}/${m.id}:key`,
		},
		sessionId: "session-1",
		agent: { telemetry: undefined },
		messages: [],
		convertMessagesToLlm: async () => [],
		// Identity: keep the options the tool built so the test can assert on them.
		prepareSimpleStreamOptions: (options: unknown) => options,
	} as unknown as AgentSession;
}

function createToolSession(agentSession?: AgentSession, opts: { compactorRole?: string } = {}): ToolSession {
	return {
		settings: { get: () => true, getModelRole: () => opts.compactorRole },
		getAgentSession: () => agentSession,
	} as unknown as ToolSession;
}

describe("advisor tool", () => {
	afterEach(() => {
		(core.instrumentedCompleteSimple as { mockRestore?: () => void }).mockRestore?.();
	});

	it("is opt-in: createIf returns null unless advisor.enabled", () => {
		const off = { settings: { get: () => false } } as unknown as ToolSession;
		const on = { settings: { get: () => true } } as unknown as ToolSession;
		expect(AdvisorTool.createIf(off)).toBeNull();
		expect(AdvisorTool.createIf(on)).toBeInstanceOf(AdvisorTool);
	});

	it("errors (no throw) when no advisor model is paired", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple");
		const session = createAgentSession({ model: undefined });
		const result = await new AdvisorTool(createToolSession(session)).execute("call-1", {});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("Advisor");
		expect(complete).not.toHaveBeenCalled();
	});

	it("errors (no throw) when used without an agent session", async () => {
		const result = await new AdvisorTool(createToolSession(undefined)).execute("call-1", {});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("unavailable");
	});

	it("surfaces an advisor request failure as a tool error rather than throwing", async () => {
		spyOn(core, "instrumentedCompleteSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "upstream 500",
		} as never);
		const result = await new AdvisorTool(createToolSession(createAgentSession())).execute("call-1", {});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("upstream 500");
	});

	it("contains a thrown (rejected) advisor completion instead of failing the turn", async () => {
		spyOn(core, "instrumentedCompleteSimple").mockRejectedValue(new Error("ECONNRESET"));
		const result = await new AdvisorTool(createToolSession(createAgentSession())).execute("call-1", {});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("ECONNRESET");
	});

	it("routes to the advisor role with a stable cache key and unique request lineage", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			adviceResponse("Pick approach B; the failure mode is N+1 queries.") as never,
		);
		const roles: string[] = [];
		const session = createAgentSession({ roles });
		const result = await new AdvisorTool(createToolSession(session)).execute("call-42", {});

		expect(roles).toContain("advisor");
		const streamOptions = complete.mock.calls[0]?.[2] as { promptCacheKey?: string; sessionId?: string };
		expect(streamOptions.promptCacheKey).toBe("session-1");
		expect(streamOptions.sessionId).toBe("session-1:advisor:call-42");
		expect(streamOptions.sessionId).not.toBe(streamOptions.promptCacheKey);

		expect(result.isError).toBeUndefined();
		expect((result.content[0] as { text: string }).text).toContain("approach B");
		expect(result.details).toMatchObject({ advisor: "openai/gpt-x" });
	});

	it("compacts with the paired compactor, then briefs the advisor (both cache-friendly)", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple")
			.mockResolvedValueOnce(
				adviceResponse("BRIEF: task is to add caching; open decision is eviction policy.") as never,
			)
			.mockResolvedValueOnce(adviceResponse("Use approach B; failure mode is N+1.") as never);
		const session = createAgentSession({ compactor: compactorModel });

		const result = await new AdvisorTool(createToolSession(session)).execute("call-7", {});

		expect(complete.mock.calls).toHaveLength(2);
		// First call: the compactor digests the transcript on its own request lineage.
		expect(complete.mock.calls[0]?.[0]).toBe(compactorModel);
		const compactOptions = complete.mock.calls[0]?.[2] as { promptCacheKey?: string; sessionId?: string };
		expect(compactOptions.promptCacheKey).toBe("session-1");
		expect(compactOptions.sessionId).toBe("session-1:advisor-compact:call-7");
		// Second call: the advisor reviews the brief, not the raw transcript.
		expect(complete.mock.calls[1]?.[0]).toBe(advisorModel);
		const advisorContext = complete.mock.calls[1]?.[1] as { messages: { content: { text: string }[] }[] };
		expect(advisorContext.messages).toHaveLength(1);
		expect(advisorContext.messages[0]?.content[0]?.text).toContain("<conversation_brief>");
		expect(advisorContext.messages[0]?.content[0]?.text).toContain("eviction policy");
		expect(result.details).toMatchObject({ advisor: "openai/gpt-x", compacted: true });
	});

	it("errors when a compactor is paired but unavailable, instead of dumping the transcript", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple");
		// Advisor resolves, but the paired `compactor` role string is set yet resolves to no model.
		const session = createAgentSession({ compactor: undefined });
		const result = await new AdvisorTool(createToolSession(session, { compactorRole: "google/flash-lc" })).execute(
			"call-9",
			{},
		);
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("compactor");
		expect(complete).not.toHaveBeenCalled();
	});
});
