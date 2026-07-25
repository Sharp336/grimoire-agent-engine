import { afterEach, describe, expect, it } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MAX_POLL_FAILURES,
	setVideoProviderOrder,
	VideoJobPoller,
	videoGenSchema,
	videoGenTool,
} from "@oh-my-pi/pi-coding-agent/tools/video-gen";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

const writtenPaths: string[] = [];

afterEach(async () => {
	await Promise.all(writtenPaths.splice(0).map(target => removeWithRetries(target)));
	setVideoProviderOrder([]);
});

interface CredentialedProviders {
	xai?: boolean;
	openrouter?: boolean;
	/** Bearer the xAI resolver hands out, read fresh each call so a test can rotate it. */
	xaiKey?: () => string;
}

function createContext(fetchMock: typeof fetch, available: CredentialedProviders): CustomToolContext {
	return {
		fetch: fetchMock,
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			getApiKey: async () => undefined,
			getApiKeyForProvider: async (provider: string) => {
				if (provider === "xai-oauth" && available.xai) return "test-xai-token";
				if (provider === "openrouter" && available.openrouter) return "test-openrouter-key";
				return undefined;
			},
			getProviderBaseUrl: () => undefined,
			getAll: () => [],
			authStorage: {
				hasNonEnvCredential: (provider: string) => provider === "xai-oauth" && Boolean(available.xai),
				rotateSessionCredential: async () => false,
			},
			resolver: (provider: string) => async () =>
				provider === "openrouter" ? "test-openrouter-key" : (available.xaiKey?.() ?? "test-xai-token"),
		} as unknown as ModelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

/** Serve a scripted sequence of responses, one per request, keyed by call order. */
function sequencedFetch(handlers: Array<(url: string, init?: RequestInit) => Response>): {
	fetch: typeof fetch;
	calls: Array<{ url: string; body?: Record<string, unknown>; headers: Headers }>;
} {
	const calls: Array<{ url: string; body?: Record<string, unknown>; headers: Headers }> = [];
	const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = input.toString();
		const rawBody = init?.body;
		calls.push({
			url,
			body: typeof rawBody === "string" ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined,
			headers: new Headers(init?.headers),
		});
		const handler = handlers[calls.length - 1];
		if (!handler) throw new Error(`Unexpected request #${calls.length} to ${url}`);
		return handler(url, init);
	}) as unknown as typeof fetch;
	return { fetch: fetchMock, calls };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** First text block of a tool result — `toMatchObject` + asymmetric matchers misreports here. */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	return block?.type === "text" ? (block.text ?? "") : "";
}

describe("videoGenTool", () => {
	it("submits, polls, and writes the finished xAI video with its reported cost", async () => {
		const outputPath = `/tmp/omp-video-test-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-1" }),
			() =>
				json({
					status: "done",
					model: "grok-imagine-video",
					video: { url: "https://vidgen.x.ai/out.mp4", duration: 4 },
					usage: { cost_in_usd_ticks: 2_000_000_000 },
				}),
			() => new Response(new Uint8Array([0, 1, 2, 3, 4])),
		]);

		const result = await videoGenTool.execute(
			"call-xai",
			{ prompt: "a red balloon rising", output_path: outputPath, duration: 4, resolution: "480p" },
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls[0].url).toBe("https://api.x.ai/v1/videos/generations");
		expect(calls[0].headers.get("authorization")).toBe("Bearer test-xai-token");
		expect(calls[0].headers.get("user-agent")).toBe("oh-my-pi/xai");
		expect(calls[0].body).toEqual({
			model: "grok-imagine-video",
			prompt: "a red balloon rising",
			duration: 4,
			resolution: "480p",
		});
		expect(calls[1].url).toBe("https://api.x.ai/v1/videos/req-1");
		expect(calls[2].url).toBe("https://vidgen.x.ai/out.mp4");
		// xAI hands back a presigned URL — never attach the bearer token to it.
		expect(calls[2].headers.get("authorization")).toBeNull();

		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({
			provider: "xai",
			model: "grok-imagine-video",
			requestId: "req-1",
			bytes: 5,
			durationSeconds: 4,
			costUsd: 0.2,
		});
		expect(await Bun.file(outputPath).bytes()).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
	});

	it("inlines a local still image as a data URL for image-to-video", async () => {
		const imagePath = `/tmp/omp-video-still-${Bun.randomUUIDv7()}.png`;
		const outputPath = `/tmp/omp-video-test-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(imagePath, outputPath);
		// 1x1 transparent PNG — parseImageMetadata sniffs the magic bytes.
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		await Bun.write(imagePath, png);

		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-img" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4", duration: 2 } }),
			() => new Response(new Uint8Array([9])),
		]);

		await videoGenTool.execute(
			"call-i2v",
			{ prompt: "make it drift", output_path: outputPath, image: imagePath },
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		const image = calls[0].body?.image as { url?: string } | undefined;
		expect(image?.url).toBe(`data:image/png;base64,${png.toString("base64")}`);
	});

	it("pins a slash-qualified model to OpenRouter instead of falling back to xAI", async () => {
		const outputPath = `/tmp/omp-video-test-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ id: "job-1", polling_url: "https://openrouter.ai/api/v1/videos/job-1", status: "pending" }),
			() => json({ status: "completed", unsigned_urls: ["https://openrouter.ai/api/v1/videos/job-1/content"] }),
			(_url, init) =>
				new Headers(init?.headers).get("authorization") === "Bearer test-openrouter-key"
					? new Response(new Uint8Array([7, 7]))
					: json({ error: { message: "No cookie auth credentials found", code: 401 } }, 401),
		]);

		const result = await videoGenTool.execute(
			"call-or",
			{ prompt: "a city timelapse", output_path: outputPath, model: "google/veo-3.1-fast" },
			undefined,
			// xAI credentials exist and would win the auto order — the explicit
			// namespaced model must pin OpenRouter anyway.
			createContext(fetchMock, { xai: true, openrouter: true }),
		);

		expect(calls[0].url).toBe("https://openrouter.ai/api/v1/videos");
		expect(calls[0].body).toMatchObject({ model: "google/veo-3.1-fast", prompt: "a city timelapse" });
		// `unsigned_urls` are API paths, not presigned links: the download 401s
		// without the bearer token, so the mock only yields bytes when it is sent.
		expect(calls[2].headers.get("authorization")).toBe("Bearer test-openrouter-key");
		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({
			provider: "openrouter",
			model: "google/veo-3.1-fast",
			requestId: "job-1",
			bytes: 2,
		});
	});

	it("reports an actionable error and issues no request when no provider is credentialed", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);

		const result = await videoGenTool.execute(
			"call-none",
			{ prompt: "anything", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4` },
			undefined,
			createContext(fetchMock, {}),
		);

		expect(calls).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("XAI_API_KEY");
	});
	it("does not run a second billed generation on another provider once a job is submitted", async () => {
		// xAI accepts the job (billing starts), then the generation itself fails.
		// Falling through to OpenRouter here would charge for a whole second video.
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-doomed" }),
			() => json({ status: "failed", error: { message: "content moderation" } }),
		]);

		const result = await videoGenTool.execute(
			"call-committed",
			{ prompt: "something", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4` },
			undefined,
			createContext(fetchMock, { xai: true, openrouter: true }),
		);

		expect(calls.map(c => c.url)).toEqual([
			"https://api.x.ai/v1/videos/generations",
			"https://api.x.ai/v1/videos/req-doomed",
		]);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("req-doomed");
	});

	it("does not run a second billed generation when the download of a finished job fails", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-dl" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4", duration: 2 } }),
			() => new Response("gone", { status: 502 }),
		]);

		const result = await videoGenTool.execute(
			"call-dl-fail",
			{ prompt: "something", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4` },
			undefined,
			createContext(fetchMock, { xai: true, openrouter: true }),
		);

		expect(calls).toHaveLength(3);
		expect(calls.every(c => !c.url.startsWith("https://openrouter.ai"))).toBe(true);
		expect(result.isError).toBe(true);
		// The bytes are still retrievable by hand, so name the job and its URL.
		expect(resultText(result)).toContain("req-dl");
		expect(resultText(result)).toContain("https://vidgen.x.ai/out.mp4");
	});

	it("rotates credentials on a polling 401 without resubmitting the job", async () => {
		// `withAuth` retries its callback on an auth error. If one callback spans
		// submit+poll, a mid-job token rotation starts a second paid generation.
		let token = "stale-token";
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-auth" }),
			() => {
				token = "fresh-token";
				return json({ error: { message: "expired" } }, 401);
			},
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4", duration: 1 } }),
			() => new Response(new Uint8Array([1])),
		]);
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);

		const result = await videoGenTool.execute(
			"call-auth-rotate",
			{ prompt: "something", output_path: outputPath },
			undefined,
			createContext(fetchMock, { xai: true, xaiKey: () => token }),
		);

		const submits = calls.filter(c => c.url.endsWith("/videos/generations"));
		expect(submits).toHaveLength(1);
		expect(calls[2].headers.get("authorization")).toBe("Bearer fresh-token");
		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({ requestId: "req-auth" });
	});

	it("still falls through to the next provider when the first has no credentials", async () => {
		// The no-fallback rule must only bind AFTER submission — an uncredentialed
		// provider has billed nothing, so the chain has to keep going.
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ id: "job-fb", polling_url: "https://openrouter.ai/api/v1/videos/job-fb", status: "pending" }),
			() =>
				json({
					status: "completed",
					unsigned_urls: ["https://openrouter.ai/api/v1/videos/job-fb/content"],
					usage: { cost: 0.25 },
				}),
			() => new Response(new Uint8Array([3, 3, 3])),
		]);

		const result = await videoGenTool.execute(
			"call-fallback",
			{ prompt: "a kite", output_path: outputPath },
			undefined,
			createContext(fetchMock, { openrouter: true }),
		);

		expect(calls[0].url).toBe("https://openrouter.ai/api/v1/videos");
		expect(result.isError).toBeUndefined();
		// OpenRouter reports spend on the poll response; surface it like xAI's ticks.
		expect(result.details).toMatchObject({ provider: "openrouter", costUsd: 0.25 });
	});

	it("tolerates a null cost from OpenRouter instead of crashing after the file is written", async () => {
		// `null !== undefined`, so an unguarded `costUsd` reaches `.toFixed()` and
		// throws only after the video has already landed on disk.
		const nullCostPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(nullCostPath);
		const { fetch: nullCostFetch } = sequencedFetch([
			() => json({ id: "job-null", polling_url: "https://openrouter.ai/api/v1/videos/job-null" }),
			() =>
				json({
					status: "completed",
					unsigned_urls: ["https://openrouter.ai/api/v1/videos/job-null/content"],
					usage: { cost: null },
				}),
			() => new Response(new Uint8Array([8])),
		]);

		const nullCostResult = await videoGenTool.execute(
			"call-null-cost",
			{ prompt: "x", output_path: nullCostPath },
			undefined,
			createContext(nullCostFetch, { openrouter: true }),
		);

		expect(nullCostResult.isError).toBeUndefined();
		expect(nullCostResult.details?.costUsd).toBeUndefined();
		expect(await Bun.file(nullCostPath).bytes()).toEqual(new Uint8Array([8]));
	});
	it("treats an accepted submission with an unreadable body as committed, not as a fallback", async () => {
		// HTTP 200 means the job exists and is billing. A body that will not parse
		// must not escape as an ordinary error and start a second generation.
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => new Response("<html>edge error</html>", { status: 200, headers: { "content-type": "text/html" } }),
		]);

		const result = await videoGenTool.execute(
			"call-bad-body",
			{ prompt: "x", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4` },
			undefined,
			createContext(fetchMock, { xai: true, openrouter: true }),
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.x.ai/v1/videos/generations");
		expect(result.isError).toBe(true);
	});

	it("sends OpenRouter image-to-video in the documented frame_images shape", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ id: "job-i2v", polling_url: "https://openrouter.ai/api/v1/videos/job-i2v", status: "pending" }),
			() => json({ status: "completed", unsigned_urls: ["https://openrouter.ai/api/v1/videos/job-i2v/content"] }),
			() => new Response(new Uint8Array([4])),
		]);

		await videoGenTool.execute(
			"call-or-i2v",
			{
				prompt: "drift",
				output_path: outputPath,
				model: "google/veo-3.1-fast",
				image: "https://example.test/still.png",
			},
			undefined,
			createContext(fetchMock, { openrouter: true }),
		);

		expect(calls[0].body?.frame_images).toEqual([
			{ type: "image_url", image_url: { url: "https://example.test/still.png" }, frame_type: "first_frame" },
		]);
	});

	it("routes an xAI 1080p image-to-video request to the only model that serves it", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-hd" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4", duration: 4 } }),
			() => new Response(new Uint8Array([5])),
		]);

		await videoGenTool.execute(
			"call-1080p",
			{
				prompt: "push in",
				output_path: outputPath,
				image: "https://example.test/still.png",
				resolution: "1080p",
			},
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls[0].body).toMatchObject({ model: "grok-imagine-video-1.5", resolution: "1080p" });
	});

	it("refuses xAI 1080p text-to-video locally instead of sending a doomed request", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);

		const result = await videoGenTool.execute(
			"call-1080p-t2v",
			{ prompt: "no image", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`, resolution: "1080p" },
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("1080p");
	});

	it("rejects a fractional duration at the schema boundary", () => {
		const base = { prompt: "x", output_path: "/tmp/x.mp4" };
		expect(videoGenSchema({ ...base, duration: 4.5 })).toBeInstanceOf(type.errors);
		expect(videoGenSchema({ ...base, duration: 4 })).not.toBeInstanceOf(type.errors);
		expect(videoGenSchema({ ...base, duration: 20 })).toBeInstanceOf(type.errors);
	});
});

describe("VideoJobPoller", () => {
	function poller(handler: (attempt: number) => Response | Promise<never>): VideoJobPoller {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			return handler(attempt);
		}) as unknown as typeof fetch;
		// A static string key keeps `withAuth` on its no-retry path, isolating the
		// poller's own transient-failure budget.
		return new VideoJobPoller("test", "static-key", () => ({}), fetchMock, new AbortController().signal);
	}

	it("absorbs transient failures up to the budget, then surfaces the provider status", async () => {
		const subject = poller(() => json({ error: { message: "upstream busy" } }, 503));

		for (let i = 0; i < MAX_POLL_FAILURES; i++) {
			expect(await subject.poll("https://example.test/job")).toBeNull();
		}
		await expect(subject.poll("https://example.test/job")).rejects.toThrow("test video poll failed (503)");
	});

	it("resets the failure budget after a successful poll", async () => {
		let call = 0;
		const subject = poller(() => {
			call += 1;
			// Fail, succeed, then fail again — the reset must make the second run
			// of failures start from zero rather than trip the budget early.
			return call === MAX_POLL_FAILURES + 1 ? json({ status: "pending" }) : json({}, 500);
		});

		for (let i = 0; i < MAX_POLL_FAILURES; i++) {
			expect(await subject.poll("https://example.test/job")).toBeNull();
		}
		expect(await subject.poll<{ status: string }>("https://example.test/job")).toEqual({ status: "pending" });
		for (let i = 0; i < MAX_POLL_FAILURES; i++) {
			expect(await subject.poll("https://example.test/job")).toBeNull();
		}
	});

	it("fails immediately on a non-retryable status", async () => {
		const subject = poller(() => json({ error: { message: "no such job" } }, 404));

		await expect(subject.poll("https://example.test/job")).rejects.toThrow(
			"test video poll failed (404): no such job",
		);
	});
});
