import type * as http2 from "node:http2";
import { mapH2TransportError } from "../cursor";
import { type ConnectFrame, ConnectFrameDecoder } from "./connect-frame";
import * as h2Pool from "./h2-pool";
import { buildCursorRunHeaders } from "./headers";
import { openCursorHttp1Bridge } from "./http1-bridge";
import * as serverConfig from "./server-config";

export interface CursorTransportAttempt {
	write(frame: Buffer): void;
	frames(): AsyncIterable<ConnectFrame>;
	trailers(): Promise<http2.IncomingHttpHeaders>;
	close(): void;
}

/**
 * Opens the Cursor Run transport. HTTP/2 is preferred; the HTTP/1.1 bridge is
 * reachable only when acquisition reports a typed ALPN failure AND
 * GetServerConfig authoritatively disables bidi (or all HTTP/2). The fallback
 * decision is made entirely before this function returns — once an attempt is
 * handed to the caller, no later error can reopen the other protocol.
 */
export async function openCursorTransport(args: {
	baseUrl: string;
	apiKey: string;
	requestPath: string;
	callerHeaders?: Record<string, string>;
	gzipRequest: boolean;
	signal?: AbortSignal;
	provider: string;
}): Promise<CursorTransportAttempt> {
	const headers = buildCursorRunHeaders({
		apiKey: args.apiKey,
		requestPath: args.requestPath,
		callerHeaders: args.callerHeaders,
		gzipRequest: args.gzipRequest,
	});
	const acquisition = await h2Pool.acquireCursorH2({
		baseUrl: args.baseUrl,
		requestPath: args.requestPath,
		headers,
		provider: args.provider,
		signal: args.signal,
	});
	if (acquisition.ok) return wrapH2Lease(acquisition.lease);

	if (acquisition.unavailable.reason === "alpn") {
		const availability = await serverConfig.fetchCursorBidiAvailability({
			apiKey: args.apiKey,
			baseUrl: args.baseUrl,
			signal: args.signal,
		});
		if (availability === "bidi-disabled" || availability === "all-disabled") {
			return openCursorHttp1Bridge({
				baseUrl: args.baseUrl,
				apiKey: args.apiKey,
				requestPath: args.requestPath,
				callerHeaders: args.callerHeaders,
				gzipRequest: args.gzipRequest,
				signal: args.signal,
			});
		}
	}

	throw mapH2TransportError(acquisition.unavailable.cause, args.baseUrl);
}

function wrapH2Lease(lease: h2Pool.CursorH2Lease): CursorTransportAttempt {
	const { request, release } = lease;
	const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
	const trailersResult = Promise.withResolvers<http2.IncomingHttpHeaders>();
	void trailersResult.promise.catch(() => {});
	let trailersSettled = false;
	let closed = false;

	const settleTrailers = (headers: http2.IncomingHttpHeaders): void => {
		if (trailersSettled) return;
		trailersSettled = true;
		trailersResult.resolve(headers);
	};
	const failTrailers = (cause: unknown): void => {
		if (trailersSettled) return;
		trailersSettled = true;
		trailersResult.reject(cause instanceof Error ? cause : new Error(String(cause)));
	};

	request.on("trailers", headers => settleTrailers(headers));
	request.on("end", () => settleTrailers({}));
	request.on("error", error => failTrailers(error));
	request.on("close", () => settleTrailers({}));

	return {
		write(frame: Buffer): void {
			request.write(frame);
		},
		frames(): AsyncIterable<ConnectFrame> {
			return iterateH2Frames(request, decoder);
		},
		trailers: () => trailersResult.promise,
		close(): void {
			if (closed) return;
			closed = true;
			release();
		},
	};
}

async function* iterateH2Frames(
	request: http2.ClientHttp2Stream,
	decoder: ConnectFrameDecoder,
): AsyncGenerator<ConnectFrame> {
	const pending: ConnectFrame[] = [];
	const waiters: Array<() => void> = [];
	let done = false;
	let failure: Error | undefined;

	const wake = (): void => {
		for (const resolve of waiters.splice(0)) resolve();
	};
	const fail = (cause: unknown): void => {
		if (done || failure) return;
		failure = cause instanceof Error ? cause : new Error(String(cause));
		wake();
	};

	const onData = (chunk: Buffer | string): void => {
		if (done || failure) return;
		try {
			const frames = decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
			if (frames.length === 0) return;
			pending.push(...frames);
			wake();
		} catch (cause) {
			fail(cause);
		}
	};
	const onEnd = (): void => {
		if (done || failure) return;
		try {
			decoder.finish();
			done = true;
			wake();
		} catch (cause) {
			fail(cause);
		}
	};

	request.on("data", onData);
	request.on("end", onEnd);
	request.on("error", fail);
	request.on("close", () => {
		if (!done && !failure) onEnd();
	});

	try {
		for (;;) {
			const frame = pending.shift();
			if (frame) {
				yield frame;
				continue;
			}
			if (failure) throw failure;
			if (done) return;
			await new Promise<void>(resolve => waiters.push(resolve));
		}
	} finally {
		request.off("data", onData);
		request.off("end", onEnd);
		request.off("error", fail);
	}
}
