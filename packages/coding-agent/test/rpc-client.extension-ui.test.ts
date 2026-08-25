import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

/** Resolves once `predicate` holds, so a test never races the reader loop. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
		await Bun.sleep(10);
	}
}

describe("RpcClient extension UI and command output", () => {
	test("delivers extension UI requests to a host listener", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT, env: { MOCK_RPC_EXTENSION_UI: "1" } });
		await client.start();

		const seen: RpcExtensionUIRequest[] = [];
		client.onExtensionUiRequest(request => seen.push(request));

		await client.getState();
		await waitFor(() => seen.length > 0);

		expect(seen[0]).toMatchObject({ type: "extension_ui_request", id: "mock-ui-1", method: "confirm" });
	}, 20_000);

	test("sends an answer the server actually receives", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT, env: { MOCK_RPC_EXTENSION_UI: "1" } });
		await client.start();

		// The mock echoes any `extension_ui_response` back as `command_output`, so
		// this asserts the answer reached the server rather than only that the
		// client wrote it to stdin.
		const echoes: string[] = [];
		client.onCommandOutput(text => echoes.push(text));

		const requests: RpcExtensionUIRequest[] = [];
		client.onExtensionUiRequest(request => requests.push(request));

		await client.getState();
		await waitFor(() => requests.length > 0);

		const request = requests[0];
		if (!request) throw new Error("no extension UI request arrived");
		client.respondToExtensionUi({ type: "extension_ui_response", id: request.id, confirmed: true });
		await waitFor(() => echoes.some(text => text.startsWith("ui_response:")));

		const echoed = echoes.find(text => text.startsWith("ui_response:")) ?? "";
		expect(JSON.parse(echoed.slice("ui_response:".length))).toMatchObject({
			type: "extension_ui_response",
			id: "mock-ui-1",
			confirmed: true,
		});
	}, 20_000);

	test("unsubscribing stops delivery", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT, env: { MOCK_RPC_EXTENSION_UI: "1" } });
		await client.start();

		const seen: RpcExtensionUIRequest[] = [];
		const unsubscribe = client.onExtensionUiRequest(request => seen.push(request));
		unsubscribe();

		const kept: RpcExtensionUIRequest[] = [];
		client.onExtensionUiRequest(request => kept.push(request));

		await client.getState();
		await waitFor(() => kept.length > 0);

		expect(seen).toHaveLength(0);
	}, 20_000);

	test("delivers builtin command output to a host listener", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT, env: { MOCK_RPC_COMMAND_OUTPUT: "1" } });
		await client.start();

		const output: string[] = [];
		client.onCommandOutput(text => output.push(text));

		await client.getState();
		await waitFor(() => output.length > 0);

		expect(output).toContain("mock command output");
	}, 20_000);

	test("a command_output frame is not mistaken for an agent event", async () => {
		using client = new RpcClient({ cliPath: MOCK_AGENT, env: { MOCK_RPC_COMMAND_OUTPUT: "1" } });
		await client.start();

		const output: string[] = [];
		const sessionEvents: unknown[] = [];
		client.onCommandOutput(text => output.push(text));
		client.onSessionEvent(event => sessionEvents.push(event));

		await client.getState();
		await waitFor(() => output.length > 0);

		expect(sessionEvents).toHaveLength(0);
	}, 20_000);
});
