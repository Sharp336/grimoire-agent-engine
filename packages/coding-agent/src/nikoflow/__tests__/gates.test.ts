import { describe, expect, test } from "bun:test";
import { humanGateAccepted } from "../gates";

describe("nikoflow gates", () => {
	test("human gate requires a real later turn", () => {
		expect(humanGateAccepted(1_000, 1_001)).toBe(true);
		expect(humanGateAccepted(1_000, 1_000)).toBe(false);
		expect(humanGateAccepted(1_000, undefined)).toBe(false);
		expect(humanGateAccepted(null, 1_001)).toBe(false);
	});
});
