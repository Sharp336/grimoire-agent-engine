import { describe, expect, test } from "bun:test";
import { projectBoundedRpcContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { ContextAssemblySnapshot } from "@oh-my-pi/pi-coding-agent/session/session-context-projection";

const visibility = { persisted: true, display: true, model: true } as const;
const inclusion = { included: true, reason: "active-branch" } as const;

describe("RPC context projection", () => {
	test("bounds source and relation lists without parsing rendered prompt text", () => {
		const snapshot: ContextAssemblySnapshot = {
			revision: 1,
			leafId: "leaf-1",
			sources: [
				{ id: "source-1", category: "stored", kind: "message", visibility, inclusion },
				{ id: "source-2", category: "stored", kind: "message", visibility, inclusion },
			],
			relations: [{ kind: "branch-order", sourceId: "source-1", position: 0 }],
			systemPrompt: { logicalSources: [], rendered: [] },
		};

		const projected = projectBoundedRpcContext(snapshot, {
			maxSources: 1,
			maxRelations: 0,
			maxContentBytes: 0,
		});

		expect(projected.snapshot.sources.map(source => source.id)).toEqual(["source-1"]);
		expect(projected.snapshot.relations).toEqual([]);
		expect(projected.returned).toEqual({ sources: 1, relations: 0, contentBytes: 0 });
		expect(projected.truncated).toEqual({ sources: true, relations: true, content: false });
	});

	test("bounds every nested source and relation collection", () => {
		const snapshot: ContextAssemblySnapshot = {
			revision: 1,
			leafId: "leaf-1",
			sources: [
				{ id: "source-1", category: "stored", kind: "message", visibility, inclusion },
				{ id: "source-2", category: "stored", kind: "message", visibility, inclusion },
			],
			relations: [
				{
					kind: "generated-from",
					sourceIds: ["source-1", "source-2"],
					targetIds: ["source-1", "source-2"],
				},
			],
			systemPrompt: {
				logicalSources: [
					{ id: "system-1", kind: "default", foldedInto: [0, 1] },
					{ id: "system-2", kind: "append", foldedInto: [] },
				],
				rendered: ["rendered-1", "rendered-2"],
			},
			provider: {
				systemPrompt: ["provider-system-1", "provider-system-2"],
				messages: [
					{ role: "user", content: "provider-1", timestamp: 1 },
					{ role: "user", content: "provider-2", timestamp: 2 },
				],
				relations: [
					{
						kind: "split",
						sourceIds: ["source-1", "source-2"],
						transformedMessageIndexes: [0, 1],
						providerMessageIndexes: [0, 1],
					},
					{
						kind: "dropped",
						sourceIds: ["source-3"],
						transformedMessageIndexes: [2],
						providerMessageIndexes: [],
					},
				],
			},
			tokenEvidence: [
				{ kind: "provider-aggregate", tokens: 1, source: "provider-usage" },
				{ kind: "provider-aggregate", tokens: 2, source: "provider-usage" },
			],
		};

		const projected = projectBoundedRpcContext(snapshot, {
			maxSources: 1,
			maxRelations: 1,
			maxContentBytes: 1_000,
		});

		expect(projected.snapshot.systemPrompt.logicalSources).toHaveLength(1);
		expect(projected.snapshot.systemPrompt.logicalSources[0]?.foldedInto).toEqual([0]);
		expect(projected.snapshot.systemPrompt.rendered).toEqual(["rendered-1"]);
		expect(projected.snapshot.provider?.systemPrompt).toEqual(["provider-system-1"]);
		expect(projected.snapshot.provider?.messages).toEqual([{ role: "user", content: "provider-1", timestamp: 1 }]);
		expect(projected.snapshot.provider?.relations).toEqual([
			{
				kind: "split",
				sourceIds: ["source-1"],
				transformedMessageIndexes: [0],
				providerMessageIndexes: [0],
			},
		]);
		expect(projected.snapshot.tokenEvidence).toHaveLength(1);
		expect(projected.truncated.sources).toBeTrue();
		expect(projected.truncated.relations).toBeTrue();
	});

	test("retains only complete content values within one shared UTF-8 byte budget", () => {
		const sourceContent = "α";
		const sourceBytes = Buffer.byteLength(JSON.stringify(sourceContent), "utf8");
		const snapshot: ContextAssemblySnapshot = {
			revision: 1,
			leafId: null,
			sources: [
				{
					id: "source-1",
					category: "stored",
					kind: "message",
					content: sourceContent,
					visibility,
					inclusion,
				},
			],
			relations: [],
			systemPrompt: {
				logicalSources: [{ id: "system-1", kind: "default", content: "too-large", foldedInto: [0] }],
				rendered: ["also-too-large"],
			},
		};

		const projected = projectBoundedRpcContext(snapshot, {
			maxContentBytes: sourceBytes,
		});

		expect(projected.snapshot.sources[0]?.content).toBe(sourceContent);
		expect(projected.snapshot.systemPrompt.logicalSources[0]).not.toHaveProperty("content");
		expect(projected.snapshot.systemPrompt.rendered).toEqual([]);
		expect(projected.returned.contentBytes).toBe(sourceBytes);
		expect(projected.truncated.content).toBeTrue();
	});

	test("filters bounded lineage against retained sources and provider messages", () => {
		const snapshot: ContextAssemblySnapshot = {
			revision: 1,
			leafId: null,
			sources: [
				{ id: "source-1", category: "stored", kind: "message", visibility, inclusion },
				{ id: "source-2", category: "stored", kind: "message", visibility, inclusion },
			],
			relations: [
				{
					kind: "generated-from",
					sourceIds: ["source-2", "source-1"],
					targetIds: ["source-2", "source-1"],
				},
			],
			systemPrompt: { logicalSources: [], rendered: [] },
			provider: {
				messages: [
					{ role: "user", content: "provider-1", timestamp: 1 },
					{ role: "user", content: "provider-2", timestamp: 2 },
				],
				relations: [
					{
						kind: "split",
						sourceIds: ["source-2", "source-1"],
						transformedMessageIndexes: [1, 0],
						providerMessageIndexes: [1, 0],
					},
				],
			},
		};

		const projected = projectBoundedRpcContext(snapshot, {
			maxSources: 1,
			maxRelations: 1,
			maxContentBytes: 1_000,
		});

		expect(projected.snapshot.relations).toEqual([
			{ kind: "generated-from", sourceIds: ["source-1"], targetIds: ["source-1"] },
		]);
		expect(projected.snapshot.provider?.relations).toEqual([
			{
				kind: "split",
				sourceIds: ["source-1"],
				transformedMessageIndexes: [0],
				providerMessageIndexes: [0],
			},
		]);
		expect(projected.truncated.relations).toBeTrue();
	});

	test("remaps rendered prompt lineage after content elision", () => {
		const kept = "kept";
		const snapshot: ContextAssemblySnapshot = {
			revision: 1,
			leafId: null,
			sources: [
				{
					id: "system:system-1",
					category: "system",
					kind: "default",
					visibility,
					inclusion,
				},
			],
			relations: [
				{
					kind: "system-fold",
					sourceIds: ["system:system-1"],
					targetIds: ["system-rendered:1"],
				},
			],
			systemPrompt: {
				logicalSources: [{ id: "system-1", kind: "default", foldedInto: [1] }],
				rendered: ["too-large", kept],
			},
		};

		const projected = projectBoundedRpcContext(snapshot, {
			maxSources: 2,
			maxRelations: 2,
			maxContentBytes: Buffer.byteLength(JSON.stringify(kept), "utf8"),
		});

		expect(projected.snapshot.systemPrompt.rendered).toEqual([kept]);
		expect(projected.snapshot.systemPrompt.logicalSources[0]?.foldedInto).toEqual([0]);
		expect(projected.snapshot.relations).toEqual([
			{
				kind: "system-fold",
				sourceIds: ["system:system-1"],
				targetIds: ["system-rendered:0"],
			},
		]);
		expect(projected.truncated.content).toBeTrue();
	});
	test("applies the content budget to output metadata diagnostics", () => {
		const snapshot: ContextAssemblySnapshot = {
			revision: 1,
			leafId: null,
			sources: [
				{
					id: "source-1",
					category: "stored",
					kind: "pythonExecution",
					visibility,
					inclusion,
					outputMeta: {
						diagnostics: {
							summary: "large diagnostics",
							messages: ["unbounded-diagnostic".repeat(1_000)],
						},
					},
				},
			],
			relations: [],
			systemPrompt: { logicalSources: [], rendered: [] },
		};

		const projected = projectBoundedRpcContext(snapshot, { maxContentBytes: 0 });

		expect(projected.snapshot.sources[0]).not.toHaveProperty("outputMeta");
		expect(projected.returned.contentBytes).toBe(0);
		expect(projected.truncated.content).toBeTrue();
	});
});
