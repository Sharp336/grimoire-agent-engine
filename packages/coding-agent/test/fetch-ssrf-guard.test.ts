import { afterEach, describe, expect, it, vi } from "bun:test";
import { isLocalOrMetadataHost } from "@oh-my-pi/pi-ai";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { fetchBinary } from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

/**
 * Build a fetch mock that preserves `preconnect` (Bun's fetch type requires it).
 * The supplied handler receives the input URL and init, and returns a Response.
 */
function mockFetch(handler: (input: FetchInput, init?: FetchInit) => Promise<Response> | Response): void {
	const fetchMock = Object.assign(
		async (input: FetchInput, init?: FetchInit): Promise<Response> => handler(input, init),
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

function makeOkResponse(body: string, _url: string, contentType = "text/html; charset=utf-8"): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": contentType },
	});
}

function makeRedirectResponse(location: string, status = 302): Response {
	return new Response(null, {
		status,
		headers: { location },
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isLocalOrMetadataHost — the hardened classifier shared by both fetch paths.
// ---------------------------------------------------------------------------

describe("isLocalOrMetadataHost SSRF classifier", () => {
	const blocked = [
		// Loopback
		"127.0.0.1",
		"127.255.255.255",
		"::1",
		"0:0:0:0:0:0:0:1",
		"0000:0000:0000:0000:0000:0000:0000:0001",
		// IPv4-mapped IPv6 (critical bypass vector that string matching missed)
		"::ffff:127.0.0.1",
		"::ffff:10.0.0.1",
		"::ffff:192.168.1.1",
		"::ffff:172.16.0.1",
		"::ffff:169.254.169.254",
		// RFC1918 private
		"10.0.0.1",
		"10.255.255.255",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"192.168.0.0",
		// Unspecified
		"0.0.0.0",
		"::",
		// Link-local (covers IMDS + ECS)
		"169.254.169.254",
		"169.254.170.2",
		"fe80::1",
		// Unique-local (covers EC2 IPv6 IMDS)
		"fc00::1",
		"fd00:ec2::254",
		// Hostnames
		"localhost",
		"app.localhost",
		"metadata.google.internal",
	];

	for (const host of blocked) {
		it(`blocks ${host}`, () => {
			expect(isLocalOrMetadataHost(host)).toBe(true);
		});
	}

	const allowed = [
		"8.8.8.8",
		"1.1.1.1",
		"172.15.0.1",
		"172.32.0.1",
		"11.0.0.1",
		"example.com",
		"api.openai.com",
		"::ffff:8.8.8.8",
		"2606:4700:4700::1111",
	];

	for (const host of allowed) {
		it(`allows ${host}`, () => {
			expect(isLocalOrMetadataHost(host)).toBe(false);
		});
	}
});

// ---------------------------------------------------------------------------
// loadPage — SSRF guard on the initial URL.
// ---------------------------------------------------------------------------

describe("loadPage SSRF guard — initial URL", () => {
	const blockedUrls = [
		// Loopback
		"http://127.0.0.1/",
		"http://127.5.5.5:8080/",
		"http://[::1]/",
		// RFC1918 private
		"http://10.0.0.1/",
		"http://172.16.0.1/",
		"http://192.168.1.1/",
		// Link-local / metadata
		"http://169.254.169.254/latest/meta-data/",
		"http://169.254.170.2/",
		// Hostnames
		"http://localhost/",
		"http://metadata.google.internal/",
		// IPv4-mapped IPv6 bypass vectors
		"http://[::ffff:127.0.0.1]/",
		"http://[0:0:0:0:0:0:0:1]/",
	];

	for (const url of blockedUrls) {
		it(`refuses ${url}`, async () => {
			// fetch must never be called for a blocked URL.
			let fetchCalled = false;
			mockFetch(() => {
				fetchCalled = true;
				return makeOkResponse("should not reach", url);
			});
			const result = await scrapers.loadPage(url);
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/Refused to fetch non-public address/);
			expect(fetchCalled).toBe(false);
		});
	}
});

// ---------------------------------------------------------------------------
// loadPage — redirect guard: public URL that redirects to a private address.
// ---------------------------------------------------------------------------

describe("loadPage SSRF guard — redirect to internal address", () => {
	it("blocks a 302 redirect from a public URL to 127.0.0.1", async () => {
		mockFetch(input => {
			const urlStr = input.toString();
			if (urlStr.includes("example.com")) {
				return makeRedirectResponse("http://127.0.0.1/secret");
			}
			// Should never reach the internal target.
			return makeOkResponse("should not reach", urlStr);
		});
		const result = await scrapers.loadPage("https://example.com/redirect");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Refused to fetch non-public address: 127\.0\.0\.1/);
	});

	it("blocks a 301 redirect to 169.254.169.254 (cloud metadata)", async () => {
		mockFetch(input => {
			const urlStr = input.toString();
			if (urlStr.includes("example.com")) {
				return makeRedirectResponse("http://169.254.169.254/latest/meta-data/", 301);
			}
			return makeOkResponse("should not reach", urlStr);
		});
		const result = await scrapers.loadPage("https://example.com/meta");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Refused to fetch non-public address: 169\.254\.169\.254/);
	});

	it("blocks a redirect chain that hops through a public host then to 10.0.0.1", async () => {
		mockFetch(input => {
			const urlStr = input.toString();
			if (urlStr.includes("example.com/page")) {
				return makeRedirectResponse("https://cdn.example.com/follow", 302);
			}
			if (urlStr.includes("cdn.example.com/follow")) {
				return makeRedirectResponse("http://10.0.0.1/internal", 302);
			}
			return makeOkResponse("should not reach", urlStr);
		});
		const result = await scrapers.loadPage("https://example.com/page");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Refused to fetch non-public address: 10\.0\.0\.1/);
	});

	it("blocks a redirect to localhost", async () => {
		mockFetch(input => {
			const urlStr = input.toString();
			if (urlStr.includes("example.com")) {
				return makeRedirectResponse("http://localhost:3000/admin");
			}
			return makeOkResponse("should not reach", urlStr);
		});
		const result = await scrapers.loadPage("https://example.com/");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Refused to fetch non-public address: localhost/);
	});
});

// ---------------------------------------------------------------------------
// loadPage — legitimate public URLs are not blocked.
// ---------------------------------------------------------------------------

describe("loadPage — legitimate public URLs", () => {
	it("fetches a public URL and returns content", async () => {
		let fetchedUrl = "";
		mockFetch(input => {
			fetchedUrl = input.toString();
			return makeOkResponse("<html><body>Hello</body></html>", fetchedUrl);
		});
		const result = await scrapers.loadPage("https://example.com/");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Hello");
		expect(fetchedUrl).toBe("https://example.com/");
	});

	it("follows a redirect between two public hosts", async () => {
		const fetchedUrls: string[] = [];
		mockFetch(input => {
			const urlStr = input.toString();
			fetchedUrls.push(urlStr);
			if (urlStr.includes("old.example.com")) {
				return makeRedirectResponse("https://new.example.com/page", 302);
			}
			return makeOkResponse("<html><body>Moved</body></html>", urlStr);
		});
		const result = await scrapers.loadPage("https://old.example.com/");
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Moved");
		expect(fetchedUrls).toContain("https://old.example.com/");
		expect(fetchedUrls).toContain("https://new.example.com/page");
	});
});

// ---------------------------------------------------------------------------
// fetchBinary — SSRF guard on the binary fetch path.
// ---------------------------------------------------------------------------

describe("fetchBinary SSRF guard", () => {
	it("refuses loopback addresses", async () => {
		let fetchCalled = false;
		mockFetch(() => {
			fetchCalled = true;
			return makeOkResponse("data", "http://127.0.0.1/");
		});
		const result = await fetchBinary("http://127.0.0.1/image.png");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/Refused to fetch non-public address/);
		expect(fetchCalled).toBe(false);
	});

	it("refuses cloud metadata endpoint", async () => {
		let fetchCalled = false;
		mockFetch(() => {
			fetchCalled = true;
			return makeOkResponse("data", "http://169.254.169.254/");
		});
		const result = await fetchBinary("http://169.254.169.254/latest/meta-data/");
		expect(result.ok).toBe(false);
		expect(fetchCalled).toBe(false);
	});

	it("blocks a redirect from a public URL to a private address", async () => {
		mockFetch(input => {
			const urlStr = input.toString();
			if (urlStr.includes("example.com")) {
				return makeRedirectResponse("http://10.0.0.1/secret.png");
			}
			return makeOkResponse("should not reach", urlStr);
		});
		const result = await fetchBinary("https://example.com/image.png");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/Refused to follow redirect to non-public address: 10\.0\.0\.1/);
	});

	it("fetches a public binary URL successfully", async () => {
		const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		mockFetch(() => {
			return new Response(pngBytes, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		});
		const result = await fetchBinary("https://example.com/image.png");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.buffer).toEqual(pngBytes);
		}
	});

	it("blocks a 302 redirect to a file:/// target", async () => {
		let fetchCalled = false;
		mockFetch(input => {
			const urlStr = input.toString();
			if (urlStr.includes("example.com")) {
				return makeRedirectResponse("file:///etc/hosts");
			}
			fetchCalled = true;
			return makeOkResponse("should not reach", urlStr);
		});
		const result = await fetchBinary("https://example.com/image.png");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/non-HTTP\(S\) protocol: file:/);
		expect(fetchCalled).toBe(false);
	});

	it("blocks a 302 redirect to a data: target", async () => {
		let fetchCalled = false;
		mockFetch(input => {
			const urlStr = input.toString();
			if (urlStr.includes("example.com")) {
				return makeRedirectResponse("data:text/html,<script>alert(1)</script>");
			}
			fetchCalled = true;
			return makeOkResponse("should not reach", urlStr);
		});
		const result = await fetchBinary("https://example.com/image.png");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/non-HTTP\(S\) protocol: data:/);
		expect(fetchCalled).toBe(false);
	});

	it("returns 'redirect loop exceeded' when the chain exceeds MAX_REDIRECTS", async () => {
		mockFetch(input => {
			const urlStr = input.toString();
			// Every hop redirects to itself, so the chain never terminates.
			return makeRedirectResponse(urlStr, 302);
		});
		const result = await fetchBinary("https://example.com/image.png");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/Redirect loop exceeded/);
	});
});

// ---------------------------------------------------------------------------
// loadPage — cross-protocol redirect targets are rejected.
// ---------------------------------------------------------------------------

describe("loadPage — cross-protocol redirect guard", () => {
	it("blocks a 302 redirect to file:///", async () => {
		let fetchCalled = false;
		mockFetch(input => {
			const urlStr = input.toString();
			if (urlStr.includes("example.com")) {
				return makeRedirectResponse("file:///etc/hosts");
			}
			fetchCalled = true;
			return makeOkResponse("should not reach", urlStr);
		});
		const result = await scrapers.loadPage("https://example.com/");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/non-HTTP\(S\) protocol: file:/);
		expect(fetchCalled).toBe(false);
	});

	it("blocks a 301 redirect to a data: URI", async () => {
		let fetchCalled = false;
		mockFetch(input => {
			const urlStr = input.toString();
			if (urlStr.includes("example.com")) {
				return makeRedirectResponse("data:text/html,<h1>hi</h1>", 301);
			}
			fetchCalled = true;
			return makeOkResponse("should not reach", urlStr);
		});
		const result = await scrapers.loadPage("https://example.com/");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/non-HTTP\(S\) protocol: data:/);
		expect(fetchCalled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// loadPage — POST downgrades to GET on 301/302/303 (RFC 9110 §15.4).
// ---------------------------------------------------------------------------

describe("loadPage — method downgrade on redirect", () => {
	it("downgrades POST to GET on a 302 redirect", async () => {
		const methods: string[] = [];
		mockFetch((input, init) => {
			const urlStr = input.toString();
			methods.push(init?.method ?? "GET");
			if (urlStr.includes("example.com/submit")) {
				return makeRedirectResponse("https://cdn.example.org/result", 302);
			}
			return makeOkResponse("<html><body>OK</body></html>", urlStr);
		});
		const result = await scrapers.loadPage("https://example.com/submit", { method: "POST", body: "data" });
		expect(result.ok).toBe(true);
		// First hop: POST (original), second hop: GET (downgraded).
		expect(methods).toEqual(["POST", "GET"]);
	});

	it("preserves POST on a 307 redirect", async () => {
		const methods: string[] = [];
		mockFetch((input, init) => {
			const urlStr = input.toString();
			methods.push(init?.method ?? "GET");
			if (urlStr.includes("example.com/submit")) {
				return makeRedirectResponse("https://cdn.example.org/result", 307);
			}
			return makeOkResponse("<html><body>OK</body></html>", urlStr);
		});
		const result = await scrapers.loadPage("https://example.com/submit", { method: "POST", body: "data" });
		expect(result.ok).toBe(true);
		// 307 preserves the method and body.
		expect(methods).toEqual(["POST", "POST"]);
	});
});
