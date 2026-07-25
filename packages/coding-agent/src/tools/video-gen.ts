import { type ApiKey, type FetchImpl, getEnvApiKey, type Model, withAuth } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { ModelRegistry } from "../config/model-registry";
import type { AgentToolUpdateCallback, CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { ohMyPiXAIUserAgent, resolveXAIHttpCredentials } from "../lib/xai-http";
import videoGenDescription from "../prompts/tools/video-gen.md" with { type: "text" };
import { resolveImageReferenceUrl } from "./media-input";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";
import { shortenPath } from "./render-utils";
import { AUTO_VIDEO_PROVIDER_ORDER, isVideoProviderId, type VideoProvider } from "./video-providers";

const DEFAULT_XAI_VIDEO_MODEL = "grok-imagine-video";
/**
 * xAI's only 1080p-capable video model, and it is image-to-video only. Verified
 * against api.x.ai: `grok-imagine-video` rejects 1080p ("1080p video resolution
 * is not available for this model") and this model rejects text-only prompts
 * ("Text-to-video is not supported for this model").
 */
const XAI_1080P_VIDEO_MODEL = "grok-imagine-video-1.5";
/** Stand-in id for a job the provider confirmed but would not name. */
const UNKNOWN_JOB_ID = "unknown";
// OpenRouter brokers a dozen video models with no house default; Veo 3.1 Fast is
// the cheapest entry that covers both 720p and 1080p across the common ratios.
const DEFAULT_OPENROUTER_VIDEO_MODEL = "google/veo-3.1-fast";
const OPENROUTER_VIDEO_URL = "https://openrouter.ai/api/v1/videos";

/**
 * Whole-job fence. xAI documents "up to several minutes" and scales with
 * duration/resolution; OpenRouter brokers slower third-party backends and its
 * own sample polls on a 30 s cadence. 20 minutes covers the worst documented
 * case without letting a wedged job pin a session forever.
 */
const VIDEO_TIMEOUT = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
/** xAI reports request cost in ticks; 1 USD = 10^10 ticks (docs.x.ai/developers/cost-tracking). */
const USD_TICKS_PER_DOLLAR = 10_000_000_000;

const VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const VIDEO_PROVIDER_REQUEST_CHOICES = ["auto", ...AUTO_VIDEO_PROVIDER_ORDER] as const;

export type VideoProviderPreference = VideoProvider | "auto";

export const videoGenSchema = type({
	prompt: type("string").describe("motion description: subject, action, camera move, lighting, style"),
	output_path: type("string").describe("path to write the finished .mp4 to"),
	"image?": type("string").describe("path or https URL of a still image to animate (image-to-video)"),
	"duration?": type("1 <= number.integer <= 15").describe(
		"whole seconds of output video; omitted means the provider's own default",
	),
	"aspect_ratio?": type
		.enumerated(...VIDEO_ASPECT_RATIOS)
		.describe("aspect ratio; omitted means the provider's own default"),
	"resolution?": type
		.enumerated(...VIDEO_RESOLUTIONS)
		.describe("output resolution; omitted means the provider's own default"),
	"model?": type("string").describe("provider-specific model id; overrides the provider default"),
	"provider?": type
		.enumerated(...VIDEO_PROVIDER_REQUEST_CHOICES)
		.describe("video provider for this request; overrides the providers.videoOrder setting"),
});

export type VideoGenParams = typeof videoGenSchema.infer;

export interface VideoGenToolDetails {
	provider: VideoProvider;
	model: string;
	videoPath: string;
	bytes: number;
	requestId: string;
	durationSeconds?: number;
	costUsd?: number;
}

/** A finished provider job, normalized across the two backends. */
interface VideoJobResult {
	/** Temporary provider-hosted URL the finished video must be pulled from. */
	url: string;
	/**
	 * Credential the download must present, when the URL is not self-authenticating.
	 * xAI hands back a presigned `vidgen.x.ai` URL that must stay bare — sending
	 * credentials to that host is both unnecessary and a token leak. OpenRouter's
	 * `unsigned_urls` are, per the name, NOT presigned: they are API paths that
	 * 401 without the bearer token (the vendor's own docs sample fetches them
	 * unauthenticated and is wrong).
	 */
	downloadApiKey?: ApiKey;
	requestId: string;
	durationSeconds?: number;
	costUsd?: number;
}

/**
 * Raised once a provider has accepted a job.
 *
 * From that moment the generation is running and billing regardless of what
 * fails afterwards, so the tool MUST surface this rather than advance the
 * provider chain — a retry on another backend charges for a second video and
 * returns different output. Pre-submission failures stay ordinary errors and
 * still fall through.
 */
class VideoJobCommittedError extends Error {
	constructor(
		readonly provider: VideoProvider,
		readonly requestId: string,
		cause: unknown,
	) {
		super(`job ${requestId} failed after submission: ${cause instanceof Error ? cause.message : String(cause)}`, {
			cause,
		});
		this.name = "VideoJobCommittedError";
	}
}

/** Configured provider priority set via `providers.videoOrder` (default: none). */
let configuredVideoProviderOrder: readonly VideoProvider[] = [];

export function isVideoProviderPreference(value: unknown): value is VideoProviderPreference {
	return value === "auto" || isVideoProviderId(value);
}

/** Set the configured video-provider priority from settings; invalid IDs are dropped. */
export function setVideoProviderOrder(providers: readonly string[]): void {
	configuredVideoProviderOrder = providers.filter(isVideoProviderId);
}

function activeVideoProvider(model: Model | undefined): VideoProvider | null {
	switch (model?.provider) {
		case "xai":
		case "xai-oauth":
			return "xai";
		case "openrouter":
			return "openrouter";
		default:
			return null;
	}
}

/**
 * Resolve the provider attempt order.
 *
 * An explicit `provider`, or an explicit `model`, PINS the request to a single
 * backend instead of seeding a fallback chain — unlike `generate_image`, whose
 * providers are interchangeable and effectively free to retry. Video is billed
 * per second of output and model ids are provider-namespaced (`grok-imagine-video`
 * vs `x-ai/grok-imagine-video`), so falling through would either 404 on a bare id
 * or silently bill a differently-priced backend the caller did not choose.
 */
function videoProviderOrder(
	activeModel: Model | undefined,
	requested: VideoProviderPreference | undefined,
	explicitModelId: string | undefined,
): VideoProvider[] {
	if (requested !== undefined && requested !== "auto") return [requested];
	// OpenRouter slugs are `vendor/model`; xAI ids are bare.
	if (explicitModelId) return [explicitModelId.includes("/") ? "openrouter" : "xai"];

	const providers: VideoProvider[] = [];
	const added = new Set<VideoProvider>();
	const add = (provider: VideoProvider | null): void => {
		if (!provider || added.has(provider)) return;
		added.add(provider);
		providers.push(provider);
	};

	// Configured priority list first, then the active session's provider, then
	// the built-in auto order.
	for (const provider of configuredVideoProviderOrder) add(provider);
	add(activeVideoProvider(activeModel));
	for (const provider of AUTO_VIDEO_PROVIDER_ORDER) add(provider);
	return providers;
}

/**
 * Sleep between polls without outliving the job fence. `untilAborted` rejects
 * the tool call the moment the caller aborts, but a bare sleep would still hold
 * a timer past that point — race it against the signal so the loop unwinds.
 */
function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	function onAbort(): void {
		clearTimeout(timer);
		resolve();
	}
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

function reportProgress(
	onUpdate: AgentToolUpdateCallback<VideoGenToolDetails, VideoGenParams> | undefined,
	provider: VideoProvider,
	model: string,
	status: string,
	progress: number | undefined,
): void {
	if (!onUpdate) return;
	const pct = typeof progress === "number" ? ` ${Math.round(progress)}%` : "";
	onUpdate({ content: [{ type: "text", text: `${provider}/${model}: ${status}${pct}` }] });
}

async function readErrorMessage(response: Response): Promise<string> {
	const rawText = await response.text();
	try {
		const parsed = JSON.parse(rawText) as { error?: { message?: string } | string };
		if (typeof parsed.error === "string") return parsed.error;
		if (parsed.error?.message) return parsed.error.message;
	} catch {
		// Keep raw text.
	}
	return rawText.slice(0, 300);
}
/** Consecutive transient poll failures tolerated before abandoning a running job. */
export const MAX_POLL_FAILURES = 5;

/**
 * Polls a provider job endpoint for one generation.
 *
 * A submitted job is already running and already billed, so a transient
 * 429/5xx/network blip must not throw it away — those are retried against a
 * budget while `VIDEO_TIMEOUT` fences the loop overall. Terminal statuses
 * (any other 4xx) and an exhausted budget still fail fast.
 *
 * Each poll carries its own `withAuth`. That scoping is load-bearing: a poll is
 * an idempotent GET, so rotating a credential and reissuing it is free, whereas
 * wrapping submission and polling in one `withAuth` would let a mid-job 401
 * replay the submission and start a second paid generation.
 */
export class VideoJobPoller {
	#failures = 0;

	constructor(
		private readonly label: string,
		private readonly apiKey: ApiKey,
		private readonly buildHeaders: (key: string) => Record<string, string>,
		private readonly fetchImpl: FetchImpl,
		private readonly signal: AbortSignal,
	) {}

	/** Job state, or `null` when a transient failure was absorbed — poll again. */
	async poll<T>(url: string): Promise<T | null> {
		return withAuth(this.apiKey, key => this.#pollOnce<T>(url, key), { signal: this.signal });
	}

	async #pollOnce<T>(url: string, key: string): Promise<T | null> {
		let response: Response;
		try {
			response = await this.fetchImpl(url, { headers: this.buildHeaders(key), signal: this.signal });
		} catch (error) {
			this.signal.throwIfAborted();
			if (++this.#failures > MAX_POLL_FAILURES) throw error;
			logger.warn("Video job poll errored, retrying", { label: this.label, failures: this.#failures });
			return null;
		}
		if (response.ok) {
			this.#failures = 0;
			return (await response.json()) as T;
		}

		const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
		const message = await readErrorMessage(response);
		if (retryable && ++this.#failures <= MAX_POLL_FAILURES) {
			logger.warn("Video job poll failed, retrying", {
				label: this.label,
				status: response.status,
				failures: this.#failures,
			});
			return null;
		}
		throw new ProviderHttpError(`${this.label} video poll failed (${response.status}): ${message}`, response.status, {
			headers: response.headers,
		});
	}
}

interface XAIVideoStatus {
	status?: string;
	progress?: number;
	model?: string;
	video?: { url?: string; duration?: number };
	error?: { message?: string };
	usage?: { cost_in_usd_ticks?: number };
}

/**
 * Statuses docs.x.ai documents as terminal failures. Membership is checked
 * against provider-supplied strings, so this is a Set rather than a record —
 * an object index would resolve `constructor`/`toString` off the prototype.
 */
const XAI_FAILED_STATUSES: ReadonlySet<string> = new Set(["failed", "expired", "cancelled", "canceled"]);

/**
 * POST a generation request under `withAuth`.
 *
 * HTTP 200 is the commit point: a job now exists and is billing per second.
 * Everything from that response onward — including a body that will not parse —
 * is raised as `VideoJobCommittedError`, so it can neither be replayed by a
 * credential rotation nor fall through into a second billed generation.
 *
 * Failures before the 200 stay ordinary errors and may fall through to another
 * provider. That includes transport rejections, which are strictly speaking
 * ambiguous — a socket can die after the server accepted the job. Treating them
 * as committed was considered and rejected: a rejected `fetch` overwhelmingly
 * means nothing was accepted, the alternative turns any unreachable provider
 * into a hard tool failure instead of a fallback, and the errno detail needed to
 * tell the two apart is runtime-specific and cannot be verified against the real
 * providers. The residual exposure is one lost response on an accepted job.
 */
async function submitVideoJob<T>(
	provider: VideoProvider,
	label: string,
	apiKey: ApiKey,
	url: string,
	body: unknown,
	buildHeaders: (key: string) => Record<string, string>,
	fetchImpl: FetchImpl,
	signal: AbortSignal,
): Promise<T> {
	return withAuth(
		apiKey,
		async key => {
			const submit = await fetchImpl(url, {
				method: "POST",
				headers: buildHeaders(key),
				body: JSON.stringify(body),
				signal,
			});
			if (!submit.ok) {
				throw new ProviderHttpError(
					`${label} video request failed (${submit.status}): ${await readErrorMessage(submit)}`,
					submit.status,
					{ headers: submit.headers },
				);
			}
			try {
				return (await submit.json()) as T;
			} catch (error) {
				throw new VideoJobCommittedError(provider, UNKNOWN_JOB_ID, error);
			}
		},
		{ signal },
	);
}

function xaiHeaders(key: string): Record<string, string> {
	return {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
		"User-Agent": ohMyPiXAIUserAgent(),
	};
}

async function generateXaiVideo(
	apiKey: ApiKey,
	baseUrl: string,
	model: string,
	params: VideoGenParams,
	imageUrl: string | undefined,
	fetchImpl: FetchImpl,
	signal: AbortSignal,
	onUpdate: AgentToolUpdateCallback<VideoGenToolDetails, VideoGenParams> | undefined,
): Promise<VideoJobResult> {
	const body: Record<string, unknown> = { model, prompt: params.prompt };
	if (params.duration !== undefined) body.duration = params.duration;
	if (params.aspect_ratio !== undefined) body.aspect_ratio = params.aspect_ratio;
	if (params.resolution !== undefined) body.resolution = params.resolution;
	if (imageUrl) body.image = { url: imageUrl };

	const submitted = await submitVideoJob<{ request_id?: string }>(
		"xai",
		"xAI",
		apiKey,
		`${baseUrl}/videos/generations`,
		body,
		xaiHeaders,
		fetchImpl,
		signal,
	);
	const requestId = submitted.request_id;
	if (typeof requestId !== "string" || requestId.length === 0) {
		throw new VideoJobCommittedError(
			"xai",
			UNKNOWN_JOB_ID,
			new Error("xAI accepted the request but returned no request_id."),
		);
	}

	// Past this point the generation is billing, so every failure is reported
	// against this job rather than retried on another provider.
	try {
		// Poll until terminal. `pending` arrives as HTTP 202 and `done` as 200 —
		// both are successful transports, so status lives in the body, not the code.
		const poller = new VideoJobPoller("xAI", apiKey, xaiHeaders, fetchImpl, signal);
		for (;;) {
			const status = await poller.poll<XAIVideoStatus>(`${baseUrl}/videos/${requestId}`);
			if (!status) {
				await sleepUntilAborted(POLL_INTERVAL_MS, signal);
				signal.throwIfAborted();
				continue;
			}
			if (status.status === "done") {
				const url = status.video?.url;
				if (typeof url !== "string" || url.length === 0) {
					throw new Error("xAI reported a finished video with no URL.");
				}
				const ticks = status.usage?.cost_in_usd_ticks;
				return {
					url,
					requestId,
					// Providers may send `null` here; `null !== undefined` would slip past
					// the presence checks in the summary and render "duration=nulls".
					durationSeconds: typeof status.video?.duration === "number" ? status.video.duration : undefined,
					costUsd: typeof ticks === "number" ? ticks / USD_TICKS_PER_DOLLAR : undefined,
				};
			}
			// Only abandon the job on a status documented as terminal. Treating every
			// unrecognised value as failure would kill a running, billing generation
			// the first time the provider adds a state such as `queued`.
			if (status.status && XAI_FAILED_STATUSES.has(status.status)) {
				const detail = status.error?.message ? `: ${status.error.message}` : "";
				throw new Error(`xAI video generation ${status.status}${detail}`);
			}
			reportProgress(onUpdate, "xai", model, "generating", status.progress);
			await sleepUntilAborted(POLL_INTERVAL_MS, signal);
			signal.throwIfAborted();
		}
	} catch (error) {
		throw new VideoJobCommittedError("xai", requestId, error);
	}
}

interface OpenRouterVideoStatus {
	status?: string;
	unsigned_urls?: string[];
	progress?: number;
	error?: { message?: string } | string;
	usage?: { cost?: number };
}

/**
 * Terminal success states across OpenRouter's brokered backends. A Set, not a
 * record: the key comes from the provider, and an object index would resolve
 * `constructor`/`toString` off the prototype and declare the job complete.
 */
const OPENROUTER_DONE_STATUSES: ReadonlySet<string> = new Set(["completed", "succeeded", "done"]);

function openRouterHeaders(key: string): Record<string, string> {
	return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function generateOpenRouterVideo(
	apiKey: ApiKey,
	model: string,
	params: VideoGenParams,
	imageUrl: string | undefined,
	fetchImpl: FetchImpl,
	signal: AbortSignal,
	onUpdate: AgentToolUpdateCallback<VideoGenToolDetails, VideoGenParams> | undefined,
): Promise<VideoJobResult> {
	const body: Record<string, unknown> = { model, prompt: params.prompt };
	if (params.duration !== undefined) body.duration = params.duration;
	if (params.aspect_ratio !== undefined) body.aspect_ratio = params.aspect_ratio;
	if (params.resolution !== undefined) body.resolution = params.resolution;
	// Image-to-video is `frame_images` with an explicit frame slot; the bare
	// `{ url }` shape xAI accepts is not what OpenRouter's API takes.
	if (imageUrl) {
		body.frame_images = [{ type: "image_url", image_url: { url: imageUrl }, frame_type: "first_frame" }];
	}

	const submitted = await submitVideoJob<{ id?: string; polling_url?: string }>(
		"openrouter",
		"OpenRouter",
		apiKey,
		OPENROUTER_VIDEO_URL,
		body,
		openRouterHeaders,
		fetchImpl,
		signal,
	);
	const requestId = submitted.id;
	if (typeof requestId !== "string" || requestId.length === 0) {
		// Submit returned 200, so a job exists and is billing even though the
		// response is unusable — commit rather than retry on another provider.
		throw new VideoJobCommittedError(
			"openrouter",
			UNKNOWN_JOB_ID,
			new Error("OpenRouter accepted the request but returned no job id."),
		);
	}
	const pollingUrl = submitted.polling_url ?? `${OPENROUTER_VIDEO_URL}/${requestId}`;
	try {
		const poller = new VideoJobPoller("OpenRouter", apiKey, openRouterHeaders, fetchImpl, signal);
		for (;;) {
			const status = await poller.poll<OpenRouterVideoStatus>(pollingUrl);
			if (!status) {
				await sleepUntilAborted(POLL_INTERVAL_MS, signal);
				signal.throwIfAborted();
				continue;
			}
			const state = status.status ?? "pending";
			if (OPENROUTER_DONE_STATUSES.has(state)) {
				const url = status.unsigned_urls?.[0];
				if (typeof url !== "string" || url.length === 0) {
					throw new Error("OpenRouter reported a finished video with no URL.");
				}
				// A `null` cost would survive the `!== undefined` guard in the summary
				// and crash on `.toFixed()` after the video is already on disk.
				const cost = status.usage?.cost;
				return {
					url,
					requestId,
					downloadApiKey: apiKey,
					costUsd: typeof cost === "number" ? cost : undefined,
				};
			}
			if (state === "failed" || state === "cancelled" || state === "expired") {
				const message = typeof status.error === "string" ? status.error : status.error?.message;
				throw new Error(`OpenRouter video generation ${state}${message ? `: ${message}` : ""}`);
			}
			reportProgress(onUpdate, "openrouter", model, "generating", status.progress);
			await sleepUntilAborted(POLL_INTERVAL_MS, signal);
			signal.throwIfAborted();
		}
	} catch (error) {
		throw new VideoJobCommittedError("openrouter", requestId, error);
	}
}

/**
 * Pull the finished video.
 *
 * `fetch` resolves auth failures instead of throwing, so a 401/403 is re-raised
 * inside the `withAuth` callback — otherwise rotation never engages and a job
 * that outlived its access token is unrecoverable. The GET is idempotent, so
 * reissuing it with a fresh credential costs nothing.
 */
async function downloadVideo(job: VideoJobResult, fetchImpl: FetchImpl, signal: AbortSignal): Promise<Response> {
	if (!job.downloadApiKey) return fetchImpl(job.url, { signal });
	return withAuth(
		job.downloadApiKey,
		async key => {
			const response = await fetchImpl(job.url, { headers: { Authorization: `Bearer ${key}` }, signal });
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(`video download auth failed (${response.status})`, response.status, {
					headers: response.headers,
				});
			}
			return response;
		},
		{ signal },
	);
}

async function resolveXaiKey(
	modelRegistry: ModelRegistry,
	model: string,
	sessionId: string | undefined,
): Promise<{ apiKey: ApiKey; baseUrl: string } | null> {
	const creds = await resolveXAIHttpCredentials(modelRegistry, model);
	if (!creds) return null;
	return {
		apiKey: modelRegistry.resolver(creds.provider, { sessionId, baseUrl: creds.baseURL }),
		baseUrl: creds.baseURL,
	};
}

async function resolveOpenRouterKey(
	modelRegistry: ModelRegistry | undefined,
	sessionId: string | undefined,
): Promise<ApiKey | null> {
	if (modelRegistry) {
		// AuthStorage.getApiKey already falls back to env keys, so this covers OPENROUTER_API_KEY too.
		const apiKey = await modelRegistry.getApiKeyForProvider("openrouter", sessionId);
		if (apiKey) return modelRegistry.resolver("openrouter", { sessionId });
		return null;
	}
	return getEnvApiKey("openrouter") ?? null;
}

export const videoGenTool: CustomTool<typeof videoGenSchema, VideoGenToolDetails> = {
	name: "generate_video",
	label: "GenerateVideo",
	strict: false,
	approval: "write",
	description: prompt.render(videoGenDescription),
	parameters: videoGenSchema,
	async execute(_toolCallId: string, params: VideoGenParams, onUpdate, ctx: CustomToolContext, signal?: AbortSignal) {
		// Deliberately NOT wrapped in `untilAborted`: racing the whole call means an
		// abort discards whatever this returns, including the job id and recovery
		// URL of a generation that is already billing. Every await below observes
		// `requestSignal` directly, so cancellation still unwinds promptly — it just
		// gets to report which job survived it.
		const cwd = ctx.sessionManager.getCwd();
		const sessionId = ctx.sessionManager.getSessionId();
		const outputPath = resolveToCwd(params.output_path, cwd);
		// `formatPathRelativeToCwd` yields an absolute path when the target sits
		// outside the workspace, which would leak the home directory into the
		// transcript; `shortenPath` renders that as `~/…`.
		const displayPath = shortenPath(formatPathRelativeToCwd(outputPath, cwd));
		// Whole-job fence. Built like tts.ts rather than via `ptree.combineSignals`
		// so the poller and the sleeps get a non-optional AbortSignal.
		const timeoutSignal = AbortSignal.timeout(VIDEO_TIMEOUT);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const fetchImpl = ctx.fetch ?? fetch;

		let imageUrl: string | undefined;
		if (params.image) imageUrl = await resolveImageReferenceUrl(params.image, cwd);

		const failures: string[] = [];
		let foundCredentials = false;

		for (const provider of videoProviderOrder(ctx.model, params.provider, params.model)) {
			let model = params.model ?? (provider === "xai" ? DEFAULT_XAI_VIDEO_MODEL : DEFAULT_OPENROUTER_VIDEO_MODEL);
			// Verified against api.x.ai: `grok-imagine-video` answers a 1080p
			// request with "1080p video resolution is not available for this
			// model", and `grok-imagine-video-1.5` answers a text-only request
			// with "Text-to-video is not supported for this model". So 1080p on
			// xAI is reachable only as image-to-video on 1.5 — pick it when an
			// image is present, and skip the provider rather than fire a request
			// that cannot succeed when one is not.
			if (provider === "xai" && !params.model && params.resolution === "1080p") {
				if (!imageUrl) {
					failures.push("xai: 1080p is image-to-video only (supply `image`, or use 720p)");
					continue;
				}
				model = XAI_1080P_VIDEO_MODEL;
			}
			let job: VideoJobResult;
			try {
				if (provider === "xai") {
					const resolved = await resolveXaiKey(ctx.modelRegistry, model, sessionId);
					if (!resolved) continue;
					foundCredentials = true;
					job = await generateXaiVideo(
						resolved.apiKey,
						resolved.baseUrl,
						model,
						params,
						imageUrl,
						fetchImpl,
						requestSignal,
						onUpdate,
					);
				} else {
					const apiKey = await resolveOpenRouterKey(ctx.modelRegistry, sessionId);
					if (!apiKey) continue;
					foundCredentials = true;
					job = await generateOpenRouterVideo(apiKey, model, params, imageUrl, fetchImpl, requestSignal, onUpdate);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.warn("Video generation provider failed", { provider, model, error: message });
				// A committed job has already billed. Report it instead of running
				// a second paid generation on the next provider.
				if (error instanceof VideoJobCommittedError) {
					// Neither the fence nor a user cancel stops the generation
					// server-side, so say the job is still running rather than
					// implying it was lost — and do not conflate the two causes.
					let text = `${provider} video generation failed. ${message}`;
					if (timeoutSignal.aborted) {
						text = `${provider} job ${error.requestId} is still generating; the tool stopped waiting after ${VIDEO_TIMEOUT / 60_000} minutes. Nothing was re-submitted.`;
					} else if (requestSignal.aborted) {
						text = `${provider} job ${error.requestId} is still generating; the tool call was cancelled. Nothing was re-submitted.`;
					}
					return { isError: true, content: [{ type: "text" as const, text }] };
				}
				failures.push(`${provider}: ${message}`);
				continue;
			}

			// Provider URLs are short-lived; pull the bytes on the same fence.
			let downloadFailure: string | undefined;
			let download: Response | undefined;
			try {
				download = await downloadVideo(job, fetchImpl, requestSignal);
				if (!download.ok) downloadFailure = `HTTP ${download.status}`;
			} catch (error) {
				downloadFailure = error instanceof Error ? error.message : String(error);
			}
			if (downloadFailure !== undefined || !download) {
				// The generation already ran and already billed, so this is terminal:
				// hand back the job id and URL so the bytes can still be fetched by
				// hand, rather than silently paying for a rerun elsewhere.
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `${provider} job ${job.requestId} finished but its download failed (${downloadFailure ?? "no response"}). The video is still retrievable at ${job.url}`,
						},
					],
				};
			}
			// Buffer the body, then write. `Bun.write(path, response)` would stream
			// and avoid holding the clip in memory, but on Bun 1.4.0-canary.1 it
			// never resolves for a fetched Response — reproduced against a real
			// vidgen.x.ai URL with and without an AbortSignal, while the buffered
			// form completed the same download in 73 ms. Mocked Responses do not
			// reproduce it, so keep this path buffered until Bun is fixed.
			let bytes: Uint8Array;
			try {
				bytes = new Uint8Array(await download.arrayBuffer());
				await Bun.write(outputPath, bytes);
			} catch (error) {
				// The video is paid for and still fetchable; a full disk or a bad
				// output_path must not lose the URL.
				const message = error instanceof Error ? error.message : String(error);
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `${provider} job ${job.requestId} downloaded but writing ${displayPath} failed (${message}). The video is still retrievable at ${job.url}`,
						},
					],
				};
			}

			const parts = [`Saved ${bytes.length} bytes to ${displayPath}`, `provider=${provider}`, `model=${model}`];
			if (job.durationSeconds !== undefined) parts.push(`duration=${job.durationSeconds}s`);
			if (job.costUsd !== undefined) parts.push(`cost=$${job.costUsd.toFixed(4)}`);
			return {
				content: [{ type: "text" as const, text: `${parts.join(", ")}.` }],
				details: {
					provider,
					model,
					videoPath: outputPath,
					bytes: bytes.length,
					requestId: job.requestId,
					durationSeconds: job.durationSeconds,
					costUsd: job.costUsd,
				},
			};
		}

		// Only claim "no credentials" when nothing else went wrong; a provider
		// skipped for a concrete reason (unsupported request, submit rejected)
		// must surface that reason instead.
		if (!foundCredentials && failures.length === 0) {
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: "No video generation credentials. Run /login → xAI Grok OAuth (SuperGrok or X Premium+), or set XAI_API_KEY or OPENROUTER_API_KEY.",
					},
				],
			};
		}
		return {
			isError: true,
			content: [{ type: "text" as const, text: `Video generation failed. ${failures.join("; ")}` }],
		};
	},
};
