import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EngineBindingSnapshot, EngineInboxTarget } from "../src/engine/contracts";
import { engineAgentId, engineAgentInstanceId } from "../src/engine/route";
import {
	RUNTIME_PROTOCOL_HASH,
	type RuntimeScope,
	runtimeLimits,
	runtimeRemainingWork,
	validateRuntimeValue,
} from "../src/engine/runtime-protocol";
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
		const page = await store.runtimeQueue(agent.agentInstanceId);
		expect((page.items as unknown[]).length).toBe(runtimeLimits.httpPageRecords);
		expect(page.nextCursor).toBeString();
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
		expect(page.visitedRecords).toBeLessThanOrEqual(204);
		expect(page.readBytes).toBeLessThan(100_000);
		expect((page.entries[0] as { id: string }).id).toBe("entry-99900");
		expect(page.nextCursor).toBeString();
		const prior = await store.nativeHistoryPage(agent.agentInstanceId, page.nextCursor!);
		expect((prior.entries.at(-1) as { id: string }).id).toBe("entry-99899");
		expect(prior.visitedRecords).toBeLessThanOrEqual(204);
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
		const chunk = await store.nativeHistoryEntry(agent.agentInstanceId, "giant", oversized.revision);
		expect(Buffer.from(String(chunk.contentBase64), "base64").length).toBe(runtimeLimits.deliveryBatchBytes);
		expect(chunk.nextOffset).toBe(runtimeLimits.deliveryBatchBytes);
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
});
