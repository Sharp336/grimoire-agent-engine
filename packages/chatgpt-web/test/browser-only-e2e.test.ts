import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Context, Model } from "@oh-my-pi/pi-ai";
import { createChatGptWebExtension } from "../src/extension";
import { type ChatGptWebProviderModel, createChatGptWebProviderModels } from "../src/models";
import { providerSessionState } from "../src/provider/session";
import { type ChatGptWebStream, type ChatGptWebTurnRunner, createChatGptWebStream } from "../src/provider/stream";
import type { ChatGptWebEvent, ChatGptWebRuntimeAdmission, ChatGptWebRuntimeGate } from "../src/provider/types";
import type { BrowserHost } from "../src/runtime/host";

function model(): Model<Api> {
	return {
		id: "light",
		name: "ChatGPT Web Light",
		api: "chatgpt-web",
		provider: "chatgpt-web",
		baseUrl: "chatgpt-web://local",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 64_000,
		compat: {},
	} as Model<Api>;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function browserEventStream(release: Promise<void>): ChatGptWebTurnRunner {
	return async (_turn, _host, _admission, emit) => {
		const events: readonly ChatGptWebEvent[] = [
			{ type: "start", responseId: "browser-only-response" },
			{ type: "reasoning", text: "reasoning" },
			{ type: "text", text: "answer" },
			{ type: "done", reason: "stop" },
		];
		emit(events[0]!);
		await release;
		for (const event of events.slice(1)) emit(event);
	};
}

function limitedGate(limit: number): { gate: ChatGptWebRuntimeGate; active: () => number; admissions: () => number } {
	let active = 0;
	let admissions = 0;
	const gate: ChatGptWebRuntimeGate = {
		async admit() {
			if (active >= limit) throw new Error("browser profile turn capacity exceeded");
			active++;
			admissions++;
			return {} as ChatGptWebRuntimeAdmission;
		},
		retain() {
			return {} as never;
		},
		release() {
			active--;
		},
		async drain() {},
		async resume() {
			return { runtimeEpoch: "browser-only-epoch", lifecycleGeneration: 1 };
		},
	};
	return { gate, active: () => active, admissions: () => admissions };
}

beforeEach(() => providerSessionState.clear());

describe("browser-only local provider path", () => {
	test("loads the real extension/model picker before running a browser turn", async () => {
		const capacity = limitedGate(5);
		let browserTurns = 0;
		let orchestrationCalls = 0;
		const config = { mode: "browser-only" as const, tunnelId: null, runtimeKeyConfigured: false };
		const orchestration = {
			async issue() {
				orchestrationCalls++;
				throw new Error("browser-only must not issue broker turns");
			},
			nextInvocationBatch() {
				throw new Error("browser-only must not poll MCP");
			},
			async resolveBatch() {
				throw new Error("browser-only must not resolve MCP batches");
			},
			async release() {},
		};
		let registered:
			| {
					readonly streamSimple: ChatGptWebStream;
					readonly models: readonly ChatGptWebProviderModel[];
			  }
			| undefined;
		const extension = createChatGptWebExtension({
			async readConfig() {
				return config;
			},
			async readLoginStatus() {
				return { authenticated: true, proAvailable: false, verifiedAt: "2026-08-02T00:00:00.000Z" };
			},
			createModels: createChatGptWebProviderModels,
			createStream: options =>
				createChatGptWebStream({
					...options,
					host: {} as BrowserHost,
					gate: capacity.gate,
					config,
					orchestration,
					turnRunner: async (...args) => {
						browserTurns++;
						return browserEventStream(Promise.resolve())(...args);
					},
				}),
		});
		await extension({
			issueKeylessProviderRegistration() {
				return { keylessCapability: {} };
			},
			registerProvider(_name, value) {
				registered = value;
			},
		});
		if (!registered) throw new Error("ChatGPT Web extension did not register a provider");
		expect(registered.models.map(model => model.id)).toEqual(["light", "medium", "high", "extra-high"]);
		const selected = registered.models.find(model => model.id === "high");
		expect(selected?.supportsTools).toBe(false);
		const events = await collect(
			registered.streamSimple(
				selected as unknown as Model<Api>,
				{
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
					tools: [],
				} satisfies Context,
				{ sessionId: "browser-only-session", apiKey: "N/A" },
			),
		);
		expect(events.at(-1)?.type).toBe("done");
		expect(browserTurns).toBe(1);
		expect(orchestrationCalls).toBe(0);
		expect(capacity.admissions()).toBe(1);
	});
	test("reattaches an image and survives a clean runtime restart", async () => {
		const capacity = limitedGate(5);
		let browserTurns = 0;
		let attachmentCount = 0;
		const turnRunner: ChatGptWebTurnRunner = async (turn, _host, _admission, emit) => {
			browserTurns++;
			attachmentCount = turn.attachments?.length ?? 0;
			emit({ type: "start", responseId: `restart-${browserTurns}` });
			emit({ type: "text", text: "image accepted" });
			emit({ type: "done", reason: "stop" });
		};
		const context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe this image" },
						{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
					],
					timestamp: 1,
				},
			],
			tools: [],
		} satisfies Context;
		const run = (sessionId: string) =>
			collect(
				createChatGptWebStream({
					host: {} as BrowserHost,
					gate: capacity.gate,
					config: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false },
					turnRunner,
				})(model(), context, { sessionId, apiKey: "N/A" }),
			);
		expect((await run("restart-before")).at(-1)?.type).toBe("done");
		expect(attachmentCount).toBe(1);
		await capacity.gate.drain();
		await capacity.gate.resume();
		expect((await run("restart-after")).at(-1)?.type).toBe("done");
		expect(browserTurns).toBe(2);
		expect(attachmentCount).toBe(1);
	});

	test("cancels an active browser turn without leaving a profile lease", async () => {
		const capacity = limitedGate(5);
		const controller = new AbortController();
		const turnRunner: ChatGptWebTurnRunner = async (_turn, _host, _admission, _emit, signal) => {
			await new Promise<void>((_resolve, reject) => {
				const abort = () => reject(new DOMException("cancelled", "AbortError"));
				if (signal?.aborted) return abort();
				signal?.addEventListener("abort", abort, { once: true });
			});
		};
		const result = collect(
			createChatGptWebStream({
				host: {} as BrowserHost,
				gate: capacity.gate,
				config: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false },
				turnRunner,
			})(model(), { messages: [{ role: "user", content: "cancel", timestamp: 1 }], tools: [] } satisfies Context, {
				sessionId: "cancel-session",
				apiKey: "N/A",
				signal: controller.signal,
			}),
		);
		await new Promise(resolve => setTimeout(resolve, 0));
		controller.abort();
		const events = await result;
		expect(events.at(-1)?.type).toBe("error");
		expect(capacity.active()).toBe(0);
	});

	test("fails closed on a conflicting profile owner before browser execution", async () => {
		let browserTurns = 0;
		const conflictGate: ChatGptWebRuntimeGate = {
			async admit() {
				throw new Error("browser profile owner conflict");
			},
			retain() {
				return {} as never;
			},
			release() {},
			async drain() {},
			async resume() {
				return { runtimeEpoch: "conflict-epoch", lifecycleGeneration: 1 };
			},
		};
		const events = await collect(
			createChatGptWebStream({
				host: {} as BrowserHost,
				gate: conflictGate,
				config: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false },
				turnRunner: async () => {
					browserTurns++;
				},
			})(model(), { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] } satisfies Context, {
				sessionId: "owner-conflict-session",
				apiKey: "N/A",
			}),
		);
		expect(events.at(-1)?.type).toBe("error");
		expect(browserTurns).toBe(0);
	});

	test("admits five parallel browser turns and rejects the sixth before browser execution", async () => {
		const capacity = limitedGate(5);
		let browserTurns = 0;
		let release!: () => void;
		const releaseAll = new Promise<void>(resolve => {
			release = resolve;
		});
		const makeStream = (sessionId: string) =>
			createChatGptWebStream({
				host: {} as BrowserHost,
				gate: capacity.gate,
				config: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false },
				turnRunner: async (...args) => {
					browserTurns++;
					return browserEventStream(releaseAll)(...args);
				},
			})(model(), { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] } satisfies Context, {
				sessionId,
				apiKey: "N/A",
			});
		const results = Array.from({ length: 6 }, (_, index) => collect(makeStream(`parallel-${index}`)));
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(browserTurns).toBe(5);
		expect(capacity.active()).toBe(5);
		release();
		const events = await Promise.all(results);
		expect(events.filter(result => result.at(-1)?.type === "done")).toHaveLength(5);
		expect(events.filter(result => result.at(-1)?.type === "error")).toHaveLength(1);
		expect(capacity.active()).toBe(0);
	});
	test("loads the real coding-agent session around the ChatGPT Web extension and picker", async () => {
		const result = await runCodingAgentSessionFixture();
		expect(result).toEqual({ provider: "chatgpt-web", model: "high", registeredModel: "high" });
	});
});
async function runCodingAgentSessionFixture(): Promise<{
	readonly provider: string;
	readonly model: string;
	readonly registeredModel: string | undefined;
}> {
	const fixturePath = path.join(process.cwd(), `.chatgpt-web-session-fixture-${randomUUID()}.ts`);
	const workspaceRoot = path.resolve(import.meta.dir, "../../..");
	await Bun.write(
		fixturePath,
		`
const codingAgentPackage = ["@oh-my-pi/pi", "coding", "agent"].join("-");
const [{ createAgentSession }, { ModelRegistry }, { Settings }, { AuthStorage }, { SessionManager }] = await Promise.all([
	import(codingAgentPackage + "/sdk"),
	import(codingAgentPackage + "/config/model-registry"),
	import(codingAgentPackage + "/config/settings"),
	import(codingAgentPackage + "/session/auth-storage"),
	import(codingAgentPackage + "/session/session-manager"),
]);
import { createChatGptWebProviderModels } from "@oh-my-pi/pi-chatgpt-web";
import { createChatGptWebExtension } from "@oh-my-pi/pi-chatgpt-web/extension";
import { createChatGptWebStream } from "@oh-my-pi/pi-chatgpt-web";
import { mkdirSync } from "node:fs";
import path from "node:path";

const root = process.env.CHATGPT_WEB_FIXTURE_ROOT;
const cwd = path.join(root, "workspace");
mkdirSync(cwd, { recursive: true });
const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.json"));
const extension = createChatGptWebExtension({
	readConfig: async () => ({ mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false }),
	readLoginStatus: async () => ({ authenticated: true, proAvailable: false, verifiedAt: "2026-08-02T00:00:00.000Z" }),
	createModels: createChatGptWebProviderModels,
	createStream: options => createChatGptWebStream(options),
});
let registeredModel;
await extension({
	issueKeylessProviderRegistration() { return { keylessCapability: {} }; },
	registerProvider(_name, config) {
		registeredModel = config.models.find(model => model.id === "high")?.id;
	},
});
const model = {
	id: "high",
	name: "ChatGPT Web — High",
	api: "chatgpt-web",
	provider: "chatgpt-web",
	baseUrl: "chatgpt-web://local",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 256000,
	maxTokens: 64000,
	compat: {},
};
const created = await createAgentSession({
	cwd,
	agentDir: root,
	sessionManager: SessionManager.inMemory(cwd),
	authStorage,
	modelRegistry,
	settings: Settings.isolated({ "async.enabled": false, "bash.autoBackground.enabled": false }),
	model,
	disableExtensionDiscovery: true,
	extensions: [extension],
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: ".\\\\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
	skipPythonPreflight: true,
	toolNames: [],
});
const selected = created.session.model;
process.stdout.write(JSON.stringify({ provider: selected.provider, model: selected.id, registeredModel }));
await created.session.dispose();
authStorage.close();
process.exit(0);
`,
	);
	try {
		const fixtureRoot = path.join(process.cwd(), `.chatgpt-web-session-${randomUUID()}`);
		const child = Bun.spawn([process.execPath, fixturePath], {
			cwd: workspaceRoot,
			env: { ...process.env, CHATGPT_WEB_FIXTURE_ROOT: fixtureRoot },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if ((await child.exited) !== 0) throw new Error(`coding-agent fixture failed: ${stderr}`);
		return JSON.parse(stdout) as { provider: string; model: string; registeredModel: string | undefined };
	} finally {
		await rm(fixturePath, { force: true });
	}
}
