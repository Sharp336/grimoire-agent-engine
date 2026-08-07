import { describe, expect, test, vi } from "bun:test";
import { RpcSemanticRenderingManager } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-semantic-rendering";

describe("RpcSemanticRenderingManager", () => {
	test("correlates validated actions and emits revised semantic content", async () => {
		const output = vi.fn<(frame: object) => void>();
		const manager = new RpcSemanticRenderingManager(output);
		const renderId = manager.register({
			source: { kind: "tool", toolCallId: "tool-1", toolName: "write" },
			content: {
				version: 1,
				fallback: { format: "plain", text: "Apply change" },
				blocks: [{ kind: "actions", actions: [{ id: "apply", label: "Apply" }] }],
			},
			actions: new Map([
				[
					"apply",
					async ({ input, requestId }) => ({
						version: 1 as const,
						fallback: { format: "plain" as const, text: "Applied" },
						blocks: [
							{ kind: "fields" as const, fields: [{ label: "Request", value: requestId }] },
							{ kind: "fields" as const, fields: [{ label: "Scope", value: String(input?.scope) }] },
						],
					}),
				],
			]),
		});

		await expect(manager.invoke(renderId, "apply", { scope: "focused" }, "request-1")).resolves.toMatchObject({
			type: "semantic_action_settled",
			renderId,
			actionId: "apply",
			requestId: "request-1",
			outcome: { state: "accepted" },
		});
		expect(output.mock.calls.map(call => call[0])).toEqual([
			expect.objectContaining({ type: "semantic_content", renderId, revision: 1 }),
			{
				type: "semantic_action_requested",
				renderId,
				actionId: "apply",
				requestId: "request-1",
			},
			expect.objectContaining({
				type: "semantic_content",
				renderId,
				revision: 2,
				content: expect.objectContaining({ fallback: { format: "plain", text: "Applied" } }),
			}),
			expect.objectContaining({
				type: "semantic_action_settled",
				renderId,
				actionId: "apply",
				requestId: "request-1",
				outcome: { state: "accepted" },
			}),
		]);
	});

	test("cancels an active action and reports unknown actions without invoking extensions", async () => {
		const output = vi.fn<(frame: object) => void>();
		const manager = new RpcSemanticRenderingManager(output);
		const started = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const renderId = manager.register({
			source: { kind: "extension", extensionPath: "/extension.ts" },
			content: {
				version: 1,
				fallback: { format: "plain", text: "Cancelable" },
				blocks: [{ kind: "actions", actions: [{ id: "run", label: "Run" }] }],
			},
			actions: new Map([
				[
					"run",
					async ({ signal }) => {
						started.resolve();
						signal.addEventListener("abort", () => aborted.resolve(), { once: true });
						await aborted.promise;
					},
				],
			]),
		});
		const action = manager.invoke(renderId, "run", undefined, "request-run");
		await started.promise;
		expect(manager.cancel(renderId, "run")).toBe(true);
		await expect(action).resolves.toMatchObject({ outcome: { state: "cancelled" } });
		await expect(manager.invoke(renderId, "missing", undefined, "request-missing")).resolves.toMatchObject({
			outcome: { state: "unsupported", message: "Unknown semantic action: missing" },
		});
	});

	test("rejects invalid content and declared actions without handlers", () => {
		const manager = new RpcSemanticRenderingManager(() => {});
		expect(() =>
			manager.register({
				source: { kind: "system" },
				content: {
					version: 1,
					fallback: { format: "plain", text: "Unsafe" },
					blocks: [{ kind: "text", format: "plain", text: "\u001b[31munsafe" }],
				},
			}),
		).toThrow("Invalid semantic content");
		expect(() =>
			manager.register({
				source: { kind: "system" },
				content: {
					version: 1,
					fallback: { format: "plain", text: "Missing handler" },
					blocks: [{ kind: "actions", actions: [{ id: "orphan", label: "Orphan" }] }],
				},
			}),
		).toThrow("has no handler");
	});
});
