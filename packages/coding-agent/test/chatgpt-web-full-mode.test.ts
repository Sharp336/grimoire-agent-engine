import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";

const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

function workspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

function asToolResult(callId: string, toolName: string, result: AgentToolResult, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: result.content,
		isError: isError || result.isError === true,
		timestamp: 1,
	};
}

describe("ChatGPT Web full-mode production tool wrapper", () => {
	let root: string;
	let cwd: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let sessionSettings: Settings;
	let setToolUIContext: (ui: never, hasUI: boolean) => void;
	let approvalChoice: "Approve" | "Deny" = "Approve";
	const prompts: string[] = [];
	const executorInputs: Array<{ callId: string; params: unknown }> = [];

	beforeAll(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-chatgpt-full-${Snowflake.next()}-`));
		cwd = path.join(root, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		sessionManager = SessionManager.create(cwd, path.join(root, "sessions"));
		sessionSettings = Settings.isolated(BASE_SETTINGS);
		const created = await createAgentSession({
			cwd,
			agentDir: root,
			sessionManager,
			settings: sessionSettings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			getApiKey: () => "test-key",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: workspaceTree(cwd),
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "write"],
			restrictToolNames: true,
		});
		session = created.session;
		session.modelRegistry.authStorage.setRuntimeApiKey("openai", "test-key");
		setToolUIContext = created.setToolUIContext;
		setInteractiveUI();
		for (const name of ["read", "write"]) {
			const wrapped = session.getToolByName(name);
			if (!wrapped) throw new Error(`missing ${name} tool`);
			const underlying = Reflect.get(wrapped, "tool") as AgentTool;
			const execute = underlying.execute.bind(underlying);
			underlying.execute = async (callId, params, signal, onUpdate, context) => {
				executorInputs.push({ callId, params });
				return execute(callId, params, signal, onUpdate, context);
			};
		}
	});

	afterAll(async () => {
		await session.dispose();
		await session.modelRegistry.authStorage.close();
		await sessionManager.close();
		removeSyncWithRetries(root);
	});

	function settings(mode: "always-ask" | "write" | "yolo", policies: Record<string, unknown> = {}) {
		return Settings.isolated({ ...BASE_SETTINGS, "tools.approvalMode": mode, "tools.approval": policies });
	}

	function context(mode: "always-ask" | "write" | "yolo", policies: Record<string, unknown> = {}): AgentToolContext {
		return { settings: settings(mode, policies), sessionManager } as unknown as AgentToolContext;
	}

	function setInteractiveUI(): void {
		setToolUIContext(
			{
				select: async (title: string, _options: unknown, options?: { signal?: AbortSignal }) => {
					prompts.push(title);
					if (!options?.signal) return approvalChoice;
					if (options.signal.aborted) throw new DOMException("aborted", "AbortError");
					const { promise, resolve, reject } = Promise.withResolvers<string>();
					const onAbort = () => reject(new DOMException("aborted", "AbortError"));
					options.signal.addEventListener("abort", onAbort, { once: true });
					queueMicrotask(() => {
						options.signal!.removeEventListener("abort", onAbort);
						resolve(approvalChoice);
					});
					return promise;
				},
			} as never,
			true,
		);
	}

	function tool(name: "read" | "write") {
		const selected = session.getToolByName(name);
		if (!selected) throw new Error(`missing ${name} tool`);
		return selected;
	}

	test("uses real wrapped read/write tools and preserves approved arguments and call IDs", async () => {
		const target = path.join(cwd, "approved.txt");
		approvalChoice = "Approve";
		const writeResult = await tool("write").execute(
			"write-approved",
			{ path: target, content: "unreviewed bytes" },
			undefined,
			undefined,
			context("always-ask"),
		);
		const wireResult = asToolResult("write-approved", "write", writeResult);
		expect(wireResult.toolCallId).toBe("write-approved");
		expect(fs.readFileSync(target, "utf8")).toBe("unreviewed bytes");
		expect(executorInputs.at(-1)).toEqual({
			callId: "write-approved",
			params: { path: target, content: "unreviewed bytes" },
		});
		expect(prompts.at(-1)).toContain("unreviewed bytes");
		const readResult = await tool("read").execute(
			"read-approved",
			{ path: target },
			undefined,
			undefined,
			context("always-ask"),
		);
		expect(asToolResult("read-approved", "read", readResult).toolCallId).toBe("read-approved");
	});

	test("routes denial through the AgentSession loop as an exact error result without executing", async () => {
		const target = path.join(cwd, "denied.txt");
		fs.writeFileSync(target, "original");
		approvalChoice = "Deny";
		sessionSettings.override("tools.approvalMode", "always-ask");
		const before = executorInputs.length;
		let result: ToolResultMessage | undefined;
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "write-denied",
							name: "write",
							arguments: { path: target, content: "forged" },
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["done"] },
			],
		});
		session.agent.streamFn = (model, streamContext, options) => {
			result = streamContext.messages.findLast(message => message.role === "toolResult") as
				| ToolResultMessage
				| undefined;
			return mock.stream(model, streamContext, options);
		};
		await session.prompt("Write the denied fixture");
		expect(result).toMatchObject({ toolCallId: "write-denied", toolName: "write", isError: true });
		expect(executorInputs).toHaveLength(before);
		expect(fs.readFileSync(target, "utf8")).toBe("original");
		sessionSettings.override("tools.approvalMode", "yolo");
	});

	test("enforces always-ask, write, yolo, explicit deny, and no-UI precedence", async () => {
		const target = path.join(cwd, "modes.txt");
		approvalChoice = "Approve";
		await tool("write").execute(
			"mode-ask",
			{ path: target, content: "ask" },
			undefined,
			undefined,
			context("always-ask"),
		);
		const promptsAfterAsk = prompts.length;
		await tool("write").execute(
			"mode-write",
			{ path: target, content: "write" },
			undefined,
			undefined,
			context("write"),
		);
		await tool("write").execute(
			"mode-yolo",
			{ path: target, content: "yolo" },
			undefined,
			undefined,
			context("yolo"),
		);
		expect(prompts).toHaveLength(promptsAfterAsk);
		const beforeDeny = executorInputs.length;
		await expect(
			tool("write").execute(
				"mode-deny",
				{ path: target, content: "denied" },
				undefined,
				undefined,
				context("yolo", { write: "deny" }),
			),
		).rejects.toThrow(/blocked by user policy/);
		expect(executorInputs).toHaveLength(beforeDeny);
		setToolUIContext({} as never, false);
		await expect(
			tool("write").execute(
				"mode-no-ui",
				{ path: target, content: "no-ui" },
				undefined,
				undefined,
				context("always-ask"),
			),
		).rejects.toThrow(/no interactive UI available/);
		setInteractiveUI();
	});

	test("fails closed for pending provider safety and cancellation during approval", async () => {
		const target = path.join(cwd, "cancelled.txt");
		const before = executorInputs.length;
		setToolUIContext({} as never, false);
		await expect(
			tool("write").execute("pending-safety", { path: target, content: "blocked" }, undefined, undefined, {
				...context("yolo"),
				toolCall: {
					providerMetadata: {
						type: "computer",
						actions: [],
						pendingSafetyChecks: [{ id: "check", code: "check", message: "review" }],
					},
				},
			} as unknown as AgentToolContext),
		).rejects.toThrow(/pending provider safety checks/);
		setInteractiveUI();
		setToolUIContext(
			{
				select: async (_title: string, _options: unknown, options?: { signal?: AbortSignal }) => {
					const { promise, reject } = Promise.withResolvers<string>();
					options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
					return promise;
				},
			} as never,
			true,
		);
		const abort = new AbortController();
		const pending = tool("write").execute(
			"cancel-approval",
			{ path: target, content: "blocked" },
			abort.signal,
			undefined,
			context("always-ask"),
		);
		await Promise.resolve();
		abort.abort();
		await expect(pending).rejects.toThrow();
		expect(executorInputs).toHaveLength(before);
		expect(fs.existsSync(target)).toBe(false);
		setInteractiveUI();
	});
});
