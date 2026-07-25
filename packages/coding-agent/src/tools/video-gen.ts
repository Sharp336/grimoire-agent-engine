import { type ApiKey, type FetchImpl, getEnvApiKey, type Model, withAuth } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { ModelRegistry } from "../config/model-registry";
import type { AgentToolUpdateCallback, CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { ohMyPiXAIUserAgent, resolveXAIHttpCredentials } from "../lib/xai-http";
import videoGenDescription from "../prompts/tools/video-gen.md" with { type: "text" };
import { resolveImageReferenceUrl } from "./media-input";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";
import { AUTO_VIDEO_PROVIDER_ORDER, isVideoProviderId, type VideoProvider } from "./video-providers";

const DEFAULT_XAI_VIDEO_MODEL = "grok-imagine-video";
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
	"duration?": type("1 <= number <= 15").describe("seconds of output video (default 8)"),
	"aspect_ratio?": type.enumerated(...VIDEO_ASPECT_RATIOS).describe("aspect ratio (default 16:9)"),
	"resolution?": type.enumerated(...VIDEO_RESOLUTIONS).describe("output resolution (default 480p)"),
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
	requestId: string;
	durationSeconds?: number;
	costUsd?: number;
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
 */
export class VideoJobPoller {
	#failures = 0;

	constructor(
		private readonly label: string,
		private readonly headers: Record<string, string>,
		private readonly fetchImpl: FetchImpl,
		private readonly signal: AbortSignal,
	) {}

	/** Job state, or `null` when a transient failure was absorbed — poll again. */
	async poll<T>(url: string): Promise<T | null> {
		let response: Response;
		try {
			response = await this.fetchImpl(url, { headers: this.headers, signal: this.signal });
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

async function generateXaiVideo(
	key: string,
	baseUrl: string,
	model: string,
	params: VideoGenParams,
	imageUrl: string | undefined,
	fetchImpl: FetchImpl,
	signal: AbortSignal,
	onUpdate: AgentToolUpdateCallback<VideoGenToolDetails, VideoGenParams> | undefined,
): Promise<VideoJobResult> {
	const headers = {
		Authorization: `Bearer ${key}`,
		"Content-Type": "application/json",
		"User-Agent": ohMyPiXAIUserAgent(),
	};
	const body: Record<string, unknown> = { model, prompt: params.prompt };
	if (params.duration !== undefined) body.duration = params.duration;
	if (params.aspect_ratio !== undefined) body.aspect_ratio = params.aspect_ratio;
	if (params.resolution !== undefined) body.resolution = params.resolution;
	if (imageUrl) body.image = { url: imageUrl };

	const submit = await fetchImpl(`${baseUrl}/videos/generations`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	if (!submit.ok) {
		throw new ProviderHttpError(
			`xAI video request failed (${submit.status}): ${await readErrorMessage(submit)}`,
			submit.status,
			{ headers: submit.headers },
		);
	}
	const { request_id: requestId } = (await submit.json()) as { request_id?: string };
	if (!requestId) throw new Error("xAI video request returned no request_id.");

	// Poll until terminal. `pending` arrives as HTTP 202 and `done` as 200 —
	// both are successful transports, so status lives in the body, not the code.
	const poller = new VideoJobPoller("xAI", headers, fetchImpl, signal);
	for (;;) {
		const status = await poller.poll<XAIVideoStatus>(`${baseUrl}/videos/${requestId}`);
		if (!status) {
			await sleepUntilAborted(POLL_INTERVAL_MS, signal);
			signal.throwIfAborted();
			continue;
		}
		if (status.status === "done") {
			const url = status.video?.url;
			if (!url) throw new Error("xAI reported a finished video with no URL.");
			const ticks = status.usage?.cost_in_usd_ticks;
			return {
				url,
				requestId,
				durationSeconds: status.video?.duration,
				costUsd: typeof ticks === "number" ? ticks / USD_TICKS_PER_DOLLAR : undefined,
			};
		}
		if (status.status && status.status !== "pending") {
			const detail = status.error?.message ? `: ${status.error.message}` : "";
			throw new Error(`xAI video generation ${status.status}${detail}`);
		}
		reportProgress(onUpdate, "xai", model, "generating", status.progress);
		await sleepUntilAborted(POLL_INTERVAL_MS, signal);
		signal.throwIfAborted();
	}
}

interface OpenRouterVideoStatus {
	status?: string;
	unsigned_urls?: string[];
	progress?: number;
	error?: { message?: string } | string;
}

/** Terminal success states across OpenRouter's brokered backends. */
const OPENROUTER_DONE_STATUSES: Record<string, true> = { completed: true, succeeded: true, done: true };

async function generateOpenRouterVideo(
	key: string,
	model: string,
	params: VideoGenParams,
	imageUrl: string | undefined,
	fetchImpl: FetchImpl,
	signal: AbortSignal,
	onUpdate: AgentToolUpdateCallback<VideoGenToolDetails, VideoGenParams> | undefined,
): Promise<VideoJobResult> {
	const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
	const body: Record<string, unknown> = { model, prompt: params.prompt };
	if (params.duration !== undefined) body.duration = params.duration;
	if (params.aspect_ratio !== undefined) body.aspect_ratio = params.aspect_ratio;
	if (params.resolution !== undefined) body.resolution = params.resolution;
	if (imageUrl) body.frame_images = [{ url: imageUrl }];

	const submit = await fetchImpl(OPENROUTER_VIDEO_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	if (!submit.ok) {
		throw new ProviderHttpError(
			`OpenRouter video request failed (${submit.status}): ${await readErrorMessage(submit)}`,
			submit.status,
			{ headers: submit.headers },
		);
	}
	const submitted = (await submit.json()) as { id?: string; polling_url?: string };
	const requestId = submitted.id;
	const pollingUrl = submitted.polling_url ?? (requestId ? `${OPENROUTER_VIDEO_URL}/${requestId}` : undefined);
	if (!requestId || !pollingUrl) throw new Error("OpenRouter video request returned no job id.");

	const poller = new VideoJobPoller("OpenRouter", headers, fetchImpl, signal);
	for (;;) {
		const status = await poller.poll<OpenRouterVideoStatus>(pollingUrl);
		if (!status) {
			await sleepUntilAborted(POLL_INTERVAL_MS, signal);
			signal.throwIfAborted();
			continue;
		}
		const state = status.status ?? "pending";
		if (OPENROUTER_DONE_STATUSES[state]) {
			const url = status.unsigned_urls?.[0];
			if (!url) throw new Error("OpenRouter reported a finished video with no URL.");
			return { url, requestId };
		}
		if (state === "failed" || state === "cancelled" || state === "expired") {
			const message = typeof status.error === "string" ? status.error : status.error?.message;
			throw new Error(`OpenRouter video generation ${state}${message ? `: ${message}` : ""}`);
		}
		reportProgress(onUpdate, "openrouter", model, "generating", status.progress);
		await sleepUntilAborted(POLL_INTERVAL_MS, signal);
		signal.throwIfAborted();
	}
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
		return untilAborted(signal, async () => {
			const cwd = ctx.sessionManager.getCwd();
			const sessionId = ctx.sessionManager.getSessionId();
			const outputPath = resolveToCwd(params.output_path, cwd);
			const displayPath = formatPathRelativeToCwd(outputPath, cwd);
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
				const model =
					params.model ?? (provider === "xai" ? DEFAULT_XAI_VIDEO_MODEL : DEFAULT_OPENROUTER_VIDEO_MODEL);
				let job: VideoJobResult;
				try {
					if (provider === "xai") {
						const resolved = ctx.modelRegistry ? await resolveXaiKey(ctx.modelRegistry, model, sessionId) : null;
						if (!resolved) continue;
						foundCredentials = true;
						job = await withAuth(
							resolved.apiKey,
							key =>
								generateXaiVideo(
									key,
									resolved.baseUrl,
									model,
									params,
									imageUrl,
									fetchImpl,
									requestSignal,
									onUpdate,
								),
							{ signal: requestSignal },
						);
					} else {
						const apiKey = await resolveOpenRouterKey(ctx.modelRegistry, sessionId);
						if (!apiKey) continue;
						foundCredentials = true;
						job = await withAuth(
							apiKey,
							key => generateOpenRouterVideo(key, model, params, imageUrl, fetchImpl, requestSignal, onUpdate),
							{ signal: requestSignal },
						);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logger.warn("Video generation provider failed", { provider, model, error: message });
					failures.push(`${provider}: ${message}`);
					continue;
				}

				// Provider URLs are short-lived; pull the bytes on the same fence.
				const download = await fetchImpl(job.url, { signal: requestSignal });
				if (!download.ok) {
					const message = `download failed (${download.status})`;
					failures.push(`${provider}: ${message}`);
					continue;
				}
				const bytes = new Uint8Array(await download.arrayBuffer());
				await Bun.write(outputPath, bytes);

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

			if (!foundCredentials) {
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
		});
	},
};
