import { type } from "@oh-my-pi/omptype";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { agentLoop } from "../src/agent-loop";
import type { AgentMessage, AgentTool } from "../src/types";

const BENCHMARK_URL = "https://httpbin.org/delay/2";
const PROVIDER_TAIL_MS = 1_000;
const MIN_EXPECTED_OVERLAP_MS = 750;
const REQUEST_HEADERS = {
	accept: "application/json",
	"cache-control": "no-store",
	pragma: "no-cache",
	"user-agent": "oh-my-pi-speculative-get-benchmark/1",
};
const PROXY_VARIABLES = [
	"PI_PROXY",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
] as const;

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "speculative-http-get",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function parseRepeats(argv: readonly string[]): number {
	const index = argv.indexOf("--repeats");
	if (index === -1) return 1;
	const value = Number(argv[index + 1]);
	if (!Number.isInteger(value) || value < 1) throw new Error("--repeats must be a positive integer");
	return value;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function normalizeHistory(messages: AgentMessage[]): string {
	return JSON.stringify(
		messages.map(message => {
			if (message.role === "assistant") {
				return {
					role: message.role,
					content: message.content.map(block =>
						block.type === "toolCall"
							? { type: block.type, id: block.id, name: block.name, arguments: block.arguments }
							: block,
					),
				};
			}
			if (message.role === "toolResult") {
				return {
					role: message.role,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					content: message.content,
				};
			}
			return { role: message.role, content: message.content };
		}),
	);
}

interface BenchmarkRun {
	durationMs: number;
	executionMs: number;
	overlapMs: number;
	getStartedBeforeProviderDone: boolean;
	physicalGets: number;
	dependentConsumers: number;
	committedCandidates: number;
	history: string;
}

async function runBenchmark(enabled: boolean): Promise<BenchmarkRun> {
	const schema = type({ url: "string" });
	const statusSchema = type({ status: "number" });
	let physicalGets = 0;
	let dependentConsumers = 0;
	let providerDoneAt: number | undefined;
	let getStartedAt: number | undefined;
	let getFinishedAt: number | undefined;
	let secondProviderObservedResult = false;
	let turn = 0;
	let committedCandidates = 0;
	const runGet = async (params: { url: string }, signal: AbortSignal | undefined) => {
		for (const variable of PROXY_VARIABLES) {
			if (process.env[variable]) throw new Error(`Refusing proxy-configured benchmark request: ${variable}`);
		}
		physicalGets++;
		getStartedAt = performance.now();
		const response = await fetch(params.url, {
			method: "GET",
			headers: REQUEST_HEADERS,
			credentials: "omit",
			cache: "no-store",
			redirect: "error",
			signal,
		});
		const body = await response.text();
		getFinishedAt = performance.now();
		if (response.status !== 200) {
			throw new Error(`Expected HTTP 200, received ${response.status}: ${body.slice(0, 160)}`);
		}
		return { content: [{ type: "text" as const, text: "HTTP 200" }] };
	};
	const tool: AgentTool<typeof schema> = {
		name: "anonymous_get",
		label: "Anonymous GET",
		description: "Fetch one pre-authorized public endpoint",
		parameters: schema,
		speculation: {
			finalized: {
				assess: ({ args }) =>
					args.url === BENCHMARK_URL
						? {
								eligible: true,
								effect: {
									kind: "remote_read",
									transport: {
										url: BENCHMARK_URL,
										headers: REQUEST_HEADERS,
										credentials: "omit",
										cache: "no-store",
										redirect: "error",
									},
									egress: [],
								},
							}
						: { eligible: false, reason: "benchmark only permits its exact URL" },
				async execute(context, signal) {
					return { kind: "result", result: await runGet(context.args as { url: string }, signal), isError: false };
				},
			},
		},
		async execute(_toolCallId, params, signal) {
			return await runGet(params, signal);
		},
	};
	const consumeStatus: AgentTool<typeof statusSchema> = {
		name: "consume_http_status",
		label: "Consume HTTP status",
		description: "Consumes the committed request status",
		parameters: statusSchema,
		async execute(_toolCallId, params) {
			assert(
				secondProviderObservedResult,
				"Dependent tool ran before the committed remote result reached the next provider turn",
			);
			assert(params.status === 200, "Dependent tool did not receive HTTP 200");
			dependentConsumers++;
			return { content: [{ type: "text", text: "status consumed" }] };
		},
	};
	const mock = createMockModel({ responses: [] });
	const streamFn = (_model: unknown, context: Context) => {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(async () => {
			if (turn++ === 0) {
				const toolCall = {
					type: "toolCall" as const,
					id: "get-1",
					name: "anonymous_get",
					arguments: { url: BENCHMARK_URL },
				};
				const partial = assistantMessage([toolCall], "toolUse");
				stream.push({ type: "start", partial });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
				await Bun.sleep(PROVIDER_TAIL_MS);
				providerDoneAt = performance.now();
				stream.push({ type: "done", reason: "toolUse", message: partial });
				return;
			}
			if (turn === 2) {
				const prior = context.messages.at(-1);
				secondProviderObservedResult =
					prior?.role === "toolResult" &&
					prior.toolName === "anonymous_get" &&
					prior.content.some(block => block.type === "text" && block.text === "HTTP 200");
				assert(
					secondProviderObservedResult,
					"Second provider turn did not receive the committed anonymous_get result",
				);
				const toolCall = {
					type: "toolCall" as const,
					id: "consume-1",
					name: "consume_http_status",
					arguments: { status: 200 },
				};
				const partial = assistantMessage([toolCall], "toolUse");
				stream.push({ type: "start", partial });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
				stream.push({ type: "done", reason: "toolUse", message: partial });
				return;
			}
			const partial = assistantMessage([{ type: "text", text: "done" }], "stop");
			stream.push({ type: "start", partial });
			stream.push({ type: "done", reason: "stop", message: partial });
		});
		return stream;
	};
	const startedAt = performance.now();
	const messages = await agentLoop(
		[{ role: "user", content: "Fetch the benchmark URL", timestamp: Date.now() }],
		{ systemPrompt: [""], messages: [], tools: [tool, consumeStatus] },
		{
			model: mock.model,
			convertToLlm: identityConverter,
			speculativeToolExecution: {
				enabled,
				host: enabled
					? {
							authorize: ({ effect }) =>
								effect.kind === "remote_read" && effect.transport.url === BENCHMARK_URL
									? { allowed: true }
									: { allowed: false, reason: "benchmark effect mismatch" },
						}
					: undefined,
				onTelemetry: event => {
					if (event.outcome === "committed") committedCandidates++;
				},
			},
		},
		undefined,
		streamFn,
	).result();
	const durationMs = performance.now() - startedAt;
	assert(
		getStartedAt !== undefined && getFinishedAt !== undefined && providerDoneAt !== undefined,
		"GET timing was not recorded",
	);
	return {
		durationMs,
		executionMs: getFinishedAt - getStartedAt,
		overlapMs: Math.max(0, providerDoneAt - getStartedAt),
		getStartedBeforeProviderDone: getStartedAt < providerDoneAt,
		physicalGets,
		dependentConsumers,
		committedCandidates,
		history: normalizeHistory(messages),
	};
}

const repeats = parseRepeats(Bun.argv);
const baselineSamples: BenchmarkRun[] = [];
const eagerSamples: BenchmarkRun[] = [];
for (let index = 0; index < repeats; index++) {
	baselineSamples.push(await runBenchmark(false));
	eagerSamples.push(await runBenchmark(true));
}

for (const [index, baseline] of baselineSamples.entries()) {
	const eager = eagerSamples[index]!;
	const savedMs = baseline.durationMs - eager.durationMs;
	assert(baseline.physicalGets === 1 && eager.physicalGets === 1, "Each run must make exactly one physical GET");
	assert(
		baseline.dependentConsumers === 1 && eager.dependentConsumers === 1,
		"Each run must execute one dependent consumer",
	);
	assert(!baseline.getStartedBeforeProviderDone, "Disabled speculation started the GET before provider done");
	assert(eager.getStartedBeforeProviderDone, "Enabled speculation did not start the GET before provider done");
	assert(
		eager.overlapMs >= MIN_EXPECTED_OVERLAP_MS,
		`Expected at least ${MIN_EXPECTED_OVERLAP_MS}ms overlap, got ${eager.overlapMs.toFixed(1)}ms`,
	);
	assert(eager.committedCandidates === 1, "Enabled run did not commit exactly one candidate");
	assert(baseline.history === eager.history, "Speculation changed the committed three-turn history");
	assert(savedMs > 0, "Enabled speculation did not reduce end-to-end duration");
}

const baselineMs = median(baselineSamples.map(sample => sample.durationMs));
const eagerMs = median(eagerSamples.map(sample => sample.durationMs));
const savedMs = baselineMs - eagerMs;
const overlapMs = median(eagerSamples.map(sample => sample.overlapMs));

console.log(`METRIC speculative_http_repeats=${repeats}`);
console.log(`METRIC speculative_http_baseline_ms=${baselineMs.toFixed(1)}`);
console.log(`METRIC speculative_http_eager_ms=${eagerMs.toFixed(1)}`);
console.log(`METRIC speculative_http_saved_ms=${savedMs.toFixed(1)}`);
console.log(`METRIC speculative_http_speedup=${(baselineMs / eagerMs).toFixed(3)}`);
console.log(
	`METRIC speculative_http_execution_ms=${median(eagerSamples.map(sample => sample.executionMs)).toFixed(1)}`,
);
console.log(`METRIC speculative_http_overlap_ms=${overlapMs.toFixed(1)}`);
console.log(
	"ASI endpoint=httpbin.org/delay/2 provider_tail_ms=1000 physical_gets_baseline=1 physical_gets_eager=1 dependent_consumers_baseline=1 dependent_consumers_eager=1",
);
