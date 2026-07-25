import { afterEach, describe, expect, it } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MAX_POLL_FAILURES,
	setVideoProviderOrder,
	VideoJobPoller,
	videoGenTool,
} from "@oh-my-pi/pi-coding-agent/tools/video-gen";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const writtenPaths: string[] = [];

afterEach(async () => {
	await Promise.all(writtenPaths.splice(0).map(target => removeWithRetries(target)));
	setVideoProviderOrder([]);
});

interface CredentialedProviders {
	xai?: boolean;
	openrouter?: boolean;
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
				provider === "openrouter" ? "test-openrouter-key" : "test-xai-token",
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
			() => json({ status: "completed", unsigned_urls: ["https://cdn.openrouter.ai/job-1.mp4"] }),
			() => new Response(new Uint8Array([7, 7])),
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
		expect(result.details).toMatchObject({
			provider: "openrouter",
			model: "google/veo-3.1-fast",
			requestId: "job-1",
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
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("XAI_API_KEY") });
	});
});

describe("VideoJobPoller", () => {
	function poller(handler: (attempt: number) => Response | Promise<never>): VideoJobPoller {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			return handler(attempt);
		}) as unknown as typeof fetch;
		return new VideoJobPoller("test", {}, fetchMock, new AbortController().signal);
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
