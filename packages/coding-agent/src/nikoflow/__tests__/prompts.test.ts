import { describe, expect, test } from "bun:test";
import { getCurrentPhaseProtocol, getPhasePrompt } from "../prompts";
import { advancePhase, createState, mintGateRequest } from "../state";

describe("nikoflow prompts", () => {
	test("injects only the current phase protocol", () => {
		const state = mintGateRequest(createState("standard"), "g1");
		const prompt = getPhasePrompt(state);
		expect(prompt).toContain("Nikoflow phase: grilling");
		expect(prompt).toContain("Required role: plan");
		expect(prompt).toContain("Gate request: g1");
		expect(prompt).not.toContain("Execute phase");
	});

	test("switches protocol by phase", () => {
		const execute = advancePhase(createState("tactical"));
		expect(getCurrentPhaseProtocol(execute)).toContain("Execute phase");
		expect(getCurrentPhaseProtocol(execute)).toContain("<nikoflow-context>");
	});
});
