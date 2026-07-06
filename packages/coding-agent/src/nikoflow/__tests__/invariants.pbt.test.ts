import { describe, expect, test } from "bun:test";
import { detectReviewerVerdict } from "../gates";
import {
	advancePhase,
	createState,
	currentPhase,
	gateMatches,
	isComplete,
	materializePhases,
	NIKOFLOW_DEPTHS,
	type NikoflowDepth,
	type NikoflowState,
	rotateGateRequest,
} from "../state";

const CASES = 1_000;
const SEED = 0x5eed_1234;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-:{}[]\\",. /\\n\\t';

function rng(seed: number): () => number {
	let value = seed >>> 0;
	return () => {
		value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
		return value;
	};
}

function int(random: () => number, maxExclusive: number): number {
	return random() % maxExclusive;
}

function string(random: () => number): string {
	const length = int(random, 64);
	let value = "";
	for (let i = 0; i < length; i++) {
		value += ALPHABET[int(random, ALPHABET.length)];
	}
	return value;
}

function distinctString(random: () => number, other: string): string {
	const value = string(random);
	return value === other ? `${value}#primary` : value;
}

function depth(random: () => number): NikoflowDepth {
	return NIKOFLOW_DEPTHS[int(random, NIKOFLOW_DEPTHS.length)];
}

function stateWithGate(random: () => number, gateRequestId: string | null): NikoflowState {
	const selectedDepth = depth(random);
	return {
		depth: selectedDepth,
		phaseIndex: int(random, materializePhases(selectedDepth).length + 5) - 2,
		gateRequestId,
		gateMintedAt: gateRequestId ? int(random, 1_000_000) : null,
	};
}

function primaryLikeString(random: () => number, gateId: string, caseIndex: number): string {
	const value = (() => {
		switch (caseIndex % 5) {
			case 0:
				return distinctString(random, gateId);
			case 1:
				return `gate:${gateId}`;
			case 2:
				return JSON.stringify({ gateId, verdict: "pass" });
			case 3:
				return "pass";
			default:
				return `${gateId}#stale`;
		}
	})();
	return value === gateId ? `${value}#primary` : value;
}

function expectCompletesInExactly(depthValue: NikoflowDepth): void {
	let state = createState(depthValue);
	const phases = materializePhases(depthValue);

	for (let step = 0; step < phases.length; step++) {
		expect(isComplete(state)).toBe(false);
		expect(currentPhase(state)).toBe(phases[step]);
		expect(currentPhase(state) === null).toBe(isComplete(state));

		const next = advancePhase(state);
		expect(next.phaseIndex).toBe(state.phaseIndex + 1);
		expect(next.phaseIndex).toBeGreaterThan(state.phaseIndex);
		state = next;
	}

	expect(state.phaseIndex).toBe(phases.length);
	expect(isComplete(state)).toBe(true);
	expect(currentPhase(state)).toBeNull();
	expect(currentPhase(state) === null).toBe(isComplete(state));
}

describe("nikoflow hard invariants", () => {
	test(`NO-SELF-APPROVE across ${CASES} generated primary strings`, () => {
		const random = rng(SEED);

		for (let i = 0; i < CASES; i++) {
			const gateId = string(random);
			const primary = primaryLikeString(random, gateId, i);
			const state = stateWithGate(random, gateId);

			expect(primary).not.toBe(gateId);
			expect(gateMatches(state, primary)).toBe(false);
			expect(gateMatches(state, null)).toBe(false);
			expect(gateMatches(state, gateId)).toBe(true);
			expect(detectReviewerVerdict(primary, state)).toEqual({ matched: false, reason: "not_tool_result" });
		}
	});

	test(`ROTATION-SOUNDNESS across ${CASES} generated id pairs`, () => {
		const random = rng(SEED ^ 0xa11ce);

		for (let i = 0; i < CASES; i++) {
			const id1 = string(random);
			const id2 = distinctString(random, id1);
			const state = stateWithGate(random, id1);
			const rotated = rotateGateRequest(state, id2);

			expect(gateMatches(rotated, id1)).toBe(false);
			expect(gateMatches(rotated, id2)).toBe(true);
		}
	});

	test(`NO-DEADLOCK / BOUNDED PROGRESS across ${CASES} generated depths`, () => {
		const random = rng(SEED ^ 0xb0_0d);

		for (const depthValue of NIKOFLOW_DEPTHS) {
			expectCompletesInExactly(depthValue);
		}

		for (let i = 0; i < CASES; i++) {
			expectCompletesInExactly(depth(random));
		}
	});
});
