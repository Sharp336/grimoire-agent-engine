import { describe, expect, it } from "bun:test";
import type { BridgeMessage } from "@oh-my-pi/prime-bridge-protocol";
import {
	createExternalPeerProvider,
	type ExternalPeerProvider,
	type PrimeBridgeEnsure,
	PrimeExternalPeerProvider,
	type PrimeExternalPeerProviderOptions,
} from "../src/integrations/prime-bridge";

interface RecordedRequest {
	url: string;
	init: RequestInit | undefined;
}

function message(overrides: Partial<BridgeMessage> & Record<string, unknown> = {}): BridgeMessage {
	return {
		meshMessageId: "mesh-1",
		idempotencyKey: "idem-1",
		originHarness: "prime",
		originSessionId: "prime-session",
		targetHarness: "omp",
		targetId: "omp-session",
		body: "hello",
		projectRoot: "/repo",
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as BridgeMessage;
}

function dependencies(
	responses: Response[],
	requests: RecordedRequest[],
	readCount: { value: number },
	ensureReady?: PrimeBridgeEnsure,
): PrimeExternalPeerProviderOptions {
	return {
		enabled: true,
		autoStart: false,
		url: "http://127.0.0.1:4123/",
		tokenPath: "/tmp/prime-bridge-token",
		originSessionId: "omp-session",
		projectRoot: "/repo",
		ensureReady,
		readFile: async () => {
			readCount.value += 1;
			return "secret-token\n";
		},
		fetch: async (input, init) => {
			requests.push({ url: String(input), init });
			if (String(input).endsWith("/v1/peers") && init?.method === "POST")
				return Response.json({ id: "omp-session", displayName: "omp-session", status: "running" });
			return responses.shift() ?? new Response("missing response", { status: 500 });
		},
	};
}

function provider(options: PrimeExternalPeerProviderOptions): ExternalPeerProvider {
	const result = createExternalPeerProvider(options);
	if (!result) throw new Error("provider should be enabled");
	return result;
}

describe("PrimeExternalPeerProvider", () => {
	it("uses bearer auth and preserves peer DTO fields", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const peer = { id: "prime-1", displayName: "Prime", status: "ready", extra: { keep: true } };
		const peers = await provider(dependencies([Response.json([peer])], requests, readCount)).list();

		expect(peers).toEqual([peer]);
		expect(readCount.value).toBe(2);
		expect(requests[0]?.url).toBe("http://127.0.0.1:4123/v1/peers");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[1]?.url).toBe("http://127.0.0.1:4123/v1/peers?targetHarness=prime");
		expect(requests[1]?.init?.method).toBe("GET");
		expect(requests[1]?.init?.headers).toEqual({ authorization: "Bearer secret-token" });
	});

	it("sends the documented message body and preserves receipt fields", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const receipt = {
			meshMessageId: "server-id",
			status: "queued" as const,
			deliveryAttempt: 2,
			nested: { value: true },
		};
		const result = await provider(dependencies([Response.json(receipt)], requests, readCount)).send(
			"prime-42",
			"hello",
			"reply-1",
		);
		const body = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>;

		expect(result).toEqual(receipt);
		expect(requests[1]?.url).toBe("http://127.0.0.1:4123/v1/messages");
		expect(requests[1]?.init?.method).toBe("POST");
		expect(requests[1]?.init?.headers).toEqual({
			authorization: "Bearer secret-token",
			"content-type": "application/json",
		});
		expect(body).toMatchObject({
			originHarness: "omp",
			targetHarness: "prime",
			originSessionId: "omp-session",
			projectRoot: "/repo",
			targetId: "prime-42",
			body: "hello",
			replyTo: "reply-1",
		});
		expect(typeof body.meshMessageId).toBe("string");
		expect(typeof body.idempotencyKey).toBe("string");
		expect(body.meshMessageId).not.toBe(body.idempotencyKey);
	});

	it("uses the inbox peek query and wait body", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const incoming = message({ extra: "preserve" });
		const peer = provider(dependencies([Response.json([incoming]), Response.json(null)], requests, readCount));

		expect(await peer.inbox(true)).toEqual([incoming]);
		expect(await peer.wait(undefined, 25)).toBeNull();
		expect(requests[1]?.url).toBe("http://127.0.0.1:4123/v1/inbox?targetId=omp-session&peek=true");
		expect(requests[3]?.url).toBe("http://127.0.0.1:4123/v1/wait");
		expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({ targetId: "omp-session", timeoutMs: 25 });
	});

	it("preserves an incoming claim returned by wait", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const incoming = message({ metadata: { source: "prime" } });
		const claim = { message: incoming, claimToken: "claim-token", claimedUntilMs: 1234 };
		const abort = new AbortController();
		const result = await provider(dependencies([Response.json(claim)], requests, readCount)).wait(
			"omp-session",
			100,
			abort.signal,
		);

		expect(result).toEqual(claim);
		expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
			targetId: "omp-session",
			from: "omp-session",
			timeoutMs: 100,
		});
		expect(requests[1]?.init?.signal).toBe(abort.signal);
	});

	it("rejects malformed Unicode in incoming session IDs", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const claim = {
			message: message({ originSessionId: "\uD800" }),
			claimToken: "claim-token",
			claimedUntilMs: 1234,
		};

		await expect(
			provider(dependencies([Response.json(claim)], requests, readCount)).wait(undefined, 100),
		).rejects.toThrow("invalid originSessionId");
	});

	it("releases a shallow-valid claim when claimed message validation fails", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const claim = {
			message: message({ originSessionId: "\uD800" }),
			claimToken: "claim-token",
			claimedUntilMs: 1234,
		};
		const peer = provider(dependencies([Response.json(claim), Response.json({ ok: true })], requests, readCount));

		await expect(peer.wait(undefined, 100)).rejects.toThrow("invalid originSessionId");

		const releases = requests.filter(request => request.url.endsWith("/v1/wait/release"));
		expect(releases).toHaveLength(1);
		expect(JSON.parse(String(releases[0]?.init?.body))).toEqual({ claimToken: "claim-token" });
	});

	it("acknowledges and releases opaque wait claims", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const peer = provider(
			dependencies([Response.json({ ok: true }), Response.json({ ok: false })], requests, readCount),
		);

		expect(await peer.ack("claim-token")).toBe(true);
		expect(await peer.release("claim-token")).toBe(false);
		expect(requests[1]?.url).toBe("http://127.0.0.1:4123/v1/wait/ack");
		expect(requests[3]?.url).toBe("http://127.0.0.1:4123/v1/wait/release");
	});

	it("ensures bridge readiness before every HTTP operation", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const events: string[] = [];
		let ready = false;
		const ensureReady: PrimeBridgeEnsure = async () => {
			events.push("ensure");
			await Promise.resolve();
			ready = true;
		};
		const options = dependencies(
			[
				Response.json([{ id: "prime-1", displayName: "Prime", status: "ready" }]),
				Response.json({ meshMessageId: "server-id", status: "queued" }),
				Response.json([]),
				Response.json(null),
			],
			requests,
			readCount,
			ensureReady,
		);
		const fetch = options.fetch;
		options.fetch = async (input, init) => {
			expect(ready).toBe(true);
			events.push("http");
			if (!fetch) throw new Error("fetch dependency is required");
			return await fetch(input, init);
		};
		const peer = provider(options);

		await peer.list();
		await peer.send("prime-42", "hello");
		await peer.inbox(false);
		await peer.wait(undefined, 25);

		expect(events).toEqual([
			"ensure",
			"http",
			"http",
			"ensure",
			"http",
			"http",
			"ensure",
			"http",
			"http",
			"ensure",
			"http",
			"http",
		]);
	});

	it("keeps autoStart false request-only when no readiness callback is injected", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const peer = provider(dependencies([Response.json([])], requests, readCount));

		await peer.list();

		expect(readCount.value).toBe(2);
		expect(requests).toHaveLength(2);
	});

	it("prevents token and network access when readiness fails", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const options = dependencies([], requests, readCount, async () => {
			throw new Error("bridge unavailable");
		});

		await expect(provider(options).list()).rejects.toThrow("bridge unavailable");
		expect(readCount.value).toBe(0);
		expect(requests).toEqual([]);
	});

	it.each([401, 403, 500])("maps HTTP %s to a safe explicit error", async status => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const request = provider(dependencies([new Response("secret body", { status })], requests, readCount)).list();

		await expect(request).rejects.toMatchObject({ status });
		await expect(request).rejects.toThrow(`Prime bridge request failed (${status})`);
	});

	it("does not touch filesystem or network when disabled or defaulted", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		const options = dependencies([], requests, readCount);
		options.enabled = false;

		expect(createExternalPeerProvider(options)).toBeUndefined();
		expect(createExternalPeerProvider()).toBeUndefined();
		expect(requests).toEqual([]);
		expect(readCount.value).toBe(0);
	});

	it("requires complete configuration when enabled", () => {
		expect(() => createExternalPeerProvider({ enabled: true })).toThrow("url");
	});

	it.each(["https://example.com:4123/", "http://127.0.0.1:4123/prefix", "http://user:secret@127.0.0.1:4123/"])(
		"rejects non-local bridge URL %s before token access",
		url => {
			const requests: RecordedRequest[] = [];
			const readCount = { value: 0 };
			const options = dependencies([], requests, readCount);
			options.url = url;

			expect(() => new PrimeExternalPeerProvider(options)).toThrow("loopback HTTP URL");
			expect(readCount.value).toBe(0);
			expect(requests).toEqual([]);
		},
	);

	it("honors autoStart readiness when directly constructed", async () => {
		const requests: RecordedRequest[] = [];
		const readCount = { value: 0 };
		let ensureCalls = 0;
		const options = dependencies([Response.json([])], requests, readCount, async () => {
			ensureCalls += 1;
		});
		options.autoStart = true;

		await new PrimeExternalPeerProvider(options).list();

		expect(ensureCalls).toBe(1);
	});

	it("exposes the concrete provider class for explicit construction", () => {
		expect(PrimeExternalPeerProvider).toBeDefined();
	});
});
