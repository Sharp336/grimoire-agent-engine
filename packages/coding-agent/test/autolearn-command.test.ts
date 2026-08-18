import "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { estimateTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, DeveloperMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { ManualAutoLearnResult } from "@oh-my-pi/pi-coding-agent/autolearn/capture-request";
import { selectManualWindow } from "@oh-my-pi/pi-coding-agent/autolearn/install";
import {
	resetSettingsForTest,
	type SettingPath,
	Settings,
	type SettingValue,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-session";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const LEARN_USAGE = "Usage: /learn [--turns 1-12] [focus text]";
const DISABLED_MESSAGE = "Auto-Learn is disabled for this session. Enable autolearn.enabled and start a new session.";
const learnEntry = BUILTIN_SESSION_SLASH_COMMANDS.find(command => command.name === "learn");
if (!learnEntry?.handle) throw new Error("The built-in /learn command is not registered");
// Narrow to the result-returning arm: `SlashCommandSpec.handle` is a union of a
// `SlashCommandResult`-returning and a `void`-returning signature (see
// slash-commands/types.ts), and a union of call signatures is not directly
// invokable. `/learn` always returns `commandConsumed()`.
const learnHandler = learnEntry.handle as (
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
) => Promise<SlashCommandResult>;

class FakeLearnSession {
	canRequestAutoLearnCapture = true;
	isStreaming = false;
	result: ManualAutoLearnResult = { ok: true, stored: [{ action: "create", name: "captured" }] };
	readonly requests: Array<{ turns: number; focus?: string }> = [];

	async requestAutoLearnCapture(request: { turns: number; focus?: string }): Promise<ManualAutoLearnResult> {
		this.requests.push(request);
		return this.result;
	}
}

interface LearnHarness {
	session: FakeLearnSession;
	runtime: SlashCommandRuntime;
	outputs: string[];
}

function createLearnHarness(): LearnHarness {
	const session = new FakeLearnSession();
	const outputs: string[] = [];
	const runtime: SlashCommandRuntime = {
		session: session as unknown as AgentSession,
		sessionManager: {} as SessionManager,
		settings: Settings.isolated(),
		cwd: process.cwd(),
		output: text => {
			outputs.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	return { session, runtime, outputs };
}

function command(args: string): ParsedSlashCommand {
	return { name: "learn", args, text: args ? `/learn ${args}` : "/learn" };
}

async function invokeLearn(args: string, harness: LearnHarness): Promise<void> {
	const result = await learnHandler(command(args), harness.runtime);
	expect(result).toEqual({ consumed: true });
}

let autolearnEnabled = true;
let restoreSettingsGet: (() => void) | undefined;

describe("/learn slash command", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		autolearnEnabled = true;
		const getSpy = spyOn(Settings.prototype, "get").mockImplementation(
			<P extends SettingPath>(path: P): SettingValue<P> =>
				(path === "autolearn.enabled" ? autolearnEnabled : undefined) as SettingValue<P>,
		);
		restoreSettingsGet = () => {
			getSpy.mockRestore();
		};
	});

	afterEach(() => {
		restoreSettingsGet?.();
		restoreSettingsGet = undefined;
		resetSettingsForTest();
	});

	it("accepts all documented turn forms and forwards turns and focus to the session bridge", async () => {
		const cases = [
			{ args: "", request: { turns: 4 } },
			{ args: "--turns 2", request: { turns: 2 } },
			{ args: "--turns=2", request: { turns: 2 } },
			{ args: "--turns 2 MSVC setup", request: { turns: 2, focus: "MSVC setup" } },
			{ args: "MSVC setup --turns 2", request: { turns: 2, focus: "MSVC setup" } },
		];

		for (const { args, request } of cases) {
			const harness = createLearnHarness();
			await invokeLearn(args, harness);
			expect(harness.session.requests).toEqual([request]);
		}
	});

	it("rejects malformed turn arguments without requesting a capture", async () => {
		const invalidArgs = [
			"--turns 0",
			"--turns 13",
			"--turns abc",
			"--turns 2.5",
			"--turns",
			"--bogus",
			"--turns 2 --turns 3",
		];

		for (const args of invalidArgs) {
			const harness = createLearnHarness();
			await invokeLearn(args, harness);
			expect(harness.outputs).toEqual([LEARN_USAGE]);
			expect(harness.session.requests).toHaveLength(0);
		}
	});

	it("rejects disabled Auto-Learn and sessions without the registered manage_skill bridge", async () => {
		autolearnEnabled = false;
		const disabled = createLearnHarness();
		await invokeLearn("", disabled);
		expect(disabled.outputs).toEqual([DISABLED_MESSAGE]);
		expect(disabled.session.requests).toHaveLength(0);

		autolearnEnabled = true;
		const missingRegistration = createLearnHarness();
		missingRegistration.session.canRequestAutoLearnCapture = false;
		await invokeLearn("", missingRegistration);
		expect(missingRegistration.outputs).toEqual([DISABLED_MESSAGE]);
		expect(missingRegistration.session.requests).toHaveLength(0);
	});

	it("rejects a streaming session before requesting a capture", async () => {
		const harness = createLearnHarness();
		harness.session.isStreaming = true;
		await invokeLearn("--turns 2", harness);
		expect(harness.outputs).toEqual(["Cannot learn while the session is streaming."]);
		expect(harness.session.requests).toHaveLength(0);
	});

	it("reports each finalized create and update exactly once", async () => {
		const create = createLearnHarness();
		await invokeLearn("", create);
		expect(create.outputs).toEqual(["Learned procedure: captured"]);

		const update = createLearnHarness();
		update.session.result = { ok: true, stored: [{ action: "update", name: "msvc-setup" }] };
		await invokeLearn("", update);
		expect(update.outputs).toEqual(["Updated procedure: msvc-setup"]);

		const multiple = createLearnHarness();
		multiple.session.result = {
			ok: true,
			stored: [
				{ action: "create", name: "msvc-setup" },
				{ action: "update", name: "compiler-cache" },
			],
		};
		await invokeLearn("", multiple);
		expect(multiple.outputs).toEqual(["Learned procedure: msvc-setup\nUpdated procedure: compiler-cache"]);
	});

	it("surfaces capture failure without claiming that a procedure was stored", async () => {
		const harness = createLearnHarness();
		harness.session.result = { ok: false, error: "Capture approval was denied." };
		await invokeLearn("", harness);
		expect(harness.outputs).toEqual(["Capture approval was denied."]);
		expect(harness.outputs.some(line => /(?:Learned|Updated) procedure:/.test(line))).toBe(false);
	});
});

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		responseId: `response-${timestamp}`,
		providerPayload: { type: "openaiResponsesHistory", items: [{ id: `provider-${timestamp}` }] },
	} as unknown as AssistantMessage;
}

function developer(text: string, timestamp: number): DeveloperMessage {
	return { role: "developer", content: text, timestamp };
}

function custom(text: string, display: boolean, timestamp: number): CustomMessage {
	return { role: "custom", customType: "test", content: text, display, timestamp };
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (!("type" in block) || block.type !== "text") continue;
		if (!("text" in block) || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("");
}

function totalTokens(messages: readonly AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

describe("selectManualWindow", () => {
	it("selects only the last complete exchanges in chronological order", () => {
		const messages = [
			user("exchange-1 user", 1),
			assistant("exchange-1 assistant", 2),
			user("exchange-2 user", 3),
			assistant("exchange-2 assistant", 4),
			user("exchange-3 user", 5),
			assistant("exchange-3 assistant", 6),
		];

		const selected = selectManualWindow(messages, 2);
		expect(selected.map(textOf)).toEqual([
			"exchange-2 user",
			"exchange-2 assistant",
			"exchange-3 user",
			"exchange-3 assistant",
		]);
	});

	it("excludes host content but preserves displayed custom content in a selected exchange", () => {
		const messages = [
			user("work request", 1),
			developer("host instruction", 2),
			custom("hidden host reminder", false, 3),
			custom("displayed status", true, 4),
			assistant("work answer", 5),
		];

		const selected = selectManualWindow(messages, 1);
		expect(selected.some(message => message.role === "developer")).toBe(false);
		expect(selected.some(message => message.role === "custom" && message.display === false)).toBe(false);
		expect(selected.some(message => message.role === "custom" && textOf(message) === "displayed status")).toBe(true);
	});

	it("drops an in-flight trailing exchange and returns nothing when no exchange is complete", () => {
		const priorAndTrailing = [
			user("completed user", 1),
			assistant("completed answer", 2),
			user("unfinished user", 3),
		];
		expect(selectManualWindow(priorAndTrailing, 2).map(textOf)).toEqual(["completed user", "completed answer"]);
		expect(selectManualWindow([user("unfinished user", 1)], 1)).toEqual([]);
	});

	it("strips provider state and returns an immutable snapshot", () => {
		const sourceAssistant = assistant("answer", 2);
		const sourceContent = structuredClone(sourceAssistant.content);
		const messages = [user("request", 1), sourceAssistant];

		const selected = selectManualWindow(messages, 1);
		const selectedAssistant = selected.find((message): message is AssistantMessage => message.role === "assistant");
		if (!selectedAssistant) throw new Error("Expected the complete exchange to include its assistant message");
		expect(selectedAssistant.responseId).toBeUndefined();
		expect(selectedAssistant.providerPayload).toBeUndefined();
		selectedAssistant.content = [{ type: "text", text: "mutated snapshot" }];
		expect(sourceAssistant.content).toEqual(sourceContent);
		expect(sourceAssistant.responseId).toBe("response-2");
		expect(sourceAssistant.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			items: [{ id: "provider-2" }],
		});
	});

	it("drops oldest complete exchanges first and truncates an oversized newest exchange under the token cap", () => {
		const exchanges = Array.from({ length: 3 }, (_, index) => {
			const label = `exchange-${index + 1}`;
			return [
				user(`${label} user ${"u".repeat(20_000)}`, index * 2 + 1),
				assistant(`${label} assistant ${"a".repeat(20_000)}`, index * 2 + 2),
			];
		}).flat();

		const selected = selectManualWindow(exchanges, 3);
		expect(totalTokens(selected)).toBeLessThanOrEqual(16_000);
		expect(selected.some(message => textOf(message).startsWith("exchange-3"))).toBe(true);
		expect(selected.some(message => textOf(message).includes("exchange-1"))).toBe(false);
		expect(selected.some(message => textOf(message).includes("exchange-2"))).toBe(false);

		const singleHugeExchange = [
			user(`single huge request ${"u".repeat(90_000)}`, 1),
			assistant(`single huge answer ${"a".repeat(90_000)}`, 2),
		];
		const truncated = selectManualWindow(singleHugeExchange, 1);
		expect(truncated.length).toBeGreaterThan(0);
		expect(totalTokens(truncated)).toBeLessThanOrEqual(16_000);
	});
});
