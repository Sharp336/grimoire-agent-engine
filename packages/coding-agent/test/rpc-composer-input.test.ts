import { describe, expect, it } from "bun:test";
import { RpcInteractiveSurfaceError, RpcInteractiveSurfaceManager } from "../src/modes/rpc/rpc-interactive-surface";
import type { RpcSessionAuthorityToken } from "../src/modes/rpc/rpc-session-authority";

function openSurface() {
	const authority: RpcSessionAuthorityToken = {
		sessionId: "composer-session",
		sessionGeneration: 0,
		authorityGeneration: 0,
	};
	const manager = new RpcInteractiveSurfaceManager({
		output: () => {},
		getAuthority: () => authority,
		getSessionName: () => "Composer session",
		getCwd: () => "/tmp/composer",
	});
	const opened = manager.open("terminal-composer");
	return { manager, fence: opened.fence, revision: opened.editor.revision };
}

describe("RPC composer input contract", () => {
	it("fences submit on the authoritative editor revision and clears only after acceptance", () => {
		const { manager, fence, revision } = openSurface();
		const updated = manager.updateEditor(fence.channelId, fence.generation, revision, "keep this draft");

		expect(manager.prepareEditorSubmit(fence.channelId, fence.generation, updated.revision)).toEqual(updated);
		expect(manager.getAuthoritativeEditor()).toEqual(updated);

		manager.clearSubmittedEditor();
		expect(manager.getAuthoritativeEditor()).toEqual({ text: "", revision: updated.revision + 1 });
	});

	it("returns the authoritative draft when a stale submit fence is rejected", () => {
		const { manager, fence, revision } = openSurface();
		const updated = manager.updateEditor(fence.channelId, fence.generation, revision, "authoritative draft");

		expect(() => manager.prepareEditorSubmit(fence.channelId, fence.generation, revision)).toThrow(
			RpcInteractiveSurfaceError,
		);
		try {
			manager.prepareEditorSubmit(fence.channelId, fence.generation, revision);
			expect.unreachable();
		} catch (error) {
			expect(error).toMatchObject({
			code: "editor_conflict",
			data: { editor: updated },
		});
		}
	});
});
