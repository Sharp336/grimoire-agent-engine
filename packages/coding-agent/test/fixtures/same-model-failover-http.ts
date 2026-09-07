const HOSTNAME = "127.0.0.1";
const DEFAULT_MODEL = "gpt-5.6-terra";
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

export const DUMMY_BEARER_TOKEN = "artel-r2-dummy-token";
export const MARKER_FILE = ".artel-r2-settled-tool-marker";
export const MARKER_TEXT = "artel-r2-settled-tool-marker";
export const TOOL_CALL_ID = "call_artel_r2_append_marker";
export const RETRY_AFTER_SECONDS = 9;

const MAX_RETRY_AFTER_SECONDS = 3_600;

const TOOL_COMMAND = `printf '%s\\n' '${MARKER_TEXT}' >> ${MARKER_FILE}`;

type FixturePhase = "tool_call_ready" | "awaiting_tool_result" | "rate_limited";

export interface SameModelFailoverFixtureEvent {
	event: "ready" | "request";
	phase: FixturePhase;
	requestCount: number;
	retryAfterSeconds: number;
	status?: number;
	toolCallId: string;
	url?: string;
}

export interface SameModelFailoverFixtureOptions {
	logger?: (event: SameModelFailoverFixtureEvent) => void;
	model?: string;
	port?: number;
	retryAfterSeconds?: number;
}

export interface SameModelFailoverFixture {
	get phase(): FixturePhase;
	get requestCount(): number;
	model: string;
	port: number;
	retryAfterSeconds: number;
	stop(): void;
	url: string;
}

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
	return Response.json(body, {
		status,
		headers: {
			"cache-control": "no-store",
			...headers,
		},
	});
}

function hasDummyAuthorization(request: Request): boolean {
	return request.headers.get("authorization") === `Bearer ${DUMMY_BEARER_TOKEN}`;
}

function hasSettledToolResult(body: unknown): boolean {
	if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) {
		return false;
	}
	return body.messages.some(message => {
		if (typeof message !== "object" || message === null) return false;
		return (
			"role" in message &&
			message.role === "tool" &&
			"tool_call_id" in message &&
			message.tool_call_id === TOOL_CALL_ID
		);
	});
}

function requestedModel(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null || !("model" in body)) return undefined;
	return typeof body.model === "string" ? body.model : undefined;
}

function isArmedEngineRequest(body: unknown): boolean {
	if (typeof body !== "object" || body === null || !("stream" in body) || body.stream !== true) return false;
	if (!("tools" in body) || !Array.isArray(body.tools)) return false;
	return body.tools.some(tool => {
		if (typeof tool !== "object" || tool === null || !("function" in tool)) return false;
		const definition = tool.function;
		return (
			typeof definition === "object" && definition !== null && "name" in definition && definition.name === "bash"
		);
	});
}

function probeResponse(model: string): Response {
	return jsonResponse(
		{
			id: "chatcmpl-artel-r2-probe",
			object: "chat.completion",
			created: 0,
			model,
			choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
		},
		200,
	);
}

function toolCallStream(model: string): Response {
	const base = {
		id: "chatcmpl-artel-r2-failover",
		object: "chat.completion.chunk",
		created: 0,
		model,
	};
	const frames = [
		{
			...base,
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: TOOL_CALL_ID,
								type: "function",
								function: { name: "bash", arguments: JSON.stringify({ command: TOOL_COMMAND }) },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		},
	];
	const payload = `${frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(payload, {
		status: 200,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/event-stream; charset=utf-8",
		},
	});
}

function rateLimitResponse(retryAfterSeconds: number): Response {
	return jsonResponse(
		{
			error: {
				code: "rate_limit_exceeded",
				message: "Test fixture requires same-model route fallback",
				type: "rate_limit_error",
			},
		},
		429,
		{ "retry-after": String(retryAfterSeconds) },
	);
}

function validateModel(model: string): string {
	if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) {
		throw new Error("Model must contain only letters, digits, '.', '_', ':', '/', or '-'");
	}
	return model;
}

function validateRetryAfterSeconds(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETRY_AFTER_SECONDS) {
		throw new Error(`Retry-After must be an integer from 1 to ${MAX_RETRY_AFTER_SECONDS} seconds`);
	}
	return value;
}

export function startSameModelFailoverFixture(options: SameModelFailoverFixtureOptions = {}): SameModelFailoverFixture {
	const logger = options.logger ?? (event => console.log(JSON.stringify(event)));
	const model = validateModel(options.model ?? DEFAULT_MODEL);
	const retryAfterSeconds = validateRetryAfterSeconds(options.retryAfterSeconds ?? RETRY_AFTER_SECONDS);
	let phase: FixturePhase = "tool_call_ready";
	let requestCount = 0;

	const logRequest = (status: number): void => {
		logger({ event: "request", phase, requestCount, retryAfterSeconds, status, toolCallId: TOOL_CALL_ID });
	};

	const server = Bun.serve({
		hostname: HOSTNAME,
		port: options.port ?? 0,
		maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/healthz") {
				return jsonResponse({ phase, requestCount, retryAfterSeconds, toolCallId: TOOL_CALL_ID }, 200);
			}
			if (!hasDummyAuthorization(request)) {
				logRequest(401);
				return jsonResponse(
					{ error: { message: "Dummy bearer token required", type: "authentication_error" } },
					401,
				);
			}
			if (request.method === "GET" && url.pathname === "/v1/models") {
				return jsonResponse(
					{ object: "list", data: [{ id: model, object: "model", owned_by: "artel-test-fixture" }] },
					200,
				);
			}
			if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
				logRequest(404);
				return jsonResponse({ error: { message: "Route not found", type: "invalid_request_error" } }, 404);
			}

			requestCount += 1;
			if (phase === "rate_limited") {
				logRequest(429);
				return rateLimitResponse(retryAfterSeconds);
			}

			let body: unknown;
			try {
				body = await request.json();
			} catch {
				logRequest(400);
				return jsonResponse({ error: { message: "JSON request required", type: "invalid_request_error" } }, 400);
			}
			if (requestedModel(body) !== model) {
				logRequest(400);
				return jsonResponse(
					{ error: { message: "Configured model required", type: "invalid_request_error" } },
					400,
				);
			}
			if (!isArmedEngineRequest(body)) {
				logRequest(200);
				return probeResponse(model);
			}

			if (phase === "tool_call_ready") {
				if (hasSettledToolResult(body)) {
					logRequest(409);
					return jsonResponse(
						{ error: { message: "Tool result arrived before tool call", type: "invalid_request_error" } },
						409,
					);
				}
				phase = "awaiting_tool_result";
				logRequest(200);
				return toolCallStream(model);
			}

			if (!hasSettledToolResult(body)) {
				logRequest(409);
				return jsonResponse(
					{ error: { message: "Matching settled tool result required", type: "invalid_request_error" } },
					409,
				);
			}
			phase = "rate_limited";
			logRequest(429);
			return rateLimitResponse(retryAfterSeconds);
		},
	});

	const assignedPort = server.port;
	if (typeof assignedPort !== "number") {
		server.stop(true);
		throw new Error("Loopback fixture did not receive a TCP port");
	}
	const url = `http://${HOSTNAME}:${assignedPort}`;
	logger({ event: "ready", phase, requestCount, retryAfterSeconds, toolCallId: TOOL_CALL_ID, url });
	return {
		get phase() {
			return phase;
		},
		get requestCount() {
			return requestCount;
		},
		model,
		port: assignedPort,
		retryAfterSeconds,
		stop: () => server.stop(true),
		url,
	};
}

export function parseSameModelFailoverFixtureCliArgs(args: string[]): SameModelFailoverFixtureOptions {
	let model: string | undefined;
	let port: number | undefined;
	let retryAfterSeconds: number | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--model") {
			const value = args[index + 1];
			if (value === undefined) throw new Error("--model requires a model id");
			model = value;
			index += 1;
			continue;
		}
		if (arg === "--port") {
			const value = args[index + 1];
			if (value === undefined || !/^\d+$/.test(value)) throw new Error("--port requires an integer from 0 to 65535");
			const parsedPort = Number(value);
			if (!Number.isSafeInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
				throw new Error("--port requires an integer from 0 to 65535");
			}
			port = parsedPort;
			index += 1;
			continue;
		}
		if (arg === "--retry-after-seconds") {
			const value = args[index + 1];
			if (value === undefined || !/^\d+$/.test(value)) {
				throw new Error(`--retry-after-seconds requires an integer from 1 to ${MAX_RETRY_AFTER_SECONDS}`);
			}
			retryAfterSeconds = validateRetryAfterSeconds(Number(value));
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { model, port, retryAfterSeconds };
}

if (import.meta.main) {
	const fixture = startSameModelFailoverFixture(parseSameModelFailoverFixtureCliArgs(process.argv.slice(2)));
	const stop = (): void => {
		fixture.stop();
		process.exit(0);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}
