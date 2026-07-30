import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
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
		client.onRawFrame(frame => {
			if (typeof frame.type === "string") rawTypes.push(frame.type);
		});
		client.onCommandOutput(frame => commandOutput.push(frame.text));
		client.onSessionInfoUpdate(frame => sessionIds.push(frame.sessionId));
		client.onConfigUpdate(frame => {
			if (frame.thinkingLevel) thinkingLevels.push(frame.thinkingLevel);
		});
		client.onExtensionError(frame => extensionErrors.push(frame.error));
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
		expect(rawTypes).toContain("ready");
		expect(rawTypes).toContain("future_server_frame");
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
});
