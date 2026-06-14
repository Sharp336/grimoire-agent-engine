import { describe, expect, test } from "bun:test";
import { ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";

/**
 * U8 — the zod `SwarmSpec` mirror must let a user-authored `swarm:` block and an
 * `api: "omp-swarm"` declaration survive `ModelsConfigSchema` parsing. Zod strips
 * unknown keys, so without the mirror the field is silently dropped before the
 * custom-model build pipeline (KTD-4). These tests assert the field is RETAINED
 * (not merely accepted), that the new api literal parses on both the model- and
 * provider-level enums, that invalid blends fail parse, and that configs without
 * a swarm block are unchanged (no contamination).
 */
describe("U8 swarm config zod mirror", () => {
	const baseSwarm = {
		strategy: "moa" as const,
		members: [
			{ role: "proposer", model: "anthropic/claude-opus-4", kind: "model" as const },
			{ role: "proposer", model: "anthropic/claude-sonnet-4" },
			{ role: "aggregator", model: "anthropic/claude-opus-4", surface: true },
		],
		selector: { kind: "classifier" as const, model: "openai/gpt-4o-mini" },
		surface: "aggregator",
		maxMembers: 3,
		firstEventTimeoutMs: 5000,
	};

	test("a valid swarm block parses AND is retained on the model definition", () => {
		const config = {
			providers: {
				omp: {
					api: "omp-swarm" as const,
					baseUrl: "omp://",
					models: [{ id: "omp/moa-synthesis", swarm: baseSwarm }],
				},
			},
		};

		const result = ModelsConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
		if (!result.success) return;

		const model = result.data.providers?.omp?.models?.[0];
		expect(model).toBeDefined();
		// The whole spec must survive byte-for-byte — proves no strip.
		expect(model?.swarm).toEqual(baseSwarm);
		expect(model?.swarm?.strategy).toBe("moa");
		expect(model?.swarm?.members).toHaveLength(3);
		expect(model?.swarm?.members[2]?.surface).toBe(true);
		expect(model?.swarm?.selector?.kind).toBe("classifier");
	});

	test('api: "omp-swarm" is accepted on the provider-level enum', () => {
		const result = ModelsConfigSchema.safeParse({
			providers: { omp: { api: "omp-swarm", baseUrl: "omp://", auth: "none" } },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.providers?.omp?.api).toBe("omp-swarm");
		}
	});

	test('api: "omp-swarm" is accepted on the model-level enum', () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				omp: {
					baseUrl: "omp://",
					models: [{ id: "omp/router-balanced", api: "omp-swarm", swarm: baseSwarm }],
				},
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.providers?.omp?.models?.[0]?.api).toBe("omp-swarm");
		}
	});

	test("each swarm strategy literal parses", () => {
		for (const strategy of ["router", "draft-refine", "sequence", "moa"] as const) {
			const result = ModelsConfigSchema.safeParse({
				providers: {
					omp: {
						baseUrl: "omp://",
						models: [{ id: `omp/${strategy}`, swarm: { strategy, members: [{ role: "a", model: "x/y" }] } }],
					},
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.providers?.omp?.models?.[0]?.swarm?.strategy).toBe(strategy);
			}
		}
	});

	test("an unknown strategy fails parse", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				omp: {
					baseUrl: "omp://",
					models: [{ id: "omp/bad", swarm: { strategy: "consensus", members: [{ role: "a", model: "x/y" }] } }],
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("an empty members array fails parse (members.min(1))", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				omp: {
					baseUrl: "omp://",
					models: [{ id: "omp/empty", swarm: { strategy: "moa", members: [] } }],
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("an invalid selector kind fails parse", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				omp: {
					baseUrl: "omp://",
					models: [
						{
							id: "omp/bad-selector",
							swarm: {
								strategy: "router",
								members: [{ role: "a", model: "x/y" }],
								selector: { kind: "semantic" },
							},
						},
					],
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("a model missing role/model in a member fails parse", () => {
		const result = ModelsConfigSchema.safeParse({
			providers: {
				omp: {
					baseUrl: "omp://",
					models: [{ id: "omp/bad-member", swarm: { strategy: "sequence", members: [{ role: "draft" }] } }],
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("a config without swarm is unchanged (no contamination)", () => {
		const config = {
			providers: {
				openai: {
					api: "openai-completions" as const,
					baseUrl: "https://api.openai.com/v1",
					apiKey: "sk-test",
					models: [{ id: "gpt-4o" }],
				},
			},
		};

		const result = ModelsConfigSchema.safeParse(config);
		expect(result.success).toBe(true);
		if (!result.success) return;

		const model = result.data.providers?.openai?.models?.[0];
		expect(model?.id).toBe("gpt-4o");
		// No swarm key introduced where the user authored none.
		expect(model?.swarm).toBeUndefined();
		expect(result.data.providers?.openai?.api).toBe("openai-completions");
	});
});
