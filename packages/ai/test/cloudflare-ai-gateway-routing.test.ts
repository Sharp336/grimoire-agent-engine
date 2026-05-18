import { describe, expect, it } from "bun:test";
import {
	classifyCloudflareAiGatewayBackend,
	toCloudflareGatewayWireModelId,
} from "@oh-my-pi/pi-ai/provider-models/cloudflare-ai-gateway-routing";

describe("classifyCloudflareAiGatewayBackend", () => {
	it("routes anthropic/* models to anthropic-messages on /anthropic", () => {
		const result = classifyCloudflareAiGatewayBackend("anthropic/claude-sonnet-4-5");
		expect(result.prefix).toBe("anthropic");
		expect(result.api).toBe("anthropic-messages");
		expect(result.pathSuffix).toBe("/anthropic");
	});

	it("routes openai/* models to openai-completions on /openai/v1", () => {
		const result = classifyCloudflareAiGatewayBackend("openai/gpt-4o");
		expect(result.prefix).toBe("openai");
		expect(result.api).toBe("openai-completions");
		expect(result.pathSuffix).toBe("/openai/v1");
	});

	it("routes workers-ai/* models to openai-completions on /workers-ai/v1", () => {
		const result = classifyCloudflareAiGatewayBackend("workers-ai/@cf/moonshotai/kimi-k2.6");
		expect(result.prefix).toBe("workers-ai");
		expect(result.api).toBe("openai-completions");
		expect(result.pathSuffix).toBe("/workers-ai/v1");
	});

	it("routes google-ai-studio/* models to openai-completions on /google-ai-studio/v1beta/openai", () => {
		const result = classifyCloudflareAiGatewayBackend("google-ai-studio/gemini-2.0-flash");
		expect(result.prefix).toBe("google-ai-studio");
		expect(result.api).toBe("openai-completions");
		expect(result.pathSuffix).toBe("/google-ai-studio/v1beta/openai");
	});

	it("falls back to anthropic backend for bare (no-prefix) model IDs", () => {
		const result = classifyCloudflareAiGatewayBackend("claude-sonnet-4-5");
		expect(result.prefix).toBe("anthropic");
		expect(result.api).toBe("anthropic-messages");
		expect(result.pathSuffix).toBe("/anthropic");
	});

	it("falls back to anthropic backend for unknown prefixes (legacy compat)", () => {
		const result = classifyCloudflareAiGatewayBackend("cohere/command-r-plus");
		expect(result.prefix).toBe("anthropic");
		expect(result.api).toBe("anthropic-messages");
		expect(result.pathSuffix).toBe("/anthropic");
	});
});

import { normalizeCloudflareAiGatewayBase } from "@oh-my-pi/pi-ai/provider-models/cloudflare-ai-gateway-routing";

describe("normalizeCloudflareAiGatewayBase", () => {
	it("strips a trailing /anthropic suffix (legacy form)", () => {
		expect(normalizeCloudflareAiGatewayBase("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic")).toBe(
			"https://gateway.ai.cloudflare.com/v1/acc/gw",
		);
	});

	it("strips a trailing /workers-ai/v1 suffix", () => {
		expect(normalizeCloudflareAiGatewayBase("https://gateway.ai.cloudflare.com/v1/acc/gw/workers-ai/v1")).toBe(
			"https://gateway.ai.cloudflare.com/v1/acc/gw",
		);
	});

	it("strips a trailing /openai/v1 suffix", () => {
		expect(normalizeCloudflareAiGatewayBase("https://gateway.ai.cloudflare.com/v1/acc/gw/openai/v1")).toBe(
			"https://gateway.ai.cloudflare.com/v1/acc/gw",
		);
	});

	it("strips a trailing /google-ai-studio/v1beta/openai suffix", () => {
		expect(
			normalizeCloudflareAiGatewayBase("https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio/v1beta/openai"),
		).toBe("https://gateway.ai.cloudflare.com/v1/acc/gw");
	});

	it("passes through the bare gateway base unchanged", () => {
		expect(normalizeCloudflareAiGatewayBase("https://gateway.ai.cloudflare.com/v1/acc/gw")).toBe(
			"https://gateway.ai.cloudflare.com/v1/acc/gw",
		);
	});

	it("tolerates a trailing slash on input", () => {
		expect(normalizeCloudflareAiGatewayBase("https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/")).toBe(
			"https://gateway.ai.cloudflare.com/v1/acc/gw",
		);
	});
});

describe("toCloudflareGatewayWireModelId", () => {
	it("strips workers-ai/ prefix", () => {
		expect(toCloudflareGatewayWireModelId("workers-ai/@cf/moonshotai/kimi-k2.6")).toBe("@cf/moonshotai/kimi-k2.6");
	});

	it("strips anthropic/ prefix", () => {
		expect(toCloudflareGatewayWireModelId("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
	});

	it("strips openai/ prefix", () => {
		expect(toCloudflareGatewayWireModelId("openai/gpt-4o")).toBe("gpt-4o");
	});

	it("strips google-ai-studio/ prefix", () => {
		expect(toCloudflareGatewayWireModelId("google-ai-studio/gemini-2.0-flash")).toBe("gemini-2.0-flash");
	});

	it("passes through unprefixed ids unchanged (legacy bare claude)", () => {
		expect(toCloudflareGatewayWireModelId("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
	});

	it("passes through unknown-prefix ids unchanged", () => {
		expect(toCloudflareGatewayWireModelId("cohere/command-r")).toBe("cohere/command-r");
	});
});
