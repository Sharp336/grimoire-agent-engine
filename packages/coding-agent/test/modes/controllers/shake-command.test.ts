import { describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ShakeMode, ShakeResult } from "@oh-my-pi/pi-coding-agent/session/shake-types";

function createShakeContext(shake: (mode: ShakeMode) => Promise<ShakeResult>) {
	const shakeMock = vi.fn(shake);
	const rebuildChatFromMessages = vi.fn();
	const invalidate = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const ctx = {
		session: { shake: shakeMock },
		rebuildChatFromMessages,
		statusLine: { invalidate },
		ui: { requestRender },
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;
	return { ctx, shake: shakeMock, rebuildChatFromMessages, showStatus, showError };
}

function elideResult(): ShakeResult {
	return { mode: "elide", toolResultsDropped: 2, blocksDropped: 1, tokensFreed: 500 };
}

describe("handleShakeCommand (combined modes)", () => {
	it("runs modes in order, rebuilds once, and reports one merged summary", async () => {
		const h = createShakeContext(async mode =>
			mode === "elide"
				? elideResult()
				: { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: 3, tokensFreed: 0 },
		);
		await new CommandController(h.ctx).handleShakeCommand(["elide", "images"]);

		expect(h.shake.mock.calls.map(c => c[0])).toEqual(["elide", "images"]);
		expect(h.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(h.showStatus).toHaveBeenCalledWith("Shook 2 tool results + 1 block + 3 images (~500 tokens freed).");
		expect(h.showError).not.toHaveBeenCalled();
	});

	it("rebuilds the chat before surfacing a mid-sequence failure when an earlier mode already mutated the session", async () => {
		const h = createShakeContext(async mode => {
			if (mode === "elide") return elideResult();
			throw new Error("persistence rewrite failed");
		});
		await new CommandController(h.ctx).handleShakeCommand(["elide", "images"]);

		expect(h.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(h.showError).toHaveBeenCalledWith("Shake failed: persistence rewrite failed");
		expect(h.showStatus).not.toHaveBeenCalled();
	});

	it("skips the rebuild when the failing mode was the first to run", async () => {
		const h = createShakeContext(async () => {
			throw new Error("boom");
		});
		await new CommandController(h.ctx).handleShakeCommand(["elide", "images"]);

		expect(h.shake).toHaveBeenCalledTimes(1);
		expect(h.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(h.showError).toHaveBeenCalledWith("Shake failed: boom");
	});

	it("reports nothing to shake without rebuilding when no mode dropped content", async () => {
		const h = createShakeContext(async mode => ({
			mode,
			toolResultsDropped: 0,
			blocksDropped: 0,
			imagesDropped: mode === "images" ? 0 : undefined,
			tokensFreed: 0,
		}));
		await new CommandController(h.ctx).handleShakeCommand(["elide", "images"]);

		expect(h.rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(h.showStatus).toHaveBeenCalledWith("Nothing to shake.");
	});
});
