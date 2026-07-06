import { describe, expect, test } from "bun:test";
import { getCurrentPhaseProtocol, getPhasePrompt } from "../prompts";
import { advancePhase, createState, mintGateRequest } from "../state";

describe("nikoflow prompts", () => {
	test("injects only the current phase protocol", () => {
		const state = mintGateRequest(createState("standard"), "g1");
		const prompt = getPhasePrompt(state);
		expect(prompt).toContain("Nikoflow phase: grilling");
		expect(prompt).toContain("Required role: plan");
		expect(prompt).toContain("Mode: interactive");
		expect(prompt).toContain("Gate request: g1");
		expect(prompt).not.toContain("Execute phase");
	});

	test("batch grilling records human-unverified assumptions", () => {
		const prompt = getPhasePrompt(mintGateRequest(createState("standard", { autonomous: true }), "g1"));
		expect(prompt).toContain("Mode: batch");
		expect(prompt).toContain("unverified by a human");
		expect(prompt).toContain('"open_questions":[]');
	});

	test("switches protocol by phase", () => {
		const execute = advancePhase(createState("tactical"));
		expect(getCurrentPhaseProtocol(execute)).toContain("Execute phase");
		expect(getCurrentPhaseProtocol(execute)).toContain("<nikoflow-context>");
	});
});
