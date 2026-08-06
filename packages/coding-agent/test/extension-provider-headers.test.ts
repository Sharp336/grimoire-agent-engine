import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { wrapStreamFnWithProviderHeaders } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/provider-headers";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";

/** Minimal runner stand-in: only the two members the wrapper consumes. */
function fakeRunner(
	subscribed: boolean,
	edit?: (headers: Record<string, string>) => void,
): { runner: ExtensionRunner; seen: Record<string, string>[] } {
	const seen: Record<string, string>[] = [];
	const runner = {
		hasHandlers: (event: string) => subscribed && event === "before_provider_headers",
		emitBeforeProviderHeaders: async (headers: Record<string, string>) => {
			seen.push(headers);
			edit?.(headers);
			return headers;
		},
	} as unknown as ExtensionRunner;
	return { runner, seen };
}

/** Records the options each call receives, and returns an empty stream. */
function recordingBase(): { base: StreamFn; calls: (Record<string, string> | undefined)[] } {
	const calls: (Record<string, string> | undefined)[] = [];
	const base: StreamFn = (_model, _context, options) => {
		calls.push(options?.headers);
		return new AssistantMessageEventStream();
	};
	return { base, calls };
}

const model = { provider: "test", id: "test-model", api: "openai-completions" } as never;
const context = {} as never;

describe("wrapStreamFnWithProviderHeaders", () => {
	it("forwards to base untouched when nothing subscribes", async () => {
		const { runner, seen } = fakeRunner(false);
		const { base, calls } = recordingBase();
		const original = { "x-a": "1" };

		await wrapStreamFnWithProviderHeaders(runner, base)(model, context, { headers: original });

		expect(seen).toHaveLength(0);
		// No copy is made on this path, so base sees the caller's own object.
		expect(calls[0]).toBe(original);
	});

	it("applies handler edits to the headers base receives", async () => {
		const { runner } = fakeRunner(true, headers => {
			headers["x-added"] = "yes";
		});
		const { base, calls } = recordingBase();

		await wrapStreamFnWithProviderHeaders(runner, base)(model, context, { headers: { "x-a": "1" } });

		expect(calls[0]).toEqual({ "x-a": "1", "x-added": "yes" });
	});

	it("does not let handlers mutate the caller's options object", async () => {
		const { runner } = fakeRunner(true, headers => {
			headers["x-added"] = "yes";
		});
		const { base } = recordingBase();
		const original = { "x-a": "1" };

		await wrapStreamFnWithProviderHeaders(runner, base)(model, context, { headers: original });

		expect(original).toEqual({ "x-a": "1" });
	});

	it("supplies an object to handlers even when the caller sent no headers", async () => {
		const { runner, seen } = fakeRunner(true);
		const { base, calls } = recordingBase();

		await wrapStreamFnWithProviderHeaders(runner, base)(model, context, {});

		expect(seen[0]).toEqual({});
		expect(calls[0]).toEqual({});
	});
});
