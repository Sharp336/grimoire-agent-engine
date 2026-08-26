import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	buildTabColorSequence,
	disposeTerminalTitleState,
	generateSessionTitle,
	setExtensionTerminalTitle,
	setSessionTerminalTitle,
	setTerminalFocus,
	setTerminalTitle,
	setTerminalTitleState,
	setTerminalTitleStateEnabled,
} from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { logger, setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { mockWindowsConsoleTitle, type WindowsConsoleTitleMock } from "./terminal-title-test-utils";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function getModelFor(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected model ${provider}/${id}`);
	return model;
}

function createSettings(model: Model<Api>, tinyModel = "online") {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return tinyModel;
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		authStorage: { rotateSessionCredential: async () => false },
		resolver: () => async () => "test-key",
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("title generator", () => {
	it("returns the marker-wrapped title without forcing a tool call", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Structured Title</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Structured Title");
		const request = completeSimpleMock.mock.calls[0]?.[1] as { tools?: unknown } | undefined;
		const options = completeSimpleMock.mock.calls[0]?.[2] as
			| { toolChoice?: unknown; disableReasoning?: boolean }
			| undefined;
		expect(request?.tools).toBeUndefined();
		expect(options?.toolChoice).toBeUndefined();
		expect(options?.disableReasoning).toBe(true);
	});

	it.each([
		[
			"<thinking>",
			"<thinking>Thinking process:\n<title>Wrong internal scratchpad</title>\n</thinking>\n<title>Fix login button</title>",
		],
		[
			"<think>",
			"<think>Thinking process:\n<title>Wrong internal scratchpad</title>\n</think>\n<title>Fix login button</title>",
		],
		[
			"<reasoning>",
			"<reasoning>Thinking process:\n<title>Wrong internal scratchpad</title>\n</reasoning>\n<title>Fix login button</title>",
		],
		[
			"```reasoning",
			"```reasoning\nThinking process:\n<title>Wrong internal scratchpad</title>\n```\n<title>Fix login button</title>",
		],
	] as const)("ignores leaked %s reasoning markup before the visible title", async (_marker, responseText) => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: responseText }],
		} as never);

		const title = await generateSessionTitle(
			"the login button is broken on mobile",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix login button");
	});

	it("preserves in-band reasoning syntax inside the parsed title", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Fix <think> tag parsing</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"fix title generation for <think> tag parsing",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix <think> tag parsing");
	});

	it("uses the bundled default prompt when no title prompt file is resolved", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Default Prompt</title>" }],
		} as never);

		await generateSessionTitle("Investigate the resolver", createRegistry(model), createSettings(model));

		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[] } | undefined;
		expect(request?.systemPrompt).toHaveLength(1);
		expect(request?.systemPrompt?.[0]).toContain("<title>");
	});

	it("appends the marker instruction after a resolved TITLE_SYSTEM.md prompt", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const customPrompt = "Generate lowercase colon-delimited session names.";
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>fix:resolver</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
			undefined,
			undefined,
			undefined,
			customPrompt,
		);

		expect(title).toBe("fix:resolver");
		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[] } | undefined;
		expect(request?.systemPrompt).toHaveLength(2);
		expect(request?.systemPrompt?.[0]).toBe(customPrompt);
		expect(request?.systemPrompt?.[1]).toContain("<title>");
	});

	it('unwraps a JSON {"title": ...} response into the bare title', async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"title": "Optimize CNPG kernel reports"}' }],
		} as never);

		const title = await generateSessionTitle(
			"optimize the CNPG kernel report pipeline",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Optimize CNPG kernel reports");
	});

	it("unwraps a code-fenced JSON title response", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '```json\n{"title": "Fix login button on mobile"}\n```' }],
		} as never);

		const title = await generateSessionTitle(
			"the login button is broken on mobile",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix login button on mobile");
	});

	it("unwraps a JSON title wrapped in <title> markers", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '<title>{"title": "Add OAuth authentication"}</title>' }],
		} as never);

		const title = await generateSessionTitle(
			"add OAuth authentication to the API",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Add OAuth authentication");
	});

	it("salvages the title from truncated JSON output", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: '{"title": "Debug failing CI tests"' }],
		} as never);

		const title = await generateSessionTitle(
			"the CI tests keep failing",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Debug failing CI tests");
	});

	it("defers titling for a greeting without invoking the model", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");

		const title = await generateSessionTitle("hi", createRegistry(model), createSettings(model));

		expect(title).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("returns null when the model rejects a non-greeting taskless message with the none sentinel", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>none</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"I have a quick question for you",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("returns null for a self-closing <title/> marker", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title/>" }],
		} as never);

		const title = await generateSessionTitle(
			"I have a quick question for you",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("returns null for a bare <title> marker", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>" }],
		} as never);

		const title = await generateSessionTitle(
			"I have a quick question for you",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("logs and returns null when title credentials are missing", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const title = await generateSessionTitle(
			"Investigate the resolver",
			{
				getAvailable: () => [model],
				getApiKey: async () => undefined,
			} as never,
			createSettings(model),
			"session-1",
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"title-generator: no API key",
			expect.objectContaining({
				sessionId: "session-1",
				provider: model.provider,
				id: model.id,
				reason: "missing-api-key",
			}),
		);
	});

	it("logs and returns null when title credential lookup throws", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const title = await generateSessionTitle(
			"Investigate the resolver",
			{
				getAvailable: () => [model],
				getApiKey: async () => {
					throw new Error("credential lookup failed");
				},
			} as never,
			createSettings(model),
			"session-2",
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"title-generator: error",
			expect.objectContaining({
				sessionId: "session-2",
				provider: model.provider,
				id: model.id,
				reason: "exception",
				error: "credential lookup failed",
			}),
		);
	});

	it("uses a reasoning-safe output budget for reasoning models", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Budget Title</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);
		const maxTokens = (completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number } | undefined)?.maxTokens;

		expect(title).toBe("Budget Title");
		expect(maxTokens).toBeGreaterThanOrEqual(1024);
	});

	// Regression for #4355: a model catalogued with `reasoning: false` that
	// still emits thinking (e.g. Qwen3 via llama.cpp) must get the same
	// reasoning-safe budget, otherwise the `<title>` output is truncated
	// before it can be emitted.
	it("uses a reasoning-safe output budget even when the model declares reasoning: false", async () => {
		const baseModel = getModelOrThrow("claude-sonnet-4-5");
		const model = { ...baseModel, reasoning: false } as Model<Api>;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Budget Title</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);
		const maxTokens = (completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number } | undefined)?.maxTokens;

		expect(title).toBe("Budget Title");
		expect(maxTokens).toBeGreaterThanOrEqual(1024);
	});

	it("strips code blocks from the message sent to the model", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Setup Screen</title>" }],
		} as never);

		await generateSessionTitle(
			"plan a setup screen\n```\nWelcome to Claude Code v2.1.158\n```\npick provider then theme",
			createRegistry(model),
			createSettings(model),
		);

		const sentMessages = (completeSimpleMock.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> })
			?.messages;
		const userContent = sentMessages?.[0]?.content ?? "";
		expect(userContent).not.toContain("Claude Code v2.1.158");
		expect(userContent).toContain("pick provider then theme");
	});

	it("accepts a plain sentence when the model omits the <title> markers", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Fix login button on mobile" }],
		} as never);

		const title = await generateSessionTitle(
			"the login button is broken on mobile",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix login button on mobile");
	});

	it.each(["Here's a thinking process:", "Thinking process:", "Reasoning process:"])(
		"rejects a markerless prose thinking preamble: %s",
		async responseText => {
			const model = getModelFor("deepseek", "deepseek-v4-pro");
			vi.spyOn(ai, "completeSimple").mockResolvedValue({
				stopReason: "stop",
				content: [{ type: "text", text: responseText }],
			} as never);

			const title = await generateSessionTitle(
				"the login button is broken on mobile",
				createRegistry(model),
				createSettings(model),
			);

			expect(title).toBeNull();
		},
	);

	it("preserves a markerless title that mentions a <think> tag", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Fix <think> tag parsing" }],
		} as never);

		const title = await generateSessionTitle(
			"fix title generation for <think> tag parsing",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix <think> tag parsing");
	});

	it("preserves a markerless title that mentions a ```thinking fence", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Fix ```thinking fence parsing" }],
		} as never);

		const title = await generateSessionTitle(
			"fix title generation for a ```thinking fence",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toContain("```thinking");
		expect(title).toContain("fence");
	});

	it("strips an unclosed <title> tag from a truncated response", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Refactor API client error handling" }],
		} as never);

		const title = await generateSessionTitle(
			"refactor the error handling in the api client",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Refactor API client error handling");
	});

	it("resolves the model roles in precedence order: tiny -> commit -> smol", async () => {
		const tinyModel = getModelOrThrow("claude-haiku-4-5");
		const commitModel = getModelOrThrow("claude-sonnet-4-5");
		const smolModel = getModelOrThrow("claude-opus-4-8");

		const mockComplete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Test Title</title>" }],
		} as never);

		// Case 1: All three roles configured. 'tiny' should be used.
		let currentSettings = {
			get(path: string) {
				if (path === "providers.tinyModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				if (role === "tiny") return `${tinyModel.provider}/${tinyModel.id}`;
				if (role === "commit") return `${commitModel.provider}/${commitModel.id}`;
				if (role === "smol") return `${smolModel.provider}/${smolModel.id}`;
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;

		const registry = {
			getAvailable: () => [tinyModel, commitModel, smolModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => "test-key",
		} as never;

		await generateSessionTitle("Some message", registry, currentSettings);
		expect(mockComplete).toHaveBeenCalled();
		expect(mockComplete.mock.calls[0]?.[0]).toBe(tinyModel);

		mockComplete.mockClear();

		// Case 2: 'tiny' role not configured, 'commit' and 'smol' configured. 'commit' should be used.
		currentSettings = {
			get(path: string) {
				if (path === "providers.tinyModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				if (role === "commit") return `${commitModel.provider}/${commitModel.id}`;
				if (role === "smol") return `${smolModel.provider}/${smolModel.id}`;
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;

		await generateSessionTitle("Some message", registry, currentSettings);
		expect(mockComplete).toHaveBeenCalled();
		expect(mockComplete.mock.calls[0]?.[0]).toBe(commitModel);

		mockComplete.mockClear();

		// Case 3: Only 'smol' role configured. 'smol' should be used.
		currentSettings = {
			get(path: string) {
				if (path === "providers.tinyModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				if (role === "smol") return `${smolModel.provider}/${smolModel.id}`;
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;

		await generateSessionTitle("Some message", registry, currentSettings);
		expect(mockComplete).toHaveBeenCalled();
		expect(mockComplete.mock.calls[0]?.[0]).toBe(smolModel);
	});
});

// The terminal title runtime is a module-global. `emitTerminalTitle()` composes
// the emitted OSC title from three inputs — an extension override, a run-state
// separator (spinner frame, static Windows `:`, `>`, or `!` between the `π`
// brand and the session label), and the session label — and writes it to
// `process.stdout` as `ESC]0;<title>BEL`. These tests pin the observable
// contract at that sink: what string actually reaches the terminal after a
// given sequence of the exported state transitions.
//
// Two seams must be opened for the real write to happen under `bun test`:
//   - `isTerminalHeadless()` defaults to true in the test runtime and short-
//     circuits `setTerminalTitle` before any write; we opt out with
//     `setTerminalHeadless(false)` and restore it.
//   - `setTerminalTitle` also no-ops unless `process.stdout.isTTY`; we force it.

const OSC_TITLE_RE = /\x1b\]0;([\s\S]*?)\x07/;

// Braille spinner frames used by the `working` state (mirrors the module's
// private TITLE_SPINNER_FRAMES); a clobbered override would surface one of these.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

describe("terminal title runtime", () => {
	let writes: string[] = [];
	let stdoutSpy: { mockRestore(): void } | undefined;
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;
	let windowsTitleMock: WindowsConsoleTitleMock | undefined;
	let prevWtSession: string | undefined;

	// Titles emitted (newest last) since the last reset of `writes`; used across
	// every assertion, so the OSC extraction lives here rather than at each site.
	function emittedTitles(): string[] {
		return writes.map(payload => OSC_TITLE_RE.exec(payload)?.[1]).filter((t): t is string => t !== undefined);
	}

	beforeEach(() => {
		// Deterministic clock so the real spinner interval can be advanced without
		// a wall-clock wait.
		vi.useFakeTimers();

		// Force the real write path: not headless, stdout is a TTY.
		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		// Tab-color gating must not fire inside these tests even when the host
		// really is Windows Terminal (WT_SESSION set): they assert exact writes.
		prevWtSession = process.env.WT_SESSION;
		delete process.env.WT_SESSION;

		windowsTitleMock = mockWindowsConsoleTitle();
		writes = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});

		// Drive the module-global back to a known state from the public API so
		// the tests are order-independent: clear any override + session base and
		// settle the run state to idle.
		setSessionTerminalTitle(undefined);
		setTerminalTitleState("idle");

		// Discard the reset's own emissions; each test asserts only its own writes.
		writes.length = 0;
	});

	afterEach(() => {
		// Stop any spinner timer started during a test before tearing spies down.
		disposeTerminalTitleState();
		windowsTitleMock?.restore();
		windowsTitleMock = undefined;
		stdoutSpy?.mockRestore();
		stdoutSpy = undefined;
		if (prevWtSession === undefined) delete process.env.WT_SESSION;
		else process.env.WT_SESSION = prevWtSession;
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
		vi.useRealTimers();
	});

	it("keeps an extension override verbatim across a run-state change (spinner never clobbers it)", () => {
		// CONTRACT (core regression): once an extension owns the title, flipping
		// the run state to `working` must NOT re-emit the base title with a
		// spinner prefix. The override wins verbatim.
		setExtensionTerminalTitle("Deploying prod");
		expect(emittedTitles().at(-1)).toBe("Deploying prod");

		writes.length = 0;
		setTerminalTitleState("working");
		setTerminalTitleState("attention");
		setTerminalTitleState("idle");

		// No state transition produced a NEW title away from the override.
		// (Deduped emits mean the sink may not fire at all; if it does, only "Deploying prod".)
		for (const title of emittedTitles()) expect(title).toBe("Deploying prod");
		for (const payload of writes) {
			for (const frame of SPINNER_FRAMES) expect(payload).not.toContain(frame);
		}
	});

	it("keeps the override verbatim across a real spinner tick", () => {
		// CONTRACT: the periodic spinner tick (frame++ → emit) must also respect
		// the override. This exercises the timer-driven emission path, not just
		// the synchronous state setter.
		setExtensionTerminalTitle("Long extension task");
		writes.length = 0;

		// Enter `working` to start the spinner interval, then advance the fake
		// clock across several tick intervals (interval is 80ms).
		setTerminalTitleState("working");
		vi.advanceTimersByTime(400);

		for (const title of emittedTitles()) expect(title).toBe("Long extension task");
		for (const payload of writes) {
			for (const frame of SPINNER_FRAMES) expect(payload).not.toContain(frame);
		}
	});

	it("clears the override when an authoritative session title is set", () => {
		// CONTRACT: `setSessionTerminalTitle` supersedes any extension override —
		// the emitted title tracks the real session, not the stale override.
		setExtensionTerminalTitle("Stale extension title");
		writes.length = 0;

		setSessionTerminalTitle("my-session");

		const last = emittedTitles().at(-1);
		expect(last).toBeDefined();
		expect(last).toContain("my-session");
		expect(last).not.toContain("Stale extension title");
	});

	it("dedupes direct writes after sanitizing the title", () => {
		setTerminalTitle("direct title\u0000");
		setTerminalTitle("direct title");

		expect(emittedTitles()).toEqual(["direct title"]);
		expect(writes).toHaveLength(1);
	});

	it("keeps the working title static with ':' on Windows", () => {
		const originalPlatform = process.platform;
		try {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			setSessionTerminalTitle("windows-project");
			writes.length = 0;

			setTerminalTitleState("working");
			expect(emittedTitles()).toEqual(["π : windows-project"]);

			writes.length = 0;
			vi.advanceTimersByTime(400);
			expect(writes).toEqual([]);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("keeps the working title static under WSL", () => {
		const originalPlatform = process.platform;
		const originalWslDistro = process.env.WSL_DISTRO_NAME;
		try {
			Object.defineProperty(process, "platform", { value: "linux", configurable: true });
			process.env.WSL_DISTRO_NAME = "Ubuntu";
			setSessionTerminalTitle("wsl-project");
			writes.length = 0;

			setTerminalTitleState("working");
			expect(emittedTitles()).toEqual(["π : wsl-project"]);

			writes.length = 0;
			vi.advanceTimersByTime(400);
			expect(writes).toEqual([]);
		} finally {
			if (originalWslDistro === undefined) delete process.env.WSL_DISTRO_NAME;
			else process.env.WSL_DISTRO_NAME = originalWslDistro;
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("uses SetConsoleTitleW without an OSC write on Windows", () => {
		const originalPlatform = process.platform;
		const native = windowsTitleMock;
		if (!native) throw new Error("Windows console title mock not initialized");
		native.succeeds = true;
		try {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			setTerminalTitle("native Ω");
			setTerminalTitle("native Ω");

			expect(native.titles).toEqual(["native Ω"]);
			expect(writes).toEqual([]);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});
});
// Windows Terminal tints the active tab via DECAC (`CSI 2;15;<idx>,|`; item 2
// is the window/tab frame, fg 15 is ignored by WT which picks contrasting tab
// text). These tests pin the observable contract at the stdout sink: which
// exact bytes reach the terminal, under which host conditions, and when the
// runtime must stay silent (other terminals, disabled signal, idle-only
// sessions, headless).
describe("terminal tab color (Windows Terminal)", () => {
	let writes: string[] = [];
	let stdoutSpy: { mockRestore(): void } | undefined;
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;
	let prevWtSession: string | undefined;
	let windowsTitleMock: WindowsConsoleTitleMock | undefined;

	const DECAC_RE = /\x1b\[2;\d+;\d+,\|/;

	function decacPayloads(): string[] {
		return writes.filter(payload => DECAC_RE.test(payload));
	}

	function emittedTitles(): string[] {
		return writes.map(payload => OSC_TITLE_RE.exec(payload)?.[1]).filter((t): t is string => t !== undefined);
	}

	/** Run `fn` with the two gate conditions forced on: platform win32 and
	 * WT_SESSION present. Restores both on exit (mirror of the WSL test). */
	function withWindowsTerminal(fn: () => void): void {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		process.env.WT_SESSION = "test-session";
		try {
			fn();
		} finally {
			if (prevWtSession === undefined) delete process.env.WT_SESSION;
			else process.env.WT_SESSION = prevWtSession;
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	}

	beforeEach(() => {
		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		windowsTitleMock = mockWindowsConsoleTitle();
		prevWtSession = process.env.WT_SESSION;
		delete process.env.WT_SESSION;

		writes = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});

		setSessionTerminalTitle(undefined);
		setTerminalTitleState("idle");
		setTerminalTitleStateEnabled(true);
		setTerminalFocus(true);
		writes.length = 0;
	});

	afterEach(() => {
		disposeTerminalTitleState();
		setTerminalFocus(true);
		windowsTitleMock?.restore();
		windowsTitleMock = undefined;
		stdoutSpy?.mockRestore();
		stdoutSpy = undefined;
		if (prevWtSession === undefined) delete process.env.WT_SESSION;
		else process.env.WT_SESSION = prevWtSession;
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
	});

	it("maps run state to DECAC wire bytes (attention=1 red, notify=3 yellow, working/idle reset to default)", () => {
		// CONTRACT: WT parses the exact sequences CSI 2;15;<bg-index>,| and
		// CSI 2;263;264,| — these bytes ARE the feature. Only attention/notify
		// paint; working/idle restore the default tab color, and from a clean
		// (never-painted) state they write nothing at all.
		withWindowsTerminal(() => {
			setTerminalFocus(false);
			setTerminalTitleState("working"); // clean → nothing
			setTerminalTitleState("attention");
			setTerminalTitleState("notify");
			setTerminalTitleState("working");
			setTerminalTitleState("idle"); // already default → nothing
			setTerminalTitleState("attention");
			setTerminalTitleState("idle");
		});
		expect(decacPayloads()).toEqual([
			"\x1b[2;15;1,|",
			"\x1b[2;15;3,|",
			"\x1b[2;263;264,|",
			"\x1b[2;15;1,|",
			"\x1b[2;263;264,|",
		]);
	});

	it("emits the same wire bytes from the pure builder", () => {
		// CONTRACT: buildTabColorSequence is the single source of the sequence;
		// pin it independently of the runtime so refactors can't drift bytes.
		expect(buildTabColorSequence("attention")).toBe("\x1b[2;15;1,|");
		expect(buildTabColorSequence("notify")).toBe("\x1b[2;15;3,|");
		expect(buildTabColorSequence("working")).toBe("\x1b[2;263;264,|");
		expect(buildTabColorSequence("idle")).toBe("\x1b[2;263;264,|");
	});

	it("emits the notify title and yellow tint when a turn finishes", () => {
		// CONTRACT: a finished-but-unread turn is a "needs the user" state: the
		// title carries the static `:>` separator and the tab turns yellow, so
		// an answered question never reads as plain idle.
		setSessionTerminalTitle("label");
		withWindowsTerminal(() => {
			setTerminalFocus(false);
			writes.length = 0;
			setTerminalTitleState("notify");
		});
		expect(emittedTitles()).toEqual(["π :> label"]);
		expect(decacPayloads()).toEqual(["\x1b[2;15;3,|"]);
	});

	it("repaints through a full turn cycle (yellow → reset → red → yellow)", () => {
		// CONTRACT: the tab follows the run state across an entire turn: notify
		// (yellow) → working (reset to default) → attention (red) → notify (yellow).
		withWindowsTerminal(() => {
			setTerminalFocus(false);
			setTerminalTitleState("notify");
			setTerminalTitleState("working");
			setTerminalTitleState("attention");
			setTerminalTitleState("notify");
		});
		expect(decacPayloads()).toEqual(["\x1b[2;15;3,|", "\x1b[2;263;264,|", "\x1b[2;15;1,|", "\x1b[2;15;3,|"]);
	});

	it("paints yellow when a turn finishes while the tab is inactive", () => {
		// CONTRACT: the bell tint applies only while the tab is unfocused —
		// agent_end on an inactive tab turns it yellow.
		withWindowsTerminal(() => {
			setTerminalFocus(false);
			setTerminalTitleState("notify");
		});
		expect(decacPayloads()).toEqual(["\x1b[2;15;3,|"]);
	});

	it("does not paint yellow when a turn finishes while the tab is focused", () => {
		// CONTRACT: with the tab focused (the default at launch), agent_end is
		// visible to the user already — no bell tint needed.
		withWindowsTerminal(() => {
			setTerminalTitleState("notify");
		});
		expect(decacPayloads()).toEqual([]);
	});

	it("clears the yellow tint on focus-in without touching the title", () => {
		// CONTRACT: activating the tab behaves like WT's native bell indicator —
		// the yellow tint clears, the `π :> label` title stays.
		withWindowsTerminal(() => {
			setTerminalFocus(false);
			setSessionTerminalTitle("label");
			writes.length = 0;
			setTerminalTitleState("notify");
			setTerminalFocus(true);
		});
		expect(decacPayloads()).toEqual(["\x1b[2;15;3,|", "\x1b[2;263;264,|"]);
		expect(emittedTitles()).toEqual(["π :> label"]);
	});

	it("does not re-paint yellow on focus-out after the tint cleared", () => {
		// CONTRACT: focus-out alone never repaints — the yellow returns only on
		// the next notify transition.
		withWindowsTerminal(() => {
			setTerminalFocus(false);
			setTerminalTitleState("notify");
			setTerminalFocus(true);
			writes.length = 0;
			setTerminalFocus(false);
		});
		expect(decacPayloads()).toEqual([]);
	});

	it("clears a lingering red tint when notify lands while focused", () => {
		// CONTRACT: a focused agent_end must not leave an earlier attention tint
		// on the tab — the red clears to the default, not lingers until the
		// next transition.
		withWindowsTerminal(() => {
			setTerminalFocus(false);
			setTerminalTitleState("attention");
			setTerminalFocus(true);
			setTerminalTitleState("notify");
		});
		expect(decacPayloads()).toEqual(["\x1b[2;15;1,|", "\x1b[2;263;264,|"]);
	});

	it("paints yellow directly on notify after red when the tab is inactive", () => {
		// CONTRACT: unfocused notify replaces the previous tint with yellow in
		// one paint (no intermediate reset).
		withWindowsTerminal(() => {
			setTerminalFocus(false);
			setTerminalTitleState("attention");
			setTerminalTitleState("notify");
		});
		expect(decacPayloads()).toEqual(["\x1b[2;15;1,|", "\x1b[2;15;3,|"]);
	});

	it("never writes DECAC outside Windows Terminal (no WT_SESSION)", () => {
		// CONTRACT: terminals without the window-frame DECAC item must not
		// receive the sequence (conhost, VS Code, mintty would drop/garble it).
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			setTerminalTitleState("working");
			setTerminalTitleState("attention");
			setTerminalTitleState("notify");
			setTerminalTitleState("idle");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
		expect(decacPayloads()).toEqual([]);
	});

	it("never writes DECAC off Windows (WT_SESSION set but platform linux)", () => {
		// CONTRACT: the gate is the conjunction — WT_SESSION alone (e.g. a WT-
		// hosted WSL/ssh pane) must not tint anything.
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		process.env.WT_SESSION = "test-session";
		try {
			setTerminalTitleState("attention");
		} finally {
			if (prevWtSession === undefined) delete process.env.WT_SESSION;
			else process.env.WT_SESSION = prevWtSession;
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
		expect(decacPayloads()).toEqual([]);
	});

	it("does not tint an idle-only session (lazy paint)", () => {
		// CONTRACT: a session that never leaves idle must not touch the tab
		// color — preserves colors the user set by hand or via --tabColor.
		withWindowsTerminal(() => {
			setTerminalTitleState("idle");
		});
		expect(decacPayloads()).toEqual([]);
	});

	it("does not tint while the titleState signal is disabled", () => {
		// CONTRACT: tui.titleState=false kills the color signal with the
		// separator signal — one switch, both effects.
		withWindowsTerminal(() => {
			setTerminalTitleStateEnabled(false);
			setTerminalTitleState("working");
			setTerminalTitleState("attention");
		});
		expect(decacPayloads()).toEqual([]);
	});

	it("resets to the default tab color when the signal is switched off mid-session", () => {
		// CONTRACT: disabling after painting must clear the tint, not freeze
		// it in the last state forever.
		withWindowsTerminal(() => {
			setTerminalTitleState("attention");
			setTerminalTitleStateEnabled(false);
		});
		expect(decacPayloads()).toEqual(["\x1b[2;15;1,|", "\x1b[2;263;264,|"]);
	});

	it("resets to the default tab color on dispose iff this process painted", () => {
		// CONTRACT: exit cleanup returns the tab to its default color exactly
		// once and only when we changed it; a second dispose is a no-op.
		withWindowsTerminal(() => {
			setTerminalTitleState("attention");
		});
		writes.length = 0;
		disposeTerminalTitleState();
		expect(decacPayloads()).toEqual(["\x1b[2;263;264,|"]);

		writes.length = 0;
		disposeTerminalTitleState();
		expect(decacPayloads()).toEqual([]);
	});

	it("does not tint in headless mode", () => {
		// CONTRACT: RPC/SDK headless runs must not write terminal control
		// sequences — mirrors the setTerminalTitle headless guard.
		setTerminalHeadless(true);
		withWindowsTerminal(() => {
			setTerminalTitleState("attention");
		});
		expect(decacPayloads()).toEqual([]);
	});
});
