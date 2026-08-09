import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorTheme,
	SlashCommand,
	Terminal,
	TerminalAppearance,
} from "@oh-my-pi/pi-tui";
import { replaceTabs, TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { KeybindingsManager } from "../../config/keybindings";
import type {
	AutocompleteProviderFactory,
	ExtensionUiComponent,
	ExtensionUiComponentFactory,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	TerminalInputHandler,
} from "../../extensibility/extensions";
import { formatSessionTerminalTitle } from "../../utils/title-generator";
import type { CustomEditor } from "../components/custom-editor";
import { createPromptActionAutocompleteProvider } from "../prompt-action-autocomplete";
import {
	getAvailableThemesWithPaths,
	getCurrentThemeName,
	getEditorTheme,
	getThemeByName,
	setTheme,
	type Theme,
	theme,
} from "../theme/theme";
import type { RpcSessionAuthorityToken } from "./rpc-session-authority";
import type {
	RpcUiAutocompleteApplyResult,
	RpcUiAutocompleteResult,
	RpcUiChannelSettlementReason,
	RpcUiEditorState,
	RpcUiFence,
	RpcUiFrame,
	RpcUiInputResult,
	RpcUiPresentation,
	RpcUiPresentationInputResult,
	RpcUiPresentationKind,
	RpcUiSnapshot,
	RpcUiSubscriptions,
	RpcUiThemeInfo,
} from "./rpc-types";
import { projectRpcUiActionRoutes } from "./rpc-ui-actions";

const DEFAULT_WIDTH = 100;
const MIN_WIDTH = 20;
const MAX_WIDTH = 240;
const MAX_PRESENTATION_ROWS = 200;
const DEFAULT_SUBSCRIPTIONS: RpcUiSubscriptions = {
	editor: true,
	presentation: true,
	theme: true,
	title: true,
	toolsExpanded: true,
};

interface RpcInteractiveSurfaceOptions {
	output: (frame: RpcUiFrame) => void;
	getAuthority: () => RpcSessionAuthorityToken;
	getSessionName: () => string | undefined;
	getCwd: () => string;
}

interface ActiveChannel {
	id: string;
	terminalId: string;
	generation: number;
	sessionId: string;
	authorityGeneration: number;
	width: number;
	subscriptions: RpcUiSubscriptions;
}

interface PresentationRecord {
	id: string;
	kind: RpcUiPresentationKind;
	key?: string;
	placement?: RpcUiPresentation["placement"];
	component: ExtensionUiComponent;
	revision: number;
	focused: boolean;
	cancel?: (cause: Error) => void;
}

interface PendingCustomPresentation {
	reject: (cause: Error) => void;
}

interface AutocompleteSelection {
	generation: number;
	editorRevision: number;
	provider: AutocompleteProvider;
	item: AutocompleteItem;
	prefix: string;
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface AutocompleteApplyContext {
	lines: string[];
	cursor: { line: number; column: number };
	clientAction?: RpcUiAutocompleteApplyResult["clientAction"];
}

class RpcSemanticTerminal implements Terminal {
	#columns = DEFAULT_WIDTH;

	set columns(value: number) {
		this.#columns = value;
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return MAX_PRESENTATION_ROWS;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	get kittyEnableSequence(): string | null {
		return null;
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
}

export class RpcInteractiveSurfaceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly data?: object,
	) {
		super(message);
		this.name = "RpcInteractiveSurfaceError";
	}
}

/**
 * Transport-neutral interactive UI state for rpc-ui.
 *
 * Extensions continue to execute official OMP factories and providers in the
 * server process. The transport exposes only revisioned semantic rows, editor
 * state, and opaque input/action handles.
 */
export class RpcInteractiveSurfaceManager {
	readonly #options: RpcInteractiveSurfaceOptions;
	readonly #terminal = new RpcSemanticTerminal();
	readonly #tui = new TUI(this.#terminal);
	readonly #keybindings = KeybindingsManager.inMemory();
	readonly #terminalInputHandlers: TerminalInputHandler[] = [];
	readonly #presentations = new Map<string, PresentationRecord>();
	readonly #pendingCustomPresentations = new Map<string, PendingCustomPresentation>();
	readonly #autocompleteFactories: AutocompleteProviderFactory[] = [];
	readonly #autocompleteOperations = new Map<string, AbortController>();
	readonly #autocompleteSelections = new Map<string, AutocompleteSelection>();
	readonly #editorHistory: RpcUiEditorState[] = [];
	#active: ActiveChannel | undefined;
	#generation = 0;
	#editor: RpcUiEditorState = { text: "", revision: 0 };
	#toolsExpanded = false;
	#toolsExpandedRevision = 0;
	#themeRevision = 0;
	#titleRevision = 0;
	#titleOverride: string | undefined;
	#baseAutocompleteProvider: AutocompleteProvider | undefined;
	#autocompleteProvider: AutocompleteProvider | undefined;
	#customEditor: CustomEditor | undefined;
	#autocompleteApplyContext: AutocompleteApplyContext | undefined;

	constructor(options: RpcInteractiveSurfaceOptions) {
		this.#options = options;
		this.#tui.requestRender = () => this.#renderAllPresentations();
	}

	get active(): boolean {
		return this.#active !== undefined;
	}

	open(
		terminalId: string,
		options: { width?: number; subscriptions?: Partial<RpcUiSubscriptions> } = {},
	): RpcUiSnapshot {
		if (this.#active) this.#settleChannel("replaced");
		this.#generation += 1;
		const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.trunc(options.width ?? DEFAULT_WIDTH)));
		this.#terminal.columns = width;
		const authority = this.#options.getAuthority();
		this.#active = {
			id: Snowflake.next() as string,
			terminalId,
			generation: this.#generation,
			sessionId: authority.sessionId,
			authorityGeneration: authority.authorityGeneration,
			width,
			subscriptions: { ...DEFAULT_SUBSCRIPTIONS, ...options.subscriptions },
		};
		this.#autocompleteSelections.clear();
		return this.snapshot();
	}

	close(channelId: string, generation: number): void {
		this.#assertChannel(channelId, generation);
		this.#settleChannel("closed");
	}

	disconnect(reason: "client_disconnected" | "shutdown"): void {
		this.#settleChannel(reason);
		this.#disposePresentations(
			new RpcInteractiveSurfaceError(reason, `Interactive UI ${reason.replaceAll("_", " ")}`),
		);
		this.#terminalInputHandlers.length = 0;
	}

	rebindAuthority(authority: RpcSessionAuthorityToken, sessionChanged: boolean): void {
		const reason = sessionChanged ? "session_changed" : "authority_changed";
		this.#settleChannel(reason);
		this.#generation += 1;
		this.#autocompleteSelections.clear();
		for (const controller of this.#autocompleteOperations.values()) controller.abort(reason);
		this.#autocompleteOperations.clear();
		if (!sessionChanged) return;
		this.#disposePresentations(new RpcInteractiveSurfaceError("session_changed", "Interactive UI session changed"));
		this.#terminalInputHandlers.length = 0;
		this.#customEditor = undefined;
		this.#editorHistory.length = 0;
		this.#editor = { text: "", revision: this.#editor.revision + 1 };
		this.#toolsExpanded = false;
		this.#toolsExpandedRevision += 1;
		this.#titleOverride = undefined;
		this.#titleRevision += 1;
		void authority;
	}

	snapshot(): RpcUiSnapshot {
		const active = this.#requireActive();
		return {
			fence: this.#fence(active),
			terminalId: active.terminalId,
			subscriptions: { ...active.subscriptions },
			editor: { ...this.#editor },
			presentations: Array.from(this.#presentations.values(), record => this.#projectPresentation(record)),
			theme: { name: getCurrentThemeName(), revision: this.#themeRevision },
			title: { value: this.#currentTitle(), revision: this.#titleRevision },
			toolsExpanded: { value: this.#toolsExpanded, revision: this.#toolsExpandedRevision },
			terminalInputHandlers: this.#terminalInputHandlers.length,
			actions: projectRpcUiActionRoutes(),
		};
	}

	onTerminalInput(handler: TerminalInputHandler): () => void {
		this.#terminalInputHandlers.push(handler);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			const index = this.#terminalInputHandlers.indexOf(handler);
			if (index >= 0) this.#terminalInputHandlers.splice(index, 1);
		};
	}

	input(channelId: string, generation: number, data: string): RpcUiInputResult {
		this.#assertChannel(channelId, generation);
		let current = data;
		for (const handler of [...this.#terminalInputHandlers]) {
			const result = handler(current);
			if (result?.data !== undefined) current = result.data;
			if (result?.consume) return { consumed: true, data: current };
		}
		return { consumed: false, data: current };
	}

	getEditorText(): string {
		return this.#editor.text;
	}

	setEditorText(text: string, source: "extension" | "component" | "session" = "extension"): RpcUiEditorState {
		if (text === this.#editor.text) return { ...this.#editor };
		this.#rememberEditor();
		this.#customEditor?.setText(text);
		this.#editor = { text, revision: this.#editor.revision + 1 };
		this.#emitEditor(source);
		return { ...this.#editor };
	}

	pasteFromExtension(text: string): RpcUiEditorState {
		if (!this.#customEditor) return this.setEditorText(text);
		this.#customEditor.handleInput(`\u001b[200~${text}\u001b[201~`);
		return this.setEditorText(this.#customEditor.getText(), "component");
	}

	updateEditor(channelId: string, generation: number, expectedRevision: number, text: string): RpcUiEditorState {
		this.#assertChannel(channelId, generation);
		this.#assertEditorRevision(expectedRevision);
		return this.#commitClientEditor(text);
	}

	pasteEditor(channelId: string, generation: number, expectedRevision: number, text: string): RpcUiEditorState {
		this.#assertChannel(channelId, generation);
		this.#assertEditorRevision(expectedRevision);
		if (!this.#customEditor) return this.#commitClientEditor(text);
		this.#customEditor.handleInput(`\u001b[200~${text}\u001b[201~`);
		return this.setEditorText(this.#customEditor.getText(), "component");
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#baseAutocompleteProvider = provider;
		this.#applyAutocompleteFactories();
	}

	configureAutocomplete(commands: SlashCommand[], basePath: string): void {
		this.setAutocompleteProvider(
			createPromptActionAutocompleteProvider({
				commands,
				basePath,
				keybindings: this.#keybindings,
				copyCurrentLine: () => this.#copyAutocompleteLine(),
				copyPrompt: () => this.#copyAutocompletePrompt(),
				undo: prefix => this.#undoAutocomplete(prefix),
				moveCursorToMessageEnd: () => this.#moveAutocompleteCursorToMessageEnd(),
				moveCursorToMessageStart: () => this.#moveAutocompleteCursorToMessageStart(),
				moveCursorToLineStart: () => this.#moveAutocompleteCursorToLineStart(),
				moveCursorToLineEnd: () => this.#moveAutocompleteCursorToLineEnd(),
			}),
		);
	}

	addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
		this.#autocompleteFactories.push(factory);
		this.#applyAutocompleteFactories();
	}

	async suggest(
		operationId: string,
		channelId: string,
		generation: number,
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		forceFile = false,
	): Promise<RpcUiAutocompleteResult | null> {
		this.#assertChannel(channelId, generation);
		const line = lines[cursorLine];
		if (line === undefined || cursorCol > line.length) {
			throw new RpcInteractiveSurfaceError(
				"invalid_request",
				"Autocomplete cursor is outside the supplied editor content",
			);
		}
		const provider = this.#autocompleteProvider;
		if (!provider) throw new RpcInteractiveSurfaceError("autocomplete_unavailable", "Autocomplete is unavailable");
		const editorRevision = this.#editor.revision;
		const controller = new AbortController();
		const cancelled = Promise.withResolvers<never>();
		const onAbort = (): void => {
			const reason = controller.signal.reason;
			const code = typeof reason === "string" ? reason : "cancelled";
			cancelled.reject(new RpcInteractiveSurfaceError(code, `Autocomplete request ${code.replaceAll("_", " ")}`));
		};
		controller.signal.addEventListener("abort", onAbort, { once: true });
		this.#autocompleteOperations.set(operationId, controller);
		try {
			const suggestions = forceFile
				? provider.getForceFileSuggestions?.(lines, cursorLine, cursorCol)
				: provider.getSuggestions(lines, cursorLine, cursorCol);
			const result = await Promise.race([suggestions, cancelled.promise]);
			this.#assertChannel(channelId, generation);
			this.#assertEditorRevision(editorRevision);
			this.#autocompleteSelections.clear();
			if (!result) return null;
			const selectionLines = [...lines];
			const items = result.items.map(item => {
				const id = Snowflake.next() as string;
				this.#autocompleteSelections.set(id, {
					generation,
					editorRevision,
					provider,
					item,
					prefix: result.prefix,
					lines: selectionLines,
					cursorLine,
					cursorCol,
				});
				return {
					id,
					value: item.value,
					label: item.label,
					...(item.description === undefined ? {} : { description: item.description }),
					...(item.hint === undefined ? {} : { hint: item.hint }),
				};
			});
			const startColumn = Math.max(0, cursorCol - result.prefix.length);
			const inlineHint = provider.getInlineHint?.(lines, cursorLine, cursorCol) ?? undefined;
			return {
				operationId,
				items,
				prefix: result.prefix,
				...(inlineHint === undefined ? {} : { inlineHint }),
				replacement: {
					start: { line: cursorLine, column: startColumn },
					end: { line: cursorLine, column: cursorCol },
				},
			};
		} finally {
			controller.signal.removeEventListener("abort", onAbort);
			this.#autocompleteOperations.delete(operationId);
		}
	}

	applySuggestion(channelId: string, generation: number, suggestionId: string): RpcUiAutocompleteApplyResult {
		this.#assertChannel(channelId, generation);
		const selection = this.#autocompleteSelections.get(suggestionId);
		if (!selection || selection.generation !== generation) {
			throw new RpcInteractiveSurfaceError("stale_suggestion", "Autocomplete suggestion is stale or unknown");
		}
		this.#assertEditorRevision(selection.editorRevision);
		this.#autocompleteSelections.clear();
		const applied = selection.provider.applyCompletion(
			selection.lines,
			selection.cursorLine,
			selection.cursorCol,
			selection.item,
			selection.prefix,
		);
		this.#autocompleteApplyContext = {
			lines: [...applied.lines],
			cursor: { line: applied.cursorLine, column: applied.cursorCol },
		};
		try {
			this.setEditorText(applied.lines.join("\n"), "component");
			applied.onApplied?.();
			const context = this.#autocompleteApplyContext;
			return {
				editor: { ...this.#editor },
				cursor: context?.cursor ?? { line: applied.cursorLine, column: applied.cursorCol },
				...(context?.clientAction === undefined ? {} : { clientAction: context.clientAction }),
			};
		} finally {
			this.#autocompleteApplyContext = undefined;
		}
	}

	cancelAutocomplete(channelId: string, generation: number, operationId: string): boolean {
		this.#assertChannel(channelId, generation);
		const operation = this.#autocompleteOperations.get(operationId);
		if (!operation) return false;
		operation.abort("cancelled");
		return true;
	}

	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
		const existing = this.#findPresentation("widget", key);
		if (content === undefined) {
			if (existing) this.#removePresentation(existing, "removed");
			return;
		}
		const component = Array.isArray(content)
			? ({ render: () => content } satisfies ExtensionUiComponent)
			: content(this.#tui, theme);
		this.#replacePresentation(existing, {
			id: existing?.id ?? (Snowflake.next() as string),
			kind: "widget",
			key,
			placement: options?.placement,
			component,
			revision: (existing?.revision ?? 0) + 1,
			focused: false,
		});
	}

	setHeader(factory: ExtensionUiComponentFactory | undefined): void {
		this.#setFactoryPresentation("header", factory);
	}

	setFooter(factory: ExtensionUiComponentFactory | undefined): void {
		this.#setFactoryPresentation("footer", factory);
	}

	setEditorComponent(
		factory: ((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
	): void {
		const existing = this.#findPresentation("editor");
		if (!factory) {
			this.#customEditor = undefined;
			if (existing) this.#removePresentation(existing, "removed");
			return;
		}
		const editor = factory(this.#tui, getEditorTheme(), this.#keybindings);
		editor.setText(this.#editor.text);
		this.#customEditor = editor;
		this.#replacePresentation(existing, {
			id: existing?.id ?? (Snowflake.next() as string),
			kind: "editor",
			component: editor,
			revision: (existing?.revision ?? 0) + 1,
			focused: true,
		});
	}

	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
		options?: { overlay?: boolean },
	): Promise<T> {
		this.#requireActive();
		const deferred = Promise.withResolvers<T>();
		const id = Snowflake.next() as string;
		this.#pendingCustomPresentations.set(id, { reject: deferred.reject });
		const done = (result: T): void => {
			if (!this.#pendingCustomPresentations.delete(id)) return;
			const record = this.#presentations.get(id);
			if (record) this.#removePresentation(record, "completed");
			deferred.resolve(result);
		};
		let created: ExtensionUiComponent | Promise<ExtensionUiComponent>;
		try {
			created = factory(this.#tui, theme, this.#keybindings, done);
		} catch (cause) {
			this.#pendingCustomPresentations.delete(id);
			deferred.reject(cause);
			return deferred.promise;
		}
		void Promise.resolve(created).then(
			component => {
				if (!this.#pendingCustomPresentations.has(id)) {
					component.dispose?.();
					return;
				}
				const record: PresentationRecord = {
					id,
					kind: "custom",
					placement: options?.overlay ? "overlay" : undefined,
					component,
					revision: 1,
					focused: true,
					cancel: cause => {
						this.#cancelCustomPresentation(id, cause);
					},
				};
				this.#presentations.set(id, record);
				this.#tui.setFocus(component);
				this.#emitPresentation(record);
			},
			cause => {
				if (!this.#pendingCustomPresentations.delete(id)) return;
				deferred.reject(cause);
			},
		);
		return deferred.promise;
	}

	presentationInput(
		channelId: string,
		generation: number,
		presentationId: string,
		data: string,
	): RpcUiPresentationInputResult {
		this.#assertChannel(channelId, generation);
		const record = this.#presentations.get(presentationId);
		if (!record) throw new RpcInteractiveSurfaceError("presentation_not_found", "Presentation is stale or unknown");
		if (!record.focused || !record.component.handleInput) {
			throw new RpcInteractiveSurfaceError("presentation_not_interactive", "Presentation does not accept input");
		}
		record.component.handleInput(data);
		const current = this.#presentations.get(presentationId);
		if (!current) return { completed: true, presentation: null };
		if (current.kind === "editor" && this.#customEditor) {
			this.setEditorText(this.#customEditor.getText(), "component");
		}
		current.revision += 1;
		const projected = this.#projectPresentation(current);
		this.#emitPresentation(current);
		return { completed: false, presentation: projected };
	}

	cancelPresentation(channelId: string, generation: number, presentationId: string): void {
		this.#assertChannel(channelId, generation);
		const record = this.#presentations.get(presentationId);
		if (!record) throw new RpcInteractiveSurfaceError("presentation_not_found", "Presentation is stale or unknown");
		record.cancel?.(new RpcInteractiveSurfaceError("cancelled", "Presentation cancelled by client"));
		this.#removePresentation(record, "cancelled");
	}

	async listThemes(channelId: string, generation: number): Promise<RpcUiThemeInfo[]> {
		this.#assertChannel(channelId, generation);
		const themes = await getAvailableThemesWithPaths();
		this.#assertChannel(channelId, generation);
		const current = getCurrentThemeName();
		return themes.map(info => ({ ...info, current: info.name === current }));
	}

	async getThemeInfo(channelId: string, generation: number, name: string): Promise<RpcUiThemeInfo | null> {
		this.#assertChannel(channelId, generation);
		const themes = await this.listThemes(channelId, generation);
		const info = themes.find(candidate => candidate.name === name);
		if (!info) return null;
		const loaded = await getThemeByName(name);
		this.#assertChannel(channelId, generation);
		return loaded ? info : null;
	}

	async setThemeName(channelId: string, generation: number, name: string): Promise<RpcUiThemeInfo> {
		this.#assertChannel(channelId, generation);
		const registered = await getThemeByName(name);
		this.#assertChannel(channelId, generation);
		if (!registered) throw new RpcInteractiveSurfaceError("theme_invalid", `Unknown theme: ${name}`);
		const result = await setTheme(name, false, {
			beforeCommit: () => this.#assertChannel(channelId, generation),
			fallbackOnError: false,
		});
		this.#assertChannel(channelId, generation);
		if (!result.success)
			throw new RpcInteractiveSurfaceError("theme_invalid", result.error ?? `Unknown theme: ${name}`);
		this.#commitThemeChange();
		const info = await this.getThemeInfo(channelId, generation, name);
		if (!info) throw new RpcInteractiveSurfaceError("theme_invalid", `Unknown theme: ${name}`);
		return info;
	}

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return getAvailableThemesWithPaths();
	}

	getTheme(name: string): Promise<Theme | undefined> {
		return getThemeByName(name);
	}

	setExtensionTheme(value: string | Theme): Promise<{ success: boolean; error?: string }> {
		if (typeof value !== "string") {
			return Promise.resolve({ success: false, error: "RPC UI themes must be selected by registered theme name" });
		}
		return setTheme(value).then(result => {
			if (result.success) this.#commitThemeChange();
			return result;
		});
	}

	getToolsExpanded(): boolean {
		return this.#toolsExpanded;
	}

	setToolsExpanded(expanded: boolean): { expanded: boolean; revision: number } {
		if (this.#toolsExpanded !== expanded) {
			this.#toolsExpanded = expanded;
			this.#toolsExpandedRevision += 1;
			this.#emitToolsExpanded();
		}
		return { expanded: this.#toolsExpanded, revision: this.#toolsExpandedRevision };
	}

	setToolsExpandedFromClient(
		channelId: string,
		generation: number,
		expanded: boolean,
	): { expanded: boolean; revision: number } {
		this.#assertChannel(channelId, generation);
		return this.setToolsExpanded(expanded);
	}
	sessionNameChanged(): void {
		if (this.#titleOverride !== undefined) return;
		this.#titleRevision += 1;
		this.#emitTitle();
	}

	setTitle(title: string): void {
		if (this.#titleOverride === title) return;
		this.#titleOverride = title;
		this.#titleRevision += 1;
		this.#emitTitle();
	}

	setTitleSubscription(
		channelId: string,
		generation: number,
		subscribed: boolean,
	): {
		subscribed: boolean;
		title: string;
		revision: number;
	} {
		const active = this.#assertChannel(channelId, generation);
		active.subscriptions.title = subscribed;
		if (subscribed) this.#emitTitle();
		return { subscribed, title: this.#currentTitle(), revision: this.#titleRevision };
	}

	#requireActive(): ActiveChannel {
		if (!this.#active) throw new RpcInteractiveSurfaceError("ui_channel_required", "Open an RPC UI channel first");
		return this.#active;
	}

	#assertChannel(channelId: string, generation: number): ActiveChannel {
		const active = this.#requireActive();
		if (active.id !== channelId || active.generation !== generation) {
			throw new RpcInteractiveSurfaceError("stale_ui_generation", "RPC UI channel or generation is stale");
		}
		const authority = this.#options.getAuthority();
		if (active.sessionId !== authority.sessionId) {
			throw new RpcInteractiveSurfaceError("session_changed", "RPC UI session changed");
		}
		if (active.authorityGeneration !== authority.authorityGeneration) {
			throw new RpcInteractiveSurfaceError("authority_changed", "RPC UI execution authority changed");
		}
		return active;
	}

	#rememberEditor(): void {
		this.#editorHistory.push({ ...this.#editor });
		if (this.#editorHistory.length > 100) this.#editorHistory.shift();
	}

	#assertEditorRevision(expectedRevision: number): void {
		if (expectedRevision !== this.#editor.revision) {
			throw new RpcInteractiveSurfaceError(
				"editor_conflict",
				`Editor revision conflict: expected ${expectedRevision}, current ${this.#editor.revision}`,
				{ editor: { ...this.#editor } },
			);
		}
	}

	#commitClientEditor(text: string): RpcUiEditorState {
		if (text === this.#editor.text) return { ...this.#editor };
		this.#rememberEditor();
		this.#customEditor?.setText(text);
		this.#editor = { text, revision: this.#editor.revision + 1 };
		this.#emitEditor("client");
		return { ...this.#editor };
	}

	#copyAutocompleteLine(): void {
		const context = this.#autocompleteApplyContext;
		if (!context) return;
		context.clientAction = {
			type: "clipboard_write",
			text: context.lines[context.cursor.line] ?? "",
		};
	}

	#copyAutocompletePrompt(): void {
		const context = this.#autocompleteApplyContext;
		if (!context) return;
		context.clientAction = { type: "clipboard_write", text: context.lines.join("\n") };
	}

	#undoAutocomplete(prefix: string): void {
		const context = this.#autocompleteApplyContext;
		if (!context) return;
		const previous = this.#editorHistory.pop();
		if (previous) {
			this.#customEditor?.setText(previous.text);
			this.#editor = { text: previous.text, revision: this.#editor.revision + 1 };
			context.lines = previous.text.split("\n");
			context.cursor = this.#endCursor(context.lines);
			this.#emitEditor("component");
			return;
		}
		const line = context.lines[context.cursor.line] ?? "";
		const start = Math.max(0, context.cursor.column - prefix.length);
		context.lines[context.cursor.line] = line.slice(0, start) + line.slice(context.cursor.column);
		context.cursor.column = start;
		this.setEditorText(context.lines.join("\n"), "component");
	}

	#moveAutocompleteCursorToMessageEnd(): void {
		const context = this.#autocompleteApplyContext;
		if (context) context.cursor = this.#endCursor(context.lines);
	}

	#moveAutocompleteCursorToMessageStart(): void {
		const context = this.#autocompleteApplyContext;
		if (context) context.cursor = { line: 0, column: 0 };
	}

	#moveAutocompleteCursorToLineStart(): void {
		const context = this.#autocompleteApplyContext;
		if (context) context.cursor.column = 0;
	}

	#moveAutocompleteCursorToLineEnd(): void {
		const context = this.#autocompleteApplyContext;
		if (context) context.cursor.column = context.lines[context.cursor.line]?.length ?? 0;
	}

	#endCursor(lines: string[]): { line: number; column: number } {
		const line = Math.max(0, lines.length - 1);
		return { line, column: lines[line]?.length ?? 0 };
	}

	#fence(active: ActiveChannel = this.#requireActive()): RpcUiFence {
		return {
			channelId: active.id,
			generation: active.generation,
			sessionId: active.sessionId,
			authorityGeneration: active.authorityGeneration,
		};
	}

	#settleChannel(reason: RpcUiChannelSettlementReason): void {
		const active = this.#active;
		if (!active) return;
		const cause = new RpcInteractiveSurfaceError(reason, `Interactive UI ${reason.replaceAll("_", " ")}`);
		for (const id of [...this.#pendingCustomPresentations.keys()]) this.#cancelCustomPresentation(id, cause);
		this.#active = undefined;
		for (const controller of this.#autocompleteOperations.values()) controller.abort(reason);
		this.#autocompleteOperations.clear();
		this.#autocompleteSelections.clear();
		this.#options.output({
			type: "ui_channel_settled",
			channelId: active.id,
			generation: active.generation,
			reason,
		});
	}

	#applyAutocompleteFactories(): void {
		const base = this.#baseAutocompleteProvider;
		if (!base) return;
		let provider = base;
		for (const factory of this.#autocompleteFactories) provider = factory(provider);
		this.#autocompleteProvider = provider;
	}

	#findPresentation(kind: RpcUiPresentationKind, key?: string): PresentationRecord | undefined {
		for (const record of this.#presentations.values()) {
			if (record.kind === kind && record.key === key) return record;
		}
		return undefined;
	}

	#setFactoryPresentation(kind: "header" | "footer", factory: ExtensionUiComponentFactory | undefined): void {
		const existing = this.#findPresentation(kind);
		if (!factory) {
			if (existing) this.#removePresentation(existing, "removed");
			return;
		}
		this.#replacePresentation(existing, {
			id: existing?.id ?? (Snowflake.next() as string),
			kind,
			component: factory(this.#tui, theme),
			revision: (existing?.revision ?? 0) + 1,
			focused: false,
		});
	}

	#replacePresentation(existing: PresentationRecord | undefined, replacement: PresentationRecord): void {
		if (existing) {
			if (this.#tui.getFocused() === existing.component) this.#tui.setFocus(null);
			existing.component.dispose?.();
			this.#presentations.delete(existing.id);
		}
		this.#presentations.set(replacement.id, replacement);
		if (replacement.focused) this.#tui.setFocus(replacement.component);
		this.#emitPresentation(replacement);
	}

	#removePresentation(
		record: PresentationRecord,
		reason: Extract<RpcUiFrame, { type: "ui_presentation_remove" }>["reason"],
	): void {
		if (!this.#presentations.delete(record.id)) return;
		if (this.#tui.getFocused() === record.component) this.#tui.setFocus(null);
		record.component.dispose?.();
		const active = this.#active;
		if (!active?.subscriptions.presentation) return;
		this.#options.output({
			type: "ui_presentation_remove",
			fence: this.#fence(active),
			presentationId: record.id,
			reason,
		});
	}

	#cancelCustomPresentation(id: string, cause: Error): boolean {
		const pending = this.#pendingCustomPresentations.get(id);
		if (!pending) return false;
		this.#pendingCustomPresentations.delete(id);
		pending.reject(cause);
		const record = this.#presentations.get(id);
		if (record) {
			this.#removePresentation(
				record,
				cause instanceof RpcInteractiveSurfaceError && cause.code === "session_changed"
					? "session_changed"
					: "cancelled",
			);
		}
		return true;
	}

	#commitThemeChange(): void {
		this.#themeRevision += 1;
		for (const record of this.#presentations.values()) record.component.invalidate?.();
		this.#emitTheme();
		this.#renderAllPresentations();
	}

	#disposePresentations(cause: Error): void {
		for (const record of [...this.#presentations.values()]) {
			record.cancel?.(cause);
			this.#removePresentation(record, cause.message.includes("session") ? "session_changed" : "cancelled");
		}
	}

	#projectPresentation(record: PresentationRecord): RpcUiPresentation {
		const width = this.#active?.width ?? DEFAULT_WIDTH;
		const rows = record.component
			.render(width)
			.slice(0, MAX_PRESENTATION_ROWS)
			.map(row => truncateToWidth(replaceTabs(Bun.stripANSI(row)), width));
		return {
			id: record.id,
			kind: record.kind,
			...(record.key === undefined ? {} : { key: record.key }),
			...(record.placement === undefined ? {} : { placement: record.placement }),
			rows,
			revision: record.revision,
			focused: record.focused,
			actions: record.focused
				? [
						{ id: "input", kind: "input" },
						...(record.kind === "custom" ? [{ id: "cancel" as const, kind: "cancel" as const }] : []),
					]
				: [],
		};
	}

	#renderAllPresentations(): void {
		for (const record of this.#presentations.values()) {
			record.revision += 1;
			this.#emitPresentation(record);
		}
	}

	#emitPresentation(record: PresentationRecord): void {
		const active = this.#active;
		if (!active?.subscriptions.presentation) return;
		this.#options.output({
			type: "ui_presentation_update",
			fence: this.#fence(active),
			presentation: this.#projectPresentation(record),
		});
	}

	#emitEditor(source: Extract<RpcUiFrame, { type: "ui_editor_update" }>["source"]): void {
		const active = this.#active;
		if (!active?.subscriptions.editor) return;
		this.#options.output({
			type: "ui_editor_update",
			fence: this.#fence(active),
			editor: { ...this.#editor },
			source,
		});
	}

	#emitTheme(): void {
		const active = this.#active;
		if (!active?.subscriptions.theme) return;
		this.#options.output({
			type: "ui_theme_update",
			fence: this.#fence(active),
			theme: { name: getCurrentThemeName(), revision: this.#themeRevision },
		});
	}

	#currentTitle(): string {
		return this.#titleOverride ?? formatSessionTerminalTitle(this.#options.getSessionName(), this.#options.getCwd());
	}

	#emitTitle(): void {
		const active = this.#active;
		if (!active?.subscriptions.title) return;
		this.#options.output({
			type: "ui_title_update",
			fence: this.#fence(active),
			title: this.#currentTitle(),
			revision: this.#titleRevision,
		});
	}

	#emitToolsExpanded(): void {
		const active = this.#active;
		if (!active?.subscriptions.toolsExpanded) return;
		this.#options.output({
			type: "ui_tools_expanded_update",
			fence: this.#fence(active),
			expanded: this.#toolsExpanded,
			revision: this.#toolsExpandedRevision,
		});
	}
}
