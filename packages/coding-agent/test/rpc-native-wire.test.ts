import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createTestSession } from "./utilities";

const RPC_WIRE_RUNNER_ARG = "--rpc-native-wire-runner";

const offMode = {
	plan: { status: "off" },
	goal: { status: "off", continuationEnabled: false },
} as const;

class ControlledProcessExit extends Error {
	constructor(readonly code: number | undefined) {
		super(`Controlled process exit: ${code ?? 0}`);
	}
}

async function runRpcWireRunner(): Promise<void> {
	const { cleanup, session } = await createTestSession({
		inMemory: true,
		settingsOverrides: {
			"plan.enabled": false,
			"goal.enabled": false,
		},
	});
	const originalExit = process.exit;

	// The exercised commands must acknowledge their no-op without starting an
	// agent turn. Throwing here makes a regression fail before any model call.
	Object.defineProperties(session, {
		prompt: {
			configurable: true,
			value: async () => {
				throw new Error("set_*_mode off must not invoke session.prompt");
			},
		},
		promptCustomMessage: {
			configurable: true,
			value: async () => {
				throw new Error("set_*_mode off must not invoke session.promptCustomMessage");
			},
		},
	});
	process.exit = ((code?: number): never => {
		throw new ControlledProcessExit(code);
	}) as typeof process.exit;

	try {
		await runRpcMode(session);
	} catch (error) {
		if (error instanceof ControlledProcessExit) {
			process.exitCode = error.code ?? 0;
			return;
		}
		process.exitCode = 1;
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	} finally {
		process.exit = originalExit;
		await cleanup();
	}
}

if (process.argv.includes(RPC_WIRE_RUNNER_ARG)) {
	await runRpcWireRunner();
} else {
	describe("RPC native mode wire frames", () => {
		test("advertises v2 control and acknowledges off-mode commands without an agent turn", async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-native-wire-"));
			const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
			const runnerPath = path.join(import.meta.dir, "rpc-native-wire.test.ts");
			const proc = Bun.spawn([process.execPath, runnerPath, RPC_WIRE_RUNNER_ARG], {
				cwd: repoRoot,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					XDG_CONFIG_HOME: root,
					XDG_DATA_HOME: root,
					PI_CODING_AGENT_DIR: path.join(root, "agent"),
					PI_NO_TITLE: "1",
					NO_COLOR: "1",
				},
			});

			try {
				const requests = [
					{ id: "state", type: "get_state" },
					{ id: "plan-off", type: "set_plan_mode", action: "off" },
					{ id: "goal-off", type: "set_goal_mode", action: "off" },
				];
				proc.stdin.write(
					new TextEncoder().encode(`${requests.map(request => JSON.stringify(request)).join("\n")}\n`),
				);
				proc.stdin.flush();
				proc.stdin.end();

				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect(exitCode).toBe(0);
				expect(stderr).toBe("");

				const frames = stdout
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line) as Record<string, unknown>);

				expect(frames[0]).toEqual({
					type: "ready",
					protocol: { version: 2, capabilities: { nativeModeControl: 1 } },
				});
				expect(frames.find(frame => frame.id === "state")).toEqual({
					id: "state",
					type: "response",
					command: "get_state",
					success: true,
					data: expect.objectContaining({ mode: offMode }),
				});
				expect(frames.find(frame => frame.id === "plan-off")).toEqual({
					id: "plan-off",
					type: "response",
					command: "set_plan_mode",
					success: true,
					data: { mode: offMode, agentInvoked: false },
				});
				expect(frames.find(frame => frame.id === "goal-off")).toEqual({
					id: "goal-off",
					type: "response",
					command: "set_goal_mode",
					success: true,
					data: { mode: offMode, agentInvoked: false },
				});
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}, 30000);
	});
}
