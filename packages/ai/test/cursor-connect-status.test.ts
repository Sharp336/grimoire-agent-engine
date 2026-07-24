import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";

// Contract: the advisor runtime reclassifies a stringified Cursor error, so the
// transient transport pattern must recognize the exact Connect / gRPC status
// text Cursor surfaces — without sweeping up terminal auth/user failures.
describe("Cursor transient status classification", () => {
	it("classifies the Connect `unavailable` status text as transient", () => {
		const id = AIError.classify(
			new Error('Advisor "grok" unavailable: Connect error unavailable: Error'),
			"cursor-agent",
		);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("classifies gRPC status 14 (UNAVAILABLE) as transient", () => {
		const id = AIError.classify(
			new Error("gRPC error 14: connection reset before headers were received"),
			"cursor-agent",
		);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("does not classify a 401 auth failure as transient", () => {
		const id = AIError.classify(new Error("401 unauthorized: invalid api key"), "cursor-agent");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
		expect(AIError.is(id, AIError.Flag.AuthFailed)).toBe(true);
	});

	it("does not classify a plain gRPC INVALID_ARGUMENT (status 3) as transient", () => {
		const id = AIError.classify(new Error("gRPC error 3: invalid argument"), "cursor-agent");
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
	});
});
