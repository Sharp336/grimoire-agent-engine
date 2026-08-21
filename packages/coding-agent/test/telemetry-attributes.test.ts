import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import type { TelemetryAttributeContext } from "@oh-my-pi/pi-agent-core";
import { createLangfuseAttributeConfig, type LangfuseAttributeConfigOptions } from "../src/telemetry-attributes";

const baseCtx: TelemetryAttributeContext = {
	kind: "invoke_agent",
	model: undefined,
	agent: undefined,
	conversationId: "conv-1",
};

function config(overrides?: Partial<LangfuseAttributeConfigOptions>) {
	return createLangfuseAttributeConfig({
		cwd: "/Users/jacob/.local/share/chezmoi",
		prompt: undefined,
		mode: "headless",
		modelRoles: { default: "kimi-code/k3-256k:high", smol: "openrouter/gpt-5-mini:low" },
		defaultModel: "k3-256k",
		...overrides,
	});
}

describe("createLangfuseAttributeConfig", () => {
	test("invoke_agent stamps trace name, tags, user, project metadata", () => {
		const attrs = config().resolveAttributes?.(baseCtx);
		expect(attrs?.["langfuse.trace.name"]).toBe("omp:chezmoi");
		expect(attrs?.["langfuse.trace.tags"]).toEqual([
			"project:chezmoi",
			"mode:headless",
			`host:${hostname()}`,
			"model:k3-256k",
		]);
		expect(typeof attrs?.["user.id"]).toBe("string");
		expect(attrs?.["langfuse.trace.metadata.project"]).toBe("chezmoi");
	});

	test("headless prompt becomes the trace name, first line, truncated", () => {
		const long = `${"x".repeat(100)}\nsecond line`;
		const attrs = config({ prompt: long }).resolveAttributes?.(baseCtx);
		expect(attrs?.["langfuse.trace.name"]).toBe(`${"x".repeat(79)}…`);
	});

	test("subagent invoke_agent adds agent tag", () => {
		const attrs = config().resolveAttributes?.({ ...baseCtx, agent: { name: "fast-generic" } });
		expect(attrs?.["langfuse.trace.tags"]).toContain("agent:fast-generic");
	});

	test("chat span tags provider and role from model", () => {
		const attrs = config().resolveAttributes?.({
			...baseCtx,
			kind: "chat",
			model: { id: "gpt-5-mini", provider: "openrouter" } as never,
		});
		expect(attrs?.["langfuse.trace.tags"]).toEqual(["provider:openrouter", "role:smol"]);
	});

	test("chat span without role match tags provider only; tool spans get nothing", () => {
		const chat = config().resolveAttributes?.({
			...baseCtx,
			kind: "chat",
			model: { id: "unconfigured-model", provider: "kimi-code" } as never,
		});
		expect(chat?.["langfuse.trace.tags"]).toEqual(["provider:kimi-code"]);
		expect(config().resolveAttributes?.({ ...baseCtx, kind: "execute_tool" })).toBeUndefined();
	});
});
