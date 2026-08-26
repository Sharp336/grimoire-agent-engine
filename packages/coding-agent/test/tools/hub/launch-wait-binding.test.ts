/**
 * Hub-level process wait binding: `executeLaunch` must send the daemon id and
 * owner to the broker, must NOT default an omitted `for` to `exit`, and must
 * turn classified broker refusals into immediate isError results instead of
 * letting a rejection surface as a framework error. The model-facing schema
 * text must describe the same auto condition — never a false default exit.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { DaemonBrokerClient } from "../../../src/launch/client";
import * as daemonClient from "../../../src/launch/client";
import { type DaemonOperation, type DaemonRpcResult, encodeDaemonWaitReject } from "../../../src/launch/protocol";
import type { ToolSession } from "../../../src/tools";
import { HubTool } from "../../../src/tools/hub";
import { executeLaunch } from "../../../src/tools/hub/launch";

const OWNER = "session-owner";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		getSessionId: () => OWNER,
	} as unknown as ToolSession;
}

const waitResult = (state: "exited" | "ready" = "exited"): DaemonRpcResult => ({
	op: "wait",
	daemon: {
		name: "web",
		id: "daemon-1",
		state,
		createdAt: 1,
		startedAt: 1,
		...(state === "exited" ? { exitedAt: 2, exitCode: 0 } : { readyAt: 2 }),
		restartCount: 0,
		outputBytes: 0,
		persist: true,
		detached: false,
	},
	timedOut: false,
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("hub process wait binding", () => {
	it("sends no default `for` and classifies a missing-id refusal immediately", async () => {
		const requests: DaemonOperation[] = [];
		const client = {
			projectDir: process.cwd(),
			request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
				requests.push(operation);
				throw new daemonClient.DaemonBrokerRejectedError(
					encodeDaemonWaitReject({
						code: "missing-id",
						message: "wait on web requires id — the daemon id returned by `start` (generation binding).",
					}),
				);
			},
			onCompletion: () => () => {},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch(makeSession(), { op: "wait", name: "web", timeout: 30 });

		expect(result.isError).toBe(true);
		expect(result.details?.op).toBe("wait");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("requires id");
		// The hub no longer defaults an omitted `for` to `exit` — the broker
		// decides the auto condition from the daemon's live state.
		expect(requests[0]).toMatchObject({ op: "wait", name: "web", id: undefined, for: undefined });
	});

	it("passes id, owner, and explicit for through to the broker", async () => {
		const captured: DaemonOperation[] = [];
		const client = {
			projectDir: process.cwd(),
			request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
				captured.push(operation);
				return waitResult();
			},
			onCompletion: () => () => {},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch(makeSession(), {
			op: "wait",
			name: "web",
			id: "daemon-1",
			for: "exit",
			timeout: 5,
		});

		expect(captured[0]).toMatchObject({
			op: "wait",
			name: "web",
			id: "daemon-1",
			owner: OWNER,
			for: "exit",
			timeoutMs: 5_000,
		});
		expect(result.isError).not.toBe(true);
		expect(result.details?.daemon?.id).toBe("daemon-1");
	});

	it("keeps an omitted `for` undefined when an id is bound", async () => {
		const captured: DaemonOperation[] = [];
		const client = {
			projectDir: process.cwd(),
			request: async (operation: DaemonOperation): Promise<DaemonRpcResult> => {
				captured.push(operation);
				return waitResult("ready");
			},
			onCompletion: () => () => {},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch(makeSession(), { op: "wait", name: "web", id: "daemon-1", timeout: 5 });

		expect(captured[0]).toMatchObject({ op: "wait", name: "web", id: "daemon-1", for: undefined });
		expect(result.isError).not.toBe(true);
		expect((result.details?.daemon as { state?: string } | undefined)?.state).toBe("ready");
	});

	it("classifies stale-id and wrong-owner refusals with their messages", async () => {
		const refusals: Array<{ code: "stale-id" | "wrong-owner"; message: string }> = [
			{
				code: "stale-id",
				message:
					"Daemon web generation mismatch: id old-id is stale (restart/relaunch rotates it); current id is new-id.",
			},
			{
				code: "wrong-owner",
				message: "Daemon web is owned by session session-a; only the owning session may wait on it.",
			},
		];
		for (const refusal of refusals) {
			const client = {
				projectDir: process.cwd(),
				request: async (): Promise<DaemonRpcResult> => {
					throw new daemonClient.DaemonBrokerRejectedError(encodeDaemonWaitReject(refusal));
				},
				onCompletion: () => () => {},
				close() {},
			} satisfies DaemonBrokerClient;
			vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

			const result = await executeLaunch(makeSession(), {
				op: "wait",
				name: "web",
				id: "daemon-1",
				for: "ready",
				timeout: 5,
			});

			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toBe(refusal.message);
			expect(result.details?.op).toBe("wait");
		}
	});

	it("pins the model-facing `for` schema text to auto semantics, never a false default exit", () => {
		const wire = toolWireSchema(new HubTool(makeSession())) as {
			properties?: { for?: { description?: string } };
		};
		// This description is the exact text the model sees in the tool schema:
		// an omitted `for` is auto (already-ready returns immediately, a
		// ready-less one-shot waits for exit), never a default exit wait.
		expect(wire.properties?.for?.description).toBe(
			"wait with name: lifecycle condition; omitted = auto: already-ready returns immediately, a ready-less one-shot waits for exit, otherwise waits for readiness or exit",
		);
		// The explicit values survive alongside the auto description.
		expect(JSON.stringify(wire.properties?.for)).toContain('"exit"');
		expect(JSON.stringify(wire.properties?.for)).toContain('"ready"');
	});
});
