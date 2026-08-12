import * as fs from "node:fs/promises";

export type PrimeBridgeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type PrimeBridgeReadFile = (path: string, encoding: "utf8") => Promise<string>;

export interface PrimeBridgeHttpClientOptions {
	url: string;
	tokenPath: string;
	fetch?: PrimeBridgeFetch;
	readFile?: PrimeBridgeReadFile;
}

function loopbackBridgeUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Prime bridge url must be a loopback HTTP URL");
	}
	const host = url.hostname.toLowerCase();
	if (
		url.protocol !== "http:" ||
		(host !== "127.0.0.1" && host !== "localhost") ||
		url.username !== "" ||
		url.password !== "" ||
		(url.pathname !== "" && url.pathname !== "/") ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("Prime bridge url must be a loopback HTTP URL");
	}
	return url.origin;
}

export class PrimeBridgeHttpError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`Prime bridge request failed (${status})`);
		this.name = "PrimeBridgeHttpError";
		this.status = status;
	}
}

export class PrimeBridgeHttpClient {
	readonly #baseUrl: string;
	readonly #tokenPath: string;
	readonly #fetch: PrimeBridgeFetch;
	readonly #readFile: PrimeBridgeReadFile;

	constructor(options: PrimeBridgeHttpClientOptions) {
		if (options.url.length === 0) throw new Error("Prime bridge url is required");
		if (options.tokenPath.length === 0) throw new Error("Prime bridge tokenPath is required");
		this.#baseUrl = loopbackBridgeUrl(options.url);
		this.#tokenPath = options.tokenPath;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#readFile = options.readFile ?? (async (path, encoding) => await fs.readFile(path, encoding));
	}

	async get<T>(route: string): Promise<T> {
		return await this.#request<T>(route, "GET");
	}

	async post<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
		return await this.#request<T>(route, "POST", body, signal);
	}

	async #request<T>(route: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal): Promise<T> {
		const token = (await this.#readFile(this.#tokenPath, "utf8")).trim();
		if (token.length === 0) throw new Error("Prime bridge token is empty");
		const headers: Record<string, string> = { authorization: `Bearer ${token}` };
		const init: RequestInit = { method, headers, signal, redirect: "error" };
		if (body !== undefined) {
			headers["content-type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		const response = await this.#fetch(`${this.#baseUrl}${route}`, init);
		if (!response.ok) throw new PrimeBridgeHttpError(response.status);
		try {
			return (await response.json()) as T;
		} catch {
			throw new Error("Prime bridge response must be valid JSON");
		}
	}
}
