import { describe, expect, it, spyOn } from "bun:test";
import type { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import {
	RUNTIME_PROTOCOL_HASH,
	type RuntimeScope,
	runtimeLimits,
	validateRuntimeValue,
} from "../src/engine/runtime-protocol";
import type { StoragePayload } from "../src/session/storage-protocol";
import {
	active,
	binding,
	command,
	eventsRequest,
	identity,
	nativeCheckpoint,
	runtimeV1Fixture,
} from "./helpers/runtime-v1-rocks-fixture";
import { storageWorkerUnavailable } from "./helpers/storage-worker-fixture";

/** Fail the owner commit that stages `matches`; nothing of that atomic batch is applied. */
function failCommit(
	store: RocksEngineStore,
	message: string,
	matches: (put: { kind: string; id: string; value: StoragePayload }) => boolean,
) {
	const write = store.storageClient.write.bind(store.storageClient);
	return spyOn(store.storageClient, "write").mockImplementation((input, ...rest) => {
		if (input.runtime?.puts.some(matches)) throw new Error(message);
		return write(input, ...rest);
	});
}

describe.skipIf(storageWorkerUnavailable)("runtime v1 durable boundaries", () => {
	const { createStore, reopen } = runtimeV1Fixture();
	async function identityRows(store: RocksEngineStore, names: string[]) {
		return Promise.all(
			names.map(async name => {
				const row = (await store.records.get("identity", identity(name).agentInstanceId)).value;
				return [row?.intent_revision, row?.summary_revision, row?.summary_json];
			}),
		);
	}

	it("refuses a too-wide branch atomically without imposing a device AgentInstance cap", async () => {
		const store = await createStore();
		await store.registerAgent(identity("wide"));
		await store.registerAgent(identity("sibling"));
		// Native branch control is one atomic owner batch of at most 64 agents; the root plus 64 children exceed it.
		const names = ["wide", "sibling"];
		for (let index = 0; index < 64; index++) {
			names.push(`wide-retained-${index}`);
			await store.registerAgent(identity(`wide-retained-${index}`, identity("wide").agentInstanceId));
		}
		const before = await identityRows(store, names);
		const cut = (await store.meta()).watermark;
		const error = await store.branchIntent(identity("wide").agentInstanceId, "pause-wide", "pause", 0).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ code: "restore_budget" });
		expect(await identityRows(store, names)).toEqual(before);
		expect((await store.meta()).watermark).toBe(cut);
		expect((await store.records.get("hold", `${identity("wide").agentInstanceId}:pause`)).value).toBeNull();
		await store.registerAgent(identity("after-limit"));
		await store.branchIntent(identity("sibling").agentInstanceId, "pause-sibling", "pause", 0);
		expect((await store.intent(identity("sibling").agentInstanceId)).manualHold).toBe(true);
		expect((await store.intent(identity("wide").agentInstanceId)).manualHold).toBe(false);
	});
	it("rolls back a branch control over the cumulative atomic record budget instead of publishing partial holds", async () => {
		const store = await createStore();
		await store.registerAgent(identity("heavy"));
		// Within the 64-agent branch bound, but every member adds its own hold and binding reads to one batch.
		const names = ["heavy"];
		for (let index = 0; index < 30; index++) {
			names.push(`heavy-retained-${index}${"x".repeat(700)}`);
			await store.registerAgent(identity(names.at(-1)!, identity("heavy").agentInstanceId));
		}
		const cut = (await store.meta()).watermark;
		const before = await identityRows(store, names);
		const error = await store.branchIntent(identity("heavy").agentInstanceId, "pause-heavy", "pause", 0).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ code: "restore_budget" });
		expect(String(error)).toContain("atomic record budget");
		expect(await identityRows(store, names)).toEqual(before);
		expect((await store.meta()).watermark).toBe(cut);
		expect((await store.records.get("hold", `${identity("heavy").agentInstanceId}:pause`)).value).toBeNull();
		expect((await store.intent(identity("heavy").agentInstanceId)).manualHold).toBe(false);
	});
	it("keeps deep internal hold and cycle checks finite while preserving usable hold continuation", async () => {
		const store = await createStore();
		// Registration walks the whole ancestry inside one atomic owner batch (at most 100 checked records): the
		// owner admits a chain through depth 21 and refuses the next level whole, instead of SQLite's 1024 ancestors.
		const deepest = 21;
		for (let index = 0; index <= deepest; index++)
			await store.registerAgent(
				identity(`chain-${index}`, index ? identity(`chain-${index - 1}`).agentInstanceId : undefined),
			);
		const leaf = identity(`chain-${deepest}`);
		const cut = (await store.meta()).watermark;
		expect(
			await store.registerAgent(identity(`chain-${deepest + 1}`, leaf.agentInstanceId)).then(
				() => null,
				(error: unknown) => error,
			),
		).toMatchObject({ code: "restore_budget" });
		expect((await store.records.get("identity", identity(`chain-${deepest + 1}`).agentInstanceId)).value).toBeNull();
		expect((await store.meta()).watermark).toBe(cut);
		expect(
			await store.registerAgent(identity("cycle-probe", identity("cycle-probe").agentInstanceId)).then(
				() => null,
				(error: unknown) => error,
			),
		).toMatchObject({ code: "invalid_request" });
		// The deepest admitted agent stays controllable and its hold page continues.
		await store.branchIntent(leaf.agentInstanceId, "leaf-pause", "pause", 0);
		await store.branchIntent(leaf.agentInstanceId, "leaf-stop", "stop", 1);
		expect((await store.intent(leaf.agentInstanceId)).holds.map(hold => hold.commandId)).toEqual([
			"leaf-pause",
			"leaf-stop",
		]);
		const request = { principalId: "owner", agentInstanceRef: leaf.agentInstanceRef, limit: 1 };
		const page = await store.runtimeHolds(request);
		expect(page.items).toMatchObject([{ commandId: "leaf-pause" }]);
		expect(page.nextCursor).not.toBeNull();
		expect((page.work as { scannedRows: number }).scannedRows).toBeLessThanOrEqual(
			runtimeLimits.bootstrapScannedRows,
		);
		const next = await store.runtimeHolds({ ...request, cursor: String(page.nextCursor) });
		expect(next.items).toMatchObject([{ commandId: "leaf-stop" }]);
		expect(next.nextCursor).toBeNull();
	});
	it("pages a deep canonical hold chain with one bounded ancestor walk per page and never trusts a changed continuation", async () => {
		const store = await createStore();
		// A root pause walks its whole branch in one atomic owner batch; nine levels keep that walk admissible.
		const depth = 8;
		const heldDepths = [0, 1, 4, 6, 7];
		for (let index = 0; index <= depth; index++)
			await store.registerAgent(
				identity(`deep-${index}`, index ? identity(`deep-${index - 1}`).agentInstanceId : undefined),
			);
		for (const held of heldDepths)
			await store.branchIntent(identity(`deep-${held}`).agentInstanceId, `hold-${held}`, "pause");
		const request = { principalId: "owner", agentInstanceRef: identity(`deep-${depth}`).agentInstanceRef, limit: 1 };
		const first = await store.runtimeHolds(request);
		expect(first.items).toEqual([
			{
				sourceAgentInstanceRef: identity(`deep-${depth - 1}`).agentInstanceRef,
				commandId: `hold-${depth - 1}`,
				generation: expect.any(Number),
				kind: "pause",
			},
		]);
		const firstCursor = String(first.nextCursor);
		let page = first;
		const commands: string[] = [];
		const rows: number[] = [];
		for (let n = 0; n < 12; n++) {
			validateRuntimeValue("holdsPage", page);
			const work = page.work as { scannedRows: number; materializedBytes: number };
			expect(work.materializedBytes).toBeGreaterThan(0);
			rows.push(work.scannedRows);
			commands.push(...(page.items as Array<{ commandId: string }>).map(item => item.commandId));
			if (page.nextCursor === null) break;
			page = await store.runtimeHolds({ ...request, cursor: String(page.nextCursor) });
		}
		// Each page re-walks the fixed ancestor path (three hold keys and one identity per level plus the cut),
		// so its work stays the same on every page instead of growing with the continuation.
		expect(rows).toEqual(rows.map(() => 4 * (depth + 1) + 4));
		expect(rows[0]).toBeLessThanOrEqual(runtimeLimits.bootstrapScannedRows);
		expect(page.nextCursor).toBeNull();
		expect(commands).toEqual(heldDepths.toReversed().map(held => `hold-${held}`));
		for (const changed of [
			{ ...request, cursor: `${firstCursor.slice(0, -1)}!` },
			{ ...request, agentInstanceRef: identity(`deep-${heldDepths[2]}`).agentInstanceRef, cursor: firstCursor },
			{ ...request, principalId: "foreign", cursor: firstCursor },
		]) {
			const rejected = await store.runtimeHolds(changed).then(
				() => undefined,
				error => error,
			);
			expect(rejected).toBeInstanceOf(Error);
		}
		await store.branchIntent(identity(`deep-${depth}`).agentInstanceId, "new-leaf-hold", "pause");
		const stale = await store.runtimeHolds({ ...request, cursor: firstCursor }).then(
			() => undefined,
			error => error,
		);
		expect(stale).toMatchObject({ code: "stale_target" });
	});

	it("pins hold pages to their exact current Attempt and resumes within one ancestor", async () => {
		const store = await createStore();
		const target = await active(store);
		const agent = identity("root");
		await store.branchIntent(agent.agentInstanceId, "hold-pause", "pause", 0);
		await store.branchIntent(agent.agentInstanceId, "hold-stop", "stop", 1);
		const request = {
			principalId: "owner",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: target.attemptId,
			revision: 2,
			limit: 1,
		};
		const first = await store.runtimeHolds(request);
		expect(first.items).toMatchObject([{ commandId: "hold-pause", kind: "pause" }]);
		const cursor = String(first.nextCursor);
		const second = await store.runtimeHolds({ ...request, cursor });
		expect(second.items).toMatchObject([{ commandId: "hold-stop", kind: "stop" }]);
		expect(second.nextCursor).toBeNull();
		const [body, mac] = cursor.split(".");
		const position = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { scope: string[] };
		position.scope[3] = identity("foreign").agentInstanceRef;
		const forged = `${Buffer.from(JSON.stringify(position)).toString("base64url")}.${mac}`;
		const denied = await store.runtimeHolds({ ...request, cursor: forged }).then(
			() => undefined,
			error => error,
		);
		expect(denied).toMatchObject({ code: "stale_target" });
		const malformed = await store.runtimeHolds({ ...request, cursor: `h1.e30.${"界".repeat(43)}` }).then(
			() => undefined,
			error => error,
		);
		expect(malformed).toMatchObject({ code: "stale_target" });
		// A new Attempt on the same Engine generation advances its binding generation.
		const restartedAttempt = {
			...target,
			attemptId: "newer-attempt",
			executionId: "newer-execution",
			bindingGeneration: 2,
		};
		await store.commitAttemptTransition(restartedAttempt, "running", [{ kind: "running" }]);
		const stale = await store.runtimeHolds({ ...request, cursor }).then(
			() => undefined,
			error => error,
		);
		expect(stale).toMatchObject({ code: "stale_target" });
		const current = await store.runtimeHolds({ ...request, attemptId: restartedAttempt.attemptId });
		expect(current.items).toMatchObject([{ commandId: "hold-pause" }]);
	});

	it("reopens bounded active tool baselines and rejects a continuation after exact lifecycle changes", async () => {
		let store = await createStore();
		const target = await active(store);
		const agent = identity("root");
		const request = { principalId: "owner", agentInstanceRef: agent.agentInstanceRef, attemptId: target.attemptId };
		const scope: RuntimeScope = {
			kind: "attempt",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: target.attemptId,
			kinds: ["tool"],
		};
		const before = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		const revisions: number[] = [];
		for (let i = 0; i < 20; i++) {
			const event = await store.startToolEffect(target, {
				effectId: `effect-${String(i).padStart(2, "0")}`,
				toolCallId: `tool-${String(i).padStart(2, "0")}`,
				toolName: "read",
				policy: "tracked",
				inputHash: "sha256:private-input-hash",
				...(i === 19 ? {} : { origin: { messageId: "assistant_parallel", blockId: `block_${i}` } }),
			});
			revisions.push(event.eventId);
		}
		await store.requestToolApproval(target, {
			effectId: "effect-permit",
			toolCallId: "tool-permit",
			toolName: "write",
			policy: "permit",
			inputHash: "sha256:approval",
			origin: { messageId: "assistant_permission", blockId: "block_1" },
		});
		const snapshot = await store.runtimeSnapshot(scope, request);
		const detail = snapshot.agents[0];
		const tools = detail.tools as Array<{ toolCallId: string; revision: number; phase: string }>;
		expect(tools.map(tool => tool.toolCallId)).toEqual(
			Array.from({ length: 16 }, (_, i) => `tool-${String(i).padStart(2, "0")}`),
		);
		expect(tools.map(tool => tool.revision)).toEqual(revisions.slice(0, 16));
		expect(tools.every(tool => tool.phase === "started")).toBeTrue();
		expect(tools).toMatchObject(
			Array.from({ length: 16 }, (_, i) => ({
				origin: { messageId: "assistant_parallel", blockId: `block_${i}` },
			})),
		);
		// Native work counts emitted page records (this one detail); its 16-tool bound is asserted above.
		expect(snapshot.work.changes).toBe(1);
		const cursor = String(detail.toolsNextCursor);
		const remaining = await store.runtimeTools({ ...request, cursor });
		expect(remaining).toMatchObject({
			revision: revisions.at(-1),
			nextCursor: null,
			items: [
				{ toolCallId: "tool-16", origin: { messageId: "assistant_parallel", blockId: "block_16" } },
				{ toolCallId: "tool-17" },
				{ toolCallId: "tool-18" },
				{ toolCallId: "tool-19" },
			],
		});
		expect((remaining.work as { scannedRows: number }).scannedRows).toBeLessThan(20);
		expect((remaining.items as Record<string, unknown>[]).at(-1)).not.toHaveProperty("origin");
		await store.appendEvent({
			...target,
			causationCommandId: target.commandId,
			kind: "message_updated",
			payload: {
				mode: "snapshot",
				messageId: "unselected",
				blockId: "text",
				stream: "assistant",
				contentId: "unselected-content",
				revision: 1,
				offset: 0,
				endOffset: 1,
				totalBytes: 1,
				text: "x",
				status: "streaming",
				partial: false,
			},
		});
		expect(await store.runtimeTools({ ...request, cursor })).toMatchObject({
			revision: revisions.at(-1),
			items: remaining.items,
		});
		await expect(store.runtimeTools({ ...request, principalId: "foreign", cursor })).rejects.toMatchObject({
			code: "agent_not_found",
		});
		await expect(store.runtimeTools({ ...request, attemptId: "other-attempt", cursor })).rejects.toMatchObject({
			code: "stale_target",
		});
		const rootSummary = (before.agents[0] as { revision: number }).revision;
		const catalog = await store.runtimeEvents(eventsRequest(before.epoch, before.watermark));
		expect(catalog.changes.filter(change => change.kind === "summary")).toHaveLength(1); // pending permit needs attention
		expect(catalog.changes.every(change => change.kind !== "tool")).toBeTrue();
		expect(Number(catalog.changes[0]?.revision)).toBeGreaterThan(rootSummary);
		store = reopen();
		const reopened = await store.runtimeSnapshot(scope, request);
		expect(reopened.agents[0].tools).toEqual(tools);
		expect(reopened.agents[0].toolsNextCursor).toBe(cursor);
		const settled = await store.settleToolEffect(target, "effect-19", "completed", {
			checkpoint: await nativeCheckpoint(store),
		});
		await expect(store.runtimeTools({ ...request, cursor })).rejects.toMatchObject({ code: "stale_target" });
		const terminal = await store.runtimeEvents(eventsRequest(before.epoch, settled.eventId - 1, scope));
		expect(terminal.changes).toMatchObject([
			{
				kind: "tool",
				attemptId: target.attemptId,
				revision: settled.eventId,
				value: { toolCallId: "tool-19", phase: "finished" },
			},
		]);
		await store.resolveToolApproval(target, "effect-permit", "deny");
		const live = await store.runtimeEvents(eventsRequest(before.epoch, settled.eventId, scope));
		expect(live.changes.some(change => change.kind === "tool" && change.value.phase === "denied")).toBeTrue();
		expect(
			live.changes.find(change => change.kind === "tool" && change.value.phase === "denied")?.value.origin,
		).toEqual({ messageId: "assistant_permission", blockId: "block_1" });
		await store.interruptGeneration(await store.nextEngineGeneration());
		const recovered = await store.runtimeTools(request);
		expect((recovered.items as Array<{ phase: string }>).every(tool => tool.phase === "unknown")).toBeTrue();
		expect((recovered.items as Record<string, unknown>[])[0]).toMatchObject({
			origin: { messageId: "assistant_parallel", blockId: "block_0" },
		});
		expect(
			(recovered.items as Array<{ toolCallId: string }>).some(
				tool => tool.toolCallId === "tool-19" || tool.toolCallId === "tool-permit",
			),
		).toBeFalse();
	});
	it("continues a tool snapshot only at its unchanged cut and never serves a mixed cut after settlement", async () => {
		const store = await createStore();
		const target = await active(store);
		const agent = identity("root");
		const request = { principalId: "owner", agentInstanceRef: agent.agentInstanceRef, attemptId: target.attemptId };
		await store.startToolEffect(target, {
			effectId: "effect-cut",
			toolCallId: "tool-cut",
			toolName: "read",
			policy: "tracked",
			inputHash: "sha256:cut",
		});
		const scope: RuntimeScope = {
			kind: "branch",
			rootAgentInstanceRef: agent.agentInstanceRef,
			interests: [
				{ kind: "attempt", agentInstanceRef: agent.agentInstanceRef, attemptId: target.attemptId, kinds: ["tool"] },
			],
		};
		const first = await store.runtimeSnapshot(scope, request, undefined, 1);
		expect(first.members).toHaveLength(1);
		expect(first.agents).toHaveLength(0);
		const continued = await store.runtimeSnapshot(scope, request, first.nextCursor!, 1);
		expect(continued.watermark).toBe(first.watermark);
		expect(continued.agents[0].tools).toMatchObject([{ toolCallId: "tool-cut", phase: "started" }]);
		await store.settleToolEffect(target, "effect-cut", "completed", { checkpoint: await nativeCheckpoint(store) });
		// The owner keeps current rows only: after any event the old continuation is refused, never answered from
		// another cut, and a fresh read from the start follows the settlement.
		await expect(store.runtimeSnapshot(scope, request, first.nextCursor!, 1)).rejects.toMatchObject({
			code: "stale_target",
		});
		expect((await store.runtimeTools(request)).items).toEqual([]);
		const fresh = await store.runtimeSnapshot(scope, request);
		expect(fresh.watermark).toBeGreaterThan(first.watermark);
		expect(fresh.agents[0].tools).toEqual([]);
	});
	it("preserves native Responses tool correlation through admission, settlement and reopen", async () => {
		let store = await createStore();
		const target = await active(store);
		const agentInstanceRef = identity("root").agentInstanceRef;
		const request = { principalId: "owner", agentInstanceRef, attemptId: target.attemptId };
		const scope: RuntimeScope = { kind: "attempt", agentInstanceRef, attemptId: target.attemptId, kinds: ["tool"] };
		const before = await store.runtimeSnapshot(scope, request);
		const toolCallId = `call_${"a".repeat(24)}|fc_${"b".repeat(50)}`;
		const origin = { messageId: "assistant_native", blockId: "block_2" };
		const effect = {
			effectId: "native-effect",
			origin,
			toolCallId,
			toolName: "read",
			policy: "tracked" as const,
			inputHash: "sha256:native",
		};
		const started = await store.startToolEffect(target, effect);
		expect((await store.runtimeTools(request)).items).toMatchObject([{ toolCallId, phase: "started", origin }]);
		await expect(store.runtimeTools({ ...request, principalId: "foreign" })).rejects.toMatchObject({
			code: "agent_not_found",
		});
		store = reopen();
		expect((await store.runtimeTools(request)).items).toMatchObject([{ toolCallId, phase: "started", origin }]);
		const checkpoint = await nativeCheckpoint(store);
		await expect(
			store.settleToolEffect({ ...target, attemptId: "another-attempt" }, effect.effectId, "completed", {
				checkpoint,
			}),
		).rejects.toThrow();
		expect(await store.getEffect(effect.effectId)).toMatchObject({ tool_call_id: toolCallId, state: "started" });
		await store.settleToolEffect(target, effect.effectId, "completed", { checkpoint });
		const changes = await store.runtimeEvents(eventsRequest(before.epoch, started.eventId, scope));
		expect(changes.changes.filter(change => change.kind === "tool")).toMatchObject([
			{ value: { toolCallId, phase: "finished", origin } },
		]);
		expect((await store.runtimeTools(request)).items).toEqual([]);
		store = reopen();
		expect(await store.getEffect(effect.effectId)).toMatchObject({
			tool_call_id: toolCallId,
			state: "settled",
			outcome: "completed",
			assistant_message_id: origin.messageId,
			assistant_block_id: origin.blockId,
		});
		await expect(
			store.startToolEffect(target, {
				...effect,
				effectId: "bad-origin",
				toolCallId: "bad-origin",
				origin: { ...origin, blockId: "" },
			}),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(await store.getEffect("bad-origin")).toBeUndefined();
		for (const [index, invalid] of [
			"call_|",
			"|fc_1",
			"call_1|fc_1|extra",
			"call_1/fc_1",
			"call_1|fc_1\n",
			"x".repeat(201),
		].entries()) {
			const effectId = `invalid-native-${index}`;
			await expect(
				store.startToolEffect(target, { ...effect, effectId, toolCallId: invalid }),
			).rejects.toMatchObject({ code: "invalid_request" });
			expect(await store.getEffect(effectId)).toBeUndefined();
		}
	});
	it("rolls back tool baseline revisions with failed effect transactions and refuses invalid tool identity before admission", async () => {
		const store = await createStore();
		const target = await active(store);
		const request = {
			principalId: "owner",
			agentInstanceRef: identity("root").agentInstanceRef,
			attemptId: target.attemptId,
		};
		const effect = {
			effectId: "effect-atomic",
			toolCallId: "tool-atomic",
			toolName: "read",
			policy: "tracked" as const,
			inputHash: "sha256:atomic",
		};
		const rejectEffect = () =>
			failCommit(store, "tool revision rollback", put => put.kind === "effect" && put.id === effect.effectId);
		const initial = await store.runtimeTools(request);
		let failure = rejectEffect();
		try {
			await expect(store.startToolEffect(target, effect)).rejects.toThrow("tool revision rollback");
		} finally {
			failure.mockRestore();
		}
		expect(await store.getEffect(effect.effectId)).toBeUndefined();
		expect(await store.runtimeTools(request)).toMatchObject({ revision: initial.revision, items: [] });
		const started = await store.startToolEffect(target, effect);
		failure = rejectEffect();
		try {
			await expect(
				store.settleToolEffect(target, effect.effectId, "completed", { checkpoint: await nativeCheckpoint(store) }),
			).rejects.toThrow("tool revision rollback");
		} finally {
			failure.mockRestore();
		}
		expect(await store.getEffect(effect.effectId)).toMatchObject({ state: "started" });
		expect(await store.runtimeTools(request)).toMatchObject({
			revision: started.eventId,
			items: [{ revision: started.eventId, phase: "started" }],
		});
		await expect(
			store.startToolEffect(target, { ...effect, effectId: "effect-invalid", toolCallId: "invalid/id" }),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(await store.getEffect("effect-invalid")).toBeUndefined();
	});

	it("projects profile route facts through exact Attempt detail without changing app summaries", async () => {
		let store = await createStore();
		const target = await active(store);
		const agentInstanceRef = identity("root").agentInstanceRef;
		const scope: RuntimeScope = {
			kind: "attempt",
			agentInstanceRef,
			attemptId: target.attemptId,
			kinds: ["state", "usage"],
		};
		const request = { principalId: "owner", agentInstanceRef, attemptId: target.attemptId };
		const before = await store.runtimeSnapshot(scope, request);
		const summary = (await store.runtimeSummary({ principalId: "owner", agentInstanceRef })).summary;
		const profileRef = "gctx:2222222222222222",
			primaryRouteRef = "gctx:3333333333333333",
			routeRef = "gctx:4444444444444444";
		for (const phase of ["loading", "active", "exhausted"] as const) {
			const state = { profileRef, primaryRouteRef, routeRef, fallback: true, phase };
			const event = await store.commitAttemptProfileRoute(target, state);
			expect(event).toBeDefined();
			const page = await store.runtimeSnapshot(scope, request);
			expect(page.agents[0].profileRoute).toMatchObject({
				state,
				eventSeq: event!.seq,
				target: {
					agentInstanceId: target.agentInstanceId,
					attemptId: target.attemptId,
					runtimeBindingId: target.bindingId,
				},
			});
			const changes = await store.runtimeEvents(eventsRequest(before.epoch, event!.eventId - 1, scope));
			expect(changes.changes.find(change => change.kind === "state")?.value.profileRoute).toEqual(
				page.agents[0].profileRoute,
			);
			expect(
				changes.changes.some(change => change.kind === "invalidate" && change.value.resource === "context"),
			).toBeTrue();
			expect((await store.runtimeSummary({ principalId: "owner", agentInstanceRef })).summary).toEqual(summary);
		}
		await expect(store.runtimeSnapshot(scope, { ...request, principalId: "other" })).rejects.toThrow();
		store = reopen();
		expect((await store.runtimeSnapshot(scope, request)).agents[0].profileRoute).toMatchObject({
			state: { phase: "exhausted", routeRef },
		});
		const catalog = await store.runtimeEvents(eventsRequest(before.epoch, before.watermark, { kind: "catalog" }));
		expect(catalog.changes).toEqual([]);
	});

	it("emits exact usage and context invalidations after model settlement without token or app churn", async () => {
		const store = await createStore();
		const target = await active(store);
		const agent = identity("root");
		const scope: RuntimeScope = {
			kind: "attempt",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: target.attemptId,
			kinds: ["usage"],
		};
		const before = await store.runtimeSnapshot(scope, { principalId: "owner" });
		const effect = { effectId: "model-usage", modelCallId: "model-call", inputHash: "sha256:private" };
		await store.startModelEffect(target, effect);
		const settled = await store.settleModelEffect(
			target,
			effect,
			"completed",
			undefined,
			await nativeCheckpoint(store),
		);
		const batch = await store.runtimeEvents(eventsRequest(before.epoch, before.watermark, scope));
		expect(batch.changes).toMatchObject([
			{
				kind: "invalidate",
				attemptId: target.attemptId,
				revision: settled.eventId,
				value: { resource: "usage", revision: settled.eventId },
			},
			{
				kind: "invalidate",
				attemptId: target.attemptId,
				revision: settled.eventId,
				value: { resource: "context", revision: settled.eventId },
			},
		]);
		expect((await store.runtimeEvents(eventsRequest(before.epoch, before.watermark))).changes).toEqual([]);
		expect(JSON.stringify(batch)).not.toContain("sha256:private");
	});
	it("settles active message status atomically with recovery without changing the retained resource", async () => {
		const store = await createStore();
		const target = await active(store);
		const request = {
			agentInstanceRef: identity("root").agentInstanceRef,
			attemptId: target.attemptId,
			principalId: "owner",
		};
		await store.appendEvent({
			...target,
			causationCommandId: target.commandId,
			kind: "message_updated",
			payload: {
				mode: "snapshot",
				messageId: "active-message",
				blockId: "text",
				stream: "assistant",
				contentId: "active-content",
				revision: 1,
				offset: 0,
				endOffset: 5,
				totalBytes: 5,
				text: "hello",
				status: "streaming",
				partial: false,
			},
		});
		const before = await store.runtimeMessages(request);
		const failure = failCommit(
			store,
			"recovery rollback",
			put => put.kind === "event" && (put.value as { kind?: string }).kind === "interrupted",
		);
		try {
			await expect(store.interruptGeneration(await store.nextEngineGeneration())).rejects.toThrow(
				"recovery rollback",
			);
		} finally {
			failure.mockRestore();
		}
		expect((await store.runtimeMessages(request)).items).toEqual(before.items);
		expect((await store.getAttempt(target.attemptId))?.state).toBe("running");
		const events = await store.interruptGeneration(2);
		expect(events.map(event => event.kind)).toContain("message_updated");
		const after = await store.runtimeMessages(request);
		expect(after.items).toMatchObject([{ revision: 2, status: "interrupted", text: "hello", totalBytes: 5 }]);
		await store.interruptGeneration(await store.nextEngineGeneration());
		expect((await store.runtimeMessages(request)).items).toEqual(after.items);
	});
	it("pins canonical schema bytes and validates the strict scope union", async () => {
		const bytes = await Bun.file(new URL("../src/engine/runtime-protocol-v1.json", import.meta.url)).arrayBuffer();
		expect(`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`).toBe(RUNTIME_PROTOCOL_HASH);
		validateRuntimeValue("scope", { kind: "catalog" });
		expect(() =>
			validateRuntimeValue("scope", { kind: "catalog", agentInstanceRef: identity("root").agentInstanceRef }),
		).toThrow();
	});
	it("rejects unknown ancestry, cross-principal children and reparenting an already projected root", async () => {
		const store = await createStore();
		await expect(store.registerAgent(identity("orphan", "unknown-parent"))).rejects.toThrow("Parent ancestry");
		const parent = identity("parent");
		await store.registerAgent(parent);
		await expect(store.registerAgent(identity("foreign-child", parent.agentInstanceId, "other"))).rejects.toThrow(
			"ownership",
		);
		const root = identity("registered-root");
		await store.registerAgent(root);
		// Native refuses the same reparent before comparing fields: a projected root keeps its ancestry.
		await expect(store.registerAgent({ ...root, parentAgentInstanceId: parent.agentInstanceId })).rejects.toThrow(
			"cannot be reparented",
		);
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		expect(snapshot.agents).toHaveLength(2);
		expect(snapshot.agents.find(agent => agent.agentInstanceRef === root.agentInstanceRef)).toMatchObject({
			rootAgentInstanceRef: root.agentInstanceRef,
		});
	});
	it("captures a no-gap watermark and discovers newly enrolled children", async () => {
		const store = await createStore();
		const root = identity("root");
		await store.registerAgent(root);
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		expect(snapshot.agents).toHaveLength(1);
		const waiting = store.waitRuntimeEvents(
			eventsRequest(snapshot.epoch, snapshot.watermark, { kind: "catalog" }, 1000),
		);
		await store.registerAgent(identity("child", root.agentInstanceId));
		const batch = await waiting;
		expect(batch.changes).toHaveLength(1);
		expect(batch.changes[0].kind).toBe("summary");
		expect(batch.changes[0].agentInstanceRef).toBe(identity("child").agentInstanceRef);
		expect(batch.throughCursor).toBeGreaterThan(snapshot.watermark);
		expect(batch.hasMore).toBe(false);
	});
	it("advances filtered cursors through a factual cut without leaking another principal", async () => {
		const store = await createStore();
		await store.registerAgent(identity("root"));
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		await store.registerAgent(identity("private", undefined, "other"));
		const batch = await store.runtimeEvents(eventsRequest(snapshot.epoch, snapshot.watermark));
		expect(batch.changes).toEqual([]);
		expect(batch.throughCursor).toBeGreaterThan(snapshot.watermark);
		expect((await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).agents).toHaveLength(1);
		await expect(store.runtimeEvents(eventsRequest("old-epoch", 0))).rejects.toThrow("epoch");
	});
	it("preserves a local child hold when its ancestor resumes and rejects stale controls", async () => {
		const store = await createStore();
		const root = identity("root"),
			child = identity("child", root.agentInstanceId);
		await store.registerAgent(root);
		await store.registerAgent(child);
		await store.branchIntent(root.agentInstanceId, "pause-root", "pause", 0);
		await store.branchIntent(child.agentInstanceId, "pause-child", "pause", 1);
		await store.branchIntent(root.agentInstanceId, "resume-root", "resume", 1);
		expect((await store.intent(root.agentInstanceId)).manualHold).toBe(false);
		const remaining = await store.intent(child.agentInstanceId);
		expect(remaining.holds.map(hold => hold.commandId)).toEqual(["pause-child"]);
		await expect(store.branchIntent(root.agentInstanceId, "stale-stop", "stop", 1)).rejects.toThrow("revision");
	});
	it("enrolls children into an existing hold before admitting any effect", async () => {
		const store = await createStore();
		const root = identity("root");
		await store.registerAgent(root);
		await store.branchIntent(root.agentInstanceId, "pause-root", "pause", 0);
		const child = identity("child", root.agentInstanceId);
		await store.registerAgent(child);
		expect((await store.intent(child.agentInstanceId)).holds[0]?.sourceAgentInstanceId).toBe(root.agentInstanceId);
		await expect(
			store.startModelEffect(binding("child"), {
				effectId: "effect-child",
				modelCallId: "model-child",
				inputHash: "hash",
			}),
		).rejects.toThrow("held");
		expect((await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).agents).toHaveLength(2);
	});
	it("keeps receipts indefinitely and never replays an interrupted admission", async () => {
		const store = await createStore();
		const original = command("pending");
		await store.admitCommand(original, 1);
		await store.interruptGeneration(await store.nextEngineGeneration());
		const replay = await store.admitCommand(original, 2);
		expect(replay.status).toBe("replay");
		if (replay.status === "replay") expect(replay.receipt.detail?.code).toBe("interrupted");
		const receipt = await store.runtimeCommand(
			original.commandId,
			{ principalId: "owner" },
			original.browserPayloadHash,
		);
		expect(receipt.stage).toBe("rejected");
		expect(receipt.retention).toBe("indefinite");
		await expect(store.admitCommand({ ...original, canonicalHash: "different" }, 2)).rejects.toThrow("different");
		expect((await store.runtimeCommand("missing", { principalId: "owner" })).lookup).toBe("outcome_unknown");
	});
	it("cancels an exact Start before ordinary delivery and preserves its fence across reopen", async () => {
		let store = await createStore();
		const start = {
			...command("start-late"),
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		};
		await store.registerAgent(identity("root"));
		const target = {
			...identity("root"),
			executionId: start.executionId!,
			attemptId: start.attemptId!,
			engineGeneration: 1,
			pendingStartCommandId: start.commandId,
			expectedStartIntentRevision: 0,
			expectedIntentRevision: 0,
		};
		expect(await store.cancelPendingStart(target, "stop-first")).toMatchObject({
			status: "cancelled",
			intentRevision: 1,
		});
		store = reopen();
		expect(await store.admitCommand(start, 1)).toMatchObject({
			status: "replay",
			receipt: { outcome: "rejected", detail: { code: "cancelled", cancellationCommandId: "stop-first" } },
		});
		expect(await store.getAttempt(start.attemptId!)).toBeUndefined();
		expect((await store.intent(target.agentInstanceId)).manualHold).toBe(true);
		await expect(store.admitCommand({ ...start, canonicalHash: "changed", attemptId: "other" }, 1)).rejects.toThrow();
	});
	it("pins a pending cancellation to the source principal and immutable Start CAS", async () => {
		const store = await createStore();
		const start = {
			...command("pending-exact"),
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		};
		await store.admitCommand(start, 1);
		const target = {
			...identity("root"),
			executionId: start.executionId!,
			attemptId: start.attemptId!,
			engineGeneration: 1,
			pendingStartCommandId: start.commandId,
			expectedStartIntentRevision: 0,
			expectedIntentRevision: 0,
		};
		await expect(store.cancelPendingStart({ ...target, principalId: "foreign" }, "foreign-stop")).rejects.toThrow(
			"immutable target",
		);
		await expect(
			store.cancelPendingStart({ ...target, expectedStartIntentRevision: 1 }, "wrong-cas"),
		).rejects.toThrow("immutable target");
		expect((await store.intent(target.agentInstanceId)).intentRevision).toBe(0);
		expect(await store.cancelPendingStart(target, "exact-stop")).toMatchObject({ status: "cancelled" });
	});
	it("uses the factual applied Start revision and rejects an intervening intent mutation", async () => {
		const store = await createStore();
		const target = binding("root");
		const start = {
			...command(target.commandId),
			attemptId: target.attemptId,
			executionId: target.executionId,
			serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
		};
		await store.admitCommand(start, 1);
		await store.commitAttemptTransition({ ...target, intentRevision: 7 }, "running", [{ kind: "running" }], {
			startIntent: { expectedRevision: 0 },
			settleCommandId: start.commandId,
			settleCommandReceipt: { outcome: "applied" },
		});
		const fence = {
			...target,
			principalId: "owner",
			pendingStartCommandId: start.commandId,
			expectedStartIntentRevision: 0,
			expectedIntentRevision: 0,
		};
		expect(await store.branchIntent(target.agentInstanceId, "stop-after-bind", "stop", 0, fence)).toMatchObject({
			intentRevision: 8,
		});
		await expect(store.branchIntent(target.agentInstanceId, "delayed-old-stop", "stop", 0, fence)).rejects.toThrow(
			"Intent changed",
		);
	});
});
