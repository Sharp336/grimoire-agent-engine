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
	it("reports the surviving job id when the caller cancels after submission", async () => {
		// The generation keeps running and billing server-side, so a cancel must
		// surface which job to go look for rather than a bare abort.
		const controller = new AbortController();
		const { fetch: fetchMock } = sequencedFetch([
			() => json({ request_id: "req-cancelled" }),
			() => {
				controller.abort();
				throw new DOMException("The operation was aborted.", "AbortError");
			},
		]);

		const result = await videoGenTool.execute(
			"call-cancel",
			{ prompt: "x", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4` },
			undefined,
			createContext(fetchMock, { xai: true, openrouter: true }),
			controller.signal,
		);

		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("req-cancelled");
		expect(resultText(result)).toContain("still generating");
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

	it("extends a source video through the extensions endpoint", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-ext" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4", duration: 15 } }),
			() => new Response(new Uint8Array([7])),
		]);

		const result = await videoGenTool.execute(
			"call-extend",
			{
				prompt: "the cat leaps off the sill",
				output_path: outputPath,
				mode: "extend",
				video: "https://vidgen.x.ai/source.mp4",
				duration: 5,
			},
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls[0].url).toBe("https://api.x.ai/v1/videos/extensions");
		expect(calls[0].body).toEqual({
			model: "grok-imagine-video",
			prompt: "the cat leaps off the sill",
			duration: 5,
			video: { url: "https://vidgen.x.ai/source.mp4" },
		});
		expect(resultText(result)).toContain("mode=extend");
	});

	it("edits a source video without forwarding geometry it cannot control", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-edit" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4" } }),
			() => new Response(new Uint8Array([8])),
		]);

		await videoGenTool.execute(
			"call-edit",
			{
				prompt: "add rain",
				output_path: outputPath,
				mode: "edit",
				video: "https://vidgen.x.ai/source.mp4",
			},
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls[0].url).toBe("https://api.x.ai/v1/videos/edits");
		expect(calls[0].body).toEqual({
			model: "grok-imagine-video",
			prompt: "add rain",
			video: { url: "https://vidgen.x.ai/source.mp4" },
		});
	});

	/** A real `ftyp` box: size, type, major brand, minor version, compatible brands. */
	function ftypBox(major: string, compatible: string[]): Uint8Array {
		const size = 16 + compatible.length * 4;
		const bytes = new Uint8Array(size);
		new DataView(bytes.buffer).setUint32(0, size);
		const write = (offset: number, text: string): void => {
			for (let i = 0; i < 4; i++) bytes[offset + i] = text.charCodeAt(i);
		};
		write(4, "ftyp");
		write(8, major);
		compatible.forEach((brand, index) => {
			write(16 + index * 4, brand);
		});
		return bytes;
	}

	it("inlines a local source video as an MP4 data URL", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		const sourcePath = `/tmp/omp-video-src-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath, sourcePath);
		const source = ftypBox("isom", ["isom", "mp41"]);
		await Bun.write(sourcePath, source);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-inline" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4" } }),
			() => new Response(new Uint8Array([9])),
		]);

		await videoGenTool.execute(
			"call-inline",
			{ prompt: "keep going", output_path: outputPath, mode: "extend", video: sourcePath },
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls[0].body?.video).toEqual({ url: `data:video/mp4;base64,${source.toBase64()}` });
	});

	it("accepts an MP4 whose profile brand only appears in the compatible list", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		const sourcePath = `/tmp/omp-video-src-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath, sourcePath);
		// `cmfc` (CMAF) is a real MP4 profile brand that is not itself in the
		// allowlist; the file is only recognisable through `mp42` below it.
		await Bun.write(sourcePath, ftypBox("cmfc", ["cmfc", "mp42"]));
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-cmaf" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4" } }),
			() => new Response(new Uint8Array([13])),
		]);

		await videoGenTool.execute(
			"call-cmaf",
			{ prompt: "keep going", output_path: outputPath, mode: "extend", video: sourcePath },
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls[0].url).toBe("https://api.x.ai/v1/videos/extensions");
	});

	it("refuses a source video that is not MP4 before any request", async () => {
		const sourcePath = `/tmp/omp-video-src-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(sourcePath);
		// HEIF: same `ftyp` container family, still images, no MP4 brand anywhere.
		await Bun.write(sourcePath, ftypBox("heic", ["mif1", "heic"]));
		const { fetch: fetchMock, calls } = sequencedFetch([]);

		await expect(
			videoGenTool.execute(
				"call-not-mp4",
				{
					prompt: "keep going",
					output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`,
					mode: "extend",
					video: sourcePath,
				},
				undefined,
				createContext(fetchMock, { xai: true }),
			),
		).rejects.toThrow("Unsupported video type");
		expect(calls).toHaveLength(0);
	});

	it("sends reference images alongside a generated shot", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-ref" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4" } }),
			() => new Response(new Uint8Array([10])),
		]);

		await videoGenTool.execute(
			"call-ref",
			{
				prompt: "she walks the runway",
				output_path: outputPath,
				reference_images: ["https://example.test/model.png", "https://example.test/dress.png"],
			},
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls[0].url).toBe("https://api.x.ai/v1/videos/generations");
		expect(calls[0].body?.reference_images).toEqual([
			{ url: "https://example.test/model.png" },
			{ url: "https://example.test/dress.png" },
		]);
	});

	it("refuses reference images on the model that cannot serve them", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);

		const result = await videoGenTool.execute(
			"call-ref-15",
			{
				prompt: "she walks the runway",
				output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`,
				model: "grok-imagine-video-1.5",
				reference_images: ["https://example.test/model.png"],
			},
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("reference_images");
	});

	it("skips OpenRouter for xAI-only modes instead of billing a plain generation", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);

		const result = await videoGenTool.execute(
			"call-or-extend",
			{
				prompt: "keep going",
				output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`,
				mode: "extend",
				video: "https://example.test/source.mp4",
			},
			undefined,
			createContext(fetchMock, { openrouter: true }),
		);

		expect(calls).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("xAI-only");
	});

	it("refuses request shapes the source-video endpoints cannot serve", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);
		const base = { prompt: "x", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4` };
		const ctx = createContext(fetchMock, { xai: true });

		const missingVideo = await videoGenTool.execute("call-a", { ...base, mode: "extend" }, undefined, ctx);
		const strayVideo = await videoGenTool.execute(
			"call-b",
			{ ...base, video: "https://example.test/source.mp4" },
			undefined,
			ctx,
		);
		const editGeometry = await videoGenTool.execute(
			"call-c",
			{ ...base, mode: "edit", video: "https://example.test/source.mp4", resolution: "1080p" },
			undefined,
			ctx,
		);
		const editDuration = await videoGenTool.execute(
			"call-d",
			{ ...base, mode: "edit", video: "https://example.test/source.mp4", duration: 5 },
			undefined,
			ctx,
		);
		const bothImageInputs = await videoGenTool.execute(
			"call-e",
			{ ...base, image: "https://example.test/still.png", reference_images: ["https://example.test/dress.png"] },
			undefined,
			ctx,
		);

		expect(calls).toHaveLength(0);
		expect(resultText(missingVideo)).toContain("requires `video`");
		expect(resultText(strayVideo)).toContain("mode extend or edit");
		expect(resultText(editGeometry)).toContain("inherits aspect ratio and resolution");
		expect(resultText(editDuration)).toContain("duration");
		expect(resultText(bothImageInputs)).toContain("mutually exclusive");
		for (const result of [missingVideo, strayVideo, editGeometry, editDuration, bothImageInputs]) {
			expect(result.isError).toBe(true);
		}
	});

	it("refuses an extension length the endpoint cannot append", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);
		const extendBase = {
			prompt: "keep going",
			output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`,
			mode: "extend" as const,
			video: "https://example.test/source.mp4",
		};
		const ctx = createContext(fetchMock, { xai: true });

		// /videos/extensions bounds the appended segment at 2-10s, narrower than
		// the 1-15s a fresh generation takes.
		const tooShort = await videoGenTool.execute("call-ext-1", { ...extendBase, duration: 1 }, undefined, ctx);
		const tooLong = await videoGenTool.execute("call-ext-15", { ...extendBase, duration: 15 }, undefined, ctx);

		expect(calls).toHaveLength(0);
		expect(resultText(tooShort)).toContain("between 2 and 10 seconds");
		expect(resultText(tooLong)).toContain("between 2 and 10 seconds");
	});

	it("rejects a fractional duration at the schema boundary", () => {
		const base = { prompt: "x", output_path: "/tmp/x.mp4" };
		expect(videoGenSchema({ ...base, duration: 4.5 })).toBeInstanceOf(type.errors);
		expect(videoGenSchema({ ...base, duration: 4 })).not.toBeInstanceOf(type.errors);
		expect(videoGenSchema({ ...base, duration: 20 })).toBeInstanceOf(type.errors);
	});

	it("persists the result and reports the id a later call can chain from", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-store" }),
			() =>
				json({
					status: "done",
					// docs.x.ai returns the Files receipt under `video` for video jobs.
					video: { url: "https://vidgen.x.ai/out.mp4", file_output: { file_id: "file_abc-123" } },
				}),
			() => new Response(new Uint8Array([11])),
		]);

		const result = await videoGenTool.execute(
			"call-store",
			{ prompt: "shot one", output_path: outputPath, store: "shot-one.mp4" },
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls[0].body?.storage_options).toEqual({ filename: "shot-one.mp4", expires_after: 2_592_000 });
		expect(resultText(result)).toContain("file_id=file_abc-123");
	});

	it("refuses a blank store filename instead of silently not storing", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);

		const result = await videoGenTool.execute(
			"call-store-blank",
			{
				prompt: "shot one",
				output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`,
				store: "   ",
			},
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("`store` must be a filename");
	});

	it("sends a stored id straight through instead of re-uploading bytes", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-chain" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4" } }),
			() => new Response(new Uint8Array([12])),
		]);

		await videoGenTool.execute(
			"call-chain",
			{
				prompt: "shot two",
				output_path: outputPath,
				mode: "extend",
				video: "file_abc-123",
				duration: 5,
			},
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls[0].url).toBe("https://api.x.ai/v1/videos/extensions");
		expect(calls[0].body?.video).toEqual({ file_id: "file_abc-123" });
	});

	it("keeps xAI Files inputs away from OpenRouter", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);

		const result = await videoGenTool.execute(
			"call-or-file",
			{
				prompt: "animate",
				output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`,
				image: "file_abc-123",
			},
			undefined,
			createContext(fetchMock, { openrouter: true }),
		);

		expect(calls).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("xAI Files");
	});

	it("never buys a second video when the first submission dies in transit", async () => {
		setVideoProviderOrder(["xai", "openrouter"]);
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => {
				throw new Error("socket hang up");
			},
		]);

		const result = await videoGenTool.execute(
			"call-transport",
			{ prompt: "a red balloon", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4` },
			undefined,
			createContext(fetchMock, { xai: true, openrouter: true }),
		);

		// The POST was already on the wire, so the job may exist and be billing.
		// Falling through to OpenRouter would pay for a second video.
		expect(calls).toHaveLength(1);
		expect(result.isError).toBe(true);
	});

	it("refuses a blank image instead of billing a text-to-video", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);

		const result = await videoGenTool.execute(
			"call-blank-image",
			{ prompt: "animate this", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`, image: "" },
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(calls).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(resultText(result)).toContain("`image` is blank");
	});

	it("enforces the known model limits when the caller pins the model by hand", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);
		const base = { prompt: "x", output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4` };
		const ctx = createContext(fetchMock, { xai: true });

		const pinnedNo1080 = await videoGenTool.execute(
			"call-pin-a",
			{ ...base, model: "grok-imagine-video", image: "https://example.test/still.png", resolution: "1080p" },
			undefined,
			ctx,
		);
		const pinnedTextOnly = await videoGenTool.execute(
			"call-pin-b",
			{ ...base, model: "grok-imagine-video-1.5" },
			undefined,
			ctx,
		);

		expect(calls).toHaveLength(0);
		expect(resultText(pinnedNo1080)).toContain("does not serve 1080p");
		expect(resultText(pinnedTextOnly)).toContain("image-to-video only");
	});

	it("prefers a real local file over reading its name as a Files id", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		// A bare name that matches the Files id grammar exactly, resolved against
		// the session cwd (/tmp in these tests) — the ambiguous case.
		const sourceName = `file_${Bun.randomUUIDv7()}`;
		writtenPaths.push(outputPath, `/tmp/${sourceName}`);
		await Bun.write(`/tmp/${sourceName}`, ftypBox("isom", ["isom"]));
		const { fetch: fetchMock, calls } = sequencedFetch([
			() => json({ request_id: "req-localfile" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4" } }),
			() => new Response(new Uint8Array([14])),
		]);

		await videoGenTool.execute(
			"call-localfile",
			{ prompt: "keep going", output_path: outputPath, mode: "extend", video: sourceName },
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		const video = calls[0].body?.video as { url?: string };
		expect(video.url?.startsWith("data:video/mp4;base64,")).toBe(true);
	});

	it("says so when a stored request comes back without a Files receipt", async () => {
		const outputPath = `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`;
		writtenPaths.push(outputPath);
		const { fetch: fetchMock } = sequencedFetch([
			() => json({ request_id: "req-noreceipt" }),
			() => json({ status: "done", video: { url: "https://vidgen.x.ai/out.mp4" } }),
			() => new Response(new Uint8Array([15])),
		]);

		const result = await videoGenTool.execute(
			"call-noreceipt",
			{ prompt: "shot one", output_path: outputPath, store: "shot-one.mp4" },
			undefined,
			createContext(fetchMock, { xai: true }),
		);

		expect(result.isError).toBeUndefined();
		expect(resultText(result)).toContain("file_id=none");
	});

	it("blames the missing xAI login, not OpenRouter's feature set", async () => {
		const { fetch: fetchMock, calls } = sequencedFetch([]);

		const result = await videoGenTool.execute(
			"call-nocreds",
			{
				prompt: "keep going",
				output_path: `/tmp/omp-video-${Bun.randomUUIDv7()}.mp4`,
				mode: "extend",
				video: "https://example.test/source.mp4",
			},
			undefined,
			createContext(fetchMock, {}),
		);

		expect(calls).toHaveLength(0);
		expect(resultText(result)).toContain("No video generation credentials");
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

describe("VideoJobPoller body handling", () => {
	it("spends the retry budget on an unreadable body rather than abandoning the job", async () => {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			return attempt === 1
				? new Response("<truncated", { status: 200, headers: { "content-type": "application/json" } })
				: json({ status: "pending" });
		}) as unknown as typeof fetch;
		const subject = new VideoJobPoller("test", "static-key", () => ({}), fetchMock, new AbortController().signal);

		// A body that will not decode is as transient as the fetch failing; the
		// generation is still running and paid for.
		expect(await subject.poll("https://example.test/job")).toBeNull();
		expect(await subject.poll<{ status: string }>("https://example.test/job")).toEqual({ status: "pending" });
	});

	it("retries a transient status whose error body cannot be read", async () => {
		// `readErrorMessage` must not reject before the retryable-status branch is
		// reached, or one truncated 503 abandons a paid job.
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			if (attempt > 1) return json({ status: "pending" });
			const broken = new ReadableStream({
				start(controller) {
					controller.error(new Error("connection reset mid-body"));
				},
			});
			return new Response(broken, { status: 503 });
		}) as unknown as typeof fetch;
		const subject = new VideoJobPoller("test", "static-key", () => ({}), fetchMock, new AbortController().signal);

		expect(await subject.poll("https://example.test/job")).toBeNull();
		expect(await subject.poll<{ status: string }>("https://example.test/job")).toEqual({ status: "pending" });
	});
});
