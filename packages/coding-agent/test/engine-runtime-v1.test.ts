import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SQL } from "bun";
import type { EngineBindingSnapshot, EngineInboxTarget } from "../src/engine/contracts";
import { engineAgentId, engineAgentInstanceId } from "../src/engine/route";
import type { CanonicalOwnershipCandidate, LegacyStartOwnershipCandidate } from "../src/engine/runtime-ownership";
import {
	RUNTIME_PROTOCOL_HASH,
	type RuntimeScope,
	runtimeLimits,
	runtimeRemainingWork,
	validateRuntimeValue,
} from "../src/engine/runtime-protocol";
import { publicRuntimeQueueItem } from "../src/engine/runtime-queue";
import { type EngineCommandIdentity, EngineStore } from "../src/engine/store";

describe("runtime v1 durable boundaries", () => {
	const stores: EngineStore[] = [];
	const directories: string[] = [];
	afterEach(async () => {
		for (const store of stores.splice(0)) await store.close();
		for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
	});
	async function createStore() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "engine-runtime-v1-"));
		directories.push(directory);
		const store = await EngineStore.open(path.join(directory, "engine.sqlite"));
		stores.push(store);
		await store.nextEngineGeneration();
		return store;
	}
	function identity(name: string, parent?: string, principalId = "owner") {
		const agentInstanceRef = `grimoire://tasks/grimoire/runtime-test/agents/${name}`;
		return {
			agentInstanceRef,
			agentInstanceId: engineAgentInstanceId(agentInstanceRef),
			parentAgentInstanceId: parent,
			principalId,
			authorityGeneration: 1,
		};
	}
	function binding(name: string): EngineBindingSnapshot {
		const agent = identity(name);
		return {
			agentInstanceId: agent.agentInstanceId,
			bindingId: `binding-${name}`,
			commandId: `start-${name}`,
			executionId: `execution-${name}`,
			attemptId: `attempt-${name}`,
			engineAgentId: engineAgentId(agent.agentInstanceId),
			profileDigest: "profile",
			state: "running",
			engineGeneration: 1,
			bindingGeneration: 1,
			authorityGeneration: 1,
			intentRevision: 0,
		};
	}
	function command(name: string, op = "start"): EngineCommandIdentity {
		return {
			...identity("root"),
			commandId: name,
			operation: op,
			deviceId: "device",
			engineId: "engine",
			engineGeneration: 1,
			attemptId: name,
			executionId: name,
			payloadHash: `sha256:${"a".repeat(64)}`,
			canonicalHash: `sha256:${name}`,
			browserPayloadHash: `sha256:${"b".repeat(64)}`,
			serializedCommand: JSON.stringify({ text: name }),
		};
	}
	function eventsRequest(
		epoch: string,
		afterCursor: number,
		scope: RuntimeScope = { kind: "catalog" },
		timeoutMs = 0,
	) {
		return {
			scope,
			principalId: "owner",
			epoch,
			afterCursor,
			timeoutMs,
			limit: 100,
			maxBytes: 61440,
			remainingWork: runtimeRemainingWork(),
		};
	}
	async function active(store: EngineStore, name = "root") {
		await store.registerAgent(identity(name));
		const target = binding(name);
		await store.commitAttemptTransition(target, "running", [{ kind: "running" }]);
		return target;
	}
	it("pins canonical schema bytes and validates the strict scope union", async () => {
		const bytes = await Bun.file(new URL("../src/engine/runtime-protocol-v1.json", import.meta.url)).arrayBuffer();
		expect(`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`).toBe(RUNTIME_PROTOCOL_HASH);
		validateRuntimeValue("scope", { kind: "catalog" });
		expect(() =>
			validateRuntimeValue("scope", { kind: "catalog", agentInstanceRef: identity("root").agentInstanceRef }),
		).toThrow();
	});
	it("enrolls only exact proven legacy Starts and inherits ownership after the parent proof", async () => {
		const store = await createStore();
		const root = identity("legacy-root", undefined, "");
		const child = identity("legacy-child", root.agentInstanceId, "");
		for (const agent of [root, child]) {
			await store.admitCommand(
				{
					...command(`legacy-${agent.agentInstanceId}`),
					...agent,
					browserPayloadHash: undefined,
					serializedCommand: undefined,
				},
				1,
			);
		}
		const before = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		expect(before.agents).toHaveLength(0);
		await expect(store.registerAgent({ ...root, principalId: "owner" })).rejects.toMatchObject({
			code: "stale_target",
		});
		await expect(
			store.admitCommand({ ...command("ownership-bypass"), ...root, principalId: "owner" }, 1),
		).rejects.toMatchObject({ code: "stale_target" });
		const page = await store.reconcileLegacyOwnershipPage("device", "engine");
		expect(page.candidates).toHaveLength(2);
		const rootCandidate = page.candidates.find(candidate => candidate.agentInstanceRef === root.agentInstanceRef)!;
		const childCandidate = page.candidates.find(candidate => candidate.agentInstanceRef === child.agentInstanceRef)!;
		if (rootCandidate.kind || childCandidate.kind) throw new Error("Retained Start proof was not selected");
		const proof = (candidate: LegacyStartOwnershipCandidate, principalId = "owner") => ({
			agentInstanceRef: candidate.agentInstanceRef,
			sourceCommandId: candidate.sourceCommandId,
			status: "verified" as const,
			principalId,
		});
		expect(await store.enrollLegacyOwnership([childCandidate], [proof(childCandidate)])).toEqual([
			{ agentInstanceRef: child.agentInstanceRef, status: "parent_pending" },
		]);
		await expect(store.enrollLegacyOwnership([rootCandidate], [proof(childCandidate)])).rejects.toThrow(
			"exact requested page",
		);
		expect(
			await store.enrollLegacyOwnership([{ ...rootCandidate, attemptId: "forged" }], [proof(rootCandidate)]),
		).toEqual([{ agentInstanceRef: root.agentInstanceRef, status: "conflict" }]);
		expect(await store.enrollLegacyOwnership([rootCandidate], [proof(rootCandidate)])).toEqual([
			{ agentInstanceRef: root.agentInstanceRef, status: "enrolled" },
		]);
		const inherited = await store.reconcileLegacyOwnershipPage("device", "engine");
		expect(inherited.inherited).toBe(1);
		expect(inherited.candidates).toEqual([]);
		const current = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		expect(current.agents).toHaveLength(2);
		expect(current.agents.find(agent => agent.agentInstanceRef === child.agentInstanceRef)).toMatchObject({
			rootAgentInstanceRef: root.agentInstanceRef,
		});
		const changes = await store.runtimeEvents(eventsRequest(before.epoch, before.watermark));
		expect(changes.changes.filter(change => change.kind === "summary")).toHaveLength(2);
		expect(await store.enrollLegacyOwnership([rootCandidate], [proof(rootCandidate)])).toEqual([
			{ agentInstanceRef: root.agentInstanceRef, status: "known" },
		]);
		expect(await store.enrollLegacyOwnership([rootCandidate], [proof(rootCandidate, "other")])).toEqual([
			{ agentInstanceRef: root.agentInstanceRef, status: "conflict" },
		]);
		expect((await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).watermark).toBe(
			current.watermark,
		);
		expect((await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "other" })).agents).toEqual([]);
	});
	it("discovers legacy ownership in bounded keyset pages without dropping missing source identities", async () => {
		const store = await createStore();
		for (let index = 0; index < runtimeLimits.httpPageRecords + 1; index++)
			await store.registerAgent(identity(`unproven-${index}`, undefined, ""));
		const first = await store.reconcileLegacyOwnershipPage("device", "engine");
		expect(first.candidates).toHaveLength(runtimeLimits.httpPageRecords);
		expect(first.candidates.every(candidate => candidate.kind === "canonical_agi")).toBe(true);
		expect(first.unresolved).toEqual([]);
		expect(first.nextCursor).toBeString();
		const second = await store.reconcileLegacyOwnershipPage("device", "engine", first.nextCursor!);
		expect(second.candidates).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		expect(
			new Set([...first.candidates, ...second.candidates].map(candidate => candidate.agentInstanceRef)).size,
		).toBe(runtimeLimits.httpPageRecords + 1);
	});
	it("CAS-enrolls canonical legacy identities without fabricated Starts and wakes existing catalog observers", async () => {
		const store = await createStore();
		const agent = identity("native-only", undefined, "");
		await store.registerAgent(agent);
		const before = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		const page = await store.reconcileLegacyOwnershipPage("device", "engine");
		const candidate = page.candidates[0];
		if (candidate.kind !== "canonical_agi") throw new Error("Canonical proof was not requested");
		const proof = (value: CanonicalOwnershipCandidate, principalId = "owner") => ({
			...value,
			status: "verified" as const,
			proofSource: "canonical_agi" as const,
			principalId,
		});
		await expect(
			store.enrollLegacyOwnership([candidate], [{ ...proof(candidate), agentInstanceId: "forged" }]),
		).rejects.toThrow("exact requested page");
		await store.registerAgent({ ...agent, authorityGeneration: 2 });
		expect(await store.enrollLegacyOwnership([candidate], [proof(candidate)])).toEqual([
			{ agentInstanceRef: agent.agentInstanceRef, status: "conflict" },
		]);
		const current = { ...candidate, authorityGeneration: 2 };
		const wait = store.waitRuntimeEvents({ ...eventsRequest(before.epoch, before.watermark), timeoutMs: 1000 });
		expect(await store.enrollLegacyOwnership([current], [proof(current)])).toEqual([
			{ agentInstanceRef: agent.agentInstanceRef, status: "enrolled" },
		]);
		expect((await wait).changes.some(change => change.kind === "summary")).toBe(true);
		expect((await store.runtimeTarget({ agentInstanceRef: agent.agentInstanceRef, principalId: "owner" })).kind).toBe(
			"registered",
		);
		expect(await store.enrollLegacyOwnership([current], [proof(current)])).toEqual([
			{ agentInstanceRef: agent.agentInstanceRef, status: "known" },
		]);
		expect(await store.enrollLegacyOwnership([current], [proof(current, "foreign")])).toEqual([
			{ agentInstanceRef: agent.agentInstanceRef, status: "conflict" },
		]);
		expect((await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "foreign" })).agents).toEqual([]);
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
		await expect(store.registerAgent({ ...root, parentAgentInstanceId: parent.agentInstanceId })).rejects.toThrow(
			"immutable",
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
		await store.interruptGeneration(2);
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
		await store.close();
		stores.pop();
		store = await EngineStore.open(path.join(directories.at(-1)!, "engine.sqlite"));
		stores.push(store);
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
	it("routes frozen browser receipt targets across branch destination changes and preserves stages", async () => {
		const store = await createStore();
		const source = identity("root");
		await store.registerAgent(source);
		const destination = identity("branch");
		const scope = { kind: "agent" as const, agentInstanceRef: source.agentInstanceRef, kinds: ["state" as const] };
		const snapshot = await store.runtimeSnapshot(scope, { principalId: "owner" });
		const browserTarget = {
			agentInstanceRef: source.agentInstanceRef,
			attemptId: "source-attempt",
			executionId: "source-execution",
		};
		const start = {
			...command("branch-command"),
			...destination,
			serializedCommand: JSON.stringify({ browserTarget, payload: { expectedIntentRevision: 0 } }),
		};
		await store.admitCommand(start, 1);
		await store.settleCommand(start.commandId, start.canonicalHash, {
			outcome: "applied",
			detail: { intentRevision: 1 },
		});
		const queried = await store.runtimeCommand(start.commandId, { principalId: "owner" });
		expect(queried.target).toEqual(browserTarget);
		expect(queried.result).toMatchObject({
			target: { agentInstanceRef: destination.agentInstanceRef, attemptId: start.attemptId, intentRevision: 1 },
		});
		const batch = await store.runtimeEvents(eventsRequest(snapshot.epoch, snapshot.watermark, scope));
		const receipts = batch.changes.filter(change => change.kind === "receipt");
		expect(receipts.map(change => change.value.stage)).toEqual(["engine_accepted", "applied"]);
		for (const change of receipts) {
			validateRuntimeValue("change", change);
			expect(change.value.target).toEqual(browserTarget);
		}
	});
	it("enforces queue record bounds atomically while reserving control admission", async () => {
		const store = await createStore();
		const agent = identity("root");
		await store.registerAgent(agent);
		const target: EngineInboxTarget = { ...binding("root"), sessionId: "session-root" };
		for (let n = 0; n < runtimeLimits.agentPendingRecords; n++)
			await store.enqueueInboxItem(target, {
				sourceEventId: `message-${n}`,
				sourceType: "user",
				body: "queued",
				wakeIntent: true,
			});
		await expect(
			store.enqueueInboxItem(target, { sourceEventId: "overflow", sourceType: "user", body: "overflow" }),
		).rejects.toThrow("budget");
		expect(await store.getInboxItem(target.sessionId, "overflow")).toBeUndefined();
		expect((await store.admitCommand(command("stop", "cancel"), 1)).status).toBe("claimed");
		await expect(store.admitCommand(command("ordinary"), 1)).rejects.toThrow("budget");
		const page = await store.runtimeQueue({ agentInstanceRef: agent.agentInstanceRef, principalId: "owner" });
		expect((page.items as unknown[]).length).toBe(runtimeLimits.httpPageRecords);
		expect(page.nextCursor).toBeString();
	});
	it("reads huge legacy queue fields through bounded previews and exact UTF-8 ranges", async () => {
		const store = await createStore();
		const agent = identity("queue-large");
		await store.registerAgent(agent);
		const target: EngineInboxTarget = { ...binding("queue-large"), sessionId: "session-queue-large" };
		const first = await store.enqueueInboxItem(target, {
			sourceEventId: "large-first",
			sourceType: "user",
			body: "small",
		});
		const second = await store.enqueueInboxItem(target, {
			sourceEventId: "large-second",
			sourceType: "agent",
			body: "later",
		});
		const raw = 'я😀\u0000\\"'.repeat(1_000_000);
		const native = new SQL(`sqlite:${path.join(directories.at(-1)!, "engine.sqlite").replaceAll("\\", "/")}`);
		try {
			await native.unsafe("UPDATE engine_inbox_items SET delivery_payload=?,annotation=? WHERE queue_id=?", [
				raw,
				raw,
				first.item.queueId,
			]);
			await native.unsafe("UPDATE engine_inbox_sources SET sender=? WHERE source_event_id=?", [raw, "large-first"]);
			const plan = await native.unsafe(
				"EXPLAIN QUERY PLAN SELECT queue_id FROM engine_inbox_items WHERE agent_instance_id=? AND disposition='pending' AND (position,queue_id)>(?,?) ORDER BY position,queue_id LIMIT 101",
				[agent.agentInstanceId, 0, ""],
			);
			expect(JSON.stringify(plan)).toContain("engine_inbox_agent_page_idx");
		} finally {
			await native.close();
		}
		const access = { principalId: "owner", agentInstanceRef: agent.agentInstanceRef };
		const page = await store.runtimeQueue({ ...access, limit: 1 });
		validateRuntimeValue("queuePage", page);
		const item = (page.items as Record<string, unknown>[])[0];
		expect(item).toMatchObject({ queueId: first.item.queueId, partial: true });
		expect(item).not.toHaveProperty("sourceBody");
		expect(item).not.toHaveProperty("agentInstanceId");
		const work = page.work as { bytes: number; materializedBytes: number; scannedRows: number };
		expect(work.bytes).toBe(Buffer.byteLength(JSON.stringify(page)));
		expect(work.materializedBytes).toBeLessThan(16_384);
		expect(work.scannedRows).toBeLessThanOrEqual(7);
		expect(
			Buffer.byteLength(
				JSON.stringify({ deliveryPayload: item.deliveryPayload, annotation: item.annotation, sender: item.sender }),
			),
		).toBeLessThanOrEqual(runtimeLimits.bulkPreviewBytes);
		const encoded = Buffer.from(raw);
		for (const key of ["resource", "annotationResource", "senderResource"]) {
			const resource = item[key] as Record<string, unknown>;
			expect(resource.bytes).toBe(encoded.length);
			const offset = 2;
			const range = await store.runtimeResource({
				principalId: "owner",
				resource,
				offset,
				limit: runtimeLimits.httpRangeBytes,
			});
			validateRuntimeValue("httpRange", range);
			const received = Buffer.from(String(range.contentBase64), "base64");
			expect(received).toEqual(encoded.subarray(offset, offset + received.length));
			expect(received.length).toBeGreaterThanOrEqual(runtimeLimits.httpRangeBytes - 3);
			await expect(
				store.runtimeResource({ principalId: "owner", resource, offset: 3, limit: 10 }),
			).rejects.toMatchObject({ code: "invalid_request" });
			const end = await store.runtimeResource({ principalId: "owner", resource, offset: encoded.length, limit: 1 });
			expect(end).toMatchObject({ nextOffset: null, contentBase64: "" });
			await expect(
				store.runtimeResource({ principalId: "other", resource, offset: 0, limit: 1 }),
			).rejects.toMatchObject({ code: "agent_not_found" });
			await expect(
				store.runtimeResource({
					principalId: "owner",
					resource: { ...resource, revision: 900 },
					offset: 0,
					limit: 1,
				}),
			).rejects.toMatchObject({ code: "stale_target" });
		}
		const next = await store.runtimeQueue({ ...access, cursor: String(page.nextCursor), limit: 1 });
		expect(next.items).toMatchObject([{ queueId: second.item.queueId, deliveryPayload: "later", partial: false }]);
		expect(next.nextCursor).toBeNull();
		const exact = await store.runtimeQueue({ ...access, queueId: second.item.queueId });
		expect(exact.items).toHaveLength(1);
		await expect(store.runtimeQueue({ ...access, principalId: "other" })).rejects.toMatchObject({
			code: "agent_not_found",
		});
		await store.mutateInboxItem(target, {
			mutationId: "change-later",
			queueId: second.item.queueId,
			op: "drop",
			expectedRevision: second.item.revision,
		});
		await expect(store.runtimeQueue({ ...access, cursor: String(page.nextCursor) })).rejects.toMatchObject({
			code: "stale_target",
		});
	});
	it("keeps escaped queue text and ancillary-only partial receipts inside the public change bound", async () => {
		const store = await createStore();
		const agent = identity("root");
		await store.registerAgent(agent);
		const target: EngineInboxTarget = { ...binding("root"), sessionId: "session-root" };
		const queued = await store.enqueueInboxItem(target, {
			sourceEventId: "escaped-queue",
			sourceType: "user",
			body: "short",
		});
		const item = publicRuntimeQueueItem(agent.agentInstanceRef, {
			...queued.item,
			sender: '\\"\n'.repeat(40_000),
			annotation: "annotation".repeat(40_000),
		});
		expect(item).toMatchObject({ partial: false, deliveryPayload: "short" });
		expect(item).not.toHaveProperty("resource");
		expect(item).toHaveProperty("senderResource");
		expect(item).toHaveProperty("annotationResource");
		validateRuntimeValue("queueItem", item);
		const emoji = "😀".repeat(20_000);
		const emojiItem = publicRuntimeQueueItem(agent.agentInstanceRef, { ...queued.item, deliveryPayload: emoji });
		expect(emojiItem.partial).toBe(true);
		expect(emoji.startsWith(String(emojiItem.deliveryPayload))).toBe(true);
		expect(emojiItem.deliveryPayload).not.toContain("�");
		validateRuntimeValue("queueItem", emojiItem);
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		const cmd = command("queue-receipt", "enqueue");
		await store.admitCommand(cmd, 1);
		await store.settleCommand(cmd.commandId, cmd.canonicalHash, { outcome: "applied", detail: { item } });
		const receipt = await store.runtimeCommand(cmd.commandId, { principalId: "owner" });
		expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(runtimeLimits.liveChangeBytes);
		const events = await store.runtimeEvents(
			eventsRequest(snapshot.epoch, snapshot.watermark, {
				kind: "agent",
				agentInstanceRef: agent.agentInstanceRef,
				kinds: ["state"],
			}),
		);
		expect(events.changes.filter(change => change.kind === "receipt").length).toBe(2);
		validateRuntimeValue("eventBatch", events);
		const legacy = command("legacy-large-receipt", "queue_edit");
		await store.admitCommand(legacy, 1);
		await store.settleCommand(legacy.commandId, legacy.canonicalHash, {
			outcome: "applied",
			detail: { item: { ...queued.item, sourceBody: "private source".repeat(200_000) } },
		});
		const recovered = await store.runtimeCommand(legacy.commandId, { principalId: "owner" });
		expect(recovered.result).toMatchObject({
			item: { queueId: queued.item.queueId, deliveryPayload: "short", partial: false },
		});
		expect(JSON.stringify(recovered)).not.toContain("private source");
		expect(JSON.stringify(recovered)).not.toContain("sourceBody");
		await store.mutateInboxItem(target, {
			mutationId: "legacy-result-later",
			queueId: queued.item.queueId,
			expectedRevision: queued.item.revision,
			op: "drop",
		});
		const unavailable = await store.runtimeCommand(legacy.commandId, { principalId: "owner" });
		expect(unavailable).toMatchObject({
			stage: "applied",
			lookup: "known",
			result: {
				partial: true,
				unavailable: "legacy_queue_revision_not_retained",
				queueId: queued.item.queueId,
				revision: queued.item.revision,
			},
		});
		expect(unavailable.target).toEqual(recovered.target);
		expect(unavailable.payloadHash).toBe(recovered.payloadHash);
	});
	it("pins bounded lifecycle pages to reachable native entries and their immutable event cut", async () => {
		const store = await createStore();
		const agent = identity("lifecycle");
		await store.registerAgent(agent);
		const sessionPath = "/runtime-v1-lifecycle.jsonl";
		const old = { ...binding("lifecycle"), sessionFile: sessionPath };
		const removed = {
			...old,
			attemptId: "removed-attempt",
			executionId: "removed-execution",
			commandId: "removed-start",
			bindingGeneration: 2,
		};
		const current = {
			...old,
			attemptId: "current-attempt",
			executionId: "current-execution",
			commandId: "current-start",
			bindingGeneration: 3,
		};
		for (const target of [old, removed, current])
			await store.commitAttemptTransition(target, "running", [{ kind: "running" }]);
		for (let i = 0; i < 110; i++)
			await store.appendEvent({
				...old,
				causationCommandId: old.commandId,
				kind: "retry_settled",
				payload: { retry: { attempt: i, maxAttempts: 110, error: "bounded retained reason" } },
			});
		await store.appendEvent({
			...removed,
			causationCommandId: removed.commandId,
			kind: "failed",
			payload: { error: "edited away" },
		});
		const header = {
			type: "session",
			version: 3,
			id: "session-lifecycle",
			timestamp: new Date(0).toISOString(),
			cwd: "/test",
		};
		const entry = (id: string, parentId: string | null, target = old) => ({
			type: "message",
			id,
			parentId,
			timestamp: new Date(0).toISOString(),
			sourceCommandId: target.commandId,
			message: { role: "user", content: id },
		});
		const retained = [
			header,
			entry("old-user", null),
			entry("removed-user", "old-user", removed),
			entry("current-user", "old-user", current),
		];
		await store.sessionStorage.writeText(sessionPath, retained.map(value => JSON.stringify(value)).join("\n") + "\n");
		const history = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 50);
		expect(history.entries.map(value => (value as { id: string }).id)).toEqual(["old-user", "current-user"]);
		const first = await store.nativeLifecyclePage(
			agent.agentInstanceId,
			agent.agentInstanceRef,
			1,
			undefined,
			history.lifecycleContext,
		);
		expect(first.activities).toHaveLength(1);
		expect(first.activityNextCursor).toBeString();
		const oneEntry = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 1);
		const later = await store.appendEvent({
			...current,
			causationCommandId: current.commandId,
			kind: "paused",
			payload: {},
		});
		const writer = store.sessionStorage.openWriter(sessionPath);
		await writer.append(JSON.stringify(entry("after-cut", "current-user", current)) + "\n");
		await writer.close();
		const olderEntry = await store.nativeHistoryPage(agent.agentInstanceId, oneEntry.nextCursor!, 1);
		expect(olderEntry.lifecycleContext.watermark).toBe(oneEntry.lifecycleContext.watermark);
		expect(olderEntry.lifecycleContext.currentAttemptId).toBe(oneEntry.lifecycleContext.currentAttemptId);
		const activities = [...first.activities];
		let cursor = first.activityNextCursor;
		while (cursor) {
			const page = await store.nativeLifecyclePage(
				agent.agentInstanceId,
				agent.agentInstanceRef,
				17,
				undefined,
				undefined,
				cursor,
			);
			expect(page.activities.length).toBeLessThanOrEqual(17);
			expect(page.work.scannedRows).toBeLessThanOrEqual(runtimeLimits.bootstrapScannedRows);
			expect(page.work.changes).toBe(page.activities.length);
			activities.push(...page.activities);
			cursor = page.activityNextCursor;
		}
		expect(activities).toHaveLength(112);
		expect(new Set(activities.map(value => value.id)).size).toBe(112);
		expect(
			activities.every(value => value.attemptId !== removed.attemptId && value.eventId !== String(later.eventId)),
		).toBe(true);
		for (const value of activities) {
			validateRuntimeValue("lifecycleActivity", value);
			expect(["old-user", "current-user"]).toContain(String(value.afterEntryId));
		}
		await expect(
			store.nativeLifecyclePage(
				"foreign",
				agent.agentInstanceRef,
				10,
				undefined,
				undefined,
				first.activityNextCursor!,
			),
		).rejects.toMatchObject({ code: "stale_target" });
		await store.sessionStorage.writeText(
			sessionPath,
			[header, entry("rewritten", null, current)].map(value => JSON.stringify(value)).join("\n") + "\n",
		);
		await expect(
			store.nativeLifecyclePage(
				agent.agentInstanceId,
				agent.agentInstanceRef,
				10,
				undefined,
				undefined,
				first.activityNextCursor!,
			),
		).rejects.toThrow("lineage");
	});
	it("bounds native history reads by the page instead of the 100,000-entry transcript", async () => {
		const store = await createStore();
		const agent = identity("history");
		await store.registerAgent(agent);
		const sessionPath = "/runtime-v1-history.jsonl";
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "session-history",
			timestamp: new Date(0).toISOString(),
			cwd: "/test",
		});
		const entries = Array.from({ length: 100_000 }, (_, i) =>
			JSON.stringify({
				type: "message",
				id: `entry-${i}`,
				parentId: i ? `entry-${i - 1}` : null,
				timestamp: new Date(i).toISOString(),
				message: {
					role: i % 2 ? "assistant" : "user",
					content: [{ type: "text", text: `message-${i}` }],
					timestamp: i,
				},
			}),
		);
		await store.sessionStorage.writeText(sessionPath, [header, ...entries].join("\n") + "\n");
		await store.putBinding({ ...binding("history"), sessionFile: sessionPath });
		const page = await store.nativeHistoryPage(agent.agentInstanceId);
		expect(page.entries).toHaveLength(100);
		expect(page.visitedRecords).toBeLessThanOrEqual(runtimeLimits.httpPageRecords * 2 + 10);
		expect(page.readBytes).toBeLessThan(100_000);
		expect((page.entries[0] as { id: string }).id).toBe("entry-99900");
		expect(page.nextCursor).toBeString();
		const later = store.sessionStorage.openWriter(sessionPath);
		await later.append(
			JSON.stringify({
				type: "message",
				id: "after-cut",
				parentId: "entry-99999",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "After pinned page", timestamp: Date.now() },
			}) + "\n",
		);
		await later.close();
		const prior = await store.nativeHistoryPage(agent.agentInstanceId, page.nextCursor!);
		expect(prior.revision).toBe(page.revision);
		expect((prior.entries.at(-1) as { id: string }).id).toBe("entry-99899");
		expect(prior.visitedRecords).toBeLessThanOrEqual(runtimeLimits.httpPageRecords * 2 + 10);
		const giant = JSON.stringify({
			type: "message",
			id: "giant",
			parentId: "entry-99999",
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "я".repeat(runtimeLimits.httpPageBytes) }] },
		});
		const writer = store.sessionStorage.openWriter(sessionPath);
		await writer.append(giant + "\n");
		await writer.close();
		const oversized = await store.nativeHistoryPage(agent.agentInstanceId);
		expect(oversized.entries).toEqual([]);
		expect(oversized.entryRef?.entryId).toBe("giant");
		expect(oversized.readBytes).toBe(0);
		const chunk = await store.nativeHistoryEntry(agent.agentInstanceId, "giant", oversized.entryRef!.revision);
		expect(Buffer.from(String(chunk.contentBase64), "base64").length).toBe(runtimeLimits.deliveryBatchBytes);
		expect(chunk.nextOffset).toBe(runtimeLimits.deliveryBatchBytes);
		const resource = {
			kind: "history_entry",
			agentInstanceRef: agent.agentInstanceRef,
			sessionId: oversized.sessionId,
			entryId: "giant",
			revision: oversized.entryRef!.revision,
			bytes: oversized.entryRef!.bytes,
			mediaType: "application/json",
		};
		const range = await store.runtimeResource({ principalId: "owner", resource, offset: 65536, limit: 65536 });
		validateRuntimeValue("httpRange", range);
		expect(Buffer.from(String(range.contentBase64), "base64")).toEqual(Buffer.from(giant).subarray(65536, 131072));
		await expect(store.runtimeResource({ principalId: "other", resource, offset: 0, limit: 32 })).rejects.toThrow(
			"authorized",
		);
		await expect(
			store.runtimeResource({
				principalId: "owner",
				resource: { ...resource, bytes: resource.bytes + 1 },
				offset: 0,
				limit: 32,
			}),
		).rejects.toThrow("size");
		await store.sessionStorage.writeText(
			sessionPath,
			[header, ...entries, giant.replace("giant", "rewritten")].join("\n") + "\n",
		);
		await expect(store.runtimeResource({ principalId: "owner", resource, offset: 0, limit: 32 })).rejects.toThrow(
			"lineage",
		);
		await expect(store.nativeHistoryPage(agent.agentInstanceId, page.nextCursor!)).rejects.toThrow("lineage");
	}, 30_000);
	it("keeps a retained Attempt history resource pinned across another binding and a store reopen", async () => {
		const store = await createStore();
		const databasePath = path.join(directories.at(-1)!, "engine.sqlite");
		const agent = identity("retained-resource");
		await store.registerAgent(agent);
		const first = { ...binding("retained-resource"), sessionFile: "/retained-first.jsonl" };
		const entry = {
			type: "message",
			id: "same-entry",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "assistant", content: "🙂я".repeat(200_000) },
		};
		const source =
			JSON.stringify({ type: "session", version: 3, id: "retained-session", cwd: "/first" }) +
			"\n" +
			JSON.stringify(entry) +
			"\n";
		await store.sessionStorage.writeText(first.sessionFile, source);
		await store.commitAttemptTransition(first, "completed", [{ kind: "completed" }], {
			transcriptCheckpoint: {
				sessionId: "retained-session",
				sessionPath: first.sessionFile,
				leafEntryId: "same-entry",
				byteBoundary: Buffer.byteLength(source),
			},
		});
		const page = await store.nativeHistoryPage(agent.agentInstanceId, undefined, 100, first.attemptId);
		const resource = {
			kind: "history_entry",
			agentInstanceRef: agent.agentInstanceRef,
			attemptId: first.attemptId,
			sessionId: page.sessionId,
			entryId: "same-entry",
			revision: page.entryRef!.revision,
			bytes: page.entryRef!.bytes,
			mediaType: "application/json",
		};
		const writer = store.sessionStorage.openWriter(first.sessionFile);
		await writer.append(
			JSON.stringify({
				...entry,
				id: "later",
				parentId: "same-entry",
				message: { role: "user", content: "later" },
			}) + "\n",
		);
		await writer.close();
		const next = {
			...first,
			sessionFile: "/retained-next.jsonl",
			attemptId: "next-attempt",
			executionId: "next-execution",
			commandId: "next-start",
		};
		await store.sessionStorage.writeText(
			next.sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "next-session" }) +
				"\n" +
				JSON.stringify({ ...entry, message: { role: "assistant", content: "foreign body" } }) +
				"\n",
		);
		await store.commitAttemptTransition(next, "running", [{ kind: "running" }]);
		await store.close();
		const reopened = await EngineStore.open(databasePath);
		stores.push(reopened);
		const expected = Buffer.from(JSON.stringify(entry));
		for (let offset = 0; offset < expected.length; offset += 65_536) {
			const range = await reopened.runtimeResource({ principalId: "owner", resource, offset, limit: 65_536 });
			validateRuntimeValue("httpRange", range);
			expect(Buffer.from(String(range.contentBase64), "base64")).toEqual(expected.subarray(offset, offset + 65_536));
		}
		await expect(
			reopened.runtimeResource({
				principalId: "owner",
				resource: { ...resource, attemptId: next.attemptId },
				offset: 0,
				limit: 100,
			}),
		).rejects.toThrow("Attempt");
		const pinned = await reopened.nativeHistoryPage(agent.agentInstanceId, undefined, 100, first.attemptId);
		expect(pinned.anchor).toBe("same-entry");
		expect(pinned.entryRef).toEqual(page.entryRef);
	}, 30_000);

	it("uses the retained native identity and preserves catalog continuation under a byte budget", async () => {
		const store = await createStore();
		const native = { ...identity("native"), agentInstanceId: "native-generated-id" };
		await store.registerAgent(native);
		expect(
			(await store.runtimeTarget({ agentInstanceRef: native.agentInstanceRef, principalId: "owner" }))
				.agentInstanceId,
		).toBe(native.agentInstanceId);
		for (let i = 0; i < 8; i++) await store.registerAgent(identity(`page-${i}`));
		const found = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" }, cursor, 100, 4096);
			for (const item of page.agents) {
				expect(found.has(String(item.agentInstanceRef))).toBe(false);
				found.add(String(item.agentInstanceRef));
			}
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(found.size).toBe(9);
	});
	it("keeps page summaries at the initial cut while current summaries advance", async () => {
		const store = await createStore();
		for (let i = 0; i < 8; i++) await store.registerAgent(identity(`cut-${i}`));
		const first = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" }, undefined, 1);
		const later = identity("cut-7");
		await store.branchIntent(later.agentInstanceId, "hold-after-cut", "pause", 0);
		const current = await store.runtimeSummary({ agentInstanceRef: later.agentInstanceRef, principalId: "owner" });
		expect((current.summary as { attention: { held: boolean } }).attention.held).toBe(true);
		let cursor = first.nextCursor;
		const all = [...first.agents];
		while (cursor) {
			const page = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" }, cursor, 1);
			expect(page.watermark).toBe(first.watermark);
			all.push(...page.agents);
			cursor = page.nextCursor;
		}
		expect(
			(all.find(row => row.agentInstanceRef === later.agentInstanceRef)!.attention as { held: boolean }).held,
		).toBe(false);
	});
	it("does not wake the app writer or materialize a token-only payload", async () => {
		const store = await createStore();
		const target = await active(store);
		const snapshot = await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" });
		let resolved = false;
		const waiting = store
			.waitRuntimeEvents(eventsRequest(snapshot.epoch, snapshot.watermark, { kind: "catalog" }, 50))
			.then(value => {
				resolved = true;
				return value;
			});
		await store.appendEvent({
			...target,
			causationCommandId: target.commandId,
			kind: "assistant_snapshot",
			payload: { text: "x".repeat(2_000_000) },
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		const result = await waiting;
		expect(result.changes).toEqual([]);
		expect(result.work.materializedBytes).toBe(0);
		expect(result.work.scannedRows).toBeLessThan(20);
		expect((await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).agents[0].revision).toBe(
			snapshot.agents[0].revision,
		);
	});
	it("filters selected Attempts before decoding detail and honors a fixed replay head", async () => {
		const store = await createStore();
		const root = identity("root");
		const target = await active(store);
		await store.registerAgent(identity("child", root.agentInstanceId));
		await store.commitAttemptTransition(binding("child"), "running", [{ kind: "running" }]);
		const scope: RuntimeScope = {
			kind: "branch",
			rootAgentInstanceRef: root.agentInstanceRef,
			interests: [
				{ kind: "attempt", agentInstanceRef: root.agentInstanceRef, attemptId: target.attemptId, kinds: ["state"] },
			],
		};
		const snapshot = await store.runtimeSnapshot(scope, { principalId: "owner" });
		expect(snapshot.members).toHaveLength(2);
		expect(snapshot.agents).toHaveLength(1);
		await store.commitAttemptTransition(target, "paused", [{ kind: "paused" }]);
		const head = (await store.runtimeSnapshot({ kind: "catalog" }, { principalId: "owner" })).watermark;
		await store.commitAttemptTransition(binding("child"), "failed", [
			{ kind: "failed", payload: { error: "heavy".repeat(100_000) } },
		]);
		const batch = await store.runtimeEvents({
			...eventsRequest(snapshot.epoch, snapshot.watermark, scope),
			untilCursor: head,
		});
		expect(batch.headCursor).toBe(head);
		expect(batch.throughCursor).toBe(head);
		expect(batch.changes.map(change => change.agentInstanceRef)).toEqual([root.agentInstanceRef]);
		expect(batch.work.materializedBytes).toBeLessThan(10_000);
		await expect(
			store.runtimeEvents({
				...eventsRequest(snapshot.epoch, 0, scope),
				remainingWork: { ...runtimeRemainingWork(), scannedRows: 1 },
			}),
		).rejects.toThrow("budget");
	});
	it("retains active UTF-8 message bytes and reopens an immutable version with bounded work", async () => {
		const store = await createStore();
		const target = await active(store);
		let offset = 0;
		let revision = 0;
		let expected = "";
		for (let i = 0; i < 100; i++) {
			const text = "🙂я".repeat(100);
			const bytes = Buffer.byteLength(text);
			const base = revision++;
			await store.appendEvent({
				...target,
				causationCommandId: target.commandId,
				kind: "message_updated",
				payload: {
					mode: base ? "append" : "snapshot",
					messageId: "message",
					blockId: "block",
					stream: "assistant",
					contentId: "content",
					revision,
					offset,
					endOffset: offset + bytes,
					totalBytes: offset + bytes,
					text,
					status: "streaming",
					...(base ? { baseRevision: base } : { partial: false }),
				},
			});
			offset += bytes;
			expected += text;
		}
		const page = await store.runtimeMessages({
			agentInstanceRef: identity("root").agentInstanceRef,
			attemptId: target.attemptId,
			principalId: "owner",
		});
		const baseline = (page.items as Array<Record<string, unknown>>)[0];
		expect(baseline.partial).toBe(true);
		expect(baseline.totalBytes).toBe(Buffer.byteLength(expected));
		expect((page.work as { scannedRows: number }).scannedRows).toBeLessThan(10);
		const resource = baseline.resource as Record<string, unknown>;
		let position = 0;
		const chunks: Buffer[] = [];
		while (position < offset) {
			const range = await store.runtimeResource({ principalId: "owner", resource, offset: position, limit: 8192 });
			const chunk = Buffer.from(String(range.contentBase64), "base64");
			new TextDecoder("utf-8", { fatal: true }).decode(chunk);
			chunks.push(chunk);
			position = range.nextOffset === null ? offset : Number(range.nextOffset);
		}
		expect(Buffer.concat(chunks).toString("utf8")).toBe(expected);
		await expect(store.runtimeResource({ principalId: "other", resource, offset: 0, limit: 4096 })).rejects.toThrow(
			"authorized",
		);
	});
	it("reads oversized input through an exact retained resource without losing controls", async () => {
		const store = await createStore();
		const target = await active(store);
		const questions = Array.from({ length: 32 }, (_, i) => ({
			id: `q-${i}`,
			question: "Вопрос".repeat(100),
			multi: true,
			options: Array.from({ length: 32 }, (_, n) => ({
				label: `${n}:` + "я".repeat(2000),
				description: "д".repeat(4000),
			})),
		}));
		const events = await store.commitAttemptTransition(target, "waiting_input", [
			{ kind: "input_requested", payload: { inputId: "input", questions } },
		]);
		const request = {
			agentInstanceRef: identity("root").agentInstanceRef,
			attemptId: target.attemptId,
			principalId: "owner",
		};
		const input = await store.runtimeInput({ ...request, inputId: "input", revision: events[0].eventId });
		expect(input.partial).toBe(true);
		expect((input.input as { questions: unknown[] }).questions).toHaveLength(32);
		expect(Buffer.byteLength(JSON.stringify(input.input))).toBeLessThanOrEqual(runtimeLimits.inputPreviewBytes);
		const range = await store.runtimeResource({
			principalId: "owner",
			resource: input.resource as Record<string, unknown>,
			offset: 0,
			limit: 65536,
		});
		expect(Buffer.from(String(range.contentBase64), "base64").length).toBe(65536);
		await expect(
			store.runtimeInput({ ...request, inputId: "input", revision: events[0].eventId + 1 }),
		).rejects.toThrow("revision");
	});
	it("pins a child wait to the launch command and retained Attempt across later executions", async () => {
		const store = await createStore();
		const first = await active(store);
		const firstResult = { assistantFinal: "first result", transcriptRef: "history://first" };
		await store.commitAttemptTransition(first, "completed", [{ kind: "completed" }], { terminalResult: firstResult });
		const later = {
			...first,
			commandId: "later-command",
			attemptId: "later-attempt",
			executionId: "later-execution",
		};
		await store.commitAttemptTransition(later, "completed", [{ kind: "completed" }], {
			terminalResult: { assistantFinal: "later result" },
		});
		expect(await store.waitAttemptResult(first.agentInstanceId, first.commandId, first.attemptId)).toEqual({
			attemptId: first.attemptId,
			state: "completed",
			payload: firstResult,
		});
		await expect(
			store.waitAttemptResult(first.agentInstanceId, "unrelated-command", first.attemptId),
		).rejects.toThrow("another launch");
		await expect(store.waitAttemptResult(first.agentInstanceId, first.commandId, later.attemptId)).rejects.toThrow(
			"another launch",
		);
	});
	it("does not lose cancellation while the initial child state read is pending", async () => {
		const store = await createStore();
		const controller = new AbortController();
		const pending = store.waitAttemptResult(
			identity("root").agentInstanceId,
			"not-yet-admitted",
			undefined,
			controller.signal,
		);
		queueMicrotask(() => controller.abort(new Error("parent cancelled")));
		await expect(pending).rejects.toThrow("parent cancelled");
	});
});
