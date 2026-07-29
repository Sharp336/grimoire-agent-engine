import { describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent } from "../src/agent";
import type { ProviderContextSnapshot } from "../src/types";

describe("onProviderContext", () => {
	test("observes the post-transform, post-dialect context without being able to change it", async () => {
		const model = createMockModel({
			id: "snapshot-model",
			provider: "snapshot-provider",
			responses: [{ content: ["done"] }],
		});
		let snapshot: ProviderContextSnapshot | undefined;
		let observedPrompt: string[] = [];
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["base"],
				tools: [
					{
						name: "ordered_tool",
						label: "Ordered tool",
						description: "test tool",
						parameters: { type: "object", properties: {}, additionalProperties: false },
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				],
			},
			streamFn: model.stream,
			dialect: "xml",
			getApiKey: () => "super-secret",
			transformProviderContext: context => ({
				...context,
				systemPrompt: [...(context.systemPrompt ?? []), "transformed"],
			}),
			onProviderContext: async value => {
				await Promise.resolve();
				snapshot = value;
				observedPrompt = value.context.systemPrompt?.slice() ?? [];
				value.context.systemPrompt?.push("observer mutation");
			},
		});

		await agent.prompt("hello");

		expect(snapshot).toBeDefined();
		expect(snapshot?.model).toEqual({ provider: "snapshot-provider", id: "snapshot-model" });
		// Own transform ran first, then the owned xml dialect moved tools into the prompt.
		expect(observedPrompt.slice(0, 2)).toEqual(["base", "transformed"]);
		expect(observedPrompt.at(-1)).toContain("ordered_tool");
		expect(snapshot?.context.tools).toBeUndefined();
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0]?.context).not.toBe(snapshot?.context);
		expect(model.calls[0]?.context.systemPrompt).toEqual(observedPrompt);
		expect(model.calls[0]?.context.systemPrompt).not.toContain("observer mutation");
		// Credentials reach the provider but never the snapshot.
		expect(model.calls[0]?.options?.apiKey).toBe("super-secret");
		expect(Object.keys(snapshot ?? {}).sort()).toEqual(["context", "model", "timestamp"]);
	});

	test("isolates synchronous and asynchronous observer failures from dispatch", async () => {
		const failures = [
			() => {
				throw new Error("synchronous observer failure");
			},
			async () => {
				await Promise.resolve();
				throw new Error("asynchronous observer failure");
			},
		];

		for (const onProviderContext of failures) {
			const model = createMockModel({ responses: [{ content: ["dispatched"] }] });
			const agent = new Agent({
				initialState: { model },
				streamFn: model.stream,
				onProviderContext,
			});

			await agent.prompt("hello");
			expect(model.calls).toHaveLength(1);
		}
	});
});
