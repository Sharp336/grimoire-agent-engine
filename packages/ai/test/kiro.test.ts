import { describe, expect, test, vi } from "bun:test";
import { buildKiroRequest, parseKiroEvent } from "@oh-my-pi/pi-ai/providers/kiro";
import { crc32, decodeKiroEventStream, decodeKiroEventStreamMessage } from "@oh-my-pi/pi-ai/providers/kiro-eventstream";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import { loginKiro, refreshKiroToken } from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { KiroModel } from "@oh-my-pi/pi-catalog/provider-models/kiro";
import { fetchKiroModelCatalog, KIRO_MODELS } from "@oh-my-pi/pi-catalog/provider-models/kiro";

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function eventStreamFrame(payload: string, headers: Record<string, string> = {}): Uint8Array {
	const payloadBytes = new TextEncoder().encode(payload);
	const headerParts = Object.entries(headers).map(([name, value]) => {
		const nameBytes = new TextEncoder().encode(name);
		const valueBytes = new TextEncoder().encode(value);
		const bytes = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
		bytes[0] = nameBytes.length;
		bytes.set(nameBytes, 1);
		bytes[1 + nameBytes.length] = 7;
		new DataView(bytes.buffer).setUint16(2 + nameBytes.length, valueBytes.length, false);
		bytes.set(valueBytes, 4 + nameBytes.length);
		return bytes;
	});
	const headerLength = headerParts.reduce((total, bytes) => total + bytes.length, 0);
	const totalLength = 12 + headerLength + payloadBytes.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	let offset = 12;
	for (const bytes of headerParts) {
		frame.set(bytes, offset);
		offset += bytes.length;
	}
	frame.set(payloadBytes, offset);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

describe("Kiro OAuth", () => {
	test("runs device authorization and stores refresh metadata without printing token bytes", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/client/register")) {
				return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete: "https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 30,
				});
			}
			if (url.endsWith("/token")) {
				return jsonResponse({ accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresIn: 3600 });
			}
			throw new Error(`unexpected Kiro test URL: ${url}`);
		};
		const onAuth = vi.fn();
		const credentials = await loginKiro({
			onAuth,
			onPrompt: async () => "",
			fetch: fetchMock,
		});

		expect(credentials.region).toBe("us-east-1");
		expect(credentials.authMethod).toBe("idc");
		expect(credentials.access).toBe("access-fixture");
		expect(credentials.refresh).toContain("|us-east-1");
		expect(onAuth).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://device.example.test/verify?code=fixture" }),
		);
		expect(calls.map(call => call.url)).toEqual([
			"https://oidc.us-east-1.amazonaws.com/client/register",
			"https://oidc.us-east-1.amazonaws.com/device_authorization",
			"https://oidc.us-east-1.amazonaws.com/token",
		]);
	});

	test("refreshes with the device client and preserves profile metadata", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ accessToken: "access-refreshed", expiresIn: 1800 }));
		try {
			const refreshed = await refreshKiroToken({
				access: "access-old",
				refresh: "refresh-old|client-fixture|secret-fixture|idc|us-east-1",
				expires: 0,
				region: "us-east-1",
				clientId: "client-fixture",
				clientSecret: "secret-fixture",
				authMethod: "idc",
				profileArn: "profile-fixture",
			} as never);
			expect(refreshed.access).toBe("access-refreshed");
			expect(refreshed.region).toBe("us-east-1");
			expect(refreshed.profileArn).toBe("profile-fixture");
			const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
			expect(JSON.parse(String(request.body))).toMatchObject({
				clientId: "client-fixture",
				refreshToken: "refresh-old",
				grantType: "refresh_token",
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("preserves definitive refresh error codes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(
				{
					error: "invalid_grant",
					error_description: "Refresh token revoked",
				},
				400,
			),
		);
		try {
			await expect(
				refreshKiroToken({
					access: "access-old",
					refresh: "refresh-old|client-fixture|secret-fixture|idc|us-east-1",
					expires: 0,
				} as never),
			).rejects.toThrow("invalid_grant: Refresh token revoked");
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("Kiro OAuth error handling", () => {
	test("fails immediately for fatal HTTP 400 token errors", async () => {
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete: "https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 30,
				});
			}
			return jsonResponse({ error: "access_denied" }, 400);
		};

		await expect(
			loginKiro({
				onAuth: () => {},
				onPrompt: async () => "",
				fetch: fetchMock,
			}),
		).rejects.toThrow("Kiro authorization failed: access_denied");
	});

	test("reports slow_down instead of treating it as authorization_pending", async () => {
		const controller = new AbortController();
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete: "https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 1,
				});
			}
			return jsonResponse({ error: "slow_down" }, 400);
		};
		await expect(
			loginKiro({
				onAuth: () => {},
				onPrompt: async () => "",
				signal: controller.signal,
				fetch: fetchMock,
			}),
		).rejects.toThrow("after one or more slow_down responses");
	});

	test("uses an independent request-timeout signal for token polling", async () => {
		const callerController = new AbortController();
		let tokenRequestSignal: AbortSignal | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete: "https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 30,
				});
			}
			tokenRequestSignal = init?.signal ?? undefined;
			return jsonResponse({ accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresIn: 3600 });
		};

		const credentials = await loginKiro({
			onAuth: () => {},
			onPrompt: async () => "",
			signal: callerController.signal,
			fetch: fetchMock,
		});
		expect(credentials.access).toBe("access-fixture");
		expect(tokenRequestSignal).toBeDefined();
		expect(tokenRequestSignal).not.toBe(callerController.signal);
	});
});
describe("Kiro management and request protocol", () => {
	test("discovers a profile then fetches the profile-scoped model catalog", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			requests.push({ url: String(input), init });
			if (String(input).endsWith("/List-Available-Profiles")) {
				return jsonResponse({ profiles: [{ arn: "profile-fixture" }] });
			}
			return jsonResponse({
				models: [{ modelId: "model-fixture", displayName: "Fixture Model", tokenLimits: { maxInputTokens: 1234 } }],
			});
		};
		const result = await fetchKiroModelCatalog(
			{ accessToken: "access-fixture", region: "eu-central-1" },
			undefined,
			fetchMock,
		);
		expect(result.profileArn).toBe("profile-fixture");
		expect(result.response.models[0]?.modelId).toBe("model-fixture");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[1]?.init?.method).toBe("GET");
		expect(requests[1]?.url).toContain("origin=KIRO_CLI");
		expect(requests[1]?.url).toContain("profileArn=profile-fixture");
		const managementHeaders = requests[1]!.init!.headers as Record<string, string>;
		expect(managementHeaders.Authorization).toBe("Bearer access-fixture");
	});

	test("maps system, tool, assistant, and tool-result history into a Kiro request", () => {
		const model = KIRO_MODELS[0] as KiroModel;
		const context: Context = {
			systemPrompt: ["Use concise answers."],
			tools: [
				{
					name: "lookup",
					description: "Look something up",
					parameters: { type: "object", properties: { query: { type: "string" } } },
				},
			],
			messages: [
				{ role: "user", content: "Earlier", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tool-1", name: "lookup", arguments: { query: "x" } }],
					api: "kiro-api",
					provider: "kiro",
					model: "auto",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "lookup",
					content: [{ type: "text", text: "result" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "Current", timestamp: 4 },
			],
		};
		const request = buildKiroRequest(model, context, "profile-fixture", "conversation-fixture", Effort.High);
		expect(request.profileArn).toBe("profile-fixture");
		expect(request.conversationState.history?.[0]?.userInputMessage?.content).toContain("Earlier");
		expect(request.conversationState.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId).toBe("tool-1");
		expect(
			request.conversationState.history?.[2]?.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.content[0]
				?.text,
		).toBe("result");
		expect(request.conversationState.currentMessage.userInputMessage.content).toBe("Current");
		expect(
			request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0]
				?.toolSpecification.name,
		).toBe("lookup");
	});
});

describe("Kiro event stream", () => {
	test("parses native content, thinking, tools, usage, and errors", () => {
		expect(parseKiroEvent({ content: "hello" })).toEqual({ type: "content", data: "hello" });
		expect(parseKiroEvent({ text: "reason" })).toEqual({ type: "thinkingText", data: "reason" });
		expect(parseKiroEvent({ name: "lookup", toolUseId: "tool-1", input: { query: "x" }, stop: true })).toEqual({
			type: "toolUse",
			data: { name: "lookup", toolUseId: "tool-1", input: JSON.stringify({ query: "x" }), stop: true },
		});
		expect(parseKiroEvent({ usage: { inputTokens: 10, outputTokens: 4 } })).toEqual({
			type: "usage",
			data: { inputTokens: 10, outputTokens: 4 },
		});
		expect(
			parseKiroEvent({
				usage: 0.006,
				unit: "credit",
				unitPlural: "credits",
			}),
		).toEqual({
			type: "metering",
			data: { value: 0.006, unit: "credit", unitPlural: "credits" },
		});
		expect(parseKiroEvent({ Error: "bad", reason: "fixture" })).toEqual({
			type: "error",
			data: { error: "bad", message: "fixture" },
		});
	});

	test("validates CRCs and reassembles split AWS EventStream frames", async () => {
		const frame = eventStreamFrame(JSON.stringify({ content: "hello" }));
		const decoded = decodeKiroEventStreamMessage(frame);
		expect(new TextDecoder().decode(decoded.payload)).toBe(JSON.stringify({ content: "hello" }));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame.slice(0, 7));
				controller.enqueue(frame.slice(7));
				controller.close();
			},
		});
		const messages = [];
		for await (const message of decodeKiroEventStream(stream)) messages.push(message);
		expect(messages).toHaveLength(1);
		expect(new TextDecoder().decode(messages[0]!.payload)).toBe(JSON.stringify({ content: "hello" }));
		const corrupt = frame.slice();
		corrupt[8] ^= 1;
		expect(() => decodeKiroEventStreamMessage(corrupt)).toThrow("prelude CRC");
	});
});

describe("Kiro structured OAuth key", () => {
	test("includes region and profile ARN for runtime routing", async () => {
		const result = await getOAuthApiKey("kiro", {
			kiro: {
				access: "access-fixture",
				refresh: "refresh-fixture",
				expires: Date.now() + 60_000,
				region: "eu-west-1",
				profileArn: "profile-fixture",
			} as never,
		});
		expect(JSON.parse(result!.apiKey)).toMatchObject({
			token: "access-fixture",
			refreshToken: "refresh-fixture",
			expiresAt: expect.any(Number),
			region: "eu-west-1",
			profileArn: "profile-fixture",
		});
	});
});

describe("Kiro streamSimple dispatch", () => {
	test("uses the built-in kiro-api handler with profile discovery and EventStream output", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/List-Available-Profiles")) {
				return jsonResponse({ profiles: [{ arn: "profile-fixture" }] });
			}
			if (url.endsWith("/generateAssistantResponse")) {
				return new Response(eventStreamFrame(JSON.stringify({ content: "streamSimple works" })), { status: 200 });
			}
			throw new Error(`unexpected Kiro stream URL: ${url}`);
		};
		const model = KIRO_MODELS[0] as KiroModel;
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: JSON.stringify({ token: "access-fixture", region: "eu-central-1" }),
				fetch: fetchMock,
				sessionId: "conversation-fixture",
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "streamSimple works" }]);
		expect(result.usage.output).toBeGreaterThan(0);
		expect(result.usage.totalTokens).toBe(result.usage.input + result.usage.output);
		expect(result.duration).toBeGreaterThanOrEqual(0);
		expect(result.ttft).toBeGreaterThanOrEqual(0);
		expect(requests.map(request => request.url)).toEqual([
			"https://management.eu-central-1.kiro.dev/List-Available-Profiles",
			"https://runtime.eu-central-1.kiro.dev/generateAssistantResponse",
		]);
		expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
			profileArn: "profile-fixture",
		});
		expect(new Headers(requests[1]?.init?.headers).get("x-amzn-kiro-profile-arn")).toBe("profile-fixture");
	});

	test("surfaces modeled AWS EventStream exceptions", async () => {
		const result = await streamSimple(
			KIRO_MODELS[0] as KiroModel,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: JSON.stringify({
					token: "access-fixture",
					region: "us-east-1",
					profileArn: "profile-fixture",
				}),
				fetch: async () =>
					new Response(
						eventStreamFrame(
							JSON.stringify({
								message: "Model is not available",
							}),
							{
								":message-type": "exception",
								":exception-type": "ValidationException",
							},
						),
						{ status: 200 },
					),
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("ValidationException: Model is not available");
	});

	test("re-resolves profile scope instead of trusting stale model metadata", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const model = {
			...KIRO_MODELS[0],
			kiroRegion: "us-east-1",
			kiroProfileArn: "stale-profile",
		} as KiroModel;
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: JSON.stringify({
					token: "new-access",
					region: "eu-central-1",
				}),
				fetch: async (input, init) => {
					const url = String(input);
					requests.push({ url, init });
					if (url.endsWith("/List-Available-Profiles")) {
						return jsonResponse({
							profiles: [{ arn: "current-profile" }],
						});
					}
					return new Response(eventStreamFrame(JSON.stringify({ content: "ok" })), { status: 200 });
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(requests.map(request => request.url)).toEqual([
			"https://management.eu-central-1.kiro.dev/List-Available-Profiles",
			"https://runtime.eu-central-1.kiro.dev/generateAssistantResponse",
		]);
		expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({
			profileArn: "current-profile",
		});
		expect(new Headers(requests[1]?.init?.headers).get("x-amzn-kiro-profile-arn")).toBe("current-profile");
	});

	test("retries exactly once when the first request hits a transient Invalid tool use format 400", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/List-Available-Profiles")) {
				return jsonResponse({ profiles: [{ arn: "profile-fixture" }] });
			}
			if (url.endsWith("/generateAssistantResponse")) {
				const runtimeCalls = requests.filter(request => request.url.endsWith("/generateAssistantResponse")).length;
				if (runtimeCalls === 1) {
					return jsonResponse({ message: "Invalid tool use format." }, 400);
				}
				return new Response(eventStreamFrame(JSON.stringify({ content: "retried ok" })), { status: 200 });
			}
			throw new Error(`unexpected Kiro stream URL: ${url}`);
		};
		const result = await streamSimple(
			KIRO_MODELS[0] as KiroModel,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: JSON.stringify({ token: "access-fixture", region: "eu-central-1" }),
				fetch: fetchMock,
				sessionId: "conversation-fixture",
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "retried ok" }]);
		const runtimeRequests = requests.filter(request => request.url.endsWith("/generateAssistantResponse"));
		expect(runtimeRequests).toHaveLength(2);
		expect(JSON.parse(String(runtimeRequests[0]?.init?.body))).toEqual(
			JSON.parse(String(runtimeRequests[1]?.init?.body)),
		);
		expect(new Headers(runtimeRequests[0]?.init?.headers).get("amz-sdk-invocation-id")).not.toBe(
			new Headers(runtimeRequests[1]?.init?.headers).get("amz-sdk-invocation-id"),
		);
	});

	test("fails immediately without retrying for HTTP 400s other than Invalid tool use format", async () => {
		let runtimeCalls = 0;
		const result = await streamSimple(
			KIRO_MODELS[0] as KiroModel,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: JSON.stringify({ token: "access-fixture", region: "eu-central-1" }),
				fetch: async input => {
					const url = String(input);
					if (url.endsWith("/List-Available-Profiles")) {
						return jsonResponse({ profiles: [{ arn: "profile-fixture" }] });
					}
					if (url.endsWith("/generateAssistantResponse")) {
						runtimeCalls++;
						return jsonResponse({ message: "Model is not available" }, 400);
					}
					throw new Error(`unexpected Kiro stream URL: ${url}`);
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("Kiro API request failed (HTTP 400)");
		expect(result.errorMessage).toContain("Model is not available");
		expect(runtimeCalls).toBe(1);
	});
});
