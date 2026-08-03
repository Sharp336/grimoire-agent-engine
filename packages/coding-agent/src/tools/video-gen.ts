import * as os from "node:os";
import { type ApiKey, type FetchImpl, getEnvApiKey, type Model, withAuth } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { ModelRegistry } from "../config/model-registry";
import type { AgentToolUpdateCallback, CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { isXAIHttpCompatProvider, ohMyPiXAIUserAgent, resolveXAIHttpCredentials } from "../lib/xai-http";
import videoGenDescription from "../prompts/tools/video-gen.md" with { type: "text" };
import { MAX_INLINE_IMAGE_SIZE, resolveImageReferenceUrl, resolveVideoReferenceUrl } from "./media-input";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";
import { replaceTabs, shortenPath } from "./render-utils";
import { AUTO_VIDEO_PROVIDER_ORDER, isVideoProviderId, type VideoProvider } from "./video-providers";

const DEFAULT_XAI_VIDEO_MODEL = "grok-imagine-video";
/**
 * xAI's only 1080p-capable video model, and it is image-to-video only. Verified
 * against api.x.ai: `grok-imagine-video` rejects 1080p ("1080p video resolution
 * is not available for this model") and this model rejects text-only prompts
 * ("Text-to-video is not supported for this model").
 */
const XAI_1080P_VIDEO_MODEL = "grok-imagine-video-1.5";
/**
 * True for the 1.5 family, alias suffixes included (`-preview`, dated builds):
 * they share the model's limits, and matching only the bare id would let an
 * alias slip past the local refusals. The `-` boundary keeps a genuinely
 * different id such as `grok-imagine-video-1.50` out.
 */
function isXai15(model: string): boolean {
	return model === XAI_1080P_VIDEO_MODEL || model.startsWith(`${XAI_1080P_VIDEO_MODEL}-`);
}
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
/**
 * TTL applied to a `store`d result — the documented maximum. Chains finish in
 * minutes, so this is only about not leaving a caller's Files storage growing
 * without bound; docs.x.ai caps `expires_after` at 30 days.
 */
const STORED_VIDEO_TTL_SECONDS = 30 * 24 * 60 * 60;

const VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const VIDEO_MODES = ["generate", "extend", "edit"] as const;
const VIDEO_PROVIDER_REQUEST_CHOICES = ["auto", ...AUTO_VIDEO_PROVIDER_ORDER] as const;

export type VideoProviderPreference = VideoProvider | "auto";
export type VideoMode = (typeof VIDEO_MODES)[number];

export const videoGenSchema = type({
	prompt: type("string").describe("motion description: subject, action, camera move, lighting, style"),
	output_path: type("string").describe("path to write the finished .mp4 to"),
	"mode?": type
		.enumerated(...VIDEO_MODES)
		.describe(
			"generate (default), extend (continue `video` from its last frame), or edit (restyle `video` in place) — extend and edit are xAI-only",
		),
	"image?": type("string").describe(
		"path, http(s) URL, data: URL or xAI `file_...` id of a still image to animate (image-to-video)",
	),
	"video?": type("string").describe(
		"path, http(s) URL, `data:video/mp4;base64,…` URL or xAI `file_...` id of the source clip; required by mode extend and edit",
	),
	"reference_images?": type("string[]").describe(
		"paths, http(s) URLs, data: URLs or xAI `file_...` ids of images whose subjects appear in the video without becoming its first frame (xAI generate mode only)",
	),
	"store?": type("string").describe(
		"filename to persist the result under in xAI Files (expires after 30 days); the reported `file_...` id feeds a later extend/edit with no re-upload (xAI only)",
	),
	"duration?": type("1 <= number.integer <= 15").describe(
		"whole seconds of output video (1-15); in mode extend it sizes the appended segment instead and must be 2-10. omitted means the provider's own default",
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
	mode: VideoMode;
	videoPath: string;
	bytes: number;
	requestId: string;
	durationSeconds?: number;
	costUsd?: number;
	/** xAI Files id, when `store` asked for the result to be persisted. */
	fileId?: string;
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
	/** xAI Files id of the persisted result, when `store` requested one. */
	fileId?: string;
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
	if (!model?.provider) return null;
	if (isXAIHttpCompatProvider(model.provider)) return "xai";
	if (model.provider === "openrouter") return "openrouter";
	return null;
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

/** Upper bound on provider-controlled error text embedded in a tool result. */
const MAX_PROVIDER_MESSAGE_CHARS = 300;

/**
 * Best-effort human message from an error response.
 *
 * Never throws: callers use the result to decide whether a transient status is
 * retryable, so a truncated body on a 502 must not abandon an already-paid job
 * before that decision is reached.
 *
 * The text is provider-controlled and ends up in a rendered tool result, so
 * tabs are flattened and the length is bounded. The cap is deliberately the
 * existing 300 characters rather than a `TRUNCATE_LENGTHS` width: those are TUI
 * line widths, and this string is also read by the model, which needs the
 * provider's actual complaint rather than its first 110 characters.
 */
async function readErrorMessage(response: Response): Promise<string> {
	let rawText: string;
	try {
		rawText = await response.text();
	} catch {
		return `HTTP ${response.status} (unreadable body)`;
	}
	let message = rawText;
	try {
		const parsed = JSON.parse(rawText) as { error?: { message?: string } | string };
		if (typeof parsed.error === "string") message = parsed.error;
		else if (parsed.error?.message) message = parsed.error.message;
	} catch {
		// Keep raw text.
	}
	return replaceTabs(message).slice(0, MAX_PROVIDER_MESSAGE_CHARS);
}

/**
 * Strip the home directory out of a filesystem message. `shortenPath` only
 * rewrites a *leading* home path, while errno messages embed the absolute
 * target mid-string (`ENOSPC: … open '/Users/me/clip.mp4'`).
 */
function redactHome(message: string): string {
	const home = os.homedir();
	return home ? message.replaceAll(home, "~") : message;
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
			// A truncated or otherwise unreadable body is as transient as the fetch
			// failing outright, and the job is still running — spend the budget
			// rather than abandoning a paid generation over one bad response.
			let parsed: T;
			try {
				parsed = (await response.json()) as T;
			} catch (error) {
				if (++this.#failures > MAX_POLL_FAILURES) throw error;
				logger.warn("Video job poll body unreadable, retrying", {
					label: this.label,
					failures: this.#failures,
				});
				return null;
			}
			this.#failures = 0;
			return parsed;
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

/** Files API receipt returned when a request carried `storage_options`. */
interface XAIFileOutput {
	file_id?: string;
}

interface XAIVideoStatus {
	status?: string;
	progress?: number;
	model?: string;
	video?: { url?: string; duration?: number; file_output?: XAIFileOutput };
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
 * Dispatching the POST is the commit point, not the 200 that may follow. Once
 * the request is on the wire the tool can no longer prove a job was NOT created
 * — a socket that dies mid-flight looks identical whether the server never saw
 * the request or accepted and billed it — so every failure from the `fetch`
 * onward is raised as `VideoJobCommittedError`. That keeps a credential
 * rotation from replaying the submission and keeps the provider loop from
 * buying a second video on another backend.
 *
 * Failing closed costs a fallback: an unreachable provider ends the call
 * instead of quietly trying the next one, and the caller retries with an
 * explicit `provider`. That is the cheap direction to be wrong in — a lost
 * fallback is one retry, a duplicate generation is money already spent.
 *
 * An HTTP error response is the exception: the server answered, so nothing was
 * created. Those stay ordinary errors and may fall through to another provider.
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
			let submit: Response;
			try {
				submit = await fetchImpl(url, {
					method: "POST",
					headers: buildHeaders(key),
					body: JSON.stringify(body),
					signal,
				});
			} catch (error) {
				throw new VideoJobCommittedError(provider, UNKNOWN_JOB_ID, error);
			}
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

/**
 * One media input as the Imagine endpoints accept it: either a URL (https or
 * inlined data) or a Files API id, never both.
 */
type XaiMediaRef = { url: string } | { file_id: string };

/** Media inputs already resolved to their request-body shape. */
interface ResolvedVideoMedia {
	image?: XaiMediaRef;
	video?: XaiMediaRef;
	referenceImages?: XaiMediaRef[];
}

/** Files API ids are opaque `file_<uuid>` strings, distinguishable from paths and URLs. */
const FILE_ID_PATTERN = /^file_[A-Za-z0-9-]+$/;

/** True when any resolved input is a Files API id rather than a URL. */
function usesFileIds(media: ResolvedVideoMedia): boolean {
	const refs = [media.image, media.video, ...(media.referenceImages ?? [])];
	return refs.some(ref => ref !== undefined && "file_id" in ref);
}

/**
 * Route and body for one xAI Imagine video request.
 *
 * The three modes are separate endpoints, not a flag: `/videos/generations`
 * takes a prompt plus optional first-frame or reference images, while
 * `/videos/extensions` and `/videos/edits` take a source video and inherit its
 * geometry — docs.x.ai documents `aspect_ratio`/`resolution` as unsupported
 * there, and `duration` on an extension sizes the appended segment only.
 */
function buildXaiVideoRequest(
	baseUrl: string,
	model: string,
	params: VideoGenParams,
	media: ResolvedVideoMedia,
): { url: string; body: Record<string, unknown> } {
	const body: Record<string, unknown> = { model, prompt: params.prompt };
	const mode: VideoMode = params.mode ?? "generate";
	if (mode !== "edit" && params.duration !== undefined) body.duration = params.duration;
	// Persisting the output is what makes a chain cheap: the next extend or edit
	// references the returned id instead of re-uploading the clip. The TTL keeps
	// a chain from silently filling the caller's Files storage forever.
	if (params.store) {
		body.storage_options = { filename: params.store, expires_after: STORED_VIDEO_TTL_SECONDS };
	}
	if (mode === "generate") {
		if (params.aspect_ratio !== undefined) body.aspect_ratio = params.aspect_ratio;
		if (params.resolution !== undefined) body.resolution = params.resolution;
		if (media.image) body.image = media.image;
		if (media.referenceImages?.length) body.reference_images = media.referenceImages;
		return { url: `${baseUrl}/videos/generations`, body };
	}
	body.video = media.video;
	return { url: `${baseUrl}/videos/${mode === "extend" ? "extensions" : "edits"}`, body };
}

/**
 * Reject request shapes the endpoints cannot serve, before anything is sent.
 *
 * Each of these is documented on docs.x.ai as unsupported for the mode rather
 * than merely defaulted, and refusing locally is free — whereas a submitted job
 * bills per second of output that silently ignored half the request.
 */
function validateVideoRequest(params: VideoGenParams): string | null {
	const mode: VideoMode = params.mode ?? "generate";
	// A blank filename is the one value this tool would drop on the floor:
	// `storage_options` is only attached when `store` is truthy, so `""` would
	// quietly generate an unstored video the caller then cannot chain from.
	if (params.store !== undefined && params.store.trim().length === 0) {
		return "`store` must be a filename such as `shot-one.mp4`.";
	}
	// Blank media strings are the dangerous shape: `if (params.image)` would drop
	// one silently and bill a text-to-video the caller never asked for, and a
	// whitespace-only value would be read as a path to the working directory.
	for (const [name, value] of [
		["image", params.image],
		["video", params.video],
	] as const) {
		if (value !== undefined && value.trim().length === 0)
			return `\`${name}\` is blank; omit it or give a real source.`;
	}
	if (params.reference_images?.some(reference => reference.trim().length === 0)) {
		return "`reference_images` contains a blank entry; every reference must be a path, URL or `file_...` id.";
	}
	if (mode === "generate") {
		if (params.video) return "`video` requires mode extend or edit.";
		// docs.x.ai: "image + reference_images — use one or the other". An image
		// fixes the first frame; references only put subjects in the shot.
		if (params.image && params.reference_images?.length) {
			return "`image` and `reference_images` are mutually exclusive: an image fixes the first frame, references only guide the shot.";
		}
		return null;
	}
	if (!params.video) return `mode ${mode} requires \`video\`: a path or https URL of the source .mp4.`;
	if (params.image || params.reference_images?.length) {
		return `mode ${mode} takes \`video\` only; \`image\` and \`reference_images\` are generate-mode inputs.`;
	}
	if (params.aspect_ratio !== undefined || params.resolution !== undefined) {
		return `mode ${mode} inherits aspect ratio and resolution from the source video (capped at 720p); drop \`aspect_ratio\` and \`resolution\`.`;
	}
	if (mode === "edit" && params.duration !== undefined) {
		return "mode edit keeps the source video's duration; drop `duration`.";
	}
	// The REST schema for /videos/extensions bounds the appended segment at
	// 2-10s (default 6), narrower than the 1-15s a fresh generation accepts.
	if (mode === "extend" && params.duration !== undefined && (params.duration < 2 || params.duration > 10)) {
		return `mode extend appends between 2 and 10 seconds; ${params.duration} is out of range.`;
	}
	return null;
}

async function generateXaiVideo(
	apiKey: ApiKey,
	baseUrl: string,
	model: string,
	params: VideoGenParams,
	media: ResolvedVideoMedia,
	fetchImpl: FetchImpl,
	signal: AbortSignal,
	onUpdate: AgentToolUpdateCallback<VideoGenToolDetails, VideoGenParams> | undefined,
): Promise<VideoJobResult> {
	const request = buildXaiVideoRequest(baseUrl, model, params, media);

	const submitted = await submitVideoJob<{ request_id?: string }>(
		"xai",
		"xAI",
		apiKey,
		request.url,
		request.body,
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
				await untilAborted(signal, Bun.sleep(POLL_INTERVAL_MS));
				continue;
			}
			if (status.status === "done") {
				const url = status.video?.url;
				if (typeof url !== "string" || url.length === 0) {
					throw new Error("xAI reported a finished video with no URL.");
				}
				const ticks = status.usage?.cost_in_usd_ticks;
				// docs.x.ai polls `.video.file_output` for a video job.
				const fileId = status.video?.file_output?.file_id;
				return {
					url,
					requestId,
					// Providers may send `null` here; `null !== undefined` would slip past
					// the presence checks in the summary and render "duration=nulls".
					durationSeconds: typeof status.video?.duration === "number" ? status.video.duration : undefined,
					costUsd: typeof ticks === "number" ? ticks / USD_TICKS_PER_DOLLAR : undefined,
					fileId: typeof fileId === "string" && fileId.length > 0 ? fileId : undefined,
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
			await untilAborted(signal, Bun.sleep(POLL_INTERVAL_MS));
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
				await untilAborted(signal, Bun.sleep(POLL_INTERVAL_MS));
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
			await untilAborted(signal, Bun.sleep(POLL_INTERVAL_MS));
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

		const validationError = validateVideoRequest(params);
		if (validationError) {
			return { isError: true, content: [{ type: "text" as const, text: validationError }] };
		}

		const mode: VideoMode = params.mode ?? "generate";
		// A `file_...` id is already the request-body shape. A real file on disk
		// wins the tie: a path may legitimately be named `file_abc-123`, and
		// misreading it as a Files id would send the provider an id that does not
		// exist instead of the bytes the caller meant.
		const asRef = async (
			reference: string,
			resolveUrl: (value: string, cwd: string) => Promise<string>,
		): Promise<XaiMediaRef> => {
			const trimmed = reference.trim();
			if (FILE_ID_PATTERN.test(trimmed) && !(await Bun.file(resolveToCwd(trimmed, cwd)).exists())) {
				return { file_id: trimmed };
			}
			return { url: await resolveUrl(reference, cwd) };
		};
		const media: ResolvedVideoMedia = {};
		if (params.image) media.image = await asRef(params.image, resolveImageReferenceUrl);
		if (params.video) media.video = await asRef(params.video, resolveVideoReferenceUrl);
		if (params.reference_images?.length) {
			// Resolved one at a time against a shared budget: each reference is
			// individually capped, but nothing else stops a dozen of them from
			// inlining half a gigabyte of base64 into one request body.
			const referenceImages: XaiMediaRef[] = [];
			let inlinedChars = 0;
			for (const reference of params.reference_images) {
				const ref = await asRef(reference, resolveImageReferenceUrl);
				if ("url" in ref && ref.url.startsWith("data:")) inlinedChars += ref.url.length;
				if (inlinedChars > MAX_INLINE_IMAGE_SIZE) {
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: `reference_images inline to more than ${MAX_INLINE_IMAGE_SIZE / (1024 * 1024)}MB in total; pass https URLs or \`file_...\` ids instead.`,
							},
						],
					};
				}
				referenceImages.push(ref);
			}
			media.referenceImages = referenceImages;
		}

		const failures: string[] = [];
		let foundCredentials = false;
		// A provider that could have served the request but had no credential —
		// distinct from one skipped because it cannot do the job at all.
		let missingCredentials = false;

		for (const provider of videoProviderOrder(ctx.model, params.provider, params.model)) {
			// Extension, editing, reference images and the Files API are all xAI
			// Imagine surfaces; OpenRouter brokers plain generation only.
			if (provider === "openrouter" && mode !== "generate") {
				failures.push(`openrouter: mode ${mode} is xAI-only`);
				continue;
			}
			if (provider === "openrouter" && media.referenceImages) {
				failures.push("openrouter: reference_images is xAI-only");
				continue;
			}
			if (provider === "openrouter" && (params.store || usesFileIds(media))) {
				failures.push("openrouter: `store` and `file_...` inputs are xAI Files features");
				continue;
			}
			let model = params.model ?? (provider === "xai" ? DEFAULT_XAI_VIDEO_MODEL : DEFAULT_OPENROUTER_VIDEO_MODEL);
			// Verified against api.x.ai: `grok-imagine-video` answers a 1080p
			// request with "1080p video resolution is not available for this
			// model", and `grok-imagine-video-1.5` answers a text-only request
			// with "Text-to-video is not supported for this model". So 1080p on
			// xAI is reachable only as image-to-video on 1.5 — pick it when an
			// image is present, and skip the provider rather than fire a request
			// that cannot succeed when one is not.
			if (provider === "xai" && !params.model && params.resolution === "1080p") {
				if (media.referenceImages) {
					failures.push(
						`xai: 1080p is served only by ${XAI_1080P_VIDEO_MODEL}, which does not support reference_images`,
					);
					continue;
				}
				if (!media.image) {
					failures.push("xai: 1080p is image-to-video only (supply `image`, or use 720p)");
					continue;
				}
				model = XAI_1080P_VIDEO_MODEL;
			}
			// Reference-to-video is documented as unsupported on 1.5, so an
			// explicit pin to it cannot serve this request either. Checked before
			// the generic 1.5 rule so the caller hears the specific reason.
			if (provider === "xai" && media.referenceImages && isXai15(model)) {
				failures.push(`xai: ${model} does not support reference_images (use ${DEFAULT_XAI_VIDEO_MODEL})`);
				continue;
			}
			// The same limits hold when the caller pins the model by hand. Only
			// the ids whose refusals were observed are policed: an unknown id is
			// the caller's call, and the provider's own 400 is free and more
			// accurate than a guess baked in here.
			if (provider === "xai" && mode === "generate" && isXai15(model) && !media.image) {
				failures.push(`xai: ${model} is image-to-video only (supply \`image\`)`);
				continue;
			}
			if (provider === "xai" && model === DEFAULT_XAI_VIDEO_MODEL && params.resolution === "1080p") {
				failures.push(
					`xai: ${DEFAULT_XAI_VIDEO_MODEL} does not serve 1080p (use ${XAI_1080P_VIDEO_MODEL} with an \`image\`, or 720p)`,
				);
				continue;
			}
			let job: VideoJobResult;
			try {
				if (provider === "xai") {
					const resolved = await resolveXaiKey(ctx.modelRegistry, model, sessionId);
					if (!resolved) {
						missingCredentials = true;
						continue;
					}
					foundCredentials = true;
					job = await generateXaiVideo(
						resolved.apiKey,
						resolved.baseUrl,
						model,
						params,
						media,
						fetchImpl,
						requestSignal,
						onUpdate,
					);
				} else {
					const apiKey = await resolveOpenRouterKey(ctx.modelRegistry, sessionId);
					if (!apiKey) {
						missingCredentials = true;
						continue;
					}
					foundCredentials = true;
					job = await generateOpenRouterVideo(
						apiKey,
						model,
						params,
						media.image && "url" in media.image ? media.image.url : undefined,
						fetchImpl,
						requestSignal,
						onUpdate,
					);
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
							text: `${provider} job ${job.requestId} finished but its download failed (${downloadFailure ?? "no response"}). The video is still retrievable at ${job.url}${job.fileId ? ` or as xAI file ${job.fileId}` : ""}`,
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
							text: `${provider} job ${job.requestId} downloaded but writing ${displayPath} failed (${redactHome(message)}). The video is still retrievable at ${job.url}${job.fileId ? ` or as xAI file ${job.fileId}` : ""}`,
						},
					],
				};
			}

			const parts = [`Saved ${bytes.length} bytes to ${displayPath}`, `provider=${provider}`, `model=${model}`];
			// `mode` is only worth the tokens when it is not the default, but the
			// structured details always carry it so a renderer never has to guess.
			if (mode !== "generate") parts.push(`mode=${mode}`);
			// A `store` that produced no receipt is worth saying out loud: the
			// caller planned to chain from an id that does not exist.
			if (job.fileId) parts.push(`file_id=${job.fileId}`);
			else if (params.store) parts.push("file_id=none (xAI returned no storage receipt)");
			if (job.durationSeconds !== undefined) parts.push(`duration=${job.durationSeconds}s`);
			if (job.costUsd !== undefined) parts.push(`cost=$${job.costUsd.toFixed(4)}`);
			return {
				content: [{ type: "text" as const, text: `${parts.join(", ")}.` }],
				details: {
					provider,
					model,
					mode,
					videoPath: outputPath,
					bytes: bytes.length,
					requestId: job.requestId,
					durationSeconds: job.durationSeconds,
					costUsd: job.costUsd,
					fileId: job.fileId,
				},
			};
		}

		// A provider that could have run this request had no credential, and none
		// of the others got as far as submitting: the actionable cause is the
		// missing login, so lead with it even when a capability skip was also
		// recorded — that note explains why only one backend was eligible.
		if (missingCredentials && !foundCredentials) {
			const detail = failures.length > 0 ? ` (${failures.join("; ")})` : "";
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: `No video generation credentials. Run /login → xAI Grok OAuth (SuperGrok or X Premium+), or set XAI_API_KEY or OPENROUTER_API_KEY.${detail}`,
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
