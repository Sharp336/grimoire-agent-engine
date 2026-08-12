import { describe, expect, it } from "bun:test";
import { ComposerInputRouter, parsePythonCommandInput } from "../src/modes/controllers/composer-input-router";

function router(overrides: Partial<ConstructorParameters<typeof ComposerInputRouter>[0]> = {}) {
	return new ComposerInputRouter({
		isStreaming: false,
		queuedMessageCount: 0,
		isCompacting: false,
		expandEmoticons: false,
		...overrides,
	});
}

describe("ComposerInputRouter", () => {
	it("keeps shell variables and unknown slash text as ordinary prompts", async () => {
		expect(await router().route("$HOME")).toEqual({ kind: "prompt", text: "$HOME" });
		expect(await router().route("/unknown thing")).toEqual({ kind: "prompt", text: "/unknown thing" });
		expect(await router().route("a => b")).toEqual({ kind: "prompt", text: "a => b" });
	});

	it("recognizes exact continue shortcuts before command hooks", async () => {
		let builtinCalled = false;
		const result = await router({
			builtin: async () => {
				builtinCalled = true;
				return { consumed: true };
			},
		}).route(" c ");
		expect(result.kind).toBe("continue");
		expect(builtinCalled).toBe(false);
	});

	it("routes empty running input only when a queue exists", async () => {
		expect(await router({ isStreaming: true, queuedMessageCount: 1 }).route(" ")).toEqual({
			kind: "abort-on-empty-running-input",
		});
		expect(await router({ isStreaming: true, queuedMessageCount: 0 }).route(" ")).toEqual({ kind: "noop", text: "" });
	});

	it("preserves queue shorthand and sequential list splitting", async () => {
		expect(await router().route("-> 1. first\n2. second")).toEqual({
			kind: "queued-messages",
			messages: ["first", "second"],
			historyText: "-> 1. first\n2. second",
			streamingBehavior: "followUp",
		});
	});

	it("keeps !! and $$ exclusion flags distinct", async () => {
		expect(await router().route("!! printf hi")).toEqual({ kind: "bash", command: "printf hi", excludeFromContext: true });
		expect(await router().route("! printf hi")).toEqual({ kind: "bash", command: "printf hi", excludeFromContext: false });
		expect(await router().route("$$ 1+1")).toEqual({ kind: "python", code: "1+1", excludeFromContext: true });
	});

	it("does not classify pasted shell prompts as python", () => {
		expect(parsePythonCommandInput("$ cd foo")).toBeUndefined();
		expect(parsePythonCommandInput("$ x + 1")).toEqual({ code: "x + 1", isExcluded: false });
		expect(parsePythonCommandInput("${HOME}")).toBeUndefined();
	});

	it("uses the explicit follow-up lane while streaming", async () => {
		expect(await router({ isStreaming: true }).route("later", undefined, "followUp")).toEqual({
			kind: "follow-up",
			text: "later",
		});
	});
});
