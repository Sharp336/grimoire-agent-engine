import type { ClientHttp2Stream, IncomingHttpHeaders } from "node:http2";
import { constants as http2Constants } from "node:http2";
import * as AIError from "../error";
import type { FetchImpl } from "../types";
import { acquireH2Session, type H2Lease } from "./h2-pool";

const PRE_DISPATCH_CODES: Record<string, true> = {
	ECONNABORTED: true,
	ECONNREFUSED: true,
	ECONNRESET: true,
	EHOSTUNREACH: true,
	ENETDOWN: true,
	ENETUNREACH: true,
	ENOTFOUND: true,
	ETIMEDOUT: true,
	ERR_HTTP2_ALPN: true,
	ERR_HTTP2_INVALID_SESSION: true,
};

export class H2UnavailableBeforeDispatchError extends Error {
	readonly cause: unknown;
	constructor(cause: unknown) {
		super(`HTTP/2 unavailable before dispatch: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "H2UnavailableBeforeDispatchError";
		this.cause = cause;
	}
}

function isPreDispatchUnavailable(error: unknown): boolean {
	if (error instanceof AIError.AbortError || error instanceof AIError.ValidationError) return false;
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && PRE_DISPATCH_CODES[code]) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /alpn.*(?:h2|http\/2)|http\/2.*(?:not supported|unavailable)|failed to connect|network is unreachable/i.test(
		message,
	);
}

export interface H2Exchange {
	readonly stream: ClientHttp2Stream;
	readonly response: Promise<{ status: number; headers: IncomingHttpHeaders }>;
	dispatch(bodyFactory: () => Uint8Array): void;
	close(): Promise<void>;
}

export interface EstablishH2RequestOptions {
	url: string;
	provider: string;
	headers: Record<string, string>;
	signal?: AbortSignal;
}

export async function establishH2Request(options: EstablishH2RequestOptions): Promise<H2Exchange> {
	let lease: H2Lease | undefined;
	let stream: ClientHttp2Stream | undefined;
	try {
		const url = new URL(options.url);
		lease = await acquireH2Session(url.origin, options.provider, options.signal);
		stream = await lease.request(
			{
				":method": "POST",
				":path": `${url.pathname}${url.search}`,
				...options.headers,
			},
			{ signal: options.signal },
		);
	} catch (error) {
		lease?.release();
		if (isPreDispatchUnavailable(error)) throw new H2UnavailableBeforeDispatchError(error);
		throw error;
	}

	const activeLease = lease;
	const activeStream = stream;
	const response = Promise.withResolvers<{ status: number; headers: IncomingHttpHeaders }>();
	let dispatched = false;
	let released = false;
	let responseSettled = false;
	activeStream.once("response", headers => {
		responseSettled = true;
		response.resolve({ status: Number(headers[":status"] ?? 0), headers });
	});
	activeStream.once("error", error => {
		if (!responseSettled) {
			responseSettled = true;
			response.reject(error);
		}
	});
	activeStream.once("close", () => {
		if (!responseSettled) {
			responseSettled = true;
			response.reject(new Error("HTTP/2 stream closed before response headers"));
		}
		if (!released) {
			released = true;
			activeLease.release();
		}
	});

	return {
		stream: activeStream,
		response: response.promise,
		dispatch(bodyFactory) {
			if (dispatched) throw new Error("HTTP/2 exchange was already dispatched");
			dispatched = true;
			activeStream.end(bodyFactory());
		},
		async close() {
			if (!activeStream.closed && !activeStream.destroyed) activeStream.close(http2Constants.NGHTTP2_CANCEL);
			if (!released) {
				released = true;
				activeLease.release();
			}
		},
	};
}

export interface H2PostOptions extends EstablishH2RequestOptions {
	body: Uint8Array;
	fetchOverride?: FetchImpl;
}

export interface TransportResponse {
	status: number;
	headers: Headers;
	body: ReadableStream<Uint8Array>;
	close(): Promise<void>;
}

function nodeBody(exchange: H2Exchange): ReadableStream<Uint8Array> {
	const iterator = exchange.stream[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await iterator.next();
				if (result.done) {
					controller.close();
					await exchange.close();
					return;
				}
				const value = result.value;
				controller.enqueue(value instanceof Uint8Array ? value : new Uint8Array(value));
			} catch (error) {
				controller.error(error);
				await exchange.close();
			}
		},
		async cancel() {
			await iterator.return?.();
			await exchange.close();
		},
	});
}

function webHeaders(headers: IncomingHttpHeaders): Headers {
	const result = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (name.startsWith(":")) continue;
		if (Array.isArray(value)) for (const item of value) result.append(name, item);
		else if (value !== undefined) result.set(name, String(value));
	}
	return result;
}

async function postFetch(options: H2PostOptions, fetchImpl: FetchImpl): Promise<TransportResponse> {
	const response = await fetchImpl(options.url, {
		method: "POST",
		headers: options.headers,
		body: options.body,
		signal: options.signal,
	});
	return {
		status: response.status,
		headers: response.headers,
		body: response.body ?? new ReadableStream({ start: controller => controller.close() }),
		async close() {
			await response.body?.cancel();
		},
	};
}

export async function postH2Only(options: H2PostOptions): Promise<TransportResponse> {
	if (options.fetchOverride) return postFetch(options, options.fetchOverride);
	const exchange = await establishH2Request(options);
	try {
		exchange.dispatch(() => options.body);
		const response = await exchange.response;
		return {
			status: response.status,
			headers: webHeaders(response.headers),
			body: nodeBody(exchange),
			close: exchange.close,
		};
	} catch (error) {
		await exchange.close();
		throw error;
	}
}

export async function postH2Primary(options: H2PostOptions): Promise<TransportResponse> {
	try {
		return await postH2Only(options);
	} catch (error) {
		if (!(error instanceof H2UnavailableBeforeDispatchError)) throw error;
		return postFetch(options, fetch);
	}
}
