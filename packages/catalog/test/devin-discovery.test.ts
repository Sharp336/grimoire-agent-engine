import { describe, expect, it } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { fetchDevinModels } from "../src/discovery/devin";
import {
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
} from "../src/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import {
	type ClientModelConfig,
	ClientModelConfigSchema,
	DisplayOption,
	ModelDimensionSchema,
	ModelInfoSchema,
} from "../src/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

/** DISPLAY_OPTION_INTERNAL_ROUTER: on the wire but absent from the generated enum. */
const DISPLAY_OPTION_INTERNAL_ROUTER = 6;

interface ConfigInit {
	modelUid: string;
	maxTokens?: number;
	displayOption?: number;
	supportsImages?: boolean;
	dimensions?: { label: string; value: number }[];
}

function config({
	modelUid,
	maxTokens = 0,
	displayOption = DisplayOption.UNSPECIFIED,
	supportsImages = false,
	dimensions = [],
}: ConfigInit) {
	return create(ClientModelConfigSchema, {
		modelUid,
		label: modelUid,
		maxTokens,
		supportsImages,
		modelInfo: create(ModelInfoSchema, { modelUid, maxTokens, displayOption }),
		modelDimensions: dimensions.map(({ label, value }) =>
			create(ModelDimensionSchema, { label, value, denominator: "1M tokens" }),
		),
	});
}

async function discover(configs: ClientModelConfig[]) {
	const response = create(GetCliModelConfigsResponseSchema, { clientModelConfigs: configs });
	let requestBody: Uint8Array | undefined;
	const models = await fetchDevinModels({
		apiKey: "session-token",
		fetch: async (_url, init) => {
			if (!(init?.body instanceof Uint8Array)) throw new Error("expected protobuf request body");
			requestBody = init.body;
			return new Response(toBinary(GetCliModelConfigsResponseSchema, response));
		},
	});
	if (!requestBody) throw new Error("expected Devin catalog request");
	const request = fromBinary(GetCliModelConfigsRequestSchema, requestBody);
	if (!request.metadata) throw new Error("expected Devin request metadata");
	return { metadata: request.metadata, byId: new Map((models ?? []).map(m => [m.id, m])) };
}

describe("fetchDevinModels", () => {
	it("declares MODEL_ROUTER support so the server includes adaptive", async () => {
		// Verified live: omitting supportedModelDisplays returns 164 models with no
		// `adaptive`; declaring MODEL_ROUTER returns the 165 that `devin models list`
		// shows. This field is the whole reason adaptive is reachable.
		const { metadata } = await discover([
			config({ modelUid: "adaptive", displayOption: DisplayOption.MODEL_ROUTER }),
		]);
		expect(metadata.supportedModelDisplays).toEqual([DisplayOption.MODEL_ROUTER]);
		expect(metadata).toMatchObject({
			ideName: "windsurf",
			locale: "en",
			os: process.platform === "win32" ? "windows" : process.platform,
		});
	});

	it("gives the adaptive router a usable context window and real pricing", async () => {
		// adaptive arrives with maxTokens 0; without a fallback, model selection rejects it.
		const { byId } = await discover([
			config({
				modelUid: "adaptive",
				maxTokens: 0,
				displayOption: DisplayOption.MODEL_ROUTER,
				supportsImages: true,
				dimensions: [
					{ label: "Input", value: 0.5 },
					{ label: "Cached input", value: 0.05 },
					{ label: "Output", value: 2 },
				],
			}),
		]);
		const adaptive = byId.get("adaptive");
		expect(adaptive).toMatchObject({
			contextWindow: 200_000,
			maxTokens: 64_000,
			input: ["text", "image"],
			cost: { input: 0.5, output: 2 },
		});
		expect(adaptive?.cost.cacheRead).toBeCloseTo(0.05);
	});

	it("drops display options it never requested, even when the server volunteers them", async () => {
		const { byId } = await discover([
			config({ modelUid: "claude-opus-5-medium", maxTokens: 1_000_000 }),
			config({ modelUid: "adaptive", displayOption: DisplayOption.MODEL_ROUTER }),
			config({ modelUid: "swe-check", maxTokens: 200_000, displayOption: DisplayOption.QUICK_REVIEW }),
			config({ modelUid: "subagent-default", displayOption: DISPLAY_OPTION_INTERNAL_ROUTER }),
			config({ modelUid: "memory-migration-default", displayOption: DISPLAY_OPTION_INTERNAL_ROUTER }),
		]);
		expect([...byId.keys()].sort()).toEqual(["adaptive", "claude-opus-5-medium"]);
	});

	it("skips configs the server marks disabled", async () => {
		const enabled = config({ modelUid: "claude-opus-5-medium", maxTokens: 1_000_000 });
		const disabled = create(ClientModelConfigSchema, {
			...config({ modelUid: "retired-model", maxTokens: 200_000 }),
			disabled: true,
		});
		const { byId } = await discover([enabled, disabled]);
		expect(byId.has("claude-opus-5-medium")).toBe(true);
		expect(byId.has("retired-model")).toBe(false);
	});
});
