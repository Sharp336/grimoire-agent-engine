import * as http2 from "node:http2";
import { type } from "@oh-my-pi/omptype";
import { isKimiK3ModelId } from "../identity";
import { bareModelId, parseGlmModel, semverGte } from "../identity/classify";
import { getBundledModels } from "../models";
import { toModelSpec } from "../provider-models/bundled-references";
import type { Model, ModelSpec } from "../types";
import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "./cursor-proto";
import { create, fromBinary, toBinary } from "./protobuf";

const CURSOR_DEFAULT_BASE_URL = "https://api2.cursor.sh";
const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

/** Default `x-cursor-client-version` when a caller pins no override. */
const CURSOR_DEFAULT_CLIENT_VERSION = "cli-2026.08.11-e8db854";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

/**
 * `GetUsableModels` carries no context-window field, so the 1M ceiling is
 * recovered from the signals Cursor does send:
 * - display-name labels ("Opus 5 1M", "GPT-5.5 1M High") across families,
 * - natively 1M families Cursor serves unlabeled (Kimi K3, GLM 5.2+),
 * - the max-mode flag on Claude/Gemini ids, whose max-mode ceiling is 1M.
 */
const CURSOR_1M_CONTEXT_WINDOW = 1_000_000;
const CURSOR_1M_NAME_PATTERN = /\b1m\b/i;
const CURSOR_MAX_MODE_1M_ID_PATTERN = /claude|gemini/;
/** Kimi's official bare K3 id (`k3`, `kimi/k3`); `k3-256k` is the 256k SKU and stays out. */
const CURSOR_KIMI_K3_BARE_ID_PATTERN = /(^|\/)k3$/i;

/**
 * Versioned Cursor Grok ids (`cursor-grok-4.5`, `cursor-grok-4.6-high`) are
 * reasoning models whose effort is carried in the per-tier sibling id.
 * `GetUsableModels` ships no `thinkingDetails` and the bundled references read
 * `reasoning: false`, so classification falls back to the id. The non-reasoning
 * `grok-code-*` coding models lack the version digit and stay out.
 */
const CURSOR_GROK_REASONING_ID_PATTERN = /^cursor-grok-\d/i;

/**
 * Model-id families whose native catalogs (anthropic, openai/openai-codex,
 * google) are multimodal. Cursor-only or text-only families (`composer-*`,
 * `grok-code-*`) intentionally stay outside this pattern.
 */
const CURSOR_MULTIMODAL_ID_PATTERN = /claude|gemini|gpt-|codex/;

const OptionalDisplayNameSchema = type("unknown").pipe(raw => (typeof raw === "string" ? raw : undefined));
const CursorAliasesSchema = type("unknown").pipe(raw => {
	if (Array.isArray(raw)) {
		return raw.filter((alias: unknown): alias is string => typeof alias === "string");
	}
	return [];
});

const CursorModelDetailsSchema = type({
	modelId: "string",
	displayName: OptionalDisplayNameSchema.default(undefined),
	displayNameShort: OptionalDisplayNameSchema.default(undefined),
	displayModelId: OptionalDisplayNameSchema.default(undefined),
	aliases: CursorAliasesSchema.default(() => []),
	"thinkingDetails?": "unknown",
	maxMode: "boolean = false",
});

const CursorModelsInnerSchema = type("unknown[]");
const ResilientCursorModelsSchema = type("unknown").pipe(raw => {
	const out = CursorModelsInnerSchema(raw);
	return out instanceof type.errors ? [] : out;
});

const CursorDecodedResponseSchema = type({
	models: ResilientCursorModelsSchema.default(() => []),
});

type CursorModelDetailsValue = typeof CursorModelDetailsSchema.infer;

/**
 * Options for fetching dynamic Cursor models from `GetUsableModels`.
 */
export interface CursorModelDiscoveryOptions {
	/** Cursor access token used for bearer authentication. */
	apiKey: string;
	/** Optional Cursor API base URL override. */
	baseUrl?: string;
	/** Optional client version override sent as `x-cursor-client-version`; defaults to the catalog-local CLI version. */
	clientVersion?: string;
	/** Optional request timeout in milliseconds. */
	timeoutMs?: number;
	/** Optional list of custom Cursor model ids to include in request context. */
	customModelIds?: string[];
}

/**
 * Fetches Cursor models through `GetUsableModels` and normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchCursorUsableModels(
	options: CursorModelDiscoveryOptions,
): Promise<ModelSpec<"cursor-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	try {
		const requestPayload = create(GetUsableModelsRequestSchema, {
			customModelIds: normalizeCustomModelIds(options.customModelIds),
		});
		const body = toBinary(GetUsableModelsRequestSchema, requestPayload);
		const baseUrl = (options.baseUrl ?? CURSOR_DEFAULT_BASE_URL).replace(/\/+$/, "");

		const responseBuffer = await fetchViaHttp2(baseUrl, body, options, timeoutMs);

		if (!responseBuffer) {
			return null;
		}
		const decoded = decodeGetUsableModelsResponse(responseBuffer);
		const parsedDecoded = CursorDecodedResponseSchema(decoded);
		if (parsedDecoded instanceof type.errors) {
			return null;
		}

		const references = createCursorReferenceMap();
		return normalizeCursorModels(parsedDecoded.models, options.baseUrl, references);
	} catch {
		return null;
	}
}

/**
 * Build the unary `GetUsableModels` request headers on the wire values Cursor
 * expects. Kept catalog-local so discovery never imports the AI package's
 * transport at runtime.
 */
function buildCursorUnaryHeaders(apiKey: string, clientVersion: string | undefined): Record<string, string> {
	return {
		"content-type": "application/proto",
		te: "trailers",
		authorization: `Bearer ${apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": clientVersion ?? CURSOR_DEFAULT_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
	};
}

/**
 * Minimal catalog-local pooled HTTP/2 owner for the unary `GetUsableModels`
 * RPC. Catalog must not import the AI package's transport at runtime — that
 * forms a `pi-catalog` ⇄ `pi-ai` cycle and can break standalone `pi-catalog`
 * module resolution — so discovery owns this tiny pool. It reuses one live
 * session per normalized base URL, shares an in-flight connect, drains on
 * GOAWAY/error, and unrefs an idle session so a short-lived catalog consumer is
 * never pinned open. No proxy tunneling: catalog has no sanctioned lower-level
 * proxy helper and adding one is outside this fix.
 */
interface CursorH2Lease {
	readonly request: http2.ClientHttp2Stream;
	release(): void;
}

interface CursorH2PoolEntry {
	session: http2.ClientHttp2Session;
	outstanding: number;
	draining: boolean;
	referenced: boolean;
}

/** Normalized origin → live (non-draining) session with its lease count. */
const cursorH2Pool = new Map<string, CursorH2PoolEntry>();
/** Normalized origin → in-flight connect shared by concurrent acquisitions. */
const cursorH2Connecting = new Map<string, Promise<CursorH2PoolEntry | null>>();
/**
 * Disposal epoch. A connect that began under one generation must not publish a
 * session after a later disposal cleared the pool; the connect handler discards
 * its session when the generation no longer matches.
 */
let cursorH2Generation = 0;
/** One-shot test gate awaited immediately before `http2.connect`. */
let cursorH2EstablishBodyGate: ((key: string) => Promise<void>) | undefined;

function destroyCursorH2Session(session: http2.ClientHttp2Session): void {
	try {
		session.destroy();
	} catch {
		/* session already gone */
	}
}

/**
 * Mark an entry draining: stop issuing new streams (drop it from the pool) and,
 * when nothing is outstanding, destroy it now. A still-leased session is
 * destroyed by its final release. Identity-checked so a stale GOAWAY/error
 * callback can never evict a replacement entry sharing the key.
 */
function drainCursorH2Entry(key: string, entry: CursorH2PoolEntry): void {
	entry.draining = true;
	if (cursorH2Pool.get(key) === entry) cursorH2Pool.delete(key);
	if (entry.outstanding === 0) destroyCursorH2Session(entry.session);
}

/** Drop one lease; destroy a drained session or unref an idle one at zero. */
function releaseCursorH2Entry(key: string, entry: CursorH2PoolEntry): void {
	entry.outstanding--;
	if (entry.outstanding > 0) return;
	if (entry.draining) {
		if (cursorH2Pool.get(key) === entry) cursorH2Pool.delete(key);
		destroyCursorH2Session(entry.session);
		return;
	}
	// Idle: unref so the pooled session never pins a short-lived consumer.
	entry.session.unref();
	entry.referenced = false;
}

function issueCursorH2Lease(
	key: string,
	entry: CursorH2PoolEntry,
	headers: Record<string, string>,
	signal: AbortSignal,
): CursorH2Lease | null {
	// Ref before issuing the stream so the session outlives the request even
	// after a prior lease unref'd it while idle.
	if (!entry.referenced) {
		entry.session.ref();
		entry.referenced = true;
	}
	entry.outstanding++;
	let request: http2.ClientHttp2Stream;
	try {
		request = entry.session.request({ ...headers, ":method": "POST", ":path": CURSOR_GET_USABLE_MODELS_PATH });
	} catch {
		// Synchronous stream-creation failure must not strand the reserved slot
		// or leave a just-connected idle session referenced.
		releaseCursorH2Entry(key, entry);
		return null;
	}

	let released = false;
	const onAbort = (): void => release();
	function release(): void {
		if (released) return;
		released = true;
		signal.removeEventListener("abort", onAbort);
		releaseCursorH2Entry(key, entry);
		try {
			request.destroy();
		} catch {
			/* already closed */
		}
	}
	signal.addEventListener("abort", onAbort, { once: true });
	// Aborted in the window between request creation and listener install.
	if (signal.aborted) release();
	return { request, release };
}

function establishCursorH2Session(key: string, origin: string): Promise<CursorH2PoolEntry | null> {
	const generation = cursorH2Generation;
	const { promise, resolve } = Promise.withResolvers<CursorH2PoolEntry | null>();
	const run = async (): Promise<void> => {
		if (cursorH2EstablishBodyGate) {
			const gate = cursorH2EstablishBodyGate;
			cursorH2EstablishBodyGate = undefined;
			await gate(key);
		}
		if (cursorH2Generation !== generation) {
			resolve(null);
			return;
		}
		let session: http2.ClientHttp2Session;
		try {
			session = http2.connect(origin);
		} catch {
			resolve(null);
			return;
		}
		let settled = false;
		const settle = (value: CursorH2PoolEntry | null): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const entry: CursorH2PoolEntry = { session, outstanding: 0, draining: false, referenced: false };
		session.on("goaway", () => drainCursorH2Entry(key, entry));
		session.on("error", () => {
			if (settled) {
				drainCursorH2Entry(key, entry);
				return;
			}
			destroyCursorH2Session(session);
			settle(null);
		});
		const publish = (): void => {
			if (cursorH2Generation !== generation) {
				destroyCursorH2Session(session);
				settle(null);
				return;
			}
			session.unref();
			entry.referenced = false;
			cursorH2Pool.set(key, entry);
			settle(entry);
		};
		session.once("connect", publish);
		if (!session.connecting && !session.destroyed) publish();
	};
	void run();
	return promise;
}

async function acquireCursorH2(
	baseUrl: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<CursorH2Lease | null> {
	let key: string;
	try {
		key = new URL(baseUrl).origin;
	} catch {
		return null;
	}
	if (signal.aborted) return null;
	const existing = cursorH2Pool.get(key);
	if (existing && !existing.draining && !existing.session.destroyed) {
		return issueCursorH2Lease(key, existing, headers, signal);
	}
	let inFlight = cursorH2Connecting.get(key);
	if (!inFlight) {
		const connect = establishCursorH2Session(key, key).finally(() => {
			if (cursorH2Connecting.get(key) === connect) cursorH2Connecting.delete(key);
		});
		inFlight = connect;
		cursorH2Connecting.set(key, connect);
	}
	// Bound the wait by the caller's timeout without cancelling a shared
	// in-flight connect another acquisition still depends on.
	const { promise: wait, resolve: finishWait } = Promise.withResolvers<CursorH2PoolEntry | null>();
	const onAbort = (): void => finishWait(null);
	signal.addEventListener("abort", onAbort, { once: true });
	void inFlight.then(finishWait, () => finishWait(null));
	const entry = await wait;
	signal.removeEventListener("abort", onAbort);
	if (!entry) return null;
	const live = cursorH2Pool.get(key);
	if (!live || live.draining || live.session.destroyed) return null;
	return issueCursorH2Lease(key, live, headers, signal);
}

/**
 * Destroys every pooled session and clears the pool. Intentional disposal seam
 * for embedders that want deterministic teardown and for tests to reset the
 * module-level singleton between cases. Idle sessions are already unref'd, so
 * calling this is optional in normal operation.
 */
export function disposeCursorDiscoveryHttp2Pool(): void {
	cursorH2Generation++;
	cursorH2Connecting.clear();
	for (const entry of cursorH2Pool.values()) {
		entry.draining = true;
		destroyCursorH2Session(entry.session);
	}
	cursorH2Pool.clear();
}

/**
 * Test seam: per-key pool introspection. `referenced` is derived from the
 * pool's own ref/unref bookkeeping so tests can assert idle unref without
 * exposing the internal session object.
 */
export function __cursorDiscoveryHttp2Snapshot(): Array<{
	key: string;
	outstanding: number;
	draining: boolean;
	referenced: boolean;
}> {
	return [...cursorH2Pool.entries()].map(([key, entry]) => ({
		key,
		outstanding: entry.outstanding,
		draining: entry.draining,
		referenced: entry.referenced,
	}));
}

/**
 * Test seam: one-shot gate awaited immediately before `http2.connect` so a
 * test can abort the caller while handshake is still pending.
 */
export function __setCursorDiscoveryHttp2EstablishBodyGate(fn: ((key: string) => Promise<void>) | undefined): void {
	cursorH2EstablishBodyGate = fn;
}

/** HTTP/2 transport required by Cursor API (HTTP/1.1 is rejected with 464). */
async function fetchViaHttp2(
	baseUrl: string,
	body: Uint8Array,
	options: CursorModelDiscoveryOptions,
	timeoutMs: number,
): Promise<Uint8Array | null> {
	const timeout = AbortSignal.timeout(timeoutMs);
	try {
		const headers = buildCursorUnaryHeaders(options.apiKey, options.clientVersion);
		const lease = await acquireCursorH2(baseUrl, headers, timeout);
		if (!lease) return null;
		return await readUnaryResponse(lease, body, timeout);
	} catch {
		return null;
	}
}

async function readUnaryResponse(
	lease: CursorH2Lease,
	body: Uint8Array,
	signal: AbortSignal,
): Promise<Uint8Array | null> {
	const { request, release } = lease;
	if (request.closed || request.destroyed) {
		release();
		return null;
	}
	const { promise, resolve } = Promise.withResolvers<Uint8Array | null>();
	let settled = false;
	const finish = (value: Uint8Array | null): void => {
		if (settled) return;
		settled = true;
		release();
		resolve(value);
	};
	const chunks: Buffer[] = [];
	request.on("data", (chunk: Buffer) => chunks.push(chunk));
	request.on("end", () => finish(new Uint8Array(Buffer.concat(chunks))));
	request.on("error", () => finish(null));
	request.on("response", (headers: { ":status"?: unknown }) => {
		const status = Number(headers[":status"] ?? 0);
		if (status < 200 || status >= 300) finish(null);
	});
	if (signal.aborted) {
		finish(null);
		return promise;
	}
	signal.addEventListener("abort", () => finish(null), { once: true });
	if (body.length > 0) request.end(Buffer.from(body));
	else request.end();
	return promise;
}

function normalizeCustomModelIds(customModelIds: readonly string[] | undefined): string[] {
	if (!customModelIds) {
		return [];
	}
	const normalized = new Set<string>();
	for (const value of customModelIds) {
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}
		normalized.add(trimmed);
	}
	return [...normalized];
}

function createCursorReferenceMap(): Map<string, ModelSpec<"cursor-agent">> {
	const references = new Map<string, ModelSpec<"cursor-agent">>();
	for (const model of getBundledModels("cursor")) {
		references.set(model.id, toModelSpec(model as Model<"cursor-agent">));
	}
	return references;
}

function decodeGetUsableModelsResponse(payload: Uint8Array) {
	if (payload.length === 0) {
		return null;
	}

	const framedBody = decodeConnectUnaryBody(payload);
	if (framedBody) {
		try {
			return fromBinary(GetUsableModelsResponseSchema, framedBody);
		} catch {
			return null;
		}
	}

	try {
		return fromBinary(GetUsableModelsResponseSchema, payload);
	} catch {
		return null;
	}
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) {
		return null;
	}

	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset];
		const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
		const messageLength = view.getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) {
			return null;
		}
		const compressionFlagSet = (flags & 0b0000_0001) !== 0;
		if (compressionFlagSet) {
			return null;
		}
		const endStreamFlagSet = (flags & 0b0000_0010) !== 0;
		if (!endStreamFlagSet) {
			return payload.subarray(offset + 5, frameEnd);
		}

		offset = frameEnd;
	}

	return null;
}

function normalizeCursorModels(
	models: readonly unknown[] | undefined,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
): ModelSpec<"cursor-agent">[] {
	if (!models || models.length === 0) {
		return [];
	}

	const byId = new Map<string, ModelSpec<"cursor-agent">>();
	for (const model of models) {
		const normalized = normalizeCursorModel(model, baseUrlOverride, references);
		if (!normalized) {
			continue;
		}
		byId.set(normalized.id, normalized);
	}

	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCursorModel(
	model: unknown,
	baseUrlOverride: string | undefined,
	references: Map<string, ModelSpec<"cursor-agent">>,
): ModelSpec<"cursor-agent"> | null {
	const parsedModel = CursorModelDetailsSchema(model);
	if (parsedModel instanceof type.errors) {
		return null;
	}

	const details = parsedModel;
	const id = details.modelId.trim();
	if (!id) {
		return null;
	}

	const name = pickModelDisplayName(details, id);
	const reference = references.get(id);
	const reasoning =
		isKimiK3ModelId(id) ||
		CURSOR_GROK_REASONING_ID_PATTERN.test(id) ||
		Boolean(details.thinkingDetails) ||
		reference?.reasoning === true;

	if (reference) {
		return {
			...reference,
			id,
			name,
			baseUrl: baseUrlOverride ?? reference.baseUrl,
			reasoning,
			contextWindow: resolveCursorContextWindow(details, id, reference.contextWindow),
			cursorMaxMode: details.maxMode,
		};
	}
	return {
		id,
		name,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: baseUrlOverride ?? CURSOR_DEFAULT_BASE_URL,
		reasoning,
		input: inferInputFromCursorId(id),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: resolveCursorContextWindow(details, id, DEFAULT_CONTEXT_WINDOW),
		maxTokens: DEFAULT_MAX_TOKENS,
		cursorMaxMode: details.maxMode,
	};
}

/**
 * Context window for a discovered Cursor model: the 1M ceiling when any 1M
 * signal fires (never below a larger bundled reference), else the fallback.
 */
function resolveCursorContextWindow(
	model: CursorModelDetailsValue,
	id: string,
	fallback: number | null,
): number | null {
	const labeled1M =
		CURSOR_1M_NAME_PATTERN.test(id) ||
		[model.displayName, model.displayNameShort, model.displayModelId, ...model.aliases].some(
			candidate => typeof candidate === "string" && CURSOR_1M_NAME_PATTERN.test(candidate),
		);
	if (labeled1M || isCursorNative1MModelId(id) || (model.maxMode && CURSOR_MAX_MODE_1M_ID_PATTERN.test(id))) {
		return Math.max(fallback ?? 0, CURSOR_1M_CONTEXT_WINDOW);
	}
	return fallback;
}

/**
 * Natively 1M-context families Cursor serves without a "1M" label: Kimi K3 and
 * GLM 5.2+ coding SKUs. The shared family parsers cover namespace forms
 * (`moonshotai/kimi-k3`, `z-ai/glm-5.2`) and future GLM versions (`glm-5.10`,
 * `glm-6`); vision and sub-1M variants stay out via the same gates as
 * `isGlm52ReasoningEffortModelId`.
 */
function isCursorNative1MModelId(id: string): boolean {
	if (isKimiK3ModelId(id) || CURSOR_KIMI_K3_BARE_ID_PATTERN.test(id)) {
		return true;
	}
	const glm = parseGlmModel(bareModelId(id));
	if (!glm || glm.vision) {
		return false;
	}
	if (glm.variant !== "base" && glm.variant !== "air" && glm.variant !== "turbo") {
		return false;
	}
	return semverGte(glm.version, "5.2");
}

function pickModelDisplayName(model: CursorModelDetailsValue, fallbackId: string): string {
	const candidates = [model.displayName, model.displayNameShort, model.displayModelId, ...model.aliases, fallbackId];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return fallbackId;
}

/**
 * Infers input modalities for Cursor models without a bundled reference.
 *
 * `GetUsableModels` carries no per-model modality metadata, so classification
 * falls back to the model family: families that are multimodal in OMP's own
 * native catalogs accept images, everything else stays text-only. Mirrors
 * `inferInputFromGeminiId` in ./gemini.ts.
 */
function inferInputFromCursorId(id: string): ("text" | "image")[] {
	if (CURSOR_MULTIMODAL_ID_PATTERN.test(id.toLowerCase())) {
		return ["text", "image"];
	}
	return ["text"];
}
