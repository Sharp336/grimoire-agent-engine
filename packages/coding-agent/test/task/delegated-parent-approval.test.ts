import { describe, expect, it, vi } from "bun:test";
import type { ClientBridge, ClientBridgePermissionOutcome } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import {
	createDelegatedParentApprovalClientBridge,
	MISSION_PARENT_APPROVAL_TIMEOUT_MS,
} from "@oh-my-pi/pi-coding-agent/task/executor";

const TOOL_CALL = { toolCallId: "call-1", toolName: "write", title: "Write file" };
const OPTIONS = [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }];

function requireRequestPermission(bridge: ClientBridge): NonNullable<ClientBridge["requestPermission"]> {
	if (!bridge.requestPermission) throw new Error("delegated bridge dropped requestPermission");
	return bridge.requestPermission;
}

describe("delegated parent approval client bridge", () => {
	it("pins the mission approval timeout policy shared with the delegated UI path", () => {
		expect(MISSION_PARENT_APPROVAL_TIMEOUT_MS).toBe(300_000);
	});

	it("fails closed when the client never answers a mission permission prompt", async () => {
		vi.useFakeTimers();
		try {
			const parent: ClientBridge = {
				capabilities: { requestPermission: true },
				requestPermission: () => Promise.withResolvers<ClientBridgePermissionOutcome>().promise,
			};
			const requestPermission = requireRequestPermission(createDelegatedParentApprovalClientBridge(parent));
			let settled = false;
			const pending = requestPermission(TOOL_CALL, OPTIONS).then(outcome => {
				settled = true;
				return outcome;
			});

			vi.advanceTimersByTime(MISSION_PARENT_APPROVAL_TIMEOUT_MS - 1);
			await Promise.resolve();
			expect(settled).toBe(false);

			vi.advanceTimersByTime(1);
			await expect(pending).resolves.toEqual({ outcome: "cancelled" });
			expect(settled).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("forwards a settled client outcome without rewriting it", async () => {
		const selected: ClientBridgePermissionOutcome = { outcome: "selected", optionId: "allow", kind: "allow_once" };
		const parent: ClientBridge = {
			capabilities: { requestPermission: true },
			requestPermission: async () => selected,
		};
		const requestPermission = requireRequestPermission(createDelegatedParentApprovalClientBridge(parent));
		await expect(requestPermission(TOOL_CALL, OPTIONS)).resolves.toBe(selected);
	});

	it("short-circuits a pre-aborted request without consulting the client", async () => {
		const parent = {
			capabilities: { requestPermission: true },
			requestPermission: vi.fn(() => Promise.withResolvers<ClientBridgePermissionOutcome>().promise),
		} satisfies ClientBridge;
		const requestPermission = requireRequestPermission(createDelegatedParentApprovalClientBridge(parent));
		await expect(requestPermission(TOOL_CALL, OPTIONS, AbortSignal.abort())).resolves.toEqual({
			outcome: "cancelled",
		});
		expect(parent.requestPermission).not.toHaveBeenCalled();
	});

	it("returns the parent unchanged when it cannot mediate permissions", () => {
		const parent: ClientBridge = { capabilities: {} };
		expect(createDelegatedParentApprovalClientBridge(parent)).toBe(parent);
	});
});
