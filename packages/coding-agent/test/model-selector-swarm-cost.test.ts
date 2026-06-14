import { beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model, SwarmSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	computeSwarmSummedCost,
	type MemberCostLookup,
	type MemberCostRate,
	ModelSelectorComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

/**
 * U10 — picker cost surfacing for blended (`omp-swarm`) models.
 *
 * The bulk of the coverage targets the PURE helper {@link computeSwarmSummedCost}:
 * it takes a {@link SwarmSpec} plus a cost-lookup fn and returns the summed
 * member cost WITHOUT touching a `ModelRegistry`, so the per-strategy reduce
 * (router ≈ 1 member + classifier; sequence/draft-refine/moa = Σ members) is
 * exercised deterministically. A small component test then asserts the additive
 * contract: a blended row renders the cost, a normal row is byte-identical.
 */

/** Build a lookup from a plain `{ id|provider/id -> {input, output} }` table. */
function lookupFrom(table: Record<string, MemberCostRate>): MemberCostLookup {
	return modelId => table[modelId];
}

describe("computeSwarmSummedCost (pure helper)", () => {
	test("sequence sums every member's input+output rate", () => {
		const swarm: SwarmSpec = {
			strategy: "sequence",
			members: [
				{ role: "draft", model: "p/draft" },
				{ role: "refine", model: "p/refine", surface: true },
			],
		};
		const summed = computeSwarmSummedCost(
			swarm,
			lookupFrom({ "p/draft": { input: 1, output: 4 }, "p/refine": { input: 3, output: 15 } }),
		);
		expect(summed).toBeDefined();
		// input = 1 + 3 = 4; output = 4 + 15 = 19; blended = 23.
		expect(summed?.input).toBe(4);
		expect(summed?.output).toBe(19);
		expect(summed?.blended).toBe(23);
		expect(summed?.counted).toBe(2);
		expect(summed?.resolved).toBe(2);
	});

	test("draft-refine sums every member (same reduce as sequence)", () => {
		const swarm: SwarmSpec = {
			strategy: "draft-refine",
			members: [
				{ role: "draft", model: "p/cheap" },
				{ role: "refine", model: "p/strong", surface: true },
			],
		};
		const summed = computeSwarmSummedCost(
			swarm,
			lookupFrom({ "p/cheap": { input: 0.5, output: 2 }, "p/strong": { input: 5, output: 25 } }),
		);
		expect(summed?.blended).toBeCloseTo(32.5, 5);
		expect(summed?.resolved).toBe(2);
	});

	test("moa sums all proposers AND the aggregator", () => {
		const swarm: SwarmSpec = {
			strategy: "moa",
			members: [
				{ role: "proposer", model: "p/mid" },
				{ role: "proposer", model: "p/mid" },
				{ role: "proposer", model: "p/mid" },
				{ role: "aggregator", model: "p/strong", surface: true },
			],
		};
		const summed = computeSwarmSummedCost(
			swarm,
			lookupFrom({ "p/mid": { input: 1, output: 5 }, "p/strong": { input: 5, output: 25 } }),
		);
		// 3 proposers @ (1+5)=6 each = 18, plus aggregator (5+25)=30 → 48.
		expect(summed?.blended).toBe(48);
		expect(summed?.counted).toBe(4);
		expect(summed?.resolved).toBe(4);
	});

	test("router counts ONE member (worst-case candidate) + the classifier", () => {
		const swarm: SwarmSpec = {
			strategy: "router",
			members: [
				{ role: "weak", model: "p/weak" },
				{ role: "strong", model: "p/strong" },
			],
			selector: { kind: "classifier", model: "p/weak" },
		};
		const summed = computeSwarmSummedCost(
			swarm,
			lookupFrom({ "p/weak": { input: 1, output: 4 }, "p/strong": { input: 5, output: 20 } }),
		);
		// One member runs per turn → worst-case is the priciest candidate (strong,
		// blended 25); plus the classifier (weak, blended 5) → 30. NOT the sum of
		// both members (which would be 30 too here — so use asymmetric rates below
		// to prove only one member is counted).
		expect(summed?.counted).toBe(2); // 1 member + 1 classifier, NOT 3.
		expect(summed?.blended).toBe(30);
	});

	test("router picks the most expensive member, not the first or the sum of all", () => {
		const swarm: SwarmSpec = {
			strategy: "router",
			members: [
				{ role: "weak", model: "p/weak" },
				{ role: "strong", model: "p/strong" },
			],
			// No classifier selector → rule routing, so only the member cost counts.
		};
		const summed = computeSwarmSummedCost(
			swarm,
			lookupFrom({ "p/weak": { input: 1, output: 1 }, "p/strong": { input: 100, output: 100 } }),
		);
		// Sum-of-all would be 202; first-member would be 2; worst-case is 200.
		expect(summed?.counted).toBe(1);
		expect(summed?.blended).toBe(200);
	});

	test("router classifier with kind:rule contributes no classifier call", () => {
		const swarm: SwarmSpec = {
			strategy: "router",
			members: [
				{ role: "a", model: "p/a" },
				{ role: "b", model: "p/b" },
			],
			selector: { kind: "rule" },
		};
		const summed = computeSwarmSummedCost(
			swarm,
			lookupFrom({ "p/a": { input: 2, output: 2 }, "p/b": { input: 1, output: 1 } }),
		);
		// rule selector → no classifier model → only the worst member is counted.
		expect(summed?.counted).toBe(1);
		expect(summed?.blended).toBe(4);
	});

	test("maxMembers caps the members counted (mirrors capMembers)", () => {
		const swarm: SwarmSpec = {
			strategy: "moa",
			members: [
				{ role: "proposer", model: "p/x" },
				{ role: "proposer", model: "p/x" },
				{ role: "proposer", model: "p/x" },
				{ role: "aggregator", model: "p/x", surface: true },
			],
			maxMembers: 2,
		};
		const summed = computeSwarmSummedCost(swarm, lookupFrom({ "p/x": { input: 1, output: 1 } }));
		// Only the first 2 members survive the cap → blended 2 + 2 = 4, not 8.
		expect(summed?.counted).toBe(2);
		expect(summed?.blended).toBe(4);
	});

	test("unresolved members contribute 0 and are tallied separately", () => {
		const swarm: SwarmSpec = {
			strategy: "sequence",
			members: [
				{ role: "draft", model: "p/known" },
				{ role: "refine", model: "p/unknown" },
			],
		};
		const summed = computeSwarmSummedCost(swarm, lookupFrom({ "p/known": { input: 2, output: 3 } }));
		expect(summed?.blended).toBe(5); // unknown contributes 0
		expect(summed?.counted).toBe(2);
		expect(summed?.resolved).toBe(1);
	});

	test("returns undefined only when the cap leaves no members", () => {
		const swarm: SwarmSpec = { strategy: "moa", members: [{ role: "x", model: "p/x" }], maxMembers: 0 };
		// maxMembers: 0 is treated as the default cap (5), so the single member survives.
		const summed = computeSwarmSummedCost(swarm, lookupFrom({ "p/x": { input: 1, output: 1 } }));
		expect(summed?.counted).toBe(1);

		const empty: SwarmSpec = { strategy: "sequence", members: [] };
		expect(computeSwarmSummedCost(empty, lookupFrom({}))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Component-level additive contract: blended row shows cost, normal row doesn't.
// ---------------------------------------------------------------------------

function normalizeRenderedText(text: string): string {
	return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector swarm-cost tests");
	}
	setThemeInstance(testTheme);
}

function memberModel(provider: string, id: string, input: number, output: number): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input, output, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

function blendedModel(swarm: SwarmSpec): Model {
	return buildModel({
		id: "draft-refine",
		name: "OMP Draft → Refine",
		api: "omp-swarm",
		provider: "omp",
		baseUrl: "omp://",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		swarm,
	});
}

function createScopedSelector(models: Model[], settings: Settings): ModelSelectorComponent {
	const modelRegistry = {
		getAll: () => models,
		getAvailable: () => models,
		getDiscoverableProviders: () => [],
		getCanonicalModelSelections: () => [],
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		undefined,
		settings,
		modelRegistry,
		models.map(model => ({ model })),
		() => {},
		() => {},
	);
}

describe("ModelSelector blended-model cost surfacing", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector swarm-cost tests");
		}
	});

	test("renders the summed (~Nx) cost on a blended model row", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const cheap = memberModel("omp", "cheap", 1, 4);
		const strong = memberModel("omp", "strong", 5, 16);
		const blend = blendedModel({
			strategy: "draft-refine",
			members: [
				{ role: "draft", model: "omp/cheap" },
				{ role: "refine", model: "omp/strong", surface: true },
			],
		});

		const selector = createScopedSelector([blend, cheap, strong], settings);
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		// blended = (1+4) + (5+16) = 26.00; rendered as ~$26.00/1M on the blend row.
		expect(rendered).toContain("draft-refine");
		expect(rendered).toContain("~$26.00/1M");
	});

	test("does not add a cost suffix to a normal (non-blended) model row", async () => {
		installTestTheme();
		const settings = Settings.isolated({});
		const plain = memberModel("omp", "plain-model", 2, 8);

		const selector = createScopedSelector([plain], settings);
		await Bun.sleep(0);
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("plain-model");
		// The /1M synthetic-cost suffix is reserved for blended rows only.
		expect(rendered).not.toContain("/1M");
	});
});
