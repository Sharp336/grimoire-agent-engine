import { describe, expect, test } from "bun:test";
import { buildBedrockCompat } from "@oh-my-pi/pi-catalog/compat/bedrock";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { dropUnsupportedBedrockGeoIds } from "../scripts/generated-policies";

// AWS's Bedrock model card for Claude Opus 5 lists exactly these Programmatic
// Access IDs — the bare model ID plus the us./eu./au. Geo and global.
// inference profiles. Japan is explicitly marked unsupported for Geo
// inference in the same card's regional-availability table, so no `jp.`
// profile exists for this model (unlike several Opus 4.x generations).
// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html
const AWS_DOCUMENTED_OPUS_5_IDS = [
	"anthropic.claude-opus-5",
	"us.anthropic.claude-opus-5",
	"eu.anthropic.claude-opus-5",
	"au.anthropic.claude-opus-5",
	"global.anthropic.claude-opus-5",
];

describe("Amazon Bedrock Claude Opus 5", () => {
	test("bundles exactly the AWS-documented inference-profile IDs", () => {
		const bedrockOpus5Ids = getBundledModels("amazon-bedrock")
			.map(model => model.id)
			.filter(id => id.endsWith("anthropic.claude-opus-5"));

		expect(new Set(bedrockOpus5Ids)).toEqual(new Set(AWS_DOCUMENTED_OPUS_5_IDS));
		// `models.dev` currently also lists `jp.anthropic.claude-opus-5`; Bedrock
		// has no such inference profile for this model and would reject it.
		expect(bedrockOpus5Ids).not.toContain("jp.anthropic.claude-opus-5");
	});

	test("dropUnsupportedBedrockGeoIds filters the undocumented jp. profile without touching other providers/ids", () => {
		const bareSpec = (provider: string, id: string): ModelSpec<"bedrock-converse-stream"> => ({
			id,
			name: id,
			api: "bedrock-converse-stream",
			provider,
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		});
		const input = [
			bareSpec("amazon-bedrock", "jp.anthropic.claude-opus-5"),
			bareSpec("amazon-bedrock", "us.anthropic.claude-opus-5"),
			// A `jp.` id on a different Bedrock model, or on a different provider,
			// must survive — only this exact (provider, id) pair is undocumented.
			bareSpec("amazon-bedrock", "jp.anthropic.claude-opus-4-8"),
			bareSpec("some-other-provider", "jp.anthropic.claude-opus-5"),
		];

		expect(dropUnsupportedBedrockGeoIds(input).map(model => model.id)).toEqual([
			"us.anthropic.claude-opus-5",
			"jp.anthropic.claude-opus-4-8",
			"jp.anthropic.claude-opus-5",
		]);
	});

	test("resolves the AWS-documented 512-token/four-checkpoint/1h prompt-cache capability", () => {
		for (const id of AWS_DOCUMENTED_OPUS_5_IDS) {
			const spec: ModelSpec<"bedrock-converse-stream"> = {
				id,
				name: id,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			};
			expect(buildBedrockCompat(spec)).toEqual({
				promptCacheMode: "explicit",
				supportsLongPromptCacheRetention: true,
				promptCacheMinimumTokens: 512,
				promptCacheMaximumCheckpoints: 4,
			});
		}
	});
});
