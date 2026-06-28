import * as fs from "node:fs";
import * as tls from "node:tls";
import { $env, isEnoent } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";

type BunTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
};

type BunTlsRequestInit = RequestInit & {
	tls?: BunTlsOptions;
};

type TlsFetch = FetchImpl & { [TLS_FETCH_MARKER]?: true };

const TLS_FETCH_MARKER = Symbol("omp.tlsFetch");

let extraCaCacheKey: string | undefined;
let extraCaCache: string | undefined;

function looksLikeFilePath(value: string): boolean {
	return value.includes("/") || value.includes("\\") || /\.(pem|crt|cer)$/i.test(value);
}

function extraCaCacheKeyComponent(value: string): string {
	if (!value.includes("-----BEGIN") && looksLikeFilePath(value)) {
		try {
			return `${value}@${fs.statSync(value).mtimeMs}`;
		} catch {
			return value;
		}
	}
	return value;
}

function resolveExtraCa(): string | undefined {
	const raw = $env.NODE_EXTRA_CA_CERTS?.trim();
	if (!raw) return undefined;

	const cacheKey = extraCaCacheKeyComponent(raw);
	if (cacheKey === extraCaCacheKey) return extraCaCache;

	const inline = raw.replace(/\\n/g, "\n");
	if (inline.includes("-----BEGIN")) {
		extraCaCacheKey = cacheKey;
		extraCaCache = inline;
		return extraCaCache;
	}

	if (looksLikeFilePath(raw)) {
		try {
			extraCaCache = fs.readFileSync(raw, "utf8");
			extraCaCacheKey = cacheKey;
			return extraCaCache;
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`NODE_EXTRA_CA_CERTS path does not exist: ${raw}`);
			}
			throw error;
		}
	}

	extraCaCacheKey = cacheKey;
	extraCaCache = inline;
	return extraCaCache;
}

function mergeTls(init: RequestInit | undefined, ca: string): RequestInit {
	const existing = (init as BunTlsRequestInit | undefined)?.tls;
	const existingCa = existing?.ca;
	const mergedCa = existingCa
		? [...tls.rootCertificates, ...(Array.isArray(existingCa) ? existingCa : [existingCa]), ca]
		: [...tls.rootCertificates, ca];
	return {
		...init,
		tls: {
			...existing,
			ca: mergedCa,
		},
	} as RequestInit;
}

export function wrapFetchForExtraCa(fetchImpl: FetchImpl): FetchImpl {
	const maybeWrapped = fetchImpl as TlsFetch;
	if (maybeWrapped[TLS_FETCH_MARKER]) return fetchImpl;

	const wrapped = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const ca = resolveExtraCa();
			return ca ? fetchImpl(input, mergeTls(init, ca)) : fetchImpl(input, init);
		},
		fetchImpl.preconnect ? { preconnect: fetchImpl.preconnect } : {},
		{ [TLS_FETCH_MARKER]: true as const },
	);
	return wrapped;
}

export function withExtraCaFetch<T extends { fetch?: FetchImpl } | undefined>(options: T): T {
	const ca = resolveExtraCa();
	if (!ca) return options;
	const fetchImpl = options?.fetch ?? (globalThis.fetch as FetchImpl);
	const wrapped = wrapFetchForExtraCa(fetchImpl);
	return { ...(options ?? {}), fetch: wrapped } as T;
}
