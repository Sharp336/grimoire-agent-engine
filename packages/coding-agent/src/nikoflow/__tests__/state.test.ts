import { describe, expect, test } from "bun:test";
import {
	advancePhase,
	clearGateRequest,
	createState,
	currentPhase,
	currentRole,
	gateMatches,
	inferDepthFromPrompt,
	isComplete,
	materializePhases,
	mintGateRequest,
	rotateGateRequest,
} from "../state";

describe("nikoflow state", () => {
	test("materializes phases per depth", () => {
		expect(materializePhases("tactical")).toEqual(["grilling", "execute", "verify"]);
		expect(materializePhases("standard")).toEqual(["grilling", "adr", "prd", "tickets", "execute", "verify"]);
		expect(materializePhases("deep")).toEqual(["grilling", "adr", "prd", "tickets", "execute", "verify"]);
	});

	test("infers depth from explicit flags or no-question prompts", () => {
		expect(inferDepthFromPrompt("niko flow:deep build")).toBe("deep");
		expect(inferDepthFromPrompt("делай в режиме никофлоу и не задавай вопросов")).toBe("standard");
		expect(inferDepthFromPrompt("давай никофлоу")).toBeNull();
		expect(inferDepthFromPrompt("не задавай вопросов")).toBeNull();
	});

	test("advances to complete and maps roles", () => {
		let state = createState("standard");
		expect(currentPhase(state)).toBe("grilling");
		expect(currentRole(state)).toBe("plan");
		state = advancePhase(state);
		expect(currentPhase(state)).toBe("adr");
		expect(currentRole(state)).toBe("plan");
		state = advancePhase(advancePhase(advancePhase(state)));
		expect(currentPhase(state)).toBe("execute");
		expect(currentRole(state)).toBe("default");
		state = advancePhase(state);
		expect(currentPhase(state)).toBe("verify");
		expect(currentRole(state)).toBe("advisor");
		state = advancePhase(state);
		expect(isComplete(state)).toBe(true);
		expect(currentPhase(state)).toBeNull();
		expect(currentRole(state)).toBeNull();
	});

	test("gate ids mint, rotate, clear, and fail closed", () => {
		const initial = createState("tactical");
		const minted = mintGateRequest(initial, "g1");
		const rotated = rotateGateRequest(minted, "g2");
		const cleared = clearGateRequest(rotated);

		expect(gateMatches(initial, "g1")).toBe(false);
		expect(gateMatches(minted, "g1")).toBe(true);
		expect(gateMatches(rotated, "g1")).toBe(false);
		expect(gateMatches(rotated, "g2")).toBe(true);
		expect(gateMatches(cleared, "g2")).toBe(false);
		expect(gateMatches(cleared, null)).toBe(false);
	});

	test("mutators return new objects", () => {
		const initial = createState("tactical");
		const minted = mintGateRequest(initial, "g1");
		const advanced = advancePhase(minted);

		expect(minted).not.toBe(initial);
		expect(advanced).not.toBe(minted);
		expect(initial.gateRequestId).toBeNull();
		expect(minted.gateRequestId).toBe("g1");
		expect(advanced.gateRequestId).toBeNull();
	});
});
