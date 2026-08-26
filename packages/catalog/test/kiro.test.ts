import { describe, expect, test } from "bun:test";
import type { KiroCatalogModel } from "@oh-my-pi/pi-catalog/provider-models/kiro";
import {
	KIRO_AUTO_MODEL,
	KIRO_MODELS,
	kiroCacheProviderId,
	mapKiroCatalogToModelSpecs,
} from "@oh-my-pi/pi-catalog/provider-models/kiro";

function catalogModel(overrides: Partial<KiroCatalogModel>): KiroCatalogModel {
	return { modelId: "gpt-5.6-sol", ...overrides };
}

describe("mapKiroCatalogToModelSpecs", () => {
	test("maps IMAGE in supportedInputTypes into image-capable input", () => {
		const specs = mapKiroCatalogToModelSpecs([catalogModel({ supportedInputTypes: ["TEXT", "IMAGE"] })], "us-east-1");
		expect(specs[0].input).toEqual(["text", "image"]);
	});

	test("maps text-only catalogs to text-only input", () => {
		const specs = mapKiroCatalogToModelSpecs(
			[catalogModel({ modelId: "glm-5", supportedInputTypes: ["TEXT"] })],
			"us-east-1",
		);
		expect(specs[0].input).toEqual(["text"]);
	});

	test("falls back to the bootstrap input when supportedInputTypes is absent", () => {
		const imageCapable = mapKiroCatalogToModelSpecs([catalogModel({ modelId: "gpt-5.6-sol" })], "us-east-1");
		const textOnly = mapKiroCatalogToModelSpecs([catalogModel({ modelId: "glm-5" })], "us-east-1");
		expect(imageCapable[0].input).toEqual(["text", "image"]);
		expect(textOnly[0].input).toEqual(["text"]);
	});

	test("prefers modelName over displayName for the spec name", () => {
		const specs = mapKiroCatalogToModelSpecs(
			[catalogModel({ modelId: "deepseek-3.2", modelName: "DeepSeek V3.2", displayName: "Legacy Label" })],
			"us-east-1",
		);
		expect(specs[0].name).toBe("DeepSeek V3.2");
	});
});

describe("KIRO_MODELS runtime fallback", () => {
	const EXPECTED = [
		["gpt-5.6-sol", 272_000, ["text", "image"]],
		["gpt-5.6-terra", 272_000, ["text", "image"]],
		["gpt-5.6-luna", 272_000, ["text", "image"]],
		["deepseek-3.2", 164_000, ["text", "image"]],
		["minimax-m2.5", 196_000, ["text"]],
		["minimax-m2.1", 196_000, ["text", "image"]],
		["glm-5", 200_000, ["text"]],
		["qwen3-coder-next", 256_000, ["text", "image"]],
	] as const;

	test("pins the eight Kiro CLI 2.19.2 models with accurate context and image support", () => {
		expect(KIRO_MODELS.map(model => model.id)).toEqual(EXPECTED.map(([id]) => id));
		for (const [id, contextWindow, input] of EXPECTED) {
			const model = KIRO_MODELS.find(candidate => candidate.id === id);
			if (!model) throw new Error(`missing ${id}`);
			expect(model.contextWindow, id).toBe(contextWindow);
			expect(model.input, id).toEqual([...input]);
		}
	});

	test("keeps KIRO_AUTO_MODEL independent from the runtime fallback", () => {
		expect(KIRO_AUTO_MODEL.id).toBe("auto");
		expect(KIRO_MODELS.some(model => model.id === "auto")).toBe(false);
		expect(KIRO_AUTO_MODEL.contextWindow).toBe(1_000_000);
		expect(KIRO_AUTO_MODEL.input).toEqual(["text", "image"]);
	});
});

describe("kiroCacheProviderId", () => {
	test("namespaces anonymous setups under default", () => {
		expect(kiroCacheProviderId(undefined)).toBe("kiro:us-east-1:default");
		expect(kiroCacheProviderId("")).toBe("kiro:us-east-1:default");
	});

	test("scopes distinct bearer tokens to distinct cache namespaces without leaking the token", () => {
		const first = kiroCacheProviderId("kiro-token-aaaa");
		const second = kiroCacheProviderId("kiro-token-bbbb");
		expect(first).not.toBe(second);
		expect(first).toBe(kiroCacheProviderId("kiro-token-aaaa"));
		expect(first).not.toContain("kiro-token-aaaa");
		expect(second).not.toContain("kiro-token-bbbb");
	});

	test("scopes structured credentials by token and keeps the profile fingerprint", () => {
		const key = kiroCacheProviderId(
			JSON.stringify({ token: "struct-token", region: "eu-central-1", profileArn: "arn:kiro:profile:abc" }),
		);
		expect(key.startsWith("kiro:eu-central-1:")).toBe(true);
		expect(key).not.toContain("struct-token");
		expect(key).not.toContain("arn:kiro:profile:abc");
		expect(key.endsWith(Bun.hash("arn:kiro:profile:abc").toString(36))).toBe(true);
	});
});
