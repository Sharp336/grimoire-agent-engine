import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildApi3Route,
	buildQoderApi3Body,
	createQoderApi3Transport,
	QODER_API3_BASE,
	type QoderApi3ModelRoute,
	type QoderApi3Transport,
	type QoderApi3TransportDeps,
	resolveApi3Effort,
} from "@oh-my-pi/pi-ai/providers/qoder-api3";
import { QODER_PRIVATE_DATA_POLICY, repairQoderSseBody } from "@oh-my-pi/pi-ai/registry/oauth/qoder";
import type {
	QoderPreparedRequest,
	QoderWasmBridge,
	QoderWasmContext,
} from "@oh-my-pi/pi-ai/registry/oauth/qoder-wasm";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	RawSseEvent,
	SimpleStreamOptions,
	Tool,
} from "@oh-my-pi/pi-ai/types";
import { isQoderApi3Model } from "@oh-my-pi/pi-ai/types";
import { withEmptyCompletionRetry } from "@oh-my-pi/pi-ai/utils/empty-completion-retry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// ---------------------------------------------------------------------------
// api3 model fixtures (base wire key → model_config.key, alias window →
// parameters.context_length, base window → model_config.max_input_tokens)
// ---------------------------------------------------------------------------

interface Api3Spec {
	id: string;
	/** Base wire key when the row is a context alias. */
	wireId?: string;
	name: string;
	contextWindow: number;
	/** Base row's window when the row is a context alias. */
	baseContextWindow?: number;
	reasoning: boolean;
	efforts: readonly string[];
	defaultEffort?: string;
	requiresEffort?: boolean;
}

const API3_SPECS: Readonly<Record<string, Api3Spec>> = {
	cmodel: {
		id: "cmodel",
		name: "Cantus",
		contextWindow: 200_000,
		reasoning: true,
		efforts: ["low", "medium", "high", "xhigh", "max"],
		defaultEffort: "high",
	},
	qmodel_preview: {
		id: "qmodel_preview",
		name: "Qwen3.8-Max-Preview",
		contextWindow: 200_000,
		reasoning: true,
		efforts: ["high"],
		defaultEffort: "high",
		requiresEffort: true,
	},
	qmodel_latest: {
		id: "qmodel_latest",
		name: "Qwen3.7-Max",
		contextWindow: 200_000,
		reasoning: false,
		efforts: [],
	},
	"qmodel_preview-400k": {
		id: "qmodel_preview-400k",
		wireId: "qmodel_preview",
		name: "Qwen3.8-Max-Preview",
		contextWindow: 400_000,
		baseContextWindow: 200_000,
		reasoning: true,
		efforts: ["high"],
		defaultEffort: "high",
		requiresEffort: true,
	},
};

function specById(id: string): Api3Spec {
	const spec = API3_SPECS[id];
	if (spec === undefined) throw new Error(`missing api3 spec: ${id}`);
	return spec;
}

/**
 * The catalog-built model dispatch would hand the transport: the bundled
 * legacy qoder row's resolved compat is the same compat family the api3 seed
 * rows carry, with identity fields overridden per spec.
 */
function api3Model(spec: Api3Spec): Model<"openai-completions"> {
	const base = getBundledModel<"openai-completions">("qoder", "auto");
	return {
		...base,
		id: spec.id,
		name: spec.name,
		contextWindow: spec.contextWindow,
		reasoning: spec.reasoning,
		...(spec.wireId !== undefined ? { requestModelId: spec.wireId } : {}),
	};
}

/** Rebuild the api3 route the transport's `buildApi3Route` derives (not exported). */
function api3Route(id: string): QoderApi3ModelRoute {
	const spec = specById(id);
	const wireId = spec.wireId ?? spec.id;
	return {
		wireId,
		displayName: spec.name,
		contextWindow: spec.contextWindow,
		maxInputTokens: spec.baseContextWindow ?? spec.contextWindow,
		isReasoning: spec.reasoning,
		isVl: true,
		efforts: spec.efforts,
		defaultEffort: spec.defaultEffort,
		requiresEffort: spec.requiresEffort === true,
		openaiModel: api3Model(spec),
	};
}

const WEATHER_TOOL: Tool = {
	name: "get_weather",
	description: "Get the weather for a city",
	parameters: {
		type: "object",
		properties: { city: { type: "string" } },
		required: ["city"],
	},
};

function userContext(): Context {
	return {
		systemPrompt: ["You are terse."],
		messages: [{ role: "user", content: "Reply exactly with OK.", timestamp: 1 }],
		tools: [WEATHER_TOOL],
	};
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`expected an object for ${label}`);
	}
	return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fake WASM bridge + fetch
// ---------------------------------------------------------------------------

interface CapturedPrepare {
	endpoint: string;
	bodyJson: string;
	modelKey: string | undefined;
	modelSource: string | undefined;
}

interface FakeBridgeState {
	identities: string[];
	userInfos: string[];
	configs: (string | undefined)[];
	prepares: CapturedPrepare[];
}

/**
 * Deterministic stand-in for the auth WASM: records the identity chain and
 * returns a canned signed request whose body echoes the plaintext it was
 * handed, so tests can assert exactly what would have been encrypted.
 */
function fakeBridge(): { bridge: QoderWasmBridge; state: FakeBridgeState } {
	const state: FakeBridgeState = {
		identities: [],
		userInfos: [],
		configs: [],
		prepares: [],
	};
	const context: QoderWasmContext = {
		prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) {
			state.prepares.push({ endpoint, bodyJson, modelKey, modelSource });
			const prepared: QoderPreparedRequest = {
				url: `${endpoint}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
				headers: {
					Authorization: `COSY fake-signature-${state.prepares.length}`,
					"Cosy-Data-Policy": QODER_PRIVATE_DATA_POLICY,
					"X-Model-Key": modelKey ?? "",
					"X-Model-Source": modelSource ?? "",
				},
				body: `encrypted(${bodyJson.length}):${bodyJson}`,
			};
			return prepared;
		},
		prepareRequest() {
			throw new Error("management requests are out of scope for these tests");
		},
		decryptServerResponse(encrypted) {
			return encrypted;
		},
		free() {},
	};
	const bridge: QoderWasmBridge = {
		createContext(_machineId, _cosyVersion, userInfoJson, configJson) {
			state.userInfos.push(userInfoJson);
			state.configs.push(configJson);
			return context;
		},
		generateRuntimeAuthFields(identityJson) {
			state.identities.push(identityJson);
			return { encrypt_user_info: "fake-encrypt-user-info", key: "fake-key" };
		},
		decryptServerResponse(encrypted) {
			return encrypted;
		},
	};
	return { bridge, state };
}

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: string;
}

interface FakeFetch {
	fetchImpl: FetchImpl;
	userinfoRequests: CapturedRequest[];
	inferRequests: CapturedRequest[];
}

/** Serves the userinfo identity lookup, then the canned SSE inference stream. */
function fakeApi3Fetch(respond: () => Response, userinfo?: () => Response): FakeFetch {
	const userinfoRequests: CapturedRequest[] = [];
	const inferRequests: CapturedRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const captured: CapturedRequest = {
			url: typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(),
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? init.body : "",
		};
		if (captured.url.includes("/api/v1/userinfo")) {
			userinfoRequests.push(captured);
			return (
				userinfo?.() ??
				new Response(JSON.stringify({ id: "uid-test-account" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			);
		}
		inferRequests.push(captured);
		return respond();
	};
	return { fetchImpl, userinfoRequests, inferRequests };
}

// ---------------------------------------------------------------------------
// SSE envelope fixtures (the api3 wire shape: JSON envelope per data line,
// whose `body` string is itself a JSON chat.completion.chunk)
// ---------------------------------------------------------------------------

function envelope(body: string, statusCodeValue = 200): string {
	return JSON.stringify({
		headers: {},
		body,
		statusCode: statusCodeValue >= 400 ? "ERROR" : "OK",
		statusCodeValue,
	});
}

function chunkEnvelope(chunk: Record<string, unknown>): string {
	return envelope(JSON.stringify(chunk));
}

const FINISH_METRICS_FRAME = `event: finish\ndata: ${JSON.stringify({ firstTokenDuration: 3, totalDuration: 9, serverDuration: 8 })}`;

function sseResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** thinking → text → tool call → finish_reason=tool_calls → usage → [DONE]. */
const HAPPY_SSE = [
	`data: ${chunkEnvelope({ choices: [{ delta: { reasoning_content: "checking" }, index: 0 }] })}`,
	`data: ${chunkEnvelope({ choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
	`data: ${chunkEnvelope({
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							function: { name: "get_weather", arguments: '{"city":' },
						},
					],
				},
				index: 0,
			},
		],
	})}`,
	`data: ${chunkEnvelope({
		choices: [
			{
				delta: {
					tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
				},
				index: 0,
			},
		],
	})}`,
	`data: ${chunkEnvelope({ choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] })}`,
	`data: ${chunkEnvelope({
		choices: [],
		usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
	})}`,
	`data: ${envelope("[DONE]")}`,
	FINISH_METRICS_FRAME,
	"",
].join("\n\n");

interface TurnResult {
	events: AssistantMessageEvent[];
	result: AssistantMessage;
	bridgeState: FakeBridgeState;
	fetches: FakeFetch;
}

async function runApi3Turn(
	modelId: string,
	respond: () => Response,
	options?: SimpleStreamOptions,
): Promise<TurnResult> {
	const { bridge, state } = fakeBridge();
	const fetches = fakeApi3Fetch(respond);
	const transport = createQoderApi3Transport({
		bridge,
		machineId: "machine-test",
		openapiBase: "https://openapi.qoder.sh",
		api3Base: QODER_API3_BASE,
		cosyVersion: "1.1.2",
		clientName: "omp",
		repair: repairQoderSseBody,
	});
	const stream = transport.stream(api3Route(modelId), api3Model(specById(modelId)), userContext(), {
		apiKey: "qoder-test-token",
		fetch: fetches.fetchImpl,
		...options,
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	return { events, result, bridgeState: state, fetches };
}

/** The deps every hand-built transport in this file shares. */
function makeTransport(bridge: QoderWasmBridge, overrides: Partial<QoderApi3TransportDeps> = {}): QoderApi3Transport {
	return createQoderApi3Transport({
		bridge,
		machineId: "machine-test",
		openapiBase: "https://openapi.qoder.sh",
		api3Base: QODER_API3_BASE,
		cosyVersion: "1.1.2",
		clientName: "omp",
		repair: repairQoderSseBody,
		...overrides,
	});
}

/** Drain one turn over an existing transport (context-cache tests reuse it across turns). */
async function collectTurn(
	transport: QoderApi3Transport,
	modelId: string,
	options?: SimpleStreamOptions,
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const stream = transport.stream(api3Route(modelId), api3Model(specById(modelId)), userContext(), options);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

// ---------------------------------------------------------------------------
// (a) plaintext body contract
// ---------------------------------------------------------------------------

describe("buildQoderApi3Body", () => {
	it("emits the verified router fields and model_config for a context alias", () => {
		const body = buildQoderApi3Body({
			route: api3Route("qmodel_preview-400k"),
			context: userContext(),
			cosyVersion: "1.1.2",
			clientName: "omp",
		});

		expect(body.chat_task).toBe("FREE_INPUT");
		expect(body.agent_id).toBe("agent_common");
		expect(body.session_type).toBe("qodercli");
		expect(body.version).toBe("3");
		expect(body.stream).toBe(true);
		expect(body.is_reply).toBe(true);
		expect(body.is_retry).toBe(false);
		expect(body.source).toBe(1);
		for (const key of ["request_id", "request_set_id", "chat_record_id", "session_id"]) {
			expect(typeof body[key], key).toBe("string");
		}
		expect(typeof body.task_id).toBe("string");

		// The alias window rides parameters.context_length while model_config
		// keeps the base wire id and the base window (live-capture contract).
		const modelConfig = asRecord(body.model_config, "model_config");
		expect(modelConfig.key).toBe("qmodel_preview");
		expect(modelConfig.source).toBe("system");
		expect(modelConfig.format).toBe("openai");
		expect(modelConfig.display_name).toBe("Qwen3.8-Max-Preview");
		expect(modelConfig.is_reasoning).toBe(true);
		expect(modelConfig.max_input_tokens).toBe(200_000);
		const parameters = asRecord(body.parameters, "parameters");
		expect(parameters.context_length).toBe(400_000);
		expect(parameters.max_tokens).toBe(32_768);

		const business = asRecord(body.business, "business");
		expect(business.product).toBe("cli");
		expect(business.version).toBe("1.1.2");
		expect(business.type).toBe("agent");
		expect(business.stage).toBe("start");
		expect(business.name).toBe("omp");

		const chatContext = asRecord(body.chat_context, "chat_context");
		expect(chatContext.text).toBe("Reply exactly with OK.");
		const extra = asRecord(chatContext.extra, "chat_context.extra");
		expect(extra.originalContent).toBe("Reply exactly with OK.");
		expect(asRecord(extra.modelConfig, "modelConfig").key).toBe("qmodel_preview");
	});

	it("serializes system prompt, messages, and tools the OpenAI way", () => {
		const body = buildQoderApi3Body({
			route: api3Route("cmodel"),
			context: userContext(),
			cosyVersion: "1.1.2",
			clientName: "omp",
		});

		expect(body.system).toBe("You are terse.");
		const messages = body.messages as Record<string, unknown>[];
		expect(Array.isArray(messages)).toBe(true);
		expect(messages.every(message => message.role !== "system" && message.role !== "developer")).toBe(true);
		const user = messages.find(message => message.role === "user");
		expect(user?.content).toBe("Reply exactly with OK.");

		const tools = body.tools as Record<string, unknown>[];
		expect(tools).toHaveLength(1);
		const fn = asRecord(tools[0]?.function, "tools[0].function");
		expect(fn.name).toBe("get_weather");
		expect(JSON.stringify(fn.parameters)).toContain("city");
	});

	it("carries the effort twins and never a privacy field in the body", () => {
		const body = buildQoderApi3Body({
			route: api3Route("qmodel_preview"),
			context: userContext(),
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		const parameters = asRecord(body.parameters, "parameters");
		expect(body.reasoningEffort).toBe("high");
		expect(parameters.reasoning_effort).toBe("high");

		// Privacy Mode is enforced by the WASM-signed Cosy-Data-Policy header;
		// the api3 body itself carries no data_policy/metadata field at all.
		expect(body.metadata).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("data_policy");
	});

	it("maps reasoning controls onto the wire effort tokens", () => {
		// Requested effort inside the ladder wins.
		const xhigh = buildQoderApi3Body({
			route: api3Route("cmodel"),
			context: userContext(),
			options: {
				reasoning: "xhigh" as SimpleStreamOptions["reasoning"],
			},
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		expect(xhigh.reasoningEffort).toBe("xhigh");
		expect(asRecord(xhigh.parameters, "parameters").reasoning_effort).toBe("xhigh");

		// Disabling reasoning on a ladder model sends none + a zero thinking budget.
		const disabled = buildQoderApi3Body({
			route: api3Route("cmodel"),
			context: userContext(),
			options: { disableReasoning: true },
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		expect(disabled.reasoningEffort).toBe("none");
		const disabledParameters = asRecord(disabled.parameters, "parameters");
		expect(disabledParameters.reasoning_effort).toBe("none");
		expect(disabledParameters.max_thinking_tokens).toBe(0);

		// A requiresEffort model ignores the disable switch.
		const required = buildQoderApi3Body({
			route: api3Route("qmodel_preview"),
			context: userContext(),
			options: { disableReasoning: true },
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		expect(required.reasoningEffort).toBe("high");

		// Non-reasoning families emit no effort fields at all.
		const nonReasoning = buildQoderApi3Body({
			route: api3Route("qmodel_latest"),
			context: userContext(),
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		expect(nonReasoning.reasoningEffort).toBeUndefined();
		expect(asRecord(nonReasoning.parameters, "parameters").reasoning_effort).toBeUndefined();
	});

	it("falls back to the route default for efforts outside the ladder", () => {
		const route = api3Route("qmodel_preview");
		expect(
			resolveApi3Effort(route, {
				reasoning: "xhigh" as SimpleStreamOptions["reasoning"],
			}),
		).toBe("high");
		expect(resolveApi3Effort(route)).toBe("high");
	});
});

// ---------------------------------------------------------------------------
// (b) SSE envelope → legacy event semantics, over the fake bridge
// ---------------------------------------------------------------------------

describe("createQoderApi3Transport", () => {
	it("maps envelope frames into the legacy event semantics", async () => {
		const { events, result, bridgeState, fetches } = await runApi3Turn("qmodel_preview", () =>
			sseResponse(HAPPY_SSE),
		);

		expect(events.map(event => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "checking" },
			{ type: "text", text: "OK" },
			{
				type: "toolCall",
				id: "call_1",
				name: "get_weather",
				arguments: { city: "Paris" },
			},
		]);
		expect(result.usage.input).toBe(12);
		expect(result.usage.output).toBe(7);
		expect(result.usage.totalTokens).toBe(19);

		// Identity chain: uid from userinfo, auth fields over the identity JSON
		// (never the machine id), privacy disagreement on the WASM userInfo.
		expect(fetches.userinfoRequests).toHaveLength(1);
		expect(fetches.userinfoRequests[0]?.headers.get("Authorization")).toBe("Bearer qoder-test-token");
		expect(bridgeState.identities).toHaveLength(1);
		expect(JSON.parse(bridgeState.identities[0] ?? "")).toEqual({
			uid: "uid-test-account",
			organization_id: "",
			organization_tags: [],
			data_policy_agreed: false,
		});
		expect(JSON.parse(bridgeState.userInfos[0] ?? "")).toEqual({
			uid: "uid-test-account",
			encrypt_user_info: "fake-encrypt-user-info",
			key: "fake-key",
			organization_id: "",
			organization_tags: [],
			data_policy_agreed: false,
		});
		expect(JSON.parse(bridgeState.configs[0] ?? "")).toEqual({
			client_type: "5",
			business_product: "cli",
			business_type: "agent",
			scene: "assistant",
		});

		// The WASM prepared exactly one signed request for the base wire id…
		expect(bridgeState.prepares).toHaveLength(1);
		const prepare = bridgeState.prepares[0];
		expect(prepare?.endpoint).toBe("https://api3.qoder.sh");
		expect(prepare?.modelKey).toBe("qmodel_preview");
		expect(prepare?.modelSource).toBe("system");
		const signedBody = asRecord(JSON.parse(prepare?.bodyJson ?? ""), "prepared body");
		expect(asRecord(signedBody.model_config, "model_config").key).toBe("qmodel_preview");

		// …and the transport POSTed it verbatim, privacy header included.
		expect(fetches.inferRequests).toHaveLength(1);
		const request = fetches.inferRequests[0];
		expect(request?.url).toContain("https://api3.qoder.sh/algo/");
		expect(request?.headers.get("Cosy-Data-Policy")).toBe("disagree");
		expect(request?.headers.get("X-Model-Key")).toBe("qmodel_preview");
		expect(request?.body).toBe(`encrypted(${(prepare?.bodyJson ?? "").length}):${prepare?.bodyJson ?? ""}`);
	});

	it("signs alias turns with the base wire id and the alias window", async () => {
		const { bridgeState } = await runApi3Turn("qmodel_preview-400k", () => sseResponse(HAPPY_SSE));
		const prepare = bridgeState.prepares[0];
		expect(prepare?.modelKey).toBe("qmodel_preview");
		const signedBody = asRecord(JSON.parse(prepare?.bodyJson ?? ""), "prepared body");
		expect(asRecord(signedBody.model_config, "model_config").key).toBe("qmodel_preview");
		expect(asRecord(signedBody.parameters, "parameters").context_length).toBe(400_000);
	});

	// (c) error envelope → error stop with the surfaced message
	it("maps an error envelope to an error stop with the surfaced message", async () => {
		const errorSse = [
			`data: ${envelope(JSON.stringify({ code: "101", message: "Signature invalid" }))}`,
			FINISH_METRICS_FRAME,
			"",
		].join("\n\n");
		const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(errorSse));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Qoder api3 error 101: Signature invalid");
		expect(events.map(event => event.type)).toEqual(["start", "error"]);
		const terminal = events[events.length - 1];
		if (terminal?.type === "error") {
			expect(terminal.reason).toBe("error");
			expect(terminal.error.errorMessage).toContain("Signature invalid");
		}
	});

	// (d) folded envelopes survive the repair pass
	it("repairs a folded envelope payload split across lines and network chunks", async () => {
		const textLine = `data: ${chunkEnvelope({ choices: [{ delta: { content: "hello" }, index: 0 }] })}`;
		const tailFrames = [
			`data: ${chunkEnvelope({
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			})}`,
			`data: ${envelope("[DONE]")}`,
			FINISH_METRICS_FRAME,
		];
		// Fold the first frame's JSON payload across a physical newline (the
		// continuation line has no data: prefix, like Qoder's folding).
		const cut = textLine.indexOf("hello") + 2;
		const foldedSse = [`${textLine.slice(0, cut)}\n${textLine.slice(cut)}`, ...tailFrames, ""].join("\n\n");
		// …and split the byte stream mid-fold across two network chunks.
		const splitAt = foldedSse.indexOf("hello") + 1;
		const encoder = new TextEncoder();
		const byteStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(foldedSse.slice(0, splitAt)));
				controller.enqueue(encoder.encode(foldedSse.slice(splitAt)));
				controller.close();
			},
		});
		const { events, result } = await runApi3Turn(
			"qmodel_preview",
			() =>
				new Response(byteStream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		expect(result.stopReason).toBe("stop");
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => (block.type === "text" ? block.text : ""))
			.join("");
		expect(text).toBe("hello");
		expect(result.usage.input).toBe(1);
		expect(result.usage.output).toBe(1);
		expect(result.usage.totalTokens).toBe(2);
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	// (e) mid-stream failure closes open blocks before the terminal error
	it("closes the open block before the terminal error when the stream fails mid-turn", async () => {
		const encoder = new TextEncoder();
		let pulled = false;
		const failingStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!pulled) {
					pulled = true;
					controller.enqueue(
						encoder.encode(
							`data: ${chunkEnvelope({ choices: [{ delta: { content: "partial" }, index: 0 }] })}\n\n`,
						),
					);
					return;
				}
				controller.error(new Error("socket reset"));
			},
		});
		const { events, result } = await runApi3Turn(
			"qmodel_preview",
			() =>
				new Response(failingStream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("socket reset");
		const types = events.map(event => event.type);
		const textEnd = types.indexOf("text_end");
		const errorIndex = types.indexOf("error");
		expect(types).toContain("text_start");
		expect(textEnd).toBeGreaterThan(-1);
		expect(errorIndex).toBeGreaterThan(-1);
		// No orphaned text_start: the consumer sees text_end before the error.
		expect(textEnd).toBeLessThan(errorIndex);
	});

	// (f) credential rotation: the newest context lives, stale frees when idle
	it("frees only the superseded credential's context once its turn ends", async () => {
		const freed: string[] = [];
		const bridge: QoderWasmBridge = {
			createContext(_machineId, _cosyVersion, userInfoJson) {
				const parsed: unknown = JSON.parse(userInfoJson);
				const uid = asRecord(parsed, "userInfo").uid;
				if (typeof uid !== "string") throw new Error("userInfo missing uid");
				return {
					prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) {
						const prepared: QoderPreparedRequest = {
							url: `${endpoint}/infer`,
							headers: { "Cosy-Data-Policy": QODER_PRIVATE_DATA_POLICY },
							body: bodyJson,
						};
						void modelKey;
						void modelSource;
						return prepared;
					},
					prepareRequest() {
						throw new Error("out of scope");
					},
					decryptServerResponse(encrypted) {
						return encrypted;
					},
					free() {
						freed.push(uid);
					},
				};
			},
			generateRuntimeAuthFields() {
				return { encrypt_user_info: "e", key: "k" };
			},
			decryptServerResponse(encrypted) {
				return encrypted;
			},
		};
		const transport = createQoderApi3Transport({
			bridge,
			machineId: "machine-test",
			openapiBase: "https://openapi.qoder.sh",
			api3Base: QODER_API3_BASE,
			cosyVersion: "1.1.2",
			clientName: "omp",
			repair: repairQoderSseBody,
		});
		const model = api3Model(specById("qmodel_preview"));
		const route = api3Route("qmodel_preview");

		// The old credential's userinfo response is gated; the new credential
		// resolves immediately, so the stale resolution lands after rotation.
		const oldUserinfoGate = Promise.withResolvers<void>();
		const oldUserinfoStarted = Promise.withResolvers<void>();
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			if (url.includes("/api/v1/userinfo")) {
				const auth = new Headers(init?.headers).get("Authorization") ?? "";
				if (auth.includes("token-old")) {
					oldUserinfoStarted.resolve();
					await oldUserinfoGate.promise;
				}
				const uid = auth.includes("token-old") ? "uid-old" : "uid-new";
				return new Response(JSON.stringify({ id: uid }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return sseResponse(HAPPY_SSE);
		};

		const collect = async (apiKey: string): Promise<{ result: AssistantMessage }> => {
			const stream = transport.stream(route, model, userContext(), {
				apiKey,
				fetch: fetchImpl,
			});
			for await (const _event of stream) {
				// drain
			}
			return { result: await stream.result() };
		};

		const oldTurn = collect("token-old");
		// Rotate only after the old turn is provably parked on its userinfo
		// fetch — no wall-clock guessing.
		await oldUserinfoStarted.promise;
		const newTurn = collect("token-new");
		const newResult = await newTurn;
		expect(newResult.result.stopReason).toBe("toolUse");
		oldUserinfoGate.resolve();
		const oldResult = await oldTurn;
		expect(oldResult.result.stopReason).toBe("toolUse");

		// The stale context freed exactly once (after its turn released), the
		// live credential's context was never freed by the late resolution.
		expect(freed).toEqual(["uid-old"]);
	});

	it("re-signs each transient inference retry without rebuilding the payload", async () => {
		let attempts = 0;
		const { result, bridgeState, fetches } = await runApi3Turn("qmodel_preview", () => {
			attempts += 1;
			if (attempts === 1) {
				return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
			}
			return sseResponse(HAPPY_SSE);
		});

		expect(result.stopReason).toBe("toolUse");
		expect(fetches.inferRequests).toHaveLength(2);
		expect(bridgeState.prepares).toHaveLength(2);
		expect(fetches.inferRequests[0]?.headers.get("Authorization")).not.toBe(
			fetches.inferRequests[1]?.headers.get("Authorization"),
		);
		expect(bridgeState.prepares[0]?.bodyJson).toBe(bridgeState.prepares[1]?.bodyJson);
	});
});

// ---------------------------------------------------------------------------
// (g) production route resolver + dispatch flag contract
// ---------------------------------------------------------------------------

describe("buildApi3Route", () => {
	it("derives the route from a bundled base row", () => {
		const model = getBundledModel<"openai-completions">("qoder", "dmodel");
		const route = buildApi3Route(model);
		expect(route.wireId).toBe("dmodel");
		expect(route.displayName).toBe("DeepSeek-V4-Pro");
		expect(route.contextWindow).toBe(200_000);
		expect(route.maxInputTokens).toBe(200_000);
		expect(route.isReasoning).toBe(true);
		expect(route.isVl).toBe(true);
		expect(route.efforts).toEqual(["high", "max"]);
		expect(route.defaultEffort).toBe("max");
		expect(route.requiresEffort).toBe(false);
		expect(route.openaiModel).toBe(model);
	});

	it("signs aliases with the base wire id, base display name, and alias window", () => {
		const alias = getBundledModel<"openai-completions">("qoder", "dmodel-1m");
		expect(alias.name).toBe("DeepSeek-V4-Pro (1M)");
		const route = buildApi3Route(alias);
		expect(route.wireId).toBe("dmodel");
		// Aliases sign model_config.display_name with the base bundled name while
		// parameters.context_length (route.contextWindow) carries the alias window.
		expect(route.displayName).toBe("DeepSeek-V4-Pro");
		expect(route.contextWindow).toBe(1_000_000);
		expect(route.maxInputTokens).toBe(200_000);

		const body = buildQoderApi3Body({
			route,
			context: userContext(),
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		expect(asRecord(body.model_config, "model_config").display_name).toBe("DeepSeek-V4-Pro");
		expect(asRecord(body.parameters, "parameters").context_length).toBe(1_000_000);
	});
});

describe("isQoderApi3Model", () => {
	it("flags only qoder rows whose compat carries api3", () => {
		const legacy = getBundledModel<"openai-completions">("qoder", "auto");
		expect(isQoderApi3Model(legacy)).toBe(false);

		const flagged = {
			...api3Model(specById("cmodel")),
			compat: { ...legacy.compat, api3: true },
		} as Model<"openai-completions">;
		expect(isQoderApi3Model(flagged)).toBe(true);

		const wrongProvider = { ...flagged, provider: "openai" } as Model<"openai-completions">;
		expect(isQoderApi3Model(wrongProvider)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// (h) failure contracts: pre-stream HTTP errors and the missing credential
// ---------------------------------------------------------------------------

describe("api3 failure contracts", () => {
	it("fails before the stream on an HTTP error: errorStatus, detail, and no start event", async () => {
		const { events, result } = await runApi3Turn(
			"qmodel_preview",
			() => new Response("Signature invalid", { status: 401 }),
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
		expect(result.errorMessage).toContain("(401)");
		expect(result.errorMessage).toContain("Signature invalid");
		// The start event is only pushed once the response is streamable, so a
		// pre-stream rejection surfaces as a lone terminal error, never a done.
		expect(events.map(event => event.type)).toEqual(["error"]);
		const terminal = events[events.length - 1];
		if (terminal?.type !== "error") throw new Error("expected a terminal error event");
		expect(terminal.reason).toBe("error");
		expect(terminal.error.stopReason).toBe("error");
	});

	it("refuses a turn without an OAuth credential before touching the identity chain", async () => {
		const { bridge, state } = fakeBridge();
		const fetches = fakeApi3Fetch(() => sseResponse(HAPPY_SSE));
		const transport = makeTransport(bridge);
		const { events, result } = await collectTurn(transport, "qmodel_preview", { fetch: fetches.fetchImpl });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("requires a Qoder OAuth credential");
		expect(events.map(event => event.type)).toEqual(["error"]);
		// Fail-fast: no userinfo lookup and no WASM context was built.
		expect(fetches.userinfoRequests).toHaveLength(0);
		expect(state.identities).toHaveLength(0);
	});

	it("preserves userinfo 401/403 into errorStatus for auth retry", async () => {
		for (const status of [401, 403] as const) {
			const { bridge } = fakeBridge();
			const fetches = fakeApi3Fetch(
				() => sseResponse(HAPPY_SSE),
				() => new Response("unauthorized", { status }),
			);
			const transport = makeTransport(bridge);
			const { events, result } = await collectTurn(transport, "qmodel_preview", {
				apiKey: "qoder-test-token",
				fetch: fetches.fetchImpl,
			});
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(status);
			expect(result.errorMessage).toContain(`userinfo failed (${status})`);
			expect(events.map(event => event.type)).toEqual(["error"]);
			// Status must ride the structured field, not rely on message parsing.
			expect(result.errorStatus).not.toBeUndefined();
		}
	});

	it("preserves malformed in-stream status and cancels after the terminal error", async () => {
		const encoder = new TextEncoder();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`data: ${envelope("Signature invalid", 401)}\n\n`));
			},
			cancel() {
				cancelled = true;
			},
		});
		const { events, result } = await runApi3Turn(
			"qmodel_preview",
			() => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
		expect(result.errorMessage).toContain("Signature invalid");
		expect(events.map(event => event.type)).toEqual(["start", "error"]);
		expect(cancelled).toBe(true);
	});

	it("preserves in-stream envelope status for OAuth retry", async () => {
		for (const status of [401, 403]) {
			const errorSse = `data: ${envelope(JSON.stringify({ code: "AUTH", message: "Signature invalid" }), status)}`;
			const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(errorSse));
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(status);
			expect(result.errorMessage).toContain("Signature invalid");
			expect(events.map(event => event.type)).toEqual(["start", "error"]);
		}
	});

	it("forwards every repaired frame to a diagnostic observer without trusting it", async () => {
		const observed: RawSseEvent[] = [];
		const { result } = await runApi3Turn("qmodel_preview", () => sseResponse(HAPPY_SSE), {
			onSseEvent(event) {
				observed.push(event);
				throw new Error("diagnostic observer failure");
			},
		});

		expect(result.stopReason).toBe("toolUse");
		expect(observed).toHaveLength(8);
		expect(observed.some(event => event.event === "finish")).toBe(true);
		expect(observed.some(event => event.data.includes("[DONE]"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (i) termination contract: truncation is an error; success needs BOTH markers
// ---------------------------------------------------------------------------

describe("api3 stream termination", () => {
	it("treats EOF before a finish_reason and [DONE] as truncation, not a silent complete", async () => {
		const truncated = `data: ${chunkEnvelope({ choices: [{ delta: { content: "partial" }, index: 0 }] })}`;
		const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(truncated));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ended before a terminal frame");
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
		const terminal = events[events.length - 1];
		if (terminal?.type !== "error") throw new Error("expected a terminal error event");
		expect(terminal.reason).toBe("error");
	});

	it("accepts a bare data: [DONE] line after a finish_reason as a clean termination", async () => {
		const bareDone = [
			`data: ${chunkEnvelope({ choices: [{ delta: { content: "hello" }, index: 0 }] })}`,
			`data: ${chunkEnvelope({
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			})}`,
			"data: [DONE]",
			FINISH_METRICS_FRAME,
		].join("\n\n");
		const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(bareDone));
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		const terminal = events[events.length - 1];
		if (terminal?.type !== "done") throw new Error("expected a terminal done event");
		expect(terminal.reason).toBe("stop");
	});

	it("treats finish_reason without [DONE] as truncation", async () => {
		const finishWithoutDone = [
			`data: ${chunkEnvelope({ choices: [{ delta: { content: "hello" }, index: 0 }] })}`,
			`data: ${chunkEnvelope({
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
			})}`,
			FINISH_METRICS_FRAME,
		].join("\n\n");
		const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(finishWithoutDone));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ended before a terminal frame");
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
	});

	it("treats [DONE] without finish_reason as truncation", async () => {
		const doneWithoutFinish = [
			`data: ${chunkEnvelope({ choices: [{ delta: { content: "hello" }, index: 0 }] })}`,
			`data: ${envelope("[DONE]")}`,
			FINISH_METRICS_FRAME,
		].join("\n\n");
		const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(doneWithoutFinish));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ended before a terminal frame");
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
	});

	it("keeps an exceeded-quota sentinel terminal when later frames report success", async () => {
		const quotaThenFinish = [
			`data: ${envelope("[EXCEED_QUOTA]")}`,
			`data: ${chunkEnvelope({
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
			})}`,
			`data: ${envelope("[DONE]")}`,
		].join("\n\n");
		const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(quotaThenFinish));

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Qoder api3 quota exceeded");
		expect(events.map(event => event.type)).toEqual(["start", "error"]);
	});

	it("ignores quota-status and notification sentinels without disrupting a normal turn", async () => {
		const sentinelsThenSuccess = [
			`data: ${envelope("[NOT_EXCEED_QUOTA]")}`,
			`data: ${envelope("[NOTIFICATIONS]#catalog-refreshed")}`,
			`data: ${chunkEnvelope({ choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
			`data: ${chunkEnvelope({
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
			})}`,
			`data: ${envelope("[DONE]")}`,
		].join("\n\n");
		const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(sentinelsThenSuccess));

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toContainEqual({ type: "text", text: "OK" });
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	it("treats a non-object body chunk as terminal despite later success frames", async () => {
		const malformedThenFinish = [
			`data: ${envelope('["invalid"]')}`,
			`data: ${chunkEnvelope({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}`,
			`data: ${envelope("[DONE]")}`,
		].join("\n\n");
		const { result } = await runApi3Turn("qmodel_preview", () => sseResponse(malformedThenFinish));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe('Qoder api3 stream error: ["invalid"]');
	});

	it("treats a malformed outer envelope as terminal despite later success frames", async () => {
		const malformedThenFinish = [
			"data: not-json",
			`data: ${chunkEnvelope({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}`,
			`data: ${envelope("[DONE]")}`,
		].join("\n\n");
		const { result } = await runApi3Turn("qmodel_preview", () => sseResponse(malformedThenFinish));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Qoder api3 returned a malformed SSE envelope");
	});

	it("treats a non-object outer envelope as terminal despite later success frames", async () => {
		const malformedThenFinish = [
			"data: []",
			`data: ${chunkEnvelope({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}`,
			`data: ${envelope("[DONE]")}`,
		].join("\n\n");
		const { result } = await runApi3Turn("qmodel_preview", () => sseResponse(malformedThenFinish));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Qoder api3 returned a malformed SSE envelope");
	});

	it("maps finish_reason end to a normal stop done result", async () => {
		const endFinish = [
			`data: ${chunkEnvelope({ choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
			`data: ${chunkEnvelope({
				choices: [{ delta: {}, finish_reason: "end", index: 0 }],
			})}`,
			`data: ${envelope("[DONE]")}`,
		].join("\n\n");
		const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(endFinish));
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});
});

// ---------------------------------------------------------------------------
// (i2) empty-completion retry: a degenerate complete-but-empty stream is
// retried (mirrors the OpenAI-completions / Anthropic policy) instead of
// silently halting the agent on a lone `done` with no content.
// ---------------------------------------------------------------------------

describe("api3 empty-completion retry", () => {
	// A degenerate complete-but-empty turn (empty `delta` + `finish_reason:"stop"`
	// + `[DONE]`) delivers a lone `start`/`done` with no content. Unretried that
	// silently halts the agent mid-task; the transport is wrapped with the same
	// bounded empty-completion retry the OpenAI-completions path uses so a flaky
	// empty stop is re-requested instead of surfaced.
	const DEGENERATE_EMPTY_SSE = [
		`data: ${chunkEnvelope({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}`,
		`data: ${envelope("[DONE]")}`,
		FINISH_METRICS_FRAME,
	].join("\n\n");

	const CONTENT_SSE = [
		`data: ${chunkEnvelope({ choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
		`data: ${chunkEnvelope({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}`,
		`data: ${envelope("[DONE]")}`,
		FINISH_METRICS_FRAME,
	].join("\n\n");

	it("a degenerate empty stop alone (no retry wrapper) surfaces as an empty done", async () => {
		// Baseline: the single-attempt transport emits a contentless terminal
		// `done` — the failure the retry wrapper exists to absorb.
		const { events, result } = await runApi3Turn("qmodel_preview", () => sseResponse(DEGENERATE_EMPTY_SSE));
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([]);
		expect(events.map(event => event.type)).toEqual(["start", "done"]);
	});

	it("withEmptyCompletionRetry retries a degenerate empty stop and delivers the next attempt's content", async () => {
		const { bridge } = fakeBridge();
		// First attempt returns the degenerate empty stop; the retry returns
		// content. Selected by request order so the closure reads the count
		// the fetch runs at, not the pre-increment value.
		let inferCall = 0;
		const fetches = fakeApi3Fetch(() => {
			inferCall += 1;
			return sseResponse(inferCall === 1 ? DEGENERATE_EMPTY_SSE : CONTENT_SSE);
		});
		const transport = makeTransport(bridge);
		const model = api3Model(specById("qmodel_preview"));
		let attempts = 0;
		// Mirrors the production `streamQoderApi3` closure: each attempt rebuilds
		// the route from the model so a retry never inherits stale route state.
		const wrapped = withEmptyCompletionRetry(model, userContext(), undefined, (attemptModel, attemptContext) => {
			attempts += 1;
			return transport.stream(buildApi3Route(attemptModel), attemptModel, attemptContext, {
				apiKey: "qoder-test-token",
				fetch: fetches.fetchImpl,
			});
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of wrapped) events.push(event);
		const result = await wrapped.result();

		// The empty first attempt was discarded and a fresh request was issued.
		expect(attempts).toBe(2);
		expect(fetches.inferRequests).toHaveLength(2);
		// Exactly one `start` — the empty attempt's buffered `start` was dropped.
		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toContainEqual({ type: "text", text: "OK" });
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
	});

	it("withEmptyCompletionRetry commits to the first attempt once content streams (no retry, no duplicate start)", async () => {
		const { bridge } = fakeBridge();
		let attempt = 0;
		const fetches = fakeApi3Fetch(() => sseResponse(CONTENT_SSE));
		const transport = makeTransport(bridge);
		const model = api3Model(specById("qmodel_preview"));
		const wrapped = withEmptyCompletionRetry(model, userContext(), undefined, (attemptModel, attemptContext) => {
			attempt += 1;
			return transport.stream(buildApi3Route(attemptModel), attemptModel, attemptContext, {
				apiKey: "qoder-test-token",
				fetch: fetches.fetchImpl,
			});
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of wrapped) events.push(event);
		const result = await wrapped.result();

		expect(attempt).toBe(1);
		expect(fetches.inferRequests).toHaveLength(1);
		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(result.content).toContainEqual({ type: "text", text: "OK" });
	});
});

// ---------------------------------------------------------------------------
// (j) abort mid-stream: pull-driven body, blocks closed before the terminal
// ---------------------------------------------------------------------------

describe("api3 abort", () => {
	it("aborts after the first delta: stopReason aborted and no orphaned blocks", async () => {
		const controller = new AbortController();
		const encoder = new TextEncoder();
		let delivered = false;
		const aborted = Promise.withResolvers<never>();
		controller.signal.addEventListener("abort", () => {
			aborted.reject(new DOMException("The operation was aborted.", "AbortError"));
		});
		const abortableBody = new ReadableStream<Uint8Array>({
			async pull(streamController) {
				if (!delivered) {
					delivered = true;
					streamController.enqueue(
						encoder.encode(
							`data: ${chunkEnvelope({ choices: [{ delta: { content: "partial" }, index: 0 }] })}\n\n`,
						),
					);
					return;
				}
				// Park like a real socket; the abort errors the body exactly as a
				// fetch response stream rejects its pending read on abort.
				await aborted.promise;
			},
		});
		const { bridge } = fakeBridge();
		const fetches = fakeApi3Fetch(
			() => new Response(abortableBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		const transport = makeTransport(bridge);
		const stream = transport.stream(
			api3Route("qmodel_preview"),
			api3Model(specById("qmodel_preview")),
			userContext(),
			{
				apiKey: "qoder-test-token",
				fetch: fetches.fetchImpl,
				signal: controller.signal,
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
			if (event.type === "text_delta") controller.abort();
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		const types = events.map(event => event.type);
		const terminal = events[events.length - 1];
		if (terminal?.type !== "error") throw new Error("expected a terminal error event");
		expect(terminal.reason).toBe("aborted");
		// The open text block was closed before the terminal event fired.
		expect(types.indexOf("text_start")).toBeGreaterThan(-1);
		expect(types.indexOf("text_end")).toBeGreaterThan(-1);
		expect(types.indexOf("text_end")).toBeLessThan(types.indexOf("error"));
	});
});

// ---------------------------------------------------------------------------
// (k) context cache: rejection evicts, shared lease, free only when idle
// ---------------------------------------------------------------------------

describe("api3 context cache", () => {
	it("evicts a rejected identity chain so the next turn retries it", async () => {
		const { bridge, state } = fakeBridge();
		let userinfoCalls = 0;
		const fetches = fakeApi3Fetch(
			() => sseResponse(HAPPY_SSE),
			() => {
				userinfoCalls += 1;
				if (userinfoCalls === 1) return new Response("gateway error", { status: 500 });
				return new Response(JSON.stringify({ id: "uid-test-account" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		);
		const transport = makeTransport(bridge);
		const options: SimpleStreamOptions = { apiKey: "qoder-test-token", fetch: fetches.fetchImpl };
		const first = await collectTurn(transport, "qmodel_preview", options);
		expect(first.result.stopReason).toBe("error");
		expect(first.result.errorStatus).toBe(500);
		expect(first.result.errorMessage).toContain("userinfo failed (500)");
		expect(first.events.map(event => event.type)).toEqual(["error"]);
		const second = await collectTurn(transport, "qmodel_preview", options);
		expect(second.result.stopReason).toBe("toolUse");
		// The 500 evicted the cache entry so the next turn retried userinfo.
		expect(fetches.userinfoRequests).toHaveLength(2);
		// The identity chain (generateRuntimeAuthFields → createContext) only
		// completes on a successful userinfo: the 500 turn recorded none, the
		// retry recorded exactly one. The cached rejection never poisoned the
		// next turn's identity.
		expect(state.identities).toHaveLength(1);
		expect(state.userInfos).toHaveLength(1);
	});

	it("fails the turn when userinfo returns no account id", async () => {
		const { bridge, state } = fakeBridge();
		const fetches = fakeApi3Fetch(
			() => sseResponse(HAPPY_SSE),
			() => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
		);
		const transport = makeTransport(bridge);
		const { events, result } = await collectTurn(transport, "qmodel_preview", {
			apiKey: "qoder-test-token",
			fetch: fetches.fetchImpl,
		});
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("returned no account id");
		expect(events.map(event => event.type)).toEqual(["error"]);
		// The chain stopped before the WASM auth fields were generated.
		expect(state.identities).toHaveLength(0);
	});

	it("shares one context across concurrent same-credential turns and frees it only after both release", async () => {
		const freed: string[] = [];
		const identities: string[] = [];
		const bridge: QoderWasmBridge = {
			createContext(_machineId, _cosyVersion, userInfoJson) {
				const parsed: unknown = JSON.parse(userInfoJson);
				const uid = asRecord(parsed, "userInfo").uid;
				if (typeof uid !== "string") throw new Error("userInfo missing uid");
				return {
					prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) {
						const prepared: QoderPreparedRequest = {
							url: `${endpoint}/infer`,
							headers: { "Cosy-Data-Policy": QODER_PRIVATE_DATA_POLICY },
							body: bodyJson,
						};
						void modelKey;
						void modelSource;
						return prepared;
					},
					prepareRequest() {
						throw new Error("out of scope");
					},
					decryptServerResponse(encrypted) {
						return encrypted;
					},
					free() {
						freed.push(uid);
					},
				};
			},
			decryptServerResponse(encrypted) {
				return encrypted;
			},
			generateRuntimeAuthFields(identityJson) {
				identities.push(identityJson);
				return { encrypt_user_info: "e", key: "k" };
			},
		};
		const transport = makeTransport(bridge);
		// Gate the first two inference requests (the two token-a turns) until a
		// token-b turn has rotated the credential underneath them.
		let inferSeen = 0;
		const aInferGate = Promise.withResolvers<void>();
		const bothAStarted = Promise.withResolvers<void>();
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			if (url.includes("/api/v1/userinfo")) {
				const auth = new Headers(init?.headers).get("Authorization") ?? "";
				const id = auth.includes("token-b") ? "uid-b" : "uid-a";
				return new Response(JSON.stringify({ id }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			inferSeen += 1;
			if (inferSeen === 2) bothAStarted.resolve();
			if (inferSeen <= 2) await aInferGate.promise;
			return sseResponse(HAPPY_SSE);
		};
		const a1 = collectTurn(transport, "qmodel_preview", { apiKey: "token-a", fetch: fetchImpl });
		const a2 = collectTurn(transport, "qmodel_preview", { apiKey: "token-a", fetch: fetchImpl });
		await bothAStarted.promise;
		// Both token-a turns leased ONE shared context: a single identity chain.
		expect(identities).toHaveLength(1);
		const b = await collectTurn(transport, "qmodel_preview", { apiKey: "token-b", fetch: fetchImpl });
		expect(b.result.stopReason).toBe("toolUse");
		// The rotation marked the token-a context stale, but its two live turns
		// still hold the lease: nothing freed yet.
		expect(freed).toEqual([]);
		aInferGate.resolve();
		const [r1, r2] = await Promise.all([a1, a2]);
		expect(r1.result.stopReason).toBe("toolUse");
		expect(r2.result.stopReason).toBe("toolUse");
		// Freed exactly once, after the last of the two turns released (the free
		// microtask is queued by release() before the stream's result settles).
		expect(freed).toEqual(["uid-a"]);
	});

	it("isolates a shared context build from one caller abort", async () => {
		const { bridge } = fakeBridge();
		const userinfoStarted = Promise.withResolvers<void>();
		const userinfoGate = Promise.withResolvers<void>();
		let userinfoCalls = 0;
		const fetchImpl: FetchImpl = async input => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			if (url.includes("/api/v1/userinfo")) {
				userinfoCalls += 1;
				userinfoStarted.resolve();
				await userinfoGate.promise;
				return new Response(JSON.stringify({ id: "uid-shared" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return sseResponse(HAPPY_SSE);
		};
		const transport = makeTransport(bridge);
		const controller = new AbortController();
		const first = collectTurn(transport, "qmodel_preview", {
			apiKey: "shared-token",
			fetch: fetchImpl,
			signal: controller.signal,
		});
		await userinfoStarted.promise;
		const second = collectTurn(transport, "qmodel_preview", { apiKey: "shared-token", fetch: fetchImpl });
		controller.abort();
		const firstResult = await Promise.race([
			first,
			Bun.sleep(250).then(() => {
				throw new Error("aborted caller waited for shared userinfo");
			}),
		]);
		expect(firstResult.result.stopReason).toBe("aborted");

		userinfoGate.resolve();
		const secondResult = await second;
		expect(secondResult.result.stopReason).toBe("toolUse");
		const thirdResult = await collectTurn(transport, "qmodel_preview", {
			apiKey: "shared-token",
			fetch: fetchImpl,
		});
		expect(thirdResult.result.stopReason).toBe("toolUse");
		expect(userinfoCalls).toBe(1);
	});

	it("evicts a timed-out shared identity chain so the next turn retries userinfo", async () => {
		const { bridge } = fakeBridge();
		const transport = makeTransport(bridge, { contextBuildTimeoutMs: 5 });
		let userinfoCalls = 0;
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
			if (!url.includes("/api/v1/userinfo")) return sseResponse(HAPPY_SSE);
			userinfoCalls += 1;
			const stalled = Promise.withResolvers<Response>();
			const signal = init?.signal;
			if (!signal) throw new Error("expected userinfo timeout signal");
			if (signal.aborted) {
				stalled.reject(signal.reason);
			} else {
				signal.addEventListener("abort", () => stalled.reject(signal.reason), { once: true });
			}
			return await stalled.promise;
		};

		for (let turn = 0; turn < 2; turn += 1) {
			const { result } = await collectTurn(transport, "qmodel_preview", {
				apiKey: "stalled-token",
				fetch: fetchImpl,
			});
			expect(result.stopReason).toBe("error");
		}
		expect(userinfoCalls).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// (l) dispatch fail-closed: no usable bridge → honest error stream
// ---------------------------------------------------------------------------

const noBridgeChildScript = `
import { streamQoderApi3 } from ${JSON.stringify(
	pathToFileURL(path.join(import.meta.dir, "../src/providers/qoder-api3.ts")).href,
)};
const model = { api: "openai-completions", provider: "qoder", id: "dmodel", name: "DeepSeek-V4-Pro" };
const context = {
	systemPrompt: ["You are terse."],
	messages: [{ role: "user", content: "Reply exactly with OK.", timestamp: 1 }],
};
const stream = streamQoderApi3(model, context, { apiKey: "unused" });
const events = [];
for await (const event of stream) events.push(event.type);
const result = await stream.result();
process.stdout.write(JSON.stringify({ events, stopReason: result.stopReason, errorMessage: result.errorMessage }));
`;

describe("streamQoderApi3 dispatch", () => {
	it("fails closed when no usable auth WASM is available", async () => {
		// sandboxed HOME (hides ~/.qoder), sandboxed XDG cache (hides the
		// verified-module cache). Runs in a child so the sandbox never touches
		// this process's environment.
		const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-no-wasm-"));
		try {
			const child = Bun.spawn([process.execPath, "--eval", noBridgeChildScript], {
				cwd: path.join(import.meta.dir, ".."),
				env: {
					...process.env,
					HOME: sandbox,
					XDG_CACHE_HOME: path.join(sandbox, "xdg-cache"),
					QODER_HOME: path.join(sandbox, "qoder-home"),
					QODER_WASM_PATH: path.join(sandbox, "missing.wasm"),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const outcome = JSON.parse(stdout) as { events: string[]; stopReason: string; errorMessage?: string };
			expect(outcome.events).toEqual(["start", "error"]);
			expect(outcome.stopReason).toBe("error");
			expect(outcome.errorMessage).toContain("qodercli");
		} finally {
			fs.rmSync(sandbox, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// (m) body shaping branches: sampling params, stop sequences, tool choice
// ---------------------------------------------------------------------------

describe("buildQoderApi3Body request-shaping branches", () => {
	const base = { route: api3Route("qmodel_preview"), context: userContext(), cosyVersion: "1.1.2", clientName: "omp" };

	it("clamps explicit maxTokens to the model output cap", () => {
		const shaped = buildQoderApi3Body({ ...base, options: { maxTokens: 100_000 } });
		const parameters = asRecord(shaped.parameters, "parameters");
		expect(parameters.max_tokens).toBe(base.route.openaiModel.maxTokens);
	});

	it("maps temperature and topP onto their api3 wire fields", () => {
		const shaped = buildQoderApi3Body({ ...base, options: { temperature: 0.7, topP: 0.9 } });
		expect(shaped.temperature).toBe(0.7);
		expect(shaped.top_p).toBe(0.9);
	});

	it("does not invent sampling defaults when the caller leaves them unset", () => {
		const defaults = buildQoderApi3Body(base);
		expect(defaults.temperature).toBeUndefined();
		expect(defaults.top_p).toBeUndefined();
	});

	it("shapes stop sequences: a single one as a string, several as an array", () => {
		const single = buildQoderApi3Body({ ...base, options: { stopSequences: ["END"] } });
		expect(single.stop).toBe("END");
		const multiple = buildQoderApi3Body({ ...base, options: { stopSequences: ["END", "STOP"] } });
		expect(multiple.stop).toEqual(["END", "STOP"]);
		expect(buildQoderApi3Body(base).stop).toBeUndefined();
	});

	it("maps tool choices onto the OpenAI wire forms", () => {
		const any = buildQoderApi3Body({ ...base, options: { toolChoice: "any" } });
		expect(any.tool_choice).toBe("required");
		const named = buildQoderApi3Body({
			...base,
			options: { toolChoice: { type: "function", name: "get_weather" } },
		});
		expect(named.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
		const passthrough = buildQoderApi3Body({ ...base, options: { toolChoice: "auto" } });
		expect(passthrough.tool_choice).toBe("auto");
		expect(buildQoderApi3Body(base).tool_choice).toBeUndefined();
	});
});
