import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	disposeCursorConversationCache,
	getCursorConversationCacheSizesForTest,
	streamCursor,
} from "@oh-my-pi/pi-ai/providers/cursor";
import { disposeH2Pool, encodeConnectFrame } from "@oh-my-pi/pi-ai/transport";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	type ConversationStateStructure,
	ConversationStateStructureSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

const CONNECT_END_STREAM_FLAG = 0x02;
const context: Context = { messages: [{ role: "user", content: "state isolation", timestamp: 1 }] };
const servers = new Set<http2.Http2Server>();

interface CapturedRequest {
	authorization: string;
	todos: Uint8Array[];
}

function model(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-state-test",
		name: "Cursor state test",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

function successResponse(checkpoint?: ConversationStateStructure): Buffer {
	const frames: Uint8Array[] = [];
	if (checkpoint) {
		frames.push(
			encodeConnectFrame(
				toBinary(
					AgentServerMessageSchema,
					create(AgentServerMessageSchema, {
						message: {
							case: "conversationCheckpointUpdate",
							value: checkpoint,
						},
					}),
				),
			),
		);
	}
	frames.push(
		encodeConnectFrame(
			toBinary(
				AgentServerMessageSchema,
				create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
						}),
					},
				}),
			),
		),
	);
	frames.push(encodeConnectFrame(new Uint8Array(), CONNECT_END_STREAM_FLAG));
	return Buffer.concat(frames);
}

async function startServer(
	checkpointRequests: boolean | ReadonlySet<number>,
	holdRequest?: (requestNumber: number) => Promise<void> | undefined,
): Promise<{ baseUrl: string; requests: CapturedRequest[]; firstRequest: Promise<void> }> {
	const requests: CapturedRequest[] = [];
	const firstRequest = Promise.withResolvers<void>();
	const server = http2.createServer();
	servers.add(server);
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		if (headers[":path"] !== "/agent.v1.AgentService/Run") {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		let body = Buffer.alloc(0);
		let responded = false;
		stream.on("data", async (chunk: Buffer) => {
			body = Buffer.concat([body, chunk]);
			if (responded || body.byteLength < 5) return;
			const payloadLength = body.readUInt32BE(1);
			if (body.byteLength < 5 + payloadLength) return;
			responded = true;
			const clientMessage = fromBinary(AgentClientMessageSchema, body.subarray(5, 5 + payloadLength));
			if (clientMessage.message.case !== "runRequest") throw new Error("expected Cursor run request");
			const request = clientMessage.message.value;
			requests.push({
				authorization: String(headers.authorization ?? ""),
				todos: request.conversationState?.todos ?? [],
			});
			const requestNumber = requests.length;
			if (requestNumber === 1) firstRequest.resolve();
			await holdRequest?.(requestNumber);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			const shouldCheckpoint =
				checkpointRequests === true
					? requestNumber === 1
					: checkpointRequests === false
						? false
						: checkpointRequests.has(requestNumber);
			const checkpoint =
				shouldCheckpoint && request.conversationState
					? create(ConversationStateStructureSchema, {
							...request.conversationState,
							todos: [new Uint8Array([42])],
						})
					: undefined;
			stream.end(successResponse(checkpoint));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected Cursor state fixture port");
	return { baseUrl: `http://127.0.0.1:${address.port}`, requests, firstRequest: firstRequest.promise };
}

async function run(baseUrl: string, apiKey: string, conversationId = "shared-caller-id"): Promise<void> {
	const result = await streamCursor(model(baseUrl), context, {
		apiKey,
		conversationId,
	}).result();
	expect(result.stopReason).toBe("stop");
}

afterEach(async () => {
	await disposeCursorConversationCache();
	await disposeH2Pool();
	await Promise.all(
		[...servers].map(
			server =>
				new Promise<void>(resolve => {
					server.close(() => resolve());
				}),
		),
	);
	servers.clear();
});

describe("Cursor conversation state isolation", () => {
	it("scopes checkpoints by endpoint and hashed credential, not caller conversation id alone", async () => {
		const firstEndpoint = await startServer(true);
		await run(firstEndpoint.baseUrl, "credential-a");
		await run(firstEndpoint.baseUrl, "credential-b");

		const secondEndpoint = await startServer(false);
		await run(secondEndpoint.baseUrl, "credential-c");
		await run(secondEndpoint.baseUrl, "credential-a");
		await run(firstEndpoint.baseUrl, "credential-a");
		await run(firstEndpoint.baseUrl, "credential-b");
		await run(secondEndpoint.baseUrl, "credential-c");

		expect(firstEndpoint.requests.map(request => request.authorization)).toEqual([
			"Bearer credential-a",
			"Bearer credential-b",
			"Bearer credential-a",
			"Bearer credential-b",
		]);
		expect(firstEndpoint.requests.map(request => request.todos)).toEqual([[], [], [new Uint8Array([42])], []]);
		expect(secondEndpoint.requests.map(request => request.authorization)).toEqual([
			"Bearer credential-c",
			"Bearer credential-a",
			"Bearer credential-c",
		]);
		expect(secondEndpoint.requests.map(request => request.todos)).toEqual([[], [], []]);
	});

	it("clears checkpoints when Cursor transports are disposed", async () => {
		const endpoint = await startServer(true);
		await run(endpoint.baseUrl, "disposed-credential", "disposed-conversation");
		await disposeCursorConversationCache();
		await run(endpoint.baseUrl, "disposed-credential", "disposed-conversation");
		expect(endpoint.requests.map(request => request.todos)).toEqual([[], []]);
	});

	it("evicts the least-recently-used checkpoint when the bounded cache fills", async () => {
		const endpoint = await startServer(new Set([1, 2]));
		await run(endpoint.baseUrl, "bounded-credential", "refreshed");
		await run(endpoint.baseUrl, "bounded-credential", "untouched");
		await run(endpoint.baseUrl, "bounded-credential", "refreshed");
		for (let index = 0; index < 63; index++) {
			await run(endpoint.baseUrl, "bounded-credential", `new-${index}`);
		}
		await run(endpoint.baseUrl, "bounded-credential", "refreshed");
		await run(endpoint.baseUrl, "bounded-credential", "untouched");
		expect(endpoint.requests.at(-2)?.todos).toEqual([new Uint8Array([42])]);
		expect(endpoint.requests.at(-1)?.todos).toEqual([]);
	});

	it("does not evict a checkpoint written by an in-flight request", async () => {
		const releaseFirst = Promise.withResolvers<void>();
		const endpoint = await startServer(true, () => releaseFirst.promise);
		const inFlight = run(endpoint.baseUrl, "pinned-credential", "pinned");
		await endpoint.firstRequest;
		for (let index = 0; index < 64; index++) {
			await run(endpoint.baseUrl, "pinned-credential", `competing-${index}`);
		}
		releaseFirst.resolve();
		await inFlight;
		await run(endpoint.baseUrl, "pinned-credential", "pinned");
		expect(endpoint.requests.at(-1)?.todos).toEqual([new Uint8Array([42])]);
	});

	it("bounds retained state after more than 64 conversations complete concurrently", async () => {
		const releaseRequests = Promise.withResolvers<void>();
		const allStarted = Promise.withResolvers<void>();
		const endpoint = await startServer(true, requestNumber => {
			if (requestNumber === 66) allStarted.resolve();
			return requestNumber === 1 ? undefined : releaseRequests.promise;
		});
		await run(endpoint.baseUrl, "concurrent-credential", "retained");

		const requests = Array.from({ length: 65 }, (_, index) =>
			run(endpoint.baseUrl, "concurrent-credential", `concurrent-${index}`),
		);
		await allStarted.promise;
		expect(getCursorConversationCacheSizesForTest()).toEqual({ idle: 1, inFlight: 65 });

		releaseRequests.resolve();
		await Promise.all(requests);
		expect(getCursorConversationCacheSizesForTest()).toEqual({ idle: 64, inFlight: 0 });
	});

	it("removes every per-request abort listener after a successful turn", async () => {
		const endpoint = await startServer(false);
		const target = new AbortController().signal;
		const active = new Set<Parameters<AbortSignal["addEventListener"]>[1]>();
		const allRemoved = Promise.withResolvers<void>();
		let resultReturned = false;
		const signal = new Proxy(target, {
			get(inner, property) {
				if (property === "addEventListener") {
					return (...args: Parameters<AbortSignal["addEventListener"]>) => {
						const [type, listener] = args;
						if (type === "abort") active.add(listener);
						inner.addEventListener(...args);
					};
				}
				if (property === "removeEventListener") {
					return (...args: Parameters<AbortSignal["removeEventListener"]>) => {
						const [type, listener] = args;
						if (type === "abort") active.delete(listener);
						inner.removeEventListener(...args);
						if (resultReturned && active.size === 0) allRemoved.resolve();
					};
				}
				const value = Reflect.get(inner, property, inner);
				return typeof value === "function" ? value.bind(inner) : value;
			},
		});
		const result = await streamCursor(model(endpoint.baseUrl), context, {
			apiKey: "listener-credential",
			conversationId: "listener-session",
			signal,
		}).result();
		expect(result.stopReason).toBe("stop");
		resultReturned = true;
		if (active.size === 0) allRemoved.resolve();
		await allRemoved.promise;
		expect(active.size).toBe(0);
	});
});
