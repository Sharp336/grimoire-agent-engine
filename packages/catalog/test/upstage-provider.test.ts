import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	isLikelyUpstageChatModelId,
	upstageModelManagerOptions,
	upstageSnapshotAliasId,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, FetchImpl, Model, ModelSpec, Provider } from "@oh-my-pi/pi-catalog/types";

const SOLAR_PRO_23_EFFORTS = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const SOLAR_PRO_4_EFFORTS = [...SOLAR_PRO_23_EFFORTS, Effort.XHigh, Effort.Max];

function createSolarModel<TApi extends Api>(id: string, provider: Provider, api: TApi): Model<TApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 8192,
	} as ModelSpec<TApi>);
}

describe("Upstage Solar effort ladders", () => {
	test("bundled solar-pro4 bakes the full minimal..max ladder with lowest-effort disable", () => {
		const pro4 = getBundledModel("upstage", "solar-pro4") as Model<"openai-completions">;
		expect(pro4.thinking).toMatchObject({ mode: "effort", efforts: SOLAR_PRO_4_EFFORTS });
		expect(pro4.compatConfig?.reasoningDisableMode).toBe("lowest-effort");
	});

	test("bundled solar-pro2/pro3 top out at high (the wire 400s on xhigh/max)", () => {
		for (const id of ["solar-pro2", "solar-pro3"]) {
			const model = getBundledModel("upstage", id);
			expect(model.thinking?.efforts).toEqual(SOLAR_PRO_23_EFFORTS);
		}
	});

	test("namespaced aggregator ids derive the same wire-exact ladders", () => {
		const pro3 = createSolarModel("upstage/solar-pro-3", "openrouter", "openai-completions");
		expect(pro3.thinking?.efforts).toEqual(SOLAR_PRO_23_EFFORTS);

		const pro4 = createSolarModel("upstage/solar-pro-4", "openrouter", "openai-completions");
		expect(pro4.thinking?.efforts).toEqual(SOLAR_PRO_4_EFFORTS);
	});

	test("dated snapshot ids classify like their alias", () => {
		const dated = createSolarModel("solar-pro4-260806", "upstage", "openai-completions");
		expect(dated.thinking?.efforts).toEqual(SOLAR_PRO_4_EFFORTS);
	});
});

describe("Upstage discovery", () => {
	test("drops non-chat SKUs by id", () => {
		expect(isLikelyUpstageChatModelId("solar-pro4")).toBe(true);
		expect(isLikelyUpstageChatModelId("syn-pro")).toBe(true);
		expect(isLikelyUpstageChatModelId("solar-embedding-1-large")).toBe(false);
		expect(isLikelyUpstageChatModelId("solar-embedding-2-query")).toBe(false);
		expect(isLikelyUpstageChatModelId("solar-docvision-preview")).toBe(false);
		expect(isLikelyUpstageChatModelId("document-parse-260630")).toBe(false);
		expect(isLikelyUpstageChatModelId("groundedness-check-240502")).toBe(false);
	});

	test("strips dated snapshot suffixes to the alias id", () => {
		expect(upstageSnapshotAliasId("solar-pro4-260806")).toBe("solar-pro4");
		expect(upstageSnapshotAliasId("solar-pro4")).toBe("solar-pro4");
		expect(upstageSnapshotAliasId("syn-pro-251021")).toBe("syn-pro");
	});

	test("hydrates dated snapshots from the alias row and keeps compat on unbundled ids", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "solar-pro4", object: "model" },
						{ id: "solar-pro4-260806", object: "model" },
						{ id: "solar-embedding-1-large", object: "model" },
						{ id: "syn-pro", object: "model" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const options = upstageModelManagerOptions({ apiKey: "up_test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["solar-pro4", "solar-pro4-260806", "syn-pro"]);

		// The dated snapshot inherits the alias's reasoning, pricing, and compat.
		const dated = models?.find(model => model.id === "solar-pro4-260806");
		expect(dated).toMatchObject({
			reasoning: true,
			cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
			compat: { supportsStore: false, supportsDeveloperRole: false, reasoningDisableMode: "lowest-effort" },
		});

		// Unbundled chat ids still avoid the wire fields the endpoint rejects.
		const synPro = models?.find(model => model.id === "syn-pro");
		expect(synPro?.reasoning).toBe(false);
		expect(synPro?.compat).toMatchObject({ supportsStore: false, supportsDeveloperRole: false });
	});
});
