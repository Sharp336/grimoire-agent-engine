import { describe, expect, it, vi } from "bun:test";
import {
	emitRpcWidgetRequest,
	type PendingExtensionRequest,
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
		expect(pendingRequests.size).toBe(0);
	});

	it("forwards right-sidebar placement and geometry for passive widget frames", () => {
		const output = vi.fn<(frame: object) => void>();

		emitRpcWidgetRequest(output, "quota", ["5 hour 42%"], {
			placement: "rightSidebar",
			width: 44,
			minWidth: 28,
			minMainWidth: 64,
		});

		expect(output).toHaveBeenCalledWith({
			type: "extension_ui_request",
			id: expect.any(String),
			method: "setWidget",
			widgetKey: "quota",
			widgetLines: ["5 hour 42%"],
			widgetPlacement: "rightSidebar",
			widgetWidth: 44,
			widgetMinWidth: 28,
			widgetMinMainWidth: 64,
		});
	});

	it("keeps supported legacy widget placements unchanged", () => {
		const output = vi.fn<(frame: object) => void>();

		emitRpcWidgetRequest(output, "above", ["context"], { placement: "aboveEditor" });
		emitRpcWidgetRequest(output, "below", ["status"], { placement: "belowEditor" });

		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "setWidget",
			widgetKey: "above",
			widgetLines: ["context"],
			widgetPlacement: "aboveEditor",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_request",
			id: expect.any(String),
			method: "setWidget",
			widgetKey: "below",
			widgetLines: ["status"],
			widgetPlacement: "belowEditor",
		});
	});

	it("ignores component widget factories in RPC mode", () => {
		const output = vi.fn<(frame: object) => void>();
		const componentFactory = (() => ({ render: () => [] })) as never;

		expect(() =>
			emitRpcWidgetRequest(output, "quota", componentFactory, { placement: "rightSidebar" }),
		).not.toThrow();
		expect(output).not.toHaveBeenCalled();
	});
});
