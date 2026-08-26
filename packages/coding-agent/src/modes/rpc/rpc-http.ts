/**
 * Opt-in HTTP transport for RPC mode.
 *
 * Same JSON frames as stdio RPC. The process owns one session; one streaming
 * subscriber (GET /rpc or WebSocket /rpc) at a time. POST /rpc injects inbound
 * frames. Subscriber disconnect closes the inbound stream the way stdin EOF
 * does for stdio RPC.
 */
import * as crypto from "node:crypto";
import { corsHeaders, isAuthorized, json, withCors } from "@oh-my-pi/pi-ai/auth-gateway";
import { parseBind } from "@oh-my-pi/pi-ai/utils/parse-bind";
import { logger, VERSION } from "@oh-my-pi/pi-utils";
import { MAX_RPC_FRAME_BYTES } from "./rpc-frame";

export const DEFAULT_RPC_HTTP_BIND = "127.0.0.1:8765";

/** Optional stdout replacement so RPC mode can emit frames over HTTP. */
export type RpcOutputSink = {
	write(line: string): boolean;
	drain(): Promise<void>;
};

const TEXT_ENCODER = new TextEncoder();
const MAX_POST_BYTES = MAX_RPC_FRAME_BYTES;

export interface RpcHttpServerOptions {
	bind?: string;
	token?: string;
	noAuth?: boolean;
}

export interface RpcHttpServer {
	url: string;
	hostname: string;
	port: number;
	input: ReadableStream<Uint8Array>;
	sink: RpcOutputSink;
	/** Bearer token clients must send, or null when auth is disabled. */
	token: string | null;
	close(): Promise<void>;
}

export interface RpcHttpAuth {
	bind: string;
	tokens: ReadonlySet<string>;
	token: string | null;
}

type Subscriber = {
	write(line: string): void;
	close(): void;
};

export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function resolveRpcHttpAuth(opts: RpcHttpServerOptions): RpcHttpAuth {
	const bind = opts.bind?.trim() || DEFAULT_RPC_HTTP_BIND;
	const parsed = parseBind(bind);
	if (opts.noAuth) {
		if (!isLoopbackHostname(parsed.hostname)) {
			throw new Error("--http-no-auth is only allowed for loopback binds (127.0.0.1, localhost, ::1)");
		}
		return { bind, tokens: new Set(), token: null };
	}
	const token = opts.token?.trim() || crypto.randomBytes(32).toString("base64url");
	return { bind, tokens: new Set([token]), token };
}

function formatSse(line: string): Uint8Array {
	const jsonLine = line.endsWith("\n") ? line.slice(0, -1) : line;
	return TEXT_ENCODER.encode(`data: ${jsonLine}\n\n`);
}

function lineBytes(line: string): Uint8Array {
	return TEXT_ENCODER.encode(line.endsWith("\n") ? line : `${line}\n`);
}

export function startRpcHttpServer(opts: RpcHttpServerOptions = {}): RpcHttpServer {
	const auth = resolveRpcHttpAuth(opts);
	const bind = parseBind(auth.bind);
	const tokens = new Set(auth.tokens);

	const inbound = new TransformStream<Uint8Array>();
	const inboundWriter = inbound.writable.getWriter();
	let inboundClosed = false;

	const pending: string[] = [];
	let subscriber: Subscriber | undefined;
	let drainWaiters: Array<() => void> = [];

	const closeInbound = (): void => {
		if (inboundClosed) return;
		inboundClosed = true;
		void inboundWriter.close().catch(() => {});
	};

	const attach = (next: Subscriber): boolean => {
		if (subscriber) return false;
		subscriber = next;
		for (const line of pending) next.write(line);
		pending.length = 0;
		for (const wake of drainWaiters) wake();
		drainWaiters = [];
		return true;
	};

	const detach = (current: Subscriber): void => {
		if (subscriber !== current) return;
		subscriber = undefined;
		closeInbound();
	};

	const sink: RpcOutputSink = {
		write(line: string): boolean {
			if (!subscriber) {
				pending.push(line);
				return true;
			}
			subscriber.write(line);
			return true;
		},
		drain(): Promise<void> {
			if (subscriber || inboundClosed) return Promise.resolve();
			return new Promise(resolve => {
				drainWaiters.push(resolve);
			});
		},
	};

	const pushInbound = async (text: string): Promise<void> => {
		if (inboundClosed) throw new Error("RPC HTTP client disconnected");
		await inboundWriter.write(lineBytes(text));
	};

	const ingestBody = async (body: string): Promise<void> => {
		const trimmed = body.trim();
		if (!trimmed) throw new Error("empty body");
		const frames = trimmed.includes("\n") ? trimmed.split("\n") : [trimmed];
		for (const frame of frames) {
			const text = frame.trim();
			if (!text) continue;
			JSON.parse(text);
			await pushInbound(text);
		}
	};

	type SocketData = { subscriber: Subscriber };

	const server = Bun.serve<SocketData>({
		hostname: bind.hostname,
		port: bind.port,
		idleTimeout: 255,
		websocket: {
			open(ws) {
				const socketSub: Subscriber = {
					write(line: string) {
						const jsonLine = line.endsWith("\n") ? line.slice(0, -1) : line;
						ws.send(jsonLine);
					},
					close() {
						try {
							ws.close();
						} catch {}
					},
				};
				if (!attach(socketSub)) {
					ws.close(1013, "RPC HTTP stream already attached");
					return;
				}
				ws.data = { subscriber: socketSub };
			},
			message(_ws, message) {
				const text = typeof message === "string" ? message : new TextDecoder().decode(message);
				void ingestBody(text).catch(error => {
					logger.warn("RPC HTTP websocket frame rejected", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			},
			close(ws) {
				const current = ws.data?.subscriber;
				if (current) detach(current);
			},
		},
		fetch: async (req, srv): Promise<Response | undefined> => {
			const url = new URL(req.url);
			const pathname = url.pathname;

			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req) });
			}

			if (req.method === "GET" && pathname === "/healthz") {
				return withCors(json(200, { ok: true, version: VERSION }), req);
			}

			if (!isAuthorized(req, tokens)) {
				return withCors(json(401, { error: "unauthorized" }), req);
			}

			if (pathname !== "/rpc") {
				return withCors(json(404, { error: "not found" }), req);
			}

			if (req.method === "GET" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
				if (subscriber) {
					return withCors(json(409, { error: "RPC HTTP stream already attached" }), req);
				}
				if (!srv.upgrade(req)) {
					return withCors(json(400, { error: "WebSocket upgrade failed" }), req);
				}
				return undefined;
			}

			if (req.method === "POST") {
				if (inboundClosed) {
					return withCors(json(410, { error: "RPC HTTP client disconnected" }), req);
				}
				const raw = await req.arrayBuffer();
				if (raw.byteLength > MAX_POST_BYTES) {
					return withCors(json(413, { error: "RPC frame exceeded the transport limit" }), req);
				}
				try {
					await ingestBody(new TextDecoder().decode(raw));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return withCors(json(400, { error: message }), req);
				}
				return withCors(json(202, { ok: true }), req);
			}

			if (req.method !== "GET") {
				return withCors(json(405, { error: "method not allowed" }), req);
			}

			if (subscriber) {
				return withCors(json(409, { error: "RPC HTTP stream already attached" }), req);
			}

			const sse = (req.headers.get("accept") ?? "").includes("text/event-stream");
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const streamSub: Subscriber = {
						write(line: string) {
							controller.enqueue(sse ? formatSse(line) : lineBytes(line));
						},
						close() {
							try {
								controller.close();
							} catch {}
						},
					};
					if (!attach(streamSub)) {
						controller.error(new Error("RPC HTTP stream already attached"));
						return;
					}
					const onAbort = () => {
						detach(streamSub);
						try {
							controller.close();
						} catch {}
					};
					req.signal.addEventListener("abort", onAbort, { once: true });
				},
				cancel() {
					if (subscriber) detach(subscriber);
				},
			});

			return withCors(
				new Response(stream, {
					status: 200,
					headers: {
						"Content-Type": sse ? "text/event-stream; charset=utf-8" : "application/x-ndjson; charset=utf-8",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
						"X-Accel-Buffering": "no",
					},
				}),
				req,
			);
		},
	});

	const onStop = (): void => {
		closeInbound();
		subscriber?.close();
		subscriber = undefined;
		server.stop(true);
	};
	process.once("SIGINT", onStop);
	process.once("SIGTERM", onStop);

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		hostname: boundHost,
		port: boundPort,
		input: inbound.readable,
		sink,
		token: auth.token,
		close: async () => {
			process.off("SIGINT", onStop);
			process.off("SIGTERM", onStop);
			onStop();
		},
	};
}
