import { describe, expect, it } from "bun:test";
import {
	ComposerInputRouter,
	parsePythonCommandInput,
	pythonCommandPrefixLength,
	type ComposerInputDisposition,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/composer-input-router";

function router(overrides: Partial<ConstructorParameters<typeof ComposerInputRouter<never>>[0]> = {}) {
	const calls: string[] = [];
	const instance = new ComposerInputRouter<never>(
		{
			isFocusedAgent: false,
			isStreaming: false,
			queuedMessageCount: 0,
			isCompacting: false,
			isCollabGuest: false,
			isCollabReadOnly: false,
			expandEmoticons: false,
			...overrides,
		},
		{
			continue: async () => {
				calls.push("continue");
				return true;
			},
			queue: async () => {
				calls.push("queue");
				return true;
			},
			builtin: async () => {
				calls.push("builtin");
				return "unmatched";
			},
			dispatch: async (_draft, mode): Promise<ComposerInputDisposition> => {
				calls.push(`dispatch:${mode}`);
				return mode === "followUp" ? "follow_up" : "prompt";
			},
		},
	);
	return { instance, calls };
}

describe("ComposerInputRouter", () => {
	it("trims before matching exact continue shortcuts", async () => {
		const { instance, calls } = router();
		const result = await instance.submit({ text: "  .  " });
		expect(result).toMatchObject({ accepted: true, disposition: "continue", draft: { text: "." } });
		expect(calls).toEqual(["continue"]);
	});

	it("does not treat near matches as continue", async () => {
		const { instance, calls } = router();
		const result = await instance.submit({ text: ".." });
		expect(result.disposition).toBe("prompt");
		expect(calls).toEqual(["builtin", "dispatch:primary"]);
	});

	it("aborts an active turn only for a genuinely empty queued draft", async () => {
		const calls: string[] = [];
		const instance = new ComposerInputRouter<never>(
			{
				isFocusedAgent: false,
				isStreaming: true,
				queuedMessageCount: 1,
				isCompacting: false,
				isCollabGuest: false,
				isCollabReadOnly: false,
				expandEmoticons: false,
			},
			{
				abortQueued: async () => {
					calls.push("abort");
				},
				dispatch: async () => "steer",
			},
		);
		expect((await instance.submit({ text: "" })).disposition).toBe("abort");
		expect((await instance.submit({ text: "", images: [] })).disposition).toBe("abort");
		expect(calls).toEqual(["abort", "abort"]);
	});

	it("queues shorthand before builtin command dispatch", async () => {
		const { instance, calls } = router();
		const result = await instance.submit({ text: "=> first" });
		expect(result.disposition).toBe("queue");
		expect(calls).toEqual(["queue"]);
	});

	it("keeps shell and Python prefix exclusions exact", () => {
		expect(pythonCommandPrefixLength("$ 1+1")).toBe(1);
		expect(pythonCommandPrefixLength("$$ 1+1")).toBe(2);
		expect(pythonCommandPrefixLength("$HOME")).toBe(0);
		expect(parsePythonCommandInput("$$ 1+1")).toEqual({ code: "1+1", isExcluded: true });
		expect(parsePythonCommandInput("!! printf")).toBeUndefined();
	});

	it("executes ! and !! in the local bash lane instead of dispatching an agent prompt", async () => {
		const calls: Array<{ command: string; excluded: boolean }> = [];
		const instance = new ComposerInputRouter<never>(
			{
				isFocusedAgent: false,
				isStreaming: false,
				queuedMessageCount: 0,
				isCompacting: false,
				isCollabGuest: false,
				isCollabReadOnly: false,
				expandEmoticons: false,
			},
			{
				bash: async draft => {
					if (!draft.text.startsWith("!")) return false;
					const excluded = draft.text.startsWith("!!");
					const command = draft.text.slice(excluded ? 2 : 1).trim();
					if (!command) return false;
					calls.push({ command, excluded });
					return true;
				},
				dispatch: async () => {
					expect.unreachable("local bash must not dispatch an agent prompt");
				},
			},
		);

		expect((await instance.submit({ text: "!ls" })).disposition).toBe("bash");
		expect((await instance.submit({ text: "!! pwd" })).disposition).toBe("bash");
		expect(calls).toEqual([
			{ command: "ls", excluded: false },
			{ command: "pwd", excluded: true },
		]);
	});

	it("preserves the explicit follow-up lane", async () => {
		const { instance, calls } = router();
		const result = await instance.submit({ text: "next" }, "followUp");
		expect(result.disposition).toBe("follow_up");
		expect(calls).toEqual(["builtin", "dispatch:followUp"]);
	});
});
