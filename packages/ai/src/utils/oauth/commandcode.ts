/**
 * Command Code browser-assisted API-key login.
 *
 * Unlike OAuth code flows, Command Code Studio posts the generated API key
 * directly to a localhost callback after authentication. Keys are stored by
 * AuthStorage as ordinary API-key credentials because they do not refresh.
 */
import type { OAuthController } from "./types";

const STUDIO_AUTH_URL = "https://commandcode.ai/studio/auth/cli";
const CALLBACK_PATH = "/callback";
const CALLBACK_HOST = "127.0.0.1";
const START_PORT = 5959;
const PORT_RANGE = 10;
const CALLBACK_PORT_ENV = "OMP_COMMANDCODE_CALLBACK_PORT";
const AUTH_TIMEOUT_MS = 15_000;
const ALLOWED_ORIGINS = new Set(["https://commandcode.ai", "https://staging.commandcode.ai", "http://localhost:3000"]);

export interface CommandCodeAuthCallback {
	apiKey: string;
	state: string;
}

export interface CommandCodeAuthServer {
	server: Bun.Server<undefined>;
	port: number;
	waitForCallback: Promise<CommandCodeAuthCallback>;
}

export interface CommandCodeAuthServerOptions {
	startPort?: number;
	portRange?: number;
	allowEphemeralFallback?: boolean;
}

export interface CommandCodeLoginOptions {
	authTimeoutMs?: number;
	startAuthServer?: () => Promise<CommandCodeAuthServer>;
}

class CommandCodeCallbackTimeoutError extends Error {
	constructor() {
		super("Command Code browser authentication timed out");
		this.name = "CommandCodeCallbackTimeoutError";
	}
}

function responseHeaders(request: Request): Headers {
	const headers = new Headers({ "Content-Type": "application/json" });
	const origin = request.headers.get("origin");
	if (origin && ALLOWED_ORIGINS.has(origin)) {
		headers.set("Access-Control-Allow-Origin", origin);
		headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
		headers.set(
			"Access-Control-Allow-Headers",
			request.headers.get("access-control-request-headers") ?? "Content-Type",
		);
		headers.set("Access-Control-Allow-Private-Network", "true");
	}
	return headers;
}

function startServerOnPort(
	port: number,
	resolveCallback: (callback: CommandCodeAuthCallback) => void,
	rejectCallback: (error: Error) => void,
): Bun.Server<undefined> {
	let server: Bun.Server<undefined>;
	server = Bun.serve({
		hostname: CALLBACK_HOST,
		port,
		fetch: async request => {
			const url = new URL(request.url);
			const headers = responseHeaders(request);
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
			if (url.pathname !== CALLBACK_PATH) {
				return Response.json({ success: false, error: "Not found" }, { status: 404, headers });
			}
			if (request.method !== "POST") {
				return Response.json({ success: false, error: "Method not allowed. Use POST." }, { status: 405, headers });
			}
			const text = await request.text();
			if (text.length > 10_000) {
				return Response.json({ success: false, error: "Request body too large" }, { status: 413, headers });
			}
			let payload: unknown;
			try {
				payload = JSON.parse(text);
			} catch {
				return Response.json({ success: false, error: "Invalid JSON" }, { status: 400, headers });
			}
			if (!payload || typeof payload !== "object") {
				return Response.json({ success: false, error: "Missing required fields" }, { status: 400, headers });
			}
			const record = payload as Record<string, unknown>;
			if (typeof record.error === "string") {
				const message = typeof record.error_description === "string" ? record.error_description : record.error;
				queueMicrotask(() => {
					rejectCallback(new Error(message));
					server.stop();
				});
				return Response.json({ success: true }, { headers });
			}
			const apiKey = typeof record.apiKey === "string" ? record.apiKey.trim() : "";
			const state = typeof record.state === "string" ? record.state : "";
			if (!apiKey || !state) {
				return Response.json({ success: false, error: "Missing required fields" }, { status: 400, headers });
			}
			queueMicrotask(() => {
				resolveCallback({ apiKey, state });
				server.stop();
			});
			return Response.json({ success: true }, { headers });
		},
	});
	return server;
}

export async function startCommandCodeAuthServer(
	options: CommandCodeAuthServerOptions = {},
): Promise<CommandCodeAuthServer> {
	const { promise: waitForCallback, resolve, reject } = Promise.withResolvers<CommandCodeAuthCallback>();
	const startPort = options.startPort ?? START_PORT;
	const portRange = options.portRange ?? PORT_RANGE;
	const attempts = startPort === 0 ? [0] : Array.from({ length: portRange }, (_, index) => startPort + index);
	const ports = options.allowEphemeralFallback === false || attempts.includes(0) ? attempts : [...attempts, 0];
	for (const port of ports) {
		try {
			const server = startServerOnPort(port, resolve, reject);
			const actualPort = server.port;
			if (actualPort === undefined) {
				server.stop(true);
				throw new Error("Command Code callback server did not expose its listening port");
			}
			return { server, port: actualPort, waitForCallback };
		} catch (error) {
			const isAddressInUse = error instanceof Error && "code" in error && error.code === "EADDRINUSE";
			if (port === 0 || !isAddressInUse) throw error;
		}
	}
	throw new Error("Unable to start Command Code callback server");
}

function readForcedCallbackPort(): number | undefined {
	const raw = Bun.env[CALLBACK_PORT_ENV];
	if (!raw) return undefined;
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
	return port;
}

function startLoginAuthServer(): Promise<CommandCodeAuthServer> {
	const forcedPort = readForcedCallbackPort();
	if (forcedPort !== undefined) {
		return startCommandCodeAuthServer({
			startPort: forcedPort,
			portRange: 1,
			allowEphemeralFallback: false,
		});
	}
	return startCommandCodeAuthServer();
}

export function sanitizeCommandCodeApiKey(input: string): string {
	return input
		.replaceAll("\u001b[200~", "")
		.replaceAll("\u001b[201~", "")
		.replaceAll("[200~", "")
		.replaceAll("[201~", "")
		.replaceAll(/[\u0000-\u001f\u007f]/g, "")
		.trim();
}

async function promptForApiKey(ctrl: OAuthController): Promise<string> {
	if (!ctrl.onPrompt) throw new Error("Command Code login requires an interactive prompt");
	const apiKey = sanitizeCommandCodeApiKey(
		await ctrl.onPrompt({ message: "Paste your Command Code API key", placeholder: "user_..." }),
	);
	if (!apiKey) throw new Error("Command Code API key is required");
	return apiKey;
}

async function waitForCallback(
	server: CommandCodeAuthServer,
	ctrl: OAuthController,
	authTimeoutMs: number,
): Promise<CommandCodeAuthCallback> {
	const timeoutSignal = AbortSignal.timeout(authTimeoutMs);
	const signal = ctrl.signal ? AbortSignal.any([ctrl.signal, timeoutSignal]) : timeoutSignal;
	const { promise, reject } = Promise.withResolvers<CommandCodeAuthCallback>();
	const onAbort = (): void => {
		reject(ctrl.signal?.aborted ? new Error("Login cancelled") : new CommandCodeCallbackTimeoutError());
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([server.waitForCallback, promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export async function loginCommandCode(ctrl: OAuthController, options: CommandCodeLoginOptions = {}): Promise<string> {
	if (ctrl.signal?.aborted) throw new Error("Login cancelled");
	let server: CommandCodeAuthServer;
	try {
		server = await (options.startAuthServer ?? startLoginAuthServer)();
	} catch {
		return promptForApiKey(ctrl);
	}
	const state = crypto.randomUUID();
	const callbackUrl = `http://${CALLBACK_HOST}:${server.port}${CALLBACK_PATH}`;
	const authUrl = `${STUDIO_AUTH_URL}?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;
	ctrl.onAuth?.({ url: authUrl, instructions: "Sign in to Command Code in your browser to create an API key." });
	ctrl.onProgress?.("Waiting for automatic Command Code transfer; manual paste will be offered if it fails...");
	try {
		const callback = await waitForCallback(server, ctrl, options.authTimeoutMs ?? AUTH_TIMEOUT_MS);
		if (callback.state !== state) throw new Error("Command Code authentication state mismatch");
		return callback.apiKey;
	} catch (error) {
		if (!(error instanceof CommandCodeCallbackTimeoutError)) throw error;
		return promptForApiKey(ctrl);
	} finally {
		server.server.stop();
	}
}
