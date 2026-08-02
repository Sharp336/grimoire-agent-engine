import { describe, expect, test } from "bun:test";
import {
	RpcPendingExtensionRequests,
	requestRpcAgentMutationConfirmation,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

describe("RPC agent mutation confirmation", () => {
	test("requires the correlated server-issued operation id", async () => {
		const pending = new RpcPendingExtensionRequests();
		const frames: RpcExtensionUIRequest[] = [];
		const confirmation = requestRpcAgentMutationConfirmation(
			pending,
			frame => frames.push(frame as RpcExtensionUIRequest),
			"release_agent",
			"SubagentA",
			false,
			1000,
		);
		const request = frames[0];
		expect(request.method).toBe("confirm");
		if (request.method !== "confirm") throw new Error("missing confirmation request");
		expect(request.operationId).toBeString();
		pending.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			confirmed: true,
			operationId: "wrong-operation",
		});
		expect(await confirmation).toBe(false);
	});

	test("fails closed on expiry and disconnect", async () => {
		const expired = requestRpcAgentMutationConfirmation(
			new RpcPendingExtensionRequests(),
			() => {},
			"cancel_agent",
			"SubagentA",
			false,
			1,
		);
		expect(await expired).toBe(false);
		const pending = new RpcPendingExtensionRequests();
		const disconnected = requestRpcAgentMutationConfirmation(
			pending,
			() => {},
			"cancel_agent",
			"SubagentA",
			false,
			1000,
		);
		pending.rejectAll("disconnected");
		await expect(disconnected).rejects.toThrow("disconnected");
	});
});
