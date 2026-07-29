import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";

function captureRequestBodies(): string[] {
	const bodies: string[] = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			bodies.push(String(init?.body ?? ""));
			return new Response("{}", { status: 200 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return bodies;
}

function captureAuthorizationHeaders(): (string | undefined)[] {
	const headers: (string | undefined)[] = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			headers.push(new Headers(init?.headers).get("Authorization") ?? undefined);
			return new Response("{}", { status: 200 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return headers;
}

function firstTimestamp(bodyText: string): string | undefined {
	const body: unknown = JSON.parse(bodyText);
	if (typeof body !== "object" || body === null) return undefined;

	const items = Object.getOwnPropertyDescriptor(body, "items")?.value;
	if (!Array.isArray(items)) return undefined;

	const first = items[0];
	if (typeof first !== "object" || first === null) return undefined;

	const timestamp = Object.getOwnPropertyDescriptor(first, "timestamp")?.value;
	return typeof timestamp === "string" ? timestamp : undefined;
}

describe("HindsightApi timestamp serialization", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("serializes Date timestamps with the local timezone offset", async () => {
		const bodies = captureRequestBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });

		await client.retain("omp", "evening memory", {
			timestamp: new Date(2026, 5, 12, 19, 17, 0),
		});

		const timestamp = firstTimestamp(bodies[0] ?? "{}");
		if (timestamp === undefined) throw new Error("Missing serialized timestamp");
		expect(timestamp).toMatch(/^2026-06-12T19:17:00[+-]\d{2}:\d{2}$/);
		expect(timestamp.endsWith("Z")).toBe(false);
	});

	it("preserves caller-provided timestamp strings", async () => {
		const bodies = captureRequestBodies();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });

		await client.retain("omp", "evening memory", {
			timestamp: "2026-06-12T19:17:00+08:00",
		});

		expect(firstTimestamp(bodies[0] ?? "{}")).toBe("2026-06-12T19:17:00+08:00");
	});
});

describe("HindsightApi authorization", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends a plain token as a bearer credential", async () => {
		const headers = captureAuthorizationHeaders();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local", apiKey: "hs-token" });

		await client.recall("omp", "query");

		expect(headers[0]).toBe("Bearer hs-token");
	});

	it("sends a user:password credential as HTTP Basic auth", async () => {
		const headers = captureAuthorizationHeaders();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local", apiKey: "memory:s3cr3t" });

		await client.recall("omp", "query");

		expect(headers[0]).toBe("Basic bWVtb3J5OnMzY3IzdA==");
	});

	it("omits the authorization header when no credential is configured", async () => {
		const headers = captureAuthorizationHeaders();
		const client = new HindsightApi({ baseUrl: "http://hindsight.local" });

		await client.recall("omp", "query");

		expect(headers[0]).toBeUndefined();
	});
});
