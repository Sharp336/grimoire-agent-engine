import { describe, expect, it } from "bun:test";
import type { AutocompleteProvider, SlashCommand } from "@oh-my-pi/pi-tui";
import type { ExtensionUiComponent } from "../src/extensibility/extensions";
import { RpcInteractiveSurfaceError, RpcInteractiveSurfaceManager } from "../src/modes/rpc/rpc-interactive-surface";
import type { RpcSessionAuthorityToken } from "../src/modes/rpc/rpc-session-authority";
import type { RpcUiFrame } from "../src/modes/rpc/rpc-types";
import { RPC_UI_ACTION_ROUTES } from "../src/modes/rpc/rpc-ui-actions";

function createManager() {
	const frames: RpcUiFrame[] = [];
	let sessionName = "Parity session";
	let authority: RpcSessionAuthorityToken = {
		sessionId: "session-a",
		sessionGeneration: 0,
		authorityGeneration: 0,
	};
	const manager = new RpcInteractiveSurfaceManager({
		output: frame => frames.push(frame),
		getAuthority: () => authority,
		getSessionName: () => sessionName,
		getCwd: () => "/tmp/parity",
	});
	return {
		manager,
		frames,
		setAuthority(next: RpcSessionAuthorityToken) {
			authority = next;
		},
		setSessionName(next: string) {
			sessionName = next;
		},
	};
}

function channelOf(manager: RpcInteractiveSurfaceManager) {
	const snapshot = manager.open("terminal-1", { width: 40 });
	return {
		snapshot,
		channel: {
			channelId: snapshot.fence.channelId,
			generation: snapshot.fence.generation,
		},
	};
}

describe("RpcInteractiveSurfaceManager", () => {
	it("orders raw input transforms and removes exactly the unsubscribed handler", () => {
		const { manager } = createManager();
		const { channel } = channelOf(manager);
		const seen: string[] = [];
		const removeFirst = manager.onTerminalInput(data => {
			seen.push(`first:${data}`);
			return { data: data.toUpperCase() };
		});
		manager.onTerminalInput(data => {
			seen.push(`second:${data}`);
			return { data: `${data}!`, consume: true };
		});

		expect(manager.input(channel.channelId, channel.generation, "abc")).toEqual({ consumed: true, data: "ABC!" });
		expect(seen).toEqual(["first:abc", "second:ABC"]);
		removeFirst();
		expect(manager.input(channel.channelId, channel.generation, "next")).toEqual({
			consumed: true,
			data: "next!",
		});
	});

	it("mirrors editor revisions and returns authoritative conflict recovery data", () => {
		const { manager } = createManager();
		const { channel, snapshot } = channelOf(manager);
		const updated = manager.updateEditor(channel.channelId, channel.generation, snapshot.editor.revision, "draft");
		expect(updated).toEqual({ text: "draft", revision: 1 });
		expect(manager.getEditorText()).toBe("draft");

		try {
			manager.updateEditor(channel.channelId, channel.generation, 0, "stale");
			expect.unreachable();
		} catch (cause) {
			expect(cause).toBeInstanceOf(RpcInteractiveSurfaceError);
			expect((cause as RpcInteractiveSurfaceError).code).toBe("editor_conflict");
			expect((cause as RpcInteractiveSurfaceError).data).toEqual({ editor: updated });
		}
	});

	it("uses native autocomplete, opaque application ids, and semantic clipboard actions", async () => {
		const { manager } = createManager();
		const { channel } = channelOf(manager);
		manager.configureAutocomplete([{ name: "help", description: "Show help" } satisfies SlashCommand], "/tmp/parity");
		const slash = await manager.suggest("suggest-1", channel.channelId, channel.generation, ["/he"], 0, 3);
		expect(slash?.items[0]).toMatchObject({ value: "help", label: "help" });
		manager.setEditorText("copy this #copy");
		const actions = await manager.suggest(
			"suggest-2",
			channel.channelId,
			channel.generation,
			["copy this #copy"],
			0,
			15,
		);
		const copy = actions?.items.find(item => item.label === "Copy whole prompt");
		expect(copy).toBeDefined();
		const copyResult = manager.applySuggestion(channel.channelId, channel.generation, copy?.id ?? "");
		expect(copyResult.clientAction).toEqual({ type: "clipboard_write", text: "copy this " });
		const stale = await manager.suggest("suggest-3", channel.channelId, channel.generation, ["/he"], 0, 3);
		manager.setEditorText("newer authoritative editor");
		try {
			manager.applySuggestion(channel.channelId, channel.generation, stale?.items[0]?.id ?? "");
			expect.unreachable();
		} catch (cause) {
			expect(cause).toMatchObject({
				code: "editor_conflict",
				data: { editor: { text: "newer authoritative editor", revision: expect.any(Number) } },
			});
		}
	});

	it("projects extension components as bounded semantic rows and drives custom input", async () => {
		const { manager, frames } = createManager();
		const { channel } = channelOf(manager);
		manager.setWidget("status", ["\u001b[31mred\u001b[0m", "tab\tvalue"], { placement: "aboveEditor" });
		manager.setHeader(() => ({ render: () => ["header"] }));
		const pending = manager.custom<string>((_tui, _theme, _keybindings, done) => ({
			render: () => ["choose"],
			handleInput: data => {
				if (data === "enter") done("selected");
			},
		}));
		await Promise.resolve();
		const custom = manager.snapshot().presentations.find(item => item.kind === "custom");
		expect(manager.snapshot().presentations.find(item => item.key === "status")).toMatchObject({
			rows: ["red", "tab   value"],
			placement: "aboveEditor",
		});
		expect(custom?.actions).toEqual([
			{ id: "input", kind: "input" },
			{ id: "cancel", kind: "cancel" },
		]);
		const result = manager.presentationInput(channel.channelId, channel.generation, custom?.id ?? "", "enter");
		expect(result).toEqual({ completed: true, presentation: null });
		expect(await pending).toBe("selected");
		const removalIndex = frames.findIndex(
			frame => frame.type === "ui_presentation_remove" && frame.presentationId === custom?.id,
		);
		expect(removalIndex).toBeGreaterThanOrEqual(0);
		expect(
			frames
				.slice(removalIndex + 1)
				.some(frame => frame.type === "ui_presentation_update" && frame.presentation.id === custom?.id),
		).toBeFalse();
	});

	it("exposes themes, titles, expansion state, and an exhaustive semantic action inventory", async () => {
		const { manager, frames, setSessionName } = createManager();
		const { channel, snapshot } = channelOf(manager);
		expect(snapshot.title.value).toContain("Parity session");
		expect(snapshot.actions.map(action => action.id).sort()).toEqual(Object.keys(RPC_UI_ACTION_ROUTES).sort());
		const themes = await manager.listThemes(channel.channelId, channel.generation);
		expect(themes.length).toBeGreaterThan(0);
		const currentThemeName = themes.find(candidate => candidate.current)?.name;
		try {
			await manager.setThemeName(channel.channelId, channel.generation, "__missing_rpc_ui_theme__");
			expect.unreachable();
		} catch (cause) {
			expect(cause).toMatchObject({ code: "theme_invalid" });
		}
		expect(
			(await manager.listThemes(channel.channelId, channel.generation)).find(candidate => candidate.current)?.name,
		).toBe(currentThemeName);
		setSessionName("Renamed parity session");
		manager.sessionNameChanged();
		expect(frames).toContainEqual(
			expect.objectContaining({ type: "ui_title_update", title: expect.stringContaining("Renamed parity session") }),
		);
		manager.setToolsExpandedFromClient(channel.channelId, channel.generation, true);
		manager.setTitleSubscription(channel.channelId, channel.generation, false);
		manager.setTitle("hidden title");
		expect(frames.some(frame => frame.type === "ui_tools_expanded_update" && frame.expanded)).toBeTrue();
		expect(frames.some(frame => frame.type === "ui_title_update" && frame.title === "hidden title")).toBeFalse();
		const staleThemes = manager.listThemes(channel.channelId, channel.generation);
		manager.close(channel.channelId, channel.generation);
		const staleThemeSettlement = staleThemes.then(
			() => expect.unreachable(),
			cause => expect(cause).toMatchObject({ code: "ui_channel_required" }),
		);
		await staleThemeSettlement;
	});

	it("settles replaced and authority-invalidated channels and rejects stale generations", () => {
		const { manager, frames, setAuthority } = createManager();
		const first = channelOf(manager).channel;
		const second = manager.open("terminal-2").fence;
		expect(frames).toContainEqual({
			type: "ui_channel_settled",
			channelId: first.channelId,
			generation: first.generation,
			reason: "replaced",
		});
		expect(() => manager.input(first.channelId, first.generation, "stale")).toThrow("stale");

		const nextAuthority = { sessionId: "session-a", sessionGeneration: 0, authorityGeneration: 1 };

		setAuthority(nextAuthority);
		manager.rebindAuthority(nextAuthority, false);
		expect(frames).toContainEqual({
			type: "ui_channel_settled",
			channelId: second.channelId,
			generation: second.generation,
			reason: "authority_changed",
		});
	});
	it("settles hanging autocomplete and blocking presentations at every channel boundary", async () => {
		const { manager } = createManager();
		const { channel } = channelOf(manager);
		const suggestions = Promise.withResolvers<{ items: []; prefix: string } | null>();
		manager.setAutocompleteProvider({
			getSuggestions: () => suggestions.promise,
			applyCompletion: lines => ({ lines, cursorLine: 0, cursorCol: 0 }),
		} satisfies AutocompleteProvider);
		const pendingSuggestion = manager.suggest("hanging", channel.channelId, channel.generation, [""], 0, 0);
		const component = Promise.withResolvers<ExtensionUiComponent>();
		let lateComponentDisposed = false;
		const pendingCustom = manager.custom(() => component.promise);
		const suggestionSettlement = pendingSuggestion.then(
			() => expect.unreachable(),
			cause => expect(cause).toMatchObject({ code: "replaced" }),
		);
		const customSettlement = pendingCustom.then(
			() => expect.unreachable(),
			cause => expect(cause).toMatchObject({ code: "replaced" }),
		);
		manager.open("replacement");
		await Promise.all([suggestionSettlement, customSettlement]);
		component.resolve({
			render: () => ["late"],
			dispose: () => {
				lateComponentDisposed = true;
			},
		});
		await Promise.resolve();
		expect(lateComponentDisposed).toBeTrue();

		const scenarios: Array<{
			reason: string;
			settle: (
				target: RpcInteractiveSurfaceManager,
				active: { channelId: string; generation: number },
				setAuthority: (next: RpcSessionAuthorityToken) => void,
			) => void;
		}> = [
			{ reason: "closed", settle: (target, active) => target.close(active.channelId, active.generation) },
			{ reason: "client_disconnected", settle: target => target.disconnect("client_disconnected") },
			{ reason: "shutdown", settle: target => target.disconnect("shutdown") },
			{
				reason: "authority_changed",
				settle: (target, _active, setAuthority) => {
					const authority = { sessionId: "session-a", sessionGeneration: 0, authorityGeneration: 1 };
					setAuthority(authority);
					target.rebindAuthority(authority, false);
				},
			},
			{
				reason: "session_changed",
				settle: (target, _active, setAuthority) => {
					const authority = { sessionId: "session-b", sessionGeneration: 1, authorityGeneration: 1 };
					setAuthority(authority);
					target.rebindAuthority(authority, true);
				},
			},
		];
		for (const scenario of scenarios) {
			const created = createManager();
			const active = channelOf(created.manager).channel;
			const blocking = created.manager.custom(() => ({ render: () => ["blocking"] }));
			const settlement = blocking.then(
				() => expect.unreachable(),
				cause => expect(cause).toMatchObject({ code: scenario.reason }),
			);
			scenario.settle(created.manager, active, created.setAuthority);
			await settlement;
		}
	});
});
