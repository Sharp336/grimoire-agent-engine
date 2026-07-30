import { describe, expect, test } from "bun:test";
import { fetchKiroModels } from "../src/discovery/kiro";
import { Effort } from "../src/effort";

const fixture = await Bun.file(new URL("./fixtures/kiro-list-available-models.json", import.meta.url)).text();

describe("fetchKiroModels", () => {
	test("normalizes only the model ids returned by the recorded Kiro catalog", async () => {
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;
		const models = await fetchKiroModels({
			apiKey: JSON.stringify({
				accessToken: "token",
				profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test",
			}),
			fetch: async (input, init) => {
				requestUrl = String(input);
				requestHeaders = new Headers(init?.headers);
				return new Response(fixture, { headers: { "content-type": "application/x-amz-json-1.0" } });
			},
		});

		expect(requestUrl).toBe(
			"https://management.us-east-1.kiro.dev/?origin=KIRO_CLI&profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A123%3Aprofile%2Ftest",
		);
		expect(requestHeaders?.get("authorization")).toBe("Bearer token");
		expect(requestHeaders?.get("x-amz-target")).toBe("AmazonCodeWhispererService.ListAvailableModels");
		expect(models?.map(model => model.id)).toContain("gpt-5.6-sol");
		expect(models?.map(model => model.id)).toContain("claude-opus-4.8");
		expect(models).toHaveLength(19);
		expect(models?.every(model => model.input.length === 1 && model.input[0] === "text")).toBe(true);
		expect(models?.find(model => model.id === "claude-opus-5")?.reasoning).toBe(true);
		expect(models?.find(model => model.id === "gpt-5.6-sol")?.reasoning).toBe(true);
		expect(models?.find(model => model.id === "auto")?.reasoning).toBe(false);
	});

	test("uses the profile ARN region for management and runtime endpoints", async () => {
		let requestUrl: string | undefined;
		const profileArn = "arn:aws:codewhisperer:eu-west-2:123:profile/test";
		const models = await fetchKiroModels({
			apiKey: JSON.stringify({ accessToken: "token", profileArn }),
			fetch: async input => {
				requestUrl = String(input);
				return new Response(fixture);
			},
		});

		expect(requestUrl).toBe(
			"https://management.eu-west-2.kiro.dev/?origin=KIRO_CLI&profileArn=arn%3Aaws%3Acodewhisperer%3Aeu-west-2%3A123%3Aprofile%2Ftest",
		);
		expect(models?.every(model => model.baseUrl === "https://runtime.eu-west-2.kiro.dev")).toBe(true);
	});

	test("derives each model's effort ladder from its reported schema enum, not a global union", async () => {
		const models = await fetchKiroModels({
			apiKey: JSON.stringify({
				accessToken: "token",
				profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/test",
			}),
			fetch: async () => new Response(fixture, { headers: { "content-type": "application/x-amz-json-1.0" } }),
		});
		const efforts = (id: string) => models?.find(model => model.id === id)?.thinking?.efforts;
		// claude-opus-5 advertises the full ladder including xhigh.
		expect(efforts("claude-opus-5")).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		// claude-opus-4.6/sonnet-4.6 omit xhigh from their schema enum — advertising it
		// would pass local validation then be rejected by Kiro's schema.
		expect(efforts("claude-opus-4.6")).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(efforts("claude-sonnet-4.6")).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		// GPT-family reasoning schema includes xhigh (none stays off-state only).
		expect(efforts("gpt-5.6-sol")).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
	});
});
