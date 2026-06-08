import { describe, it } from "bun:test";
import { buildAppViewportScenarios, runStressScenario } from "./render-stress-harness";

describe("TUI app viewport stress harness", () => {
	for (const scenario of buildAppViewportScenarios()) {
		it(
			`${scenario.name} seed=${scenario.seed.toString(16)}`,
			async () => {
				await runStressScenario(scenario);
			},
			scenario.timeoutMs,
		);
	}
});
