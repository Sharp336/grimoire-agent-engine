import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

describe("RPC runtime controls", () => {
	test("changes plan and approval modes without restarting the session", async () => {
		const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");
		const child = Bun.spawn(
			[
				"bun",
				cliPath,
				"--mode",
				"rpc",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
				"--approval-mode",
				"write",
			],
			{
				cwd: path.join(import.meta.dir, ".."),
				env: { ...Bun.env, PI_NO_TITLE: "1" },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		const commands = [
			{ id: "initial", type: "get_state" },
			{ id: "approval", type: "set_approval_mode", mode: "always-ask" },
			{ id: "plan", type: "set_mode", mode: "plan" },
			{ id: "planned", type: "get_state" },
			{ id: "default", type: "set_mode", mode: "default" },
		];
		for (const command of commands) {
			child.stdin.write(`${JSON.stringify(command)}\n`);
		}
		await child.stdin.flush();

		const responses: Partial<Record<string, Record<string, unknown>>> = {};
		const modeChanges: string[] = [];
		try {
			for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "mode_changed" && typeof frame.mode === "string") {
					modeChanges.push(frame.mode);
				}
				if (frame.type === "response" && typeof frame.id === "string") {
					responses[frame.id] = frame;
					if (frame.id === "default") break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited.catch(() => {});
		}

		expect(responses.initial?.data).toMatchObject({ mode: "default", approvalMode: "write" });
		expect(responses.approval?.data).toEqual({ approvalMode: "always-ask" });
		expect(responses.plan?.data).toEqual({ mode: "plan" });
		expect(responses.planned?.data).toMatchObject({ mode: "plan", approvalMode: "always-ask" });
		expect(responses.default?.data).toEqual({ mode: "default" });
		expect(modeChanges).toEqual(["plan", "default"]);
	}, 30000);

	test("client dispatches control events and answers plan confirmation", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT });
		const modeChanged = Promise.withResolvers<void>();
		const configUpdated = Promise.withResolvers<void>();
		const planAnswered = Promise.withResolvers<void>();
		let observedMode: string | undefined;
		let observedApprovalMode: string | undefined;
		let approvalRequest: { id: string; method: string } | undefined;

		client.onExtensionUIRequest(request => {
			if (request.method !== "confirm") return;
			approvalRequest = { id: request.id, method: request.method };
			client.sendExtensionUIResponse({
				type: "extension_ui_response",
				id: request.id,
				confirmed: true,
			});
		});
		client.onSessionEvent(event => {
			if (event.type === "mode_changed") {
				observedMode = event.mode;
				modeChanged.resolve();
			} else if (event.type === "config_update") {
				observedApprovalMode = event.approvalMode;
				configUpdated.resolve();
			} else if (event.type === "notice" && event.message === "plan approved") {
				planAnswered.resolve();
			}
		});

		await client.start();
		expect(await client.setMode("plan")).toBe("plan");
		await Promise.all([modeChanged.promise, planAnswered.promise]);
		expect(await client.setApprovalMode("always-ask")).toBe("always-ask");
		await configUpdated.promise;

		expect(approvalRequest).toEqual({ id: "plan-confirm", method: "confirm" });
		expect(observedMode).toBe("plan");
		expect(observedApprovalMode).toBe("always-ask");
	}, 20000);
});
