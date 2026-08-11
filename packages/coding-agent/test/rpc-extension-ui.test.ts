import { describe, expect, it, vi } from "bun:test";
import {
	emitRpcPassiveInteraction,
	type PendingExtensionRequest,
	RpcPendingExtensionRequests,
	requestRpcDialog,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

describe("RPC extension UI", () => {
	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(output).toHaveBeenCalledWith({
			type: "interaction_settled",
			id: request.id,
			method: "confirm",
			outcome: { state: "cancelled" },
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("routes confidential provider input through the generic response broker", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcDialog<string | undefined>(
			pendingRequests,
			output,
			undefined,
			undefined,
			{
				method: "input",
				title: "API key",
				placeholder: "sk-...",
				sensitive: true,
				operationId: "operation-auth",
				purpose: "provider_auth",
				providerId: "openrouter",
			},
			response => ("value" in response ? response.value : undefined),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the confidential input request to carry an id");
		}

		const requestFrame = request as Record<string, unknown>;
		expect(requestFrame.type).toBe("extension_ui_request");
		expect(requestFrame.method).toBe("input");
		expect(requestFrame.title).toBe("API key");
		expect(requestFrame.placeholder).toBe("sk-...");
		expect(requestFrame.sensitive).toBe(true);
		expect(requestFrame.operationId).toBe("operation-auth");
		expect(requestFrame.purpose).toBe("provider_auth");
		expect(requestFrame.providerId).toBe("openrouter");
		pendingRequests.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			value: "secret-test-key",
		});

		expect(await result).toBe("secret-test-key");
		expect(pendingRequests.size).toBe(0);
		expect(JSON.stringify(output.mock.calls)).not.toContain("secret-test-key");
	});

	it("reports accepted, timed-out, unsupported, and disconnected outcomes without echoing values", async () => {
		const output = vi.fn<(frame: object) => void>();
		const pendingRequests = new RpcPendingExtensionRequests();
		pendingRequests.configureHostCapabilities(["input"]);

		const accepted = requestRpcDialog<string | undefined>(
			pendingRequests,
			output,
			undefined,
			undefined,
			{ method: "input", title: "Secret", sensitive: true },
			response => ("value" in response ? response.value : undefined),
		);
		const acceptedRequest = output.mock.calls[0]?.[0];
		if (!acceptedRequest || !("id" in acceptedRequest) || typeof acceptedRequest.id !== "string") {
			throw new Error("Expected an input interaction request");
		}
		pendingRequests.get(acceptedRequest.id)?.resolve({
			type: "extension_ui_response",
			id: acceptedRequest.id,
			value: "never-echo-this",
		});
		expect(await accepted).toBe("never-echo-this");
		expect(output).toHaveBeenCalledWith({
			type: "interaction_settled",
			id: acceptedRequest.id,
			method: "input",
			outcome: { state: "accepted", provenance: "host" },
		});
		expect(JSON.stringify(output.mock.calls)).not.toContain("never-echo-this");

		const unsupported = await requestRpcDialog(
			pendingRequests,
			output,
			undefined,
			false,
			{ method: "confirm", title: "Unsupported", message: "No renderer" },
			response => "confirmed" in response && response.confirmed,
		);
		expect(unsupported).toBe(false);
		expect(output).toHaveBeenCalledWith({
			type: "interaction_settled",
			id: expect.any(String),
			method: "confirm",
			outcome: {
				state: "unsupported",
				message: 'RPC host did not negotiate the "confirm" interaction',
			},
		});

		const disconnect = requestRpcDialog(
			pendingRequests,
			output,
			undefined,
			false,
			{ method: "input", title: "Disconnect" },
			response => "value" in response,
		);
		const disconnectedRequest = output.mock.calls.find(
			call =>
				"method" in call[0] && call[0].method === "input" && "title" in call[0] && call[0].title === "Disconnect",
		)?.[0];
		if (!disconnectedRequest || !("id" in disconnectedRequest) || typeof disconnectedRequest.id !== "string") {
			throw new Error("Expected a pending input interaction");
		}
		expect(pendingRequests.snapshot()).toEqual([
			expect.objectContaining({
				id: disconnectedRequest.id,
				method: "input",
				title: "Disconnect",
				sensitive: false,
			}),
		]);
		pendingRequests.rejectAll("RPC client disconnected");
		await expect(disconnect).rejects.toThrow("RPC client disconnected");
		expect(output).toHaveBeenCalledWith({
			type: "interaction_settled",
			id: disconnectedRequest.id,
			method: "input",
			outcome: { state: "disconnected", message: "RPC client disconnected" },
		});
	});

	it("times out with a remote cancellation and a typed terminal outcome", async () => {
		const output = vi.fn<(frame: object) => void>();
		const pendingRequests = new RpcPendingExtensionRequests();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ timeout: 1 },
			false,
			{ method: "confirm", title: "Timeout", message: "Wait?" },
			response => "confirmed" in response && response.confirmed,
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected a confirmation interaction request");
		}

		expect(await result).toBe(false);
		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: expect.any(String),
			method: "cancel",
			targetId: request.id,
		});
		expect(output).toHaveBeenCalledWith({
			type: "interaction_settled",
			id: request.id,
			method: "confirm",
			outcome: { state: "timed_out" },
		});
	});

	it("reports response parsing failures as typed failed outcomes", async () => {
		const output = vi.fn<(frame: object) => void>();
		const pendingRequests = new RpcPendingExtensionRequests();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			undefined,
			undefined,
			{ method: "input", title: "Strict input" },
			() => {
				throw new Error("invalid host response");
			},
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected an input interaction request");
		}
		pendingRequests.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			value: "invalid",
		});

		await expect(result).rejects.toThrow("invalid host response");
		expect(output).toHaveBeenCalledWith({
			type: "interaction_settled",
			id: request.id,
			method: "input",
			outcome: { state: "failed", message: "invalid host response" },
		});
	});

	it("preserves structured approval identity, policy, safety, and decision provenance", async () => {
		const output = vi.fn<(frame: object) => void>();
		const pendingRequests = new RpcPendingExtensionRequests();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			undefined,
			{ approved: false, provenance: "host" as const },
			{
				method: "approval",
				title: "Approve write",
				toolCallId: "tool-call-1",
				toolName: "write",
				operation: "write",
				approvalMode: "always-ask",
				resolvedPolicy: "prompt",
				policySource: "tool",
				declarationPolicy: "prompt",
				escalationReason: "writes a file",
				providerSafety: { required: true, checks: ["1. Confirm destination"] },
				choices: ["Approve", "Deny"],
				defaultChoice: "Deny",
			},
			response => ({
				approved: "decision" in response && response.decision === "approve",
				provenance: "provenance" in response ? (response.provenance ?? "host") : "host",
			}),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected a structured approval request");
		}
		expect(request).toMatchObject({
			type: "extension_ui_request",
			method: "approval",
			toolCallId: "tool-call-1",
			toolName: "write",
			operation: "write",
			policySource: "tool",
			declarationPolicy: "prompt",
			escalationReason: "writes a file",
			providerSafety: { required: true, checks: ["1. Confirm destination"] },
			choices: ["Approve", "Deny"],
			defaultChoice: "Deny",
		});
		expect(pendingRequests.snapshot()).toEqual([
			expect.objectContaining({
				id: request.id,
				method: "approval",
				toolCallId: "tool-call-1",
				toolName: "write",
			}),
		]);

		pendingRequests.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			decision: "approve",
			provenance: "user",
		});

		expect(await result).toEqual({ approved: true, provenance: "user" });
		expect(output).toHaveBeenCalledWith({
			type: "interaction_settled",
			id: request.id,
			method: "approval",
			outcome: { state: "accepted", provenance: "user", decision: "approve" },
		});
	});

	it("negotiates ask and passive progress independently", async () => {
		const output = vi.fn<(frame: object) => void>();
		const pendingRequests = new RpcPendingExtensionRequests();
		pendingRequests.configureHostCapabilities(["ask", "progress"]);
		const questions = [
			{
				id: "scope",
				question: "Which scope?",
				options: [{ label: "Focused" }, { label: "Broad" }],
				multi: false,
			},
		];
		const result = requestRpcDialog(
			pendingRequests,
			output,
			undefined,
			undefined,
			{ method: "ask", questions },
			response => ("result" in response ? response.result : undefined),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected an ask interaction request");
		}
		expect(request).toMatchObject({
			type: "extension_ui_request",
			method: "ask",
			questions,
		});
		pendingRequests.get(request.id)?.resolve({
			type: "extension_ui_response",
			id: request.id,
			result: { kind: "chat" },
		});
		await expect(result).resolves.toEqual({ kind: "chat" });

		expect(
			emitRpcPassiveInteraction(pendingRequests, output, "progress", {
				type: "extension_ui_request",
				id: "progress-1",
				method: "progress",
				message: "Working",
			}),
		).toBe(true);
		expect(
			emitRpcPassiveInteraction(pendingRequests, output, "notification", {
				type: "extension_ui_request",
				id: "notification-1",
				method: "notify",
				message: "Hidden",
			}),
		).toBe(false);
		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: "progress-1",
			method: "progress",
			message: "Working",
		});
		expect(output).not.toHaveBeenCalledWith(expect.objectContaining({ id: "notification-1" }));
	});
});
