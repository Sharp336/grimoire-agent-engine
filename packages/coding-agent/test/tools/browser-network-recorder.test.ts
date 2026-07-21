import { describe, expect, it } from "bun:test";
import {
	DEFAULT_RECORDING_LIMITS,
	NetworkRecorder,
	type NetworkRecorderOptions,
	normalizeRecordingOrigins,
} from "@oh-my-pi/pi-coding-agent/tools/browser/network-recorder";

const options: NetworkRecorderOptions = {
	...DEFAULT_RECORDING_LIMITS,
	origins: new Set(["https://shop.test"]),
};

function request(overrides: Partial<Parameters<NetworkRecorder["recordRequest"]>[0]> = {}) {
	return {
		requestId: "r1",
		url: "https://shop.test/api/items",
		method: "GET",
		headers: { "content-type": "application/json" },
		timestamp: 1,
		...overrides,
	};
}

function response(overrides: Partial<Parameters<NetworkRecorder["recordResponse"]>[0]> = {}) {
	return {
		requestId: "r1",
		url: "https://shop.test/api/items",
		method: "GET",
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		contentType: "application/json",
		timestamp: 2,
		...overrides,
	};
}

describe("NetworkRecorder", () => {
	it("redacts URL, header, nested-body, and cookie secrets in the safe HAR subset", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest({
			requestId: "r1",
			url: "https://shop.test/api/cart?access_token=url-secret&item=42#code=fragment-secret",
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer header-secret",
				cookie: "session=cookie-secret; theme=dark",
			},
			postData: '{"user":{"password":"body-secret","accountId":"account-secret"},"itemId":"42"}',
			timestamp: 1,
		});
		recorder.recordResponse({
			requestId: "r1",
			url: "https://shop.test/api/cart",
			method: "POST",
			status: 200,
			statusText: "OK",
			headers: { "content-type": "application/json", "set-cookie": "session=response-secret; Secure" },
			contentType: "application/json",
			timestamp: 2,
		});
		recorder.recordResponseBody("r1", '{"ok":true,"refresh_token":"response-body-secret"}');

		const result = recorder.finish();
		const serialized = JSON.stringify(result.har);
		expect(serialized).not.toContain("url-secret");
		expect(serialized).not.toContain("fragment-secret");
		expect(serialized).not.toContain("header-secret");
		expect(serialized).not.toContain("cookie-secret");
		expect(serialized).not.toContain("body-secret");
		expect(serialized).not.toContain("response-secret");
		expect(serialized).not.toContain("response-body-secret");
		expect(serialized).toContain('\\"itemId\\":\\"42\\"');
	});

	it("filters to exact HTTP origins and keeps safe paths", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(request({ requestId: "out", url: "https://shop.test.evil/api" }));
		recorder.recordResponse(response({ requestId: "out", url: "https://shop.test.evil/api" }));
		recorder.recordRequest(request({ requestId: "http", url: "https://shop.test/api/v1/items" }));
		recorder.recordResponse(response({ requestId: "http", url: "https://shop.test/api/v1/items" }));
		recorder.recordRequest(request({ requestId: "opaque", url: "https://shop.test/reset/abcdef0123456789abcdef" }));
		recorder.recordResponse(response({ requestId: "opaque", url: "https://shop.test/reset/abcdef0123456789abcdef" }));
		recorder.recordRequest(request({ requestId: "letters", url: "https://shop.test/recovery/abcdefghijklmnopqrs" }));
		recorder.recordResponse(
			response({ requestId: "letters", url: "https://shop.test/recovery/abcdefghijklmnopqrs" }),
		);
		const result = recorder.finish();
		expect(result.entryCount).toBe(3);
		expect(JSON.stringify(result.har)).toContain("/api/v1/items");
		expect(JSON.stringify(result.har)).not.toContain("abcdef0123456789abcdef");
		expect(JSON.stringify(result.har)).not.toContain("abcdefghijklmnopqrs");
	});

	it("redacts OAuth, JWT, account, and PII values in URLs and nested JSON/form bodies", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(
			request({
				url: "https://shop.test/oauth?state=state-secret&nonce=nonce-secret&code_verifier=verifier-secret&code_challenge=challenge-secret&assertion=assertion-secret&email=e@example.test&accountId=acct-secret",
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-goog-api-key": "goog-secret",
					"x-api-key": "api-secret",
					"x-amzn-trace-id": "trace-secret",
					"x-ms-request-id": "ms-secret",
					"x-user-email": "email-secret",
					"x-user-id": "user-secret",
					"x-account-id": "account-secret",
					"x-customer-id": "customer-secret",
					"x-org-id": "org-secret",
					"cf-connecting-ip": "ip-secret",
					"x-forwarded-for": "forwarded-secret",
				},
				postData: "grant_type=password&password=hunter2&userId=alice&safe=value",
			}),
		);
		recorder.recordResponse(response({ url: "https://shop.test/oauth", method: "POST" }));
		recorder.recordResponseBody(
			"r1",
			JSON.stringify({
				nested: { nonce: "secret", account: { email: "x@y.test" } },
				safe: "ok",
				jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
			}),
		);
		const serialized = JSON.stringify(recorder.finish().har);
		for (const secret of [
			"state-secret",
			"nonce-secret",
			"verifier-secret",
			"challenge-secret",
			"assertion-secret",
			"e@example.test",
			"acct-secret",
			"goog-secret",
			"api-secret",
			"trace-secret",
			"ms-secret",
			"email-secret",
			"user-secret",
			"account-secret",
			"customer-secret",
			"org-secret",
			"ip-secret",
			"forwarded-secret",
			"hunter2",
			"alice",
			"eyJhbGciOiJIUzI1NiJ9",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).toContain('\\"grant_type\\":\\"password\\"');
	});

	it("preserves response-only metadata and counts correlation omissions", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordResponse(response({ requestId: "missing", method: undefined }));
		const result = recorder.finish();
		expect(result.entryCount).toBe(1);
		expect(result.omittedBodyCount).toBe(1);
		expect(JSON.stringify(result.har)).toContain('"method":"UNKNOWN"');
	});

	it("handles body-before-response, omitted reasons, and unknown body correlation", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(request({ method: "POST" }));
		recorder.recordResponseBody("r1", '{"ok":true}');
		recorder.recordResponse(response({ method: "POST" }));
		recorder.recordBodyOmitted("r1", "timeout");
		recorder.recordBodyOmitted("missing", "correlation");
		const result = recorder.finish();
		expect(result.capturedBodyCount).toBe(1);
		expect(result.omittedBodyCount).toBe(1);
	});

	it("enforces entry, body, and total-byte limits and reports truncation", () => {
		const recorder = new NetworkRecorder({ ...options, maxEntries: 1, maxBodyBytes: 4, maxTotalBytes: 1200 });
		recorder.recordRequest(request({ method: "POST", postData: "12345" }));
		recorder.recordResponse(response({ method: "POST" }));
		recorder.recordResponseBody("r1", "{}");
		recorder.recordRequest(request({ requestId: "r2", url: "https://shop.test/second" }));
		recorder.recordResponse(response({ requestId: "r2", url: "https://shop.test/second" }));
		const result = recorder.finish();
		expect(result.entryCount).toBe(1);
		expect(result.capturedBodyCount).toBe(1);
		expect(result.truncated).toBe(true);
		expect(result.totalBytes).toBeLessThanOrEqual(1200);
	});

	it("bounds body-before-response storage and counts each rejected body once", () => {
		const recorder = new NetworkRecorder({ ...options, maxEntries: 1, maxBodyBytes: 4, maxTotalBytes: 1200 });
		recorder.recordResponseBody("too-large", "12345");
		recorder.recordResponseBody("too-large", "67890");
		recorder.recordResponseBody("pending", "{}");
		recorder.recordResponseBody("over-capacity", "{}");
		const result = recorder.finish();
		expect(result.capturedBodyCount).toBe(0);
		expect(result.omittedBodyCount).toBe(3);
	});

	it("finish is idempotent and dispose rejects capture", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(request());
		const first = recorder.finish();
		expect(recorder.finish()).toEqual(first);
		recorder.dispose();
		expect(() => recorder.recordRequest(request({ requestId: "r2" }))).toThrow();
	});
	it("rejects opaque about:blank and invalid recording origins during normalization", () => {
		expect(() => normalizeRecordingOrigins(["about:blank"])).toThrow();
		expect(() => normalizeRecordingOrigins(["https://shop.test/path"])).toThrow();
		expect(normalizeRecordingOrigins(["HTTPS://SHOP.TEST"])).toEqual(new Set(["https://shop.test"]));
		expect(() => new NetworkRecorder({ ...options, maxTotalBytes: 1 })).toThrow(/maxTotalBytes/);
	});

	it("counts an uncorrelated late body exactly once", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordResponseBody("missing", '{"ok":true}');
		recorder.recordBodyOmitted("missing", "timeout");
		expect(recorder.finish().omittedBodyCount).toBe(1);
	});

	it("redacts normalized camel/snake/kebab sensitive keys and scheme credential values", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(
			request({
				method: "POST",
				postData: JSON.stringify({
					sessionToken: "camel-token-secret",
					account_id: "snake-account-secret",
					csrfToken: "csrf-secret",
					emailAddress: "person@corp.test",
					note: "Bearer eyJhbGciOiJIUzI1NiJ9payload0123456789",
					basicAuth: "Basic dXNlcjpwYXNzd29yZA==",
					itemCount: 42,
				}),
			}),
		);
		recorder.recordResponse(response({ method: "POST" }));
		const serialized = JSON.stringify(recorder.finish().har);
		for (const secret of [
			"camel-token-secret",
			"snake-account-secret",
			"csrf-secret",
			"person@corp.test",
			"eyJhbGciOiJIUzI1NiJ9payload0123456789",
			"dXNlcjpwYXNzd29yZA==",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).toContain("itemCount");
	});

	it("sanitizes URL-bearing response headers including Location, Content-Location, Link, and Refresh", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(request());
		recorder.recordResponse(
			response({
				status: 302,
				headers: {
					"content-type": "application/json",
					location: "https://shop.test/callback?token=loc-query-secret#frag-secret",
					"content-location": "/reset/abcdef0123456789abcdef?code=cl-secret",
					link: '</next?token=link-secret>; rel="next"',
					refresh: "5; url=https://shop.test/go?token=refresh-secret",
				},
			}),
		);
		const serialized = JSON.stringify(recorder.finish().har);
		for (const secret of [
			"loc-query-secret",
			"frag-secret",
			"cl-secret",
			"link-secret",
			"refresh-secret",
			"abcdef0123456789abcdef",
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).toContain("shop.test/callback");
	});

	it("counts a pre-response body exactly once when response metadata never arrives", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(request({ method: "POST" }));
		recorder.recordResponseBody("r1", '{"ok":true}');
		const result = recorder.finish();
		expect(result.capturedBodyCount).toBe(0);
		expect(result.omittedBodyCount).toBe(1);
	});

	it("redacts the complete Refresh url= target across path-parameter, quoted, and relative forms", () => {
		const cases: Record<string, string[]> = {
			"5; url=https://shop.test/go;session=matrix-secret?token=query-secret": ["matrix-secret", "query-secret"],
			"3; url='https://shop.test/go?token=quoted-secret'": ["quoted-secret"],
			'2; url="https://shop.test/go?token=dquoted-secret"': ["dquoted-secret"],
			"0; url=/reset/abcdef0123456789abcdef?token=relative-secret": ["relative-secret", "abcdef0123456789abcdef"],
		};
		let index = 0;
		for (const [refresh, secrets] of Object.entries(cases)) {
			const recorder = new NetworkRecorder(options);
			const requestId = `refresh-${index++}`;
			recorder.recordRequest(request({ requestId }));
			recorder.recordResponse(
				response({ requestId, status: 302, headers: { "content-type": "application/json", refresh } }),
			);
			const serialized = JSON.stringify(recorder.finish().har);
			for (const secret of secrets) expect(serialized).not.toContain(secret);
			// The delay prefix survives so the header stays meaningful.
			expect(serialized).toContain("url=");
		}
	});

	it("preserves benign compound keys that only share a token with a sensitive word", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(
			request({
				method: "POST",
				postData: JSON.stringify({
					statusCode: 200,
					productCode: "SKU-123",
					sortKey: "created_at",
					zipCode: "94107",
				}),
			}),
		);
		recorder.recordResponse(response({ method: "POST" }));
		const serialized = JSON.stringify(recorder.finish().har);
		for (const kept of ["statusCode", "productCode", "SKU-123", "sortKey", "created_at", "zipCode", "94107"]) {
			expect(serialized).toContain(kept);
		}
	});

	it("never echoes the raw invalid origin in normalization errors", () => {
		const cases = [
			"not a url",
			"ftp://secret-host.example",
			"https://user:sup3r-secret-pw@shop.test/leak-path?token=leak-query",
		];
		for (const raw of cases) {
			expect(() => normalizeRecordingOrigins([raw])).toThrow();
			let message = "";
			try {
				normalizeRecordingOrigins([raw]);
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).not.toContain(raw);
		}
		let credentialMessage = "";
		try {
			normalizeRecordingOrigins(["https://user:sup3r-secret-pw@shop.test/leak-path?token=leak-query"]);
		} catch (error) {
			credentialMessage = (error as Error).message;
		}
		expect(credentialMessage).not.toContain("sup3r-secret-pw");
		expect(credentialMessage).not.toContain("leak-query");
	});

	it("redacts high-signal credential prefixes hidden under benign JSON, form, and header values", () => {
		const paymentCredential = ["sk", "live", "0123456789abcdefABCDEFGH"].join("_");
		const chatCredential = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
		const formCredential = ["sk", "test", "51H8xabcdefghij0123456789"].join("_");
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(
			request({
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-trace-note": "ref ghp_0123456789abcdefghijABCDEFGHIJ012345",
				},
				postData: JSON.stringify({
					note: "token is ghp_0123456789abcdefghijABCDEFGHIJ012345",
					fineGrained: "github_pat_11ABCDEFG0abcdefghijkl_0123456789abcdefghij0123456789abcdefghij0123456789",
					payment: paymentCredential,
					chat: chatCredential,
					cloud: "AKIAIOSFODNN7EXAMPLE",
					maps: "AIzaSyA0123456789abcdefghijklmnopqrstuv",
					registry: "npm_0123456789abcdefghijABCDEFGHIJ012345",
					pem: "-----BEGIN RSA PRIVATE KEY-----MIIabc",
				}),
			}),
		);
		recorder.recordResponse(response({ method: "POST" }));
		recorder.recordRequest(
			request({
				requestId: "form",
				url: "https://shop.test/api/form",
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				postData: `note=${formCredential}&keep=plain`,
			}),
		);
		recorder.recordResponse(response({ requestId: "form", url: "https://shop.test/api/form", method: "POST" }));
		const serialized = JSON.stringify(recorder.finish().har);
		for (const secret of [
			"ghp_0123456789abcdefghijABCDEFGHIJ012345",
			"github_pat_11ABCDEFG0abcdefghijkl",
			paymentCredential,
			chatCredential,
			"AKIAIOSFODNN7EXAMPLE",
			"AIzaSyA0123456789abcdefghijklmnopqrstuv",
			"npm_0123456789abcdefghijABCDEFGHIJ012345",
			"BEGIN RSA PRIVATE KEY",
			formCredential,
		]) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).toContain('\\"keep\\":\\"plain\\"');
	});

	it("keeps benign values that only resemble credential tokens", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordRequest(
			request({
				method: "POST",
				postData: JSON.stringify({
					shortPat: "ghp_short",
					username: "ghost_writer_1234567890",
					plan: "sk_learning_path_2024",
					board: "skateboard",
					awsish: "AKIASHORT",
					upper: "PLEASEKEEPTHISVALUE1",
					mapsish: "AIza_no",
					sku: "SKU-123",
					zip: "94107",
				}),
			}),
		);
		recorder.recordResponse(response({ method: "POST" }));
		const serialized = JSON.stringify(recorder.finish().har);
		for (const kept of [
			"ghp_short",
			"ghost_writer_1234567890",
			"sk_learning_path_2024",
			"skateboard",
			"AKIASHORT",
			"PLEASEKEEPTHISVALUE1",
			"AIza_no",
			"SKU-123",
			"94107",
		]) {
			expect(serialized).toContain(kept);
		}
	});

	it("redacts short and numeric IDs after plural PII path parents but keeps named sub-resources", () => {
		const recorder = new NetworkRecorder(options);
		const redactedIds: [string, string][] = [
			["users", "10203040"],
			["accounts", "50607080"],
			["customers", "cus10203040"],
			["orgs", "70809010"],
		];
		const keptSegments: [string, string][] = [
			["users", "settings"],
			["accounts", "preferences"],
			["orgs", "acmeco"],
			["orders", "99887766"],
		];
		let index = 0;
		for (const [parent, segment] of [...redactedIds, ...keptSegments]) {
			const requestId = `pii-${index++}`;
			const url = `https://shop.test/${parent}/${segment}`;
			recorder.recordRequest(request({ requestId, url }));
			recorder.recordResponse(response({ requestId, url }));
		}
		const serialized = JSON.stringify(recorder.finish().har);
		for (const [, segment] of redactedIds) expect(serialized).not.toContain(segment);
		for (const [, segment] of keptSegments) expect(serialized).toContain(segment);
	});

	it("consumes a pending omission exactly once when a response-only entry is created", () => {
		const recorder = new NetworkRecorder(options);
		recorder.recordBodyOmitted("resp-only", "timeout");
		recorder.recordResponse(response({ requestId: "resp-only" }));
		const result = recorder.finish();
		expect(result.entryCount).toBe(1);
		expect(result.omittedBodyCount).toBe(1);
	});
});
