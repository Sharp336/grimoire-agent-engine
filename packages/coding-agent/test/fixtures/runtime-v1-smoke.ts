import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { EngineControlQueryClient } from "../../src/engine/control-query";
import type { EngineCommandEnvelope } from "../../src/engine/nats-adapter";
import { runtimeRemainingWork, validateRuntimeValue } from "../../src/engine/runtime-protocol";

const runDir = process.argv[2];
if (!runDir) throw new Error("An explicitly owned, new TEMP run directory is required");
const child = Bun.spawn(
	[
		process.execPath,
		path.join(import.meta.dir, "runtime-v1-load.ts"),
		"--run-dir",
		path.resolve(runDir),
		"--seconds",
		"5",
		"--roots",
		"1",
		"--rate",
		"20",
		...process.argv.slice(3),
	],
	{ stdout: "pipe", stderr: "inherit" },
);
try {
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let ready:
		| { principalId: string; agents: Array<{ agentInstanceRef: string; attemptId: string; executionId: string }> }
		| undefined;
	while (!ready) {
		const chunk = await withTimeout(reader.read(), 30_000, "Fixture startup exceeded its bounded smoke deadline");
		if (chunk.done) throw new Error(`Fixture exited before ready (${await child.exited})`);
		buffered += decoder.decode(chunk.value, { stream: true });
		for (;;) {
			const line = buffered.indexOf("\n");
			if (line < 0) break;
			const text = buffered.slice(0, line);
			buffered = buffered.slice(line + 1);
			if (!text.startsWith("{")) continue;
			const value = JSON.parse(text) as { kind: string };
			if (value.kind === "ready") ready = JSON.parse(text) as typeof ready;
		}
	}
	const client = new EngineControlQueryClient(runDir);
	const access = { principalId: ready.principalId };
	const scope = { kind: "catalog" };
	const snapshot = (await client.request("runtime.snapshot", { scope, ...access })) as {
		epoch: string;
		watermark: number;
		agents: unknown[];
	};
	validateRuntimeValue("snapshot", snapshot);
	if (snapshot.agents.length !== 3) throw new Error("The fixture did not enroll one root and two children");
	for (const current of ready.agents) {
		const selected = (await client.request("runtime.snapshot", {
			scope: {
				kind: "attempt",
				agentInstanceRef: current.agentInstanceRef,
				attemptId: current.attemptId,
				kinds: ["state", "history"],
			},
			...access,
		})) as { agents: Array<{ attemptId: string; history: { sessionId: string | null; revision: string | null } }> };
		const boundary = selected.agents[0];
		if (boundary?.attemptId !== current.attemptId || !boundary.history.sessionId)
			throw new Error("Initial exact Attempt has no retained history session boundary");
		const history = (await client.request("runtime.history", {
			agentInstanceRef: current.agentInstanceRef,
			attemptId: current.attemptId,
			limit: 2,
			...access,
		})) as { sessionId: string; revision: string };
		validateRuntimeValue("historyPage", history);
		if (history.sessionId !== boundary.history.sessionId)
			throw new Error("Initial history boundary changed session identity");
		if (current === ready.agents[0] && process.argv.includes("--history-entries")) {
			if (history.revision !== boundary.history.revision)
				throw new Error("Prepared history did not publish its retained leaf in the selected snapshot");
		}
	}
	const agent = ready.agents[0];
	const target = (await client.request("runtime.target", { ...agent, ...access })) as Record<string, unknown>;
	validateRuntimeValue("nativeTarget", target);
	if (target.kind !== "bound") throw new Error("Fixture target is not bound");
	const context = (await client.request("runtime.context", { ...agent, ...access })) as { cwd: string };
	if (context.cwd !== path.join(path.resolve(runDir), "workspace"))
		throw new Error("Context did not return the exact native cwd");
	const detailScope = { kind: "agent", agentInstanceRef: agent.agentInstanceRef, kinds: ["assistant", "state"] };
	const detail = (await client.request("runtime.snapshot", { scope: detailScope, ...access })) as {
		epoch: string;
		watermark: number;
	};
	validateRuntimeValue("snapshot", detail);
	const events = (await client.request("runtime.events.wait", {
		scope: detailScope,
		...access,
		epoch: detail.epoch,
		afterCursor: detail.watermark,
		timeoutMs: 1000,
		limit: 100,
		maxBytes: 61440,
		remainingWork: runtimeRemainingWork(),
	})) as { changes: unknown[] };
	validateRuntimeValue("eventBatch", events);
	if (!events.changes.length) throw new Error("The real owner stream produced no selected updates");
	const command: EngineCommandEnvelope = {
		schema: "grimoire.engine.command.v1",
		commandId: "fixture-enqueue",
		op: "enqueue",
		deviceId: "runtime-load-device",
		engineId: "runtime-load-engine",
		engineGeneration: Number(target.currentEngineGeneration),
		agentInstanceRef: agent.agentInstanceRef,
		agentInstanceId: String(target.agentInstanceId),
		attemptId: agent.attemptId,
		executionId: agent.executionId,
		runtimeBindingId: String(target.bindingId),
		bindingGeneration: Number(target.bindingGeneration),
		authorityGeneration: Number(target.authorityGeneration),
		issuedAt: Date.now(),
		principalId: access.principalId,
		browserPayloadHash: `sha256:${"a".repeat(64)}`,
		browserTarget: { agentInstanceRef: agent.agentInstanceRef },
		payload: {
			text: "queued during active fixture",
			clientMessageId: "fixture-message",
			expectedIntentRevision: Number(target.intentRevision),
			deliverAt: Date.now() + 60_000,
		},
	};
	await client.request("command", { command });
	const queue = await client.request("runtime.queue", { agentInstanceRef: agent.agentInstanceRef, ...access });
	validateRuntimeValue("queuePage", queue);
	const summary = (await client.request("runtime.summary", {
		agentInstanceRef: agent.agentInstanceRef,
		...access,
	})) as { summary: { attention: { queuePending: boolean }; target: { attemptId: string } } };
	validateRuntimeValue("summaryRead", summary);
	if (!summary.summary.attention.queuePending || summary.summary.target.attemptId !== agent.attemptId)
		throw new Error("Busy enqueue did not preserve its Attempt");
	const controlled = ready.agents[1];
	const controlScope = { kind: "agent", agentInstanceRef: controlled.agentInstanceRef, kinds: ["state"] };
	for (const op of ["pause", "resume", "pause", "resume"] as const) {
		const pinned = (await client.request("runtime.target", { ...controlled, ...access })) as Record<string, unknown>;
		const cut = (await client.request("runtime.snapshot", { scope: controlScope, ...access })) as {
			epoch: string;
			watermark: number;
		};
		await client.request("command", {
			command: {
				...command,
				op,
				commandId: `fixture-${op}-${pinned.intentRevision}`,
				agentInstanceRef: controlled.agentInstanceRef,
				agentInstanceId: pinned.agentInstanceId,
				attemptId: controlled.attemptId,
				executionId: controlled.executionId,
				runtimeBindingId: pinned.bindingId,
				bindingGeneration: pinned.bindingGeneration,
				authorityGeneration: pinned.authorityGeneration,
				browserPayloadHash: undefined,
				browserTarget: undefined,
				payload: { expectedIntentRevision: pinned.intentRevision, initiator: { kind: "human" } },
			},
		});
		let cursor = cut.watermark;
		const deadline = Date.now() + 2000;
		for (;;) {
			const changes = (await client.request("runtime.events.wait", {
				scope: controlScope,
				...access,
				epoch: cut.epoch,
				afterCursor: cursor,
				timeoutMs: 1000,
				limit: 100,
				maxBytes: 61440,
				remainingWork: runtimeRemainingWork(),
			})) as {
				throughCursor: number;
				changes: Array<{ kind: string; value: { state?: string; attemptId?: string } }>;
			};
			if (
				changes.changes.some(
					change =>
						change.kind === "state" &&
						change.value.state === (op === "pause" ? "paused" : "running") &&
						change.value.attemptId === controlled.attemptId,
				)
			)
				break;
			if (Date.now() >= deadline) throw new Error(`Exact fixture Attempt failed to reach ${op} quiescence`);
			cursor = changes.throughCursor;
		}
	}
	let observing = true;
	const observer = new EngineControlQueryClient(runDir, 30_000);
	const observers = Array.from({ length: 16 }, async (_, index) => {
		const selected = index % 2 ? detailScope : scope;
		const initial = (await observer.request("runtime.snapshot", { scope: selected, ...access })) as {
			epoch: string;
			watermark: number;
		};
		let cursor = initial.watermark;
		while (observing) {
			try {
				const batch = (await observer.request("runtime.events.wait", {
					scope: selected,
					...access,
					epoch: initial.epoch,
					afterCursor: cursor,
					timeoutMs: 25_000,
					limit: 100,
					maxBytes: 61440,
					remainingWork: runtimeRemainingWork(),
				})) as { throughCursor: number };
				cursor = batch.throughCursor;
			} catch {
				// The real IPC owner closes its active observer sockets during shutdown.
				break;
			}
		}
	});
	let completion = buffered;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		completion += decoder.decode(chunk.value, { stream: true });
		if (completion.split(/\r?\n/).some(line => line.startsWith("{") && line.includes('"kind":"complete"'))) break;
	}
	reader.releaseLock();
	observing = false;
	const afterComplete = performance.now();
	const code = await withTimeout(child.exited, 3000, "Engine printed complete but retained a live process handle");
	await Promise.all(observers);
	if (code !== 0) throw new Error(`Fixture process exited ${code}`);
	if (
		!completion
			.split(/\r?\n/)
			.some(line => line.startsWith("{") && (JSON.parse(line) as { kind: string }).kind === "complete")
	)
		throw new Error("Fixture exited without completing its owner teardown");
	console.log(
		JSON.stringify({
			result: "PASS",
			nativeIpc: true,
			catalogAgents: snapshot.agents.length,
			historySessionBoundaries: ready.agents.length,
			selectedChanges: events.changes.length,
			busyEnqueue: true,
			pauseResumeSameAttempt: true,
			finiteHeldShutdown: true,
			liveObservers: observers.length,
			processExitAfterCompleteMs: performance.now() - afterComplete,
			runDir: path.resolve(runDir),
		}),
	);
} finally {
	if (child.exitCode === null) child.kill();
}
