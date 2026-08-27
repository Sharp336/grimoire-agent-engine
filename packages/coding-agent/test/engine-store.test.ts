import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { EngineStore } from "@oh-my-pi/pi-coding-agent/engine/store";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("EngineStore", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
	});

	it("reconciles unfinished attempts from an earlier engine generation", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-store-${Snowflake.next()}-`));
		const databasePath = path.join(tempDir, "engine.sqlite");
		const first = await EngineStore.open(databasePath);
		const generation = await first.nextEngineGeneration();
		const binding = {
			bindingId: "binding-1",
			commandId: "command-1",
			agentInstanceId: "agent-1",
			executionId: "execution-1",
			attemptId: "attempt-1",
			engineAgentId: "Engine-1",
			profileDigest: "profile-1",
			state: "running" as const,
			engineGeneration: generation,
			bindingGeneration: 1,
			authorityGeneration: 1,
		};
		await first.putBinding(binding);
		await first.putAttempt(binding, "running");
		await first.close();

		const runtime = await EngineRuntime.create({ databasePath });
		expect(runtime.engineGeneration).toBe(generation + 1);
		expect((await runtime.store.getBinding("agent-1"))?.state).toBe("released");
		const events = await runtime.store.pendingEvents();
		expect(events.map(event => event.kind)).toEqual(["interrupted"]);
		expect(events[0]?.engineGeneration).toBe(runtime.engineGeneration);
		expect(events[0]?.payload).toEqual({ cause: "engine_lost", lostEngineGeneration: generation });
		await runtime.dispose();
	});
});
