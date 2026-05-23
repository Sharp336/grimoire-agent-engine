import { describe, expect, test } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "../usage";
import { fetchOpenCodeGoUsage } from "./opencode-go";

function makeParams(): UsageFetchParams {
	return {
		provider: "opencode-go",
		credential: {
			type: "api_key",
			metadata: { workspaceId: "workspace-123", authCookie: "cookie-abc" },
		},
	};
}

describe("OpenCode Go usage provider", () => {
	test("scrapes rolling weekly and monthly dashboard usage", async () => {
		const html = [
			"rollingUsage:$R[1]={usagePercent:25,resetInSec:3600}",
			"weeklyUsage:$R[2]={resetInSec:7200,usagePercent:50}",
			"monthlyUsage:$R[3]={usagePercent:85,resetInSec:10800}",
		].join("\n");
		let requestedUrl = "";
		let cookie = "";
		const fetchHtml = (async (url: string | URL | Request, init?: RequestInit) => {
			requestedUrl = String(url);
			cookie = String((init?.headers as Record<string, string>).Cookie);
			return new Response(html, { status: 200 });
		}) as unknown as typeof fetch;
		const ctx: UsageFetchContext = { fetch: fetchHtml };

		const report = await fetchOpenCodeGoUsage(makeParams(), ctx);

		expect(requestedUrl).toBe("https://opencode.ai/workspace/workspace-123/go");
		expect(cookie).toBe("auth=cookie-abc");
		expect(report?.provider).toBe("opencode-go");
		expect(report?.limits).toHaveLength(3);
		expect(report?.limits[0]?.amount.used).toBe(25);
		expect(report?.limits[0]?.amount.remaining).toBe(75);
		expect(report?.limits[1]?.amount.usedFraction).toBe(0.5);
		expect(report?.limits[2]?.status).toBe("warning");
	});

	test("returns null when dashboard usage cannot be parsed", async () => {
		const fetchHtml = (async () => new Response("<html></html>", { status: 200 })) as unknown as typeof fetch;
		const report = await fetchOpenCodeGoUsage(makeParams(), { fetch: fetchHtml });

		expect(report).toBeNull();
	});
});
