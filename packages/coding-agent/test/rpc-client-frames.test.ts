import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

async function waitForCapturedFrames(
	captureFile: string,
	predicate: (frames: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			const text = await Bun.file(captureFile).text();
			const frames = Bun.JSONL.parse(text) as Array<Record<string, unknown>>;
			if (predicate(frames)) return frames;
		} catch {
			// The fixture creates the capture file after it receives its first frame.
		}
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for captured RPC frames");
}

describe("RpcClient frame coverage", () => {
	test("exposes current and unknown frames while supporting UI and host URI replies", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-client-frames-");
		const captureFile = tempDir.join("captured.jsonl");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_CLIENT_FRAMES: "1",
				MOCK_RPC_CAPTURE_FILE: captureFile,
			},
		});

		const rawTypes: string[] = [];
		const commandOutput: string[] = [];
		const sessionIds: string[] = [];
		const thinkingLevels: string[] = [];
		const extensionErrors: string[] = [];
		const sessionModes: string[] = [];
		const planModes: string[] = [];
		const approvalRequests: string[] = [];
		const approvalSettlements: string[] = [];
		const uiChannels: string[] = [];
		const uiPresentations: string[] = [];
		client.onRawFrame(frame => {
			if (typeof frame.type === "string") rawTypes.push(frame.type);
		});
		const listenerErrors: string[] = [];
		client.onRawFrame(frame => {
			if (frame.type === "ready") throw new Error("fixture listener failure");
		});
		client.onListenerError(event => listenerErrors.push(`${event.frameType}:${event.error.message}`));
		client.onCommandOutput(frame => commandOutput.push(frame.text));
		client.onSessionInfoUpdate(frame => {
			sessionIds.push(frame.sessionId);
			sessionModes.push(frame.mode);
		});
		client.onConfigUpdate(frame => {
			if (frame.thinkingLevel) thinkingLevels.push(frame.thinkingLevel);
		});
		client.onExtensionError(frame => extensionErrors.push(frame.error));
		client.onPlanStateUpdate(frame => planModes.push(frame.state.mode));
		client.onPlanApprovalRequest(frame => approvalRequests.push(frame.approvalId));
		client.onPlanApprovalSettled(frame => approvalSettlements.push(frame.result.decision));
		client.onUi(frame => {
			if (frame.type === "ui_channel_settled") uiChannels.push(frame.channelId);
			if (frame.type === "ui_presentation_update") uiPresentations.push(frame.presentation.id);
		});
		client.onExtensionUiRequest(request => {
			if (request.method === "confirm") client.sendUiConfirmation(request.id, true);
		});
		client.registerHostUriHandler(request => {
			expect(request.url).toBe("fixture://resource/1");
			return {
				content: "fixture contents",
				contentType: "text/plain",
				immutable: true,
			};
		});

		await client.start();
		expect(await client.setTodos([])).toEqual([]);
		expect(await client.setHostUriSchemes([{ scheme: "fixture", immutable: true }])).toEqual(["fixture"]);
		await client.setInterruptMode("wait");
		await client.setSessionName("RPC client test");

		const captured = await waitForCapturedFrames(
			captureFile,
			frames =>
				frames.some(frame => frame.type === "extension_ui_response") &&
				frames.some(frame => frame.type === "host_uri_result"),
		);

		expect(commandOutput).toEqual(["extension output"]);
		expect(sessionIds).toEqual(["session-1"]);
		expect(thinkingLevels).toEqual(["high"]);
		expect(extensionErrors).toEqual(["fixture failure"]);
		expect(sessionModes).toEqual(["plan"]);
		expect(planModes).toEqual(["none"]);
		expect(approvalRequests).toEqual(["approval-1"]);
		expect(approvalSettlements).toEqual(["refine"]);
		expect(uiChannels).toEqual(["rpc-ui-valid"]);
		expect(uiPresentations).toEqual([]);
		expect(rawTypes.filter(type => type === "ui_presentation_update")).toHaveLength(2);
		expect(rawTypes.filter(type => type === "ui_channel_settled")).toHaveLength(2);
		expect(rawTypes).toContain("ready");
		expect(rawTypes).toContain("future_server_frame");
		expect(listenerErrors).toEqual(["ready:fixture listener failure"]);
		expect(captured.find(frame => frame.type === "extension_ui_response")).toMatchObject({
			id: "ui-confirm-1",
			confirmed: true,
		});
		expect(captured.find(frame => frame.type === "host_uri_result")).toMatchObject({
			id: "host-uri-1",
			content: "fixture contents",
			contentType: "text/plain",
			immutable: true,
		});
	});

	test("preserves the legacy model list while exposing catalog metadata", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT });
		await client.start();

		await expect(client.getAvailableModels()).resolves.toEqual([
			{
				provider: "anthropic",
				id: "claude-sonnet",
				contextWindow: 200_000,
				reasoning: true,
			},
		]);
		await expect(client.getAvailableModelsResult()).resolves.toEqual({
			models: [
				{
					provider: "anthropic",
					id: "claude-sonnet",
					contextWindow: 200_000,
					reasoning: true,
				},
			],
			usageOrder: ["anthropic/claude-sonnet"],
			roles: [
				{
					role: "default",
					provider: "anthropic",
					id: "claude-sonnet",
					autoSelected: true,
				},
			],
			thinkingOptions: [
				{
					provider: "anthropic",
					id: "claude-sonnet",
					levels: [ThinkingLevel.Off, AUTO_THINKING, ThinkingLevel.High],
				},
			],
		});
	});

	test("waits through nonterminal agent_end frames and emits prompt results", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_CLIENT_FRAMES: "1" },
		});
		const promptResults: Array<{ id?: string; agentInvoked: boolean }> = [];
		client.onPromptResult(frame => promptResults.push(frame));

		await client.start();
		const events = await client.promptAndWait("hello", undefined, 2_000);
		const terminalValues = events
			.filter(event => event.type === "agent_end")
			.map(event => Reflect.get(event, "isTerminal"));

		expect(terminalValues).toEqual([false, true]);
		expect(promptResults).toHaveLength(1);
		expect(promptResults[0]?.agentInvoked).toBe(true);
		expect(promptResults[0]?.id).toMatch(/^req_/);
	});

	test("waitForIdle keeps a legacy prompt pending until delayed terminal agent_end", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_CLIENT_FRAMES: "1" },
		});
		let terminalSeen = false;
		client.onEvent(event => {
			if (event.type === "agent_end" && Reflect.get(event, "isTerminal") !== false) terminalSeen = true;
		});

		await client.start();
		expect(await client.prompt("hello")).toBeUndefined();
		await client.waitForIdle(2_000);

		expect(terminalSeen).toBe(true);
	});

	test("waitForIdle reconciles an accepted follow-up after a stale agent_end", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-client-continuation-");
		const captureFile = tempDir.join("captured.jsonl");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_CONTINUATION_RACE: "1",
				MOCK_RPC_CAPTURE_FILE: captureFile,
			},
		});

		await client.start();
		await client.followUp("queued");
		await client.waitForIdle(2_000);

		const captured = await waitForCapturedFrames(
			captureFile,
			frames => frames.filter(frame => frame.type === "get_state").length >= 2,
		);
		expect(captured.filter(frame => frame.type === "get_state")).toHaveLength(2);
	});

	test("waitForIdle bounds stalled continuation reconciliation by its timeout", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_CONTINUATION_RACE: "1",
				MOCK_RPC_STALL_CONTINUATION_STATE: "1",
			},
		});

		await client.start();
		await client.followUp("queued");
		const startedAt = performance.now();

		await expect(client.waitForIdle(50)).rejects.toThrow("Timeout waiting for agent to become idle");
		expect(performance.now() - startedAt).toBeLessThan(1_000);
	});

	test("completes local-only prompts from response data", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_CLIENT_FRAMES: "1",
				MOCK_RPC_LOCAL_PROMPT_RESPONSE: "1",
			},
		});
		const promptResults: Array<{ id?: string; agentInvoked: boolean }> = [];
		client.onPromptResult(frame => promptResults.push(frame));

		await client.start();
		await expect(client.promptAndWait("/local-only", undefined, 2_000)).resolves.toEqual([]);
		expect(promptResults).toHaveLength(1);
		expect(promptResults[0]).toMatchObject({
			agentInvoked: false,
		});
		expect(promptResults[0]?.id).toMatch(/^req_/);
	});

	test("does not finish an active wait from another prompt's local-only result", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_CLIENT_FRAMES: "1",
				MOCK_RPC_MIXED_PROMPT_RESULTS: "1",
			},
		});

		await client.start();
		const agentPrompt = client.promptAndWait("run agent", undefined, 2_000);
		await Bun.sleep(10);
		await client.prompt("/local-only");

		const events = await agentPrompt;
		const terminalValues = events
			.filter(event => event.type === "agent_end")
			.map(event => Reflect.get(event, "isTerminal"));
		expect(terminalValues).toEqual([false, true]);
	});

	test("cancels an in-flight host URI handler when requested by the server", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_CLIENT_FRAMES: "1",
				MOCK_RPC_HOST_URI_CANCEL: "1",
			},
		});
		const aborted = Promise.withResolvers<void>();
		client.registerHostUriHandler((_request, context) => {
			context.signal.addEventListener("abort", () => aborted.resolve(), {
				once: true,
			});
			return aborted.promise;
		});

		await client.start();
		await expect(aborted.promise).resolves.toBeUndefined();
	});

	test("ignores malformed host URI writes without content", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-client-host-uri-malformed-");
		const captureFile = tempDir.join("captured.jsonl");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_CLIENT_FRAMES: "1",
				MOCK_RPC_CAPTURE_FILE: captureFile,
				MOCK_RPC_MALFORMED_HOST_URI_WRITE: "1",
			},
		});
		let handlerCalled = false;
		client.registerHostUriHandler(() => {
			handlerCalled = true;
		});

		await client.start();
		await client.getState();
		const captured = await waitForCapturedFrames(captureFile, frames =>
			frames.some(frame => frame.type === "get_state"),
		);

		expect(handlerCalled).toBe(false);
		expect(captured.some(frame => frame.type === "host_uri_result" && frame.id === "host-uri-1")).toBe(false);
	});

	test("propagates rejected session name updates", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_REJECT_SESSION_NAME: "1" },
		});

		await client.start();
		await expect(client.setSessionName(" ")).rejects.toThrow("Session name cannot be empty");
	});

	test("restores host URI schemes after restarting the client", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-client-host-uri-restart-");
		const captureFile = tempDir.join("captured.jsonl");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_CLIENT_FRAMES: "1",
				MOCK_RPC_CAPTURE_FILE: captureFile,
			},
		});

		await client.start();
		expect(await client.setHostUriSchemes([{ scheme: "fixture", immutable: true }])).toEqual(["fixture"]);
		await client.stop();
		await client.start();

		const captured = await waitForCapturedFrames(captureFile, frames =>
			frames.some(frame => frame.type === "set_host_uri_schemes"),
		);
		expect(captured.find(frame => frame.type === "set_host_uri_schemes")).toMatchObject({
			schemes: [{ scheme: "fixture", immutable: true }],
		});
	});

	test("retains the last accepted host URI schemes when an update is rejected", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-client-host-uri-rejected-");
		const captureFile = tempDir.join("captured.jsonl");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_CLIENT_FRAMES: "1",
				MOCK_RPC_CAPTURE_FILE: captureFile,
				MOCK_RPC_REJECT_HOST_URI_SCHEME: "rejected",
			},
		});

		await client.start();
		expect(await client.setHostUriSchemes([{ scheme: "fixture", immutable: true }])).toEqual(["fixture"]);
		await expect(client.setHostUriSchemes([{ scheme: "rejected" }])).rejects.toThrow(
			"Host URI scheme rejected by fixture: rejected",
		);
		await client.stop();
		await client.start();

		const captured = await waitForCapturedFrames(captureFile, frames =>
			frames.some(frame => frame.type === "set_host_uri_schemes"),
		);
		expect(captured.find(frame => frame.type === "set_host_uri_schemes")).toMatchObject({
			schemes: [{ scheme: "fixture", immutable: true }],
		});
	});
	test("exposes the resource lifecycle control surface and typed events", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_RESOURCES: "1" },
		});
		const eventTypes: string[] = [];
		client.onResourceLifecycle(frame => eventTypes.push(frame.type));

		await client.start();
		const snapshot = await client.listResources();
		expect(snapshot.servers[0]).toMatchObject({
			serverId: "alpha",
			state: "connected",
			tools: { total: 1, items: [{ name: "alpha_search" }] },
			resources: { total: 1, items: [{ uri: "docs://one" }] },
			prompts: { total: 1, items: [{ name: "summarize" }] },
		});
		expect(await client.refreshResources("alpha")).toEqual({ operationId: "resource-refresh-1" });
		expect(await client.reloadResources()).toEqual({ operationId: "resource-reload-1" });
		expect(await client.cancelResourceOperation("resource-refresh-1")).toBe(true);
		expect(await client.disposeResource("alpha")).toMatchObject({ serverId: "alpha", state: "disabled" });
		expect(eventTypes).toEqual(["resource_lifecycle", "resource_operation", "resource_operation"]);
	});

	test("exposes typed secret-safe runtime provenance snapshots and updates", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_PROVENANCE: "1" },
		});
		const revisions: number[] = [];
		client.onProvenanceUpdate(frame => revisions.push(frame.provenance.revision));

		await client.start();
		expect(await client.getRuntimeProvenance()).toMatchObject({
			model: { active: { provider: "anthropic", id: "claude-sonnet" }, role: "reviewer" },
			usage: { available: false, diagnostic: "not_requested" },
		});
		expect(await client.getRuntimeProvenance(true)).toMatchObject({
			usage: { available: true, reports: [{ provider: "anthropic", fetchedAt: 123 }] },
		});
		expect(revisions).toEqual([1]);
	});

	test("exposes typed collaboration authority, replication, acknowledgement, and media controls", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_COLLABORATION: "1" },
		});
		const replicatedKinds: string[] = [];
		client.onCollaboration(frame => {
			if (frame.type === "collaboration_replicated") replicatedKinds.push(frame.kind);
		});

		await client.start();
		expect(await client.getCollaboration()).toMatchObject({
			role: "guest",
			authority: "full",
			authoritative: false,
			replication: { generation: 1, latestSequence: 1 },
		});
		expect(await client.hostCollaboration()).toMatchObject({
			role: "host",
			authoritative: true,
			links: { link: "wss://relay/r/room.full", viewLink: "wss://relay/r/room.view" },
		});
		expect(await client.joinCollaboration("wss://relay/r/room.full")).toMatchObject({
			role: "guest",
			authoritative: false,
		});
		expect(await client.acknowledgeCollaboration(1, 1)).toEqual({ acknowledged: 1, retained: 0 });
		expect(await client.readCollaborationMedia("0", 0, 2)).toMatchObject({
			mediaId: "0",
			mediaType: "image/png",
			byteLength: 2,
			data: "AQI=",
		});
		expect(await client.revokeCollaborationParticipant("7")).toMatchObject({ role: "host" });
		expect(await client.rotateCollaborationAccess()).toMatchObject({ role: "host" });
		expect(await client.leaveCollaboration()).toMatchObject({ role: "none", state: "off" });
		expect(replicatedKinds).toEqual(["snapshot"]);
	});

	test("exposes the ordered authoritative RPC v3 session surface", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_SESSION_V3: "1" },
		});
		const delivered = Promise.withResolvers<{ subscriptionId: string; sequence: number }>();
		client.onSessionObservation(frame => {
			if (frame.observation.type === "observation") {
				delivered.resolve({ subscriptionId: frame.subscriptionId, sequence: frame.observation.sequence });
			}
		});

		await client.start();
		const negotiation = await client.initializeV3({
			requestedCapabilities: ["session.observe", "session.execute", "session.shutdown", "context.projection"],
			hostCapabilities: { interactions: ["confirm"], semanticContent: ["markdown"] },
		});
		expect(negotiation).toMatchObject({
			ok: true,
			profile: { name: "omp.session", major: 3, minor: 0 },
			framingVersion: 1,
		});

		const opened = await client.openSession({ snapshot: true });
		expect(opened).toMatchObject({
			subscriptionId: "subscription-1",
			durableCursor: { sessionId: "mock-session", leafId: "leaf-1", entryId: "entry-7" },
			watermark: { epoch: "epoch-1", sequence: 4 },
			replayComplete: true,
			snapshot: {
				sessionId: "mock-session",
				revision: 7,
				journalCursor: { sessionId: "mock-session", leafId: "leaf-1", entryId: "entry-7" },
				watermark: { epoch: "epoch-1", sequence: 4 },
			},
		});
		expect(await client.getContext({ maxSources: 256, maxRelations: 512, maxContentBytes: 262_144 })).toMatchObject({
			bounds: { maxSources: 256, maxRelations: 512, maxContentBytes: 262_144 },
			returned: { sources: 1, relations: 1, contentBytes: 5 },
			truncated: { sources: false, relations: false, content: false },
			snapshot: { sessionId: "mock-session", leafId: "leaf-1", requestId: "context-request-1" },
		});
		expect(await delivered.promise).toEqual({ subscriptionId: "subscription-1", sequence: 5 });
		await client.acknowledgeSession("subscription-1", 5);
		expect(
			await client.invokeSession({
				kind: "queue_update",
				input: { entryId: "queue-1", text: "updated" },
				expectedRevision: 7,
				idempotencyKey: "mutation-1",
			}),
		).toEqual({ outcome: "completed", revision: 8, result: { applied: true } });

		await client.unsubscribeSession("subscription-1");
		expect(await client.shutdownSession()).toEqual({ state: "settled" });
	});
	test("uses canonical v3 capability identifiers in the external-client fixture", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT });
		await client.start();
		const negotiation = await client.initializeV3({
			requestedCapabilities: ["session.mutate"],
			hostCapabilities: { interactions: [], semanticContent: [] },
		});
		expect(negotiation).toMatchObject({
			ok: true,
			capabilities: [
				{
					id: "session.mutate",
					supported: false,
					unsupportedReason: { code: "unknown_capability" },
				},
			],
		});
	});
});
