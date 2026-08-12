import { describe, expect, it, vi } from "bun:test";
import {
	type PendingExtensionRequest,
	requestRpcDialog,
	requestRpcSelect,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

describe("RPC extension UI", () => {
	it("carries optional selector help text to the RPC client", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(
			pendingRequests,
			output,
			"How would you like me to continue?",
			["Research first", "Proceed directly"],
			{ helpText: "Turn off Plan-First Suggestions in /settings → Tasks → Modes." },
		);
		const request = output.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
		if (!request || typeof request.id !== "string") {
			throw new Error("Expected the RPC select request to carry an id");
		}

		expect(request).toEqual({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "How would you like me to continue?",
			options: ["Research first", "Proceed directly"],
			helpText: "Turn off Plan-First Suggestions in /settings → Tasks → Modes.",
		});

		const pending = pendingRequests.get(request.id);
		if (!pending) throw new Error("Expected a pending RPC select request");
		pending.resolve({
			type: "extension_ui_response",
			id: request.id,
			value: "Research first",
		});
		expect(await result).toBe("Research first");
	});

	it("keeps selector RPC requests unchanged when help text is absent", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const result = requestRpcSelect(pendingRequests, output, "Continue?", ["Yes", "No"]);
		const request = output.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
		if (!request || typeof request.id !== "string") {
			throw new Error("Expected the RPC select request to carry an id");
		}

		expect(request).toEqual({
			type: "extension_ui_request",
			id: request.id,
			method: "select",
			title: "Continue?",
			options: ["Yes", "No"],
		});

		const pending = pendingRequests.get(request.id);
		if (!pending) throw new Error("Expected a pending RPC select request");
		pending.resolve({
			type: "extension_ui_response",
			id: request.id,
			value: "Yes",
		});
		expect(await result).toBe("Yes");
	});

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
		expect(pendingRequests.size).toBe(0);
	});
});
