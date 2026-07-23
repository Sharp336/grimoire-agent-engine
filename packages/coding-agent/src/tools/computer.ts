import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { OpenAIComputerCallMetadata, OpenAIComputerResultMetadata, ToolExample } from "@oh-my-pi/pi-ai";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import computerDescription from "../prompts/tools/computer.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { truncateForPrompt } from "./approval";
import { type AcquireBrowserOptions, acquireBrowser, type BrowserHandle, type BrowserKind } from "./browser/registry";
import type { RunResultOk } from "./browser/tab-protocol";
import type { AcquireTabOptions, AcquireTabResult, RunInTabOptions, TabSession } from "./browser/tab-supervisor";
import { acquireTab, getTab, runInTab } from "./browser/tab-supervisor";
import { ToolError, throwIfAborted } from "./tool-errors";

const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1 } as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_MS = 2_000;

const heldKeysSchema = type("string[]").or("null");
const safetyCheckSchema = type({
	id: "string",
	"code?": type("string").or("null"),
	"message?": type("string").or("null"),
});
const computerActionSchema = type({
	type: "'click'",
	x: "number",
	y: "number",
	button: "'left' | 'right' | 'wheel' | 'back' | 'forward'",
	"keys?": heldKeysSchema,
})
	.or({
		type: "'double_click'",
		x: "number",
		y: "number",
		keys: heldKeysSchema,
	})
	.or({
		type: "'drag'",
		path: type({ x: "number", y: "number" }).array(),
		"keys?": heldKeysSchema,
	})
	.or({
		type: "'keypress'",
		keys: "string[]",
	})
	.or({
		type: "'move'",
		x: "number",
		y: "number",
		"keys?": heldKeysSchema,
	})
	.or({ type: "'screenshot'" })
	.or({
		type: "'scroll'",
		x: "number",
		y: "number",
		scroll_x: "number",
		scroll_y: "number",
		"keys?": heldKeysSchema,
	})
	.or({ type: "'type'", text: "string" })
	.or({ type: "'wait'" });

const computerSchema = type({
	actions: computerActionSchema.array(),
	pendingSafetyChecks: safetyCheckSchema.array(),
});

export type ComputerParams = typeof computerSchema.infer;
export type ComputerAction = ComputerParams["actions"][number];

export interface ComputerToolDetails {
	actions: Array<ComputerAction["type"]>;
	tab: string;
	viewport: typeof VIEWPORT;
}

/** Browser lifecycle seam used by focused tests and alternate SDK hosts. */
export interface ComputerToolRuntime {
	acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle>;
	acquireTab(name: string, browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult>;
	getTab(name: string): TabSession | undefined;
	runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk>;
}

const defaultRuntime: ComputerToolRuntime = {
	acquireBrowser,
	acquireTab,
	getTab,
	runInTab,
};

/**
 * Essential OpenAI native computer tool backed by one isolated Puppeteer tab
 * per coding-agent session.
 */
export class ComputerTool implements AgentTool<typeof computerSchema, ComputerToolDetails> {
	readonly name = "computer";
	readonly label = "Computer";
	readonly description = computerDescription.trim();
	readonly summary = "Control an isolated browser viewport with native computer actions";
	readonly parameters = computerSchema;
	readonly strict = true;
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const params = args as Partial<ComputerParams>;
		const checks = Array.isArray(params.pendingSafetyChecks) ? params.pendingSafetyChecks : [];
		return checks.length > 0
			? {
					tier: "exec",
					alwaysPrompt: true,
					reason: "OpenAI computer safety checks require explicit confirmation",
				}
			: "exec";
	};
	readonly concurrency = "exclusive" as const;
	readonly loadMode = "essential" as const;
	readonly intent = "omit" as const;
	readonly openaiNativeTool = "computer" as const;

	readonly examples: readonly ToolExample<ComputerParams>[] = [];
	readonly #fallbackSessionId = crypto.randomUUID();

	constructor(
		private readonly session: ToolSession,
		private readonly runtime: ComputerToolRuntime = defaultRuntime,
	) {}

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<ComputerParams>;
		const actions = Array.isArray(params.actions) ? params.actions : [];
		const checks = Array.isArray(params.pendingSafetyChecks) ? params.pendingSafetyChecks : [];
		const lines = [`Batch: ${actions.length} action${actions.length === 1 ? "" : "s"}`];
		for (let index = 0; index < actions.length; index++) {
			lines.push(`${index + 1}. ${formatAction(actions[index]!)}`);
		}
		lines.push(`Safety checks: ${checks.length}`);
		for (const check of checks) {
			const code = check.code == null ? "" : ` [${truncateForPrompt(check.code)}]`;
			const message = check.message == null ? "" : `: ${truncateForPrompt(check.message)}`;
			lines.push(`- ${truncateForPrompt(check.id)}${code}${message}`);
		}
		return lines;
	};

	async execute(
		_toolCallId: string,
		params: ComputerParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ComputerToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ComputerToolDetails>> {
		throwIfAborted(signal);
		validateActions(params.actions);
		const sessionId = this.session.getSessionId?.() ?? this.#fallbackSessionId;
		const tabName = `computer:${sessionId}`;
		await this.#ensureTab(tabName, sessionId, signal);

		const execution = await this.runtime.runInTab(tabName, {
			code: buildActionScript(params.actions),
			timeoutMs: DEFAULT_TIMEOUT_MS,
			signal,
			session: this.session,
		});
		const images = execution.displays.filter(
			(content): content is { type: "image"; data: string; mimeType: string } => content.type === "image",
		);
		if (execution.displays.length !== 1 || images.length !== 1 || images[0]!.mimeType !== "image/png") {
			throw new ToolError("Computer batch completed without exactly one PNG screenshot");
		}

		const callMetadata: OpenAIComputerCallMetadata = {
			pendingSafetyChecks: params.pendingSafetyChecks,
		};
		const openaiComputer: OpenAIComputerResultMetadata = {
			acknowledgedSafetyChecks: callMetadata.pendingSafetyChecks,
		};
		return {
			content: images,
			details: {
				actions: params.actions.map(action => action.type),
				tab: tabName,
				viewport: VIEWPORT,
			},
			openaiComputer,
		};
	}

	async #ensureTab(tabName: string, ownerSessionId: string, signal?: AbortSignal): Promise<void> {
		if (this.runtime.getTab(tabName)) return;
		const headless = this.session.settings.get("browser.headless") as boolean;
		const kind: BrowserKind = { kind: "headless", headless };
		const browser = await untilAborted(signal, () =>
			this.runtime.acquireBrowser(kind, {
				cwd: this.session.cwd,
				viewport: VIEWPORT,
				signal,
			}),
		);
		const startUrl = this.session.settings.get("computer.startUrl") as string | undefined;
		await untilAborted(signal, () =>
			this.runtime.acquireTab(tabName, browser, {
				url: startUrl,
				viewport: VIEWPORT,
				timeoutMs: DEFAULT_TIMEOUT_MS,
				signal,
				ownerSessionId,
				isolateStorage: true,
			}),
		);
	}
}

function validateActions(actions: readonly ComputerAction[]): void {
	for (const action of actions) {
		if (action.type === "drag" && action.path.length < 2) {
			throw new ToolError("Computer drag actions require at least two path points");
		}
		if (action.type === "keypress" && action.keys.length === 0) {
			throw new ToolError("Computer keypress actions require at least one key");
		}
	}
}

function formatAction(action: ComputerAction): string {
	switch (action.type) {
		case "click":
			return `click ${action.button} at (${action.x}, ${action.y})${formatKeys(action.keys)}`;
		case "double_click":
			return `double click at (${action.x}, ${action.y})${formatKeys(action.keys)}`;
		case "drag":
			return `drag through ${action.path.length} points${formatKeys(action.keys)}`;
		case "keypress":
			return `keypress ${action.keys.map(key => truncateForPrompt(key)).join("+")}`;
		case "move":
			return `move to (${action.x}, ${action.y})${formatKeys(action.keys)}`;
		case "screenshot":
			return "screenshot";
		case "scroll":
			return `scroll (${action.scroll_x}, ${action.scroll_y}) at (${action.x}, ${action.y})${formatKeys(action.keys)}`;
		case "type":
			return `type ${JSON.stringify(truncateForPrompt(action.text))}`;
		case "wait":
			return "wait";
	}
}

function formatKeys(keys: readonly string[] | null | undefined): string {
	return keys?.length ? ` with ${keys.map(key => truncateForPrompt(key)).join("+")}` : "";
}

function buildActionScript(actions: readonly ComputerAction[]): string {
	return `
const actions = ${JSON.stringify(actions)};
const keyAliases = {
	ALT: "Alt", OPTION: "Alt", BACKSPACE: "Backspace", CAPSLOCK: "CapsLock",
	CMD: "Meta", COMMAND: "Meta", META: "Meta", CTRL: "Control", CONTROL: "Control",
	DEL: "Delete", DELETE: "Delete", DOWN: "ArrowDown", ARROWDOWN: "ArrowDown",
	END: "End", ENTER: "Enter", RETURN: "Enter", ESC: "Escape", ESCAPE: "Escape",
	HOME: "Home", INSERT: "Insert", LEFT: "ArrowLeft", ARROWLEFT: "ArrowLeft",
	PAGEDOWN: "PageDown", PAGEUP: "PageUp", RIGHT: "ArrowRight", ARROWRIGHT: "ArrowRight",
	SHIFT: "Shift", SPACE: "Space", SPACEBAR: "Space", TAB: "Tab",
	UP: "ArrowUp", ARROWUP: "ArrowUp"
};
const modifierKeys = new Set(["Alt", "Control", "Meta", "Shift"]);
const normalizeKey = key => {
	const compact = key.trim().replace(/[\\s_-]/g, "").toUpperCase();
	if (keyAliases[compact]) return keyAliases[compact];
	if (/^F(?:[1-9]|1[0-2])$/.test(compact)) return compact;
	return key.length === 1 ? key.toLowerCase() : key;
};
const uniqueKeys = keys => [...new Set((keys ?? []).map(normalizeKey))];
const withHeldKeys = async (keys, operation) => {
	const held = uniqueKeys(keys);
	try {
		for (const key of held) await page.keyboard.down(key);
		await operation();
	} finally {
		for (const key of held.reverse()) await page.keyboard.up(key);
	}
};
for (const action of actions) {
	switch (action.type) {
		case "click":
			await withHeldKeys(action.keys, async () => {
				const button = action.button === "wheel" ? "middle" : action.button;
				await page.mouse.click(action.x, action.y, { button });
			});
			break;
		case "double_click":
			await withHeldKeys(action.keys, async () => {
				await page.mouse.click(action.x, action.y, { button: "left", clickCount: 2 });
			});
			break;
		case "drag":
			await withHeldKeys(action.keys, async () => {
				await page.mouse.move(action.path[0].x, action.path[0].y);
				let pressed = false;
				try {
					await page.mouse.down({ button: "left" });
					pressed = true;
					for (const point of action.path.slice(1)) await page.mouse.move(point.x, point.y);
				} finally {
					if (pressed) await page.mouse.up({ button: "left" });
				}
			});
			break;
		case "keypress": {
			const normalized = uniqueKeys(action.keys);
			const modifiers = normalized.filter(key => modifierKeys.has(key));
			const regular = normalized.filter(key => !modifierKeys.has(key));
			try {
				for (const key of modifiers) await page.keyboard.down(key);
				for (const key of regular) await page.keyboard.press(key);
			} finally {
				for (const key of modifiers.reverse()) await page.keyboard.up(key);
			}
			break;
		}
		case "move":
			await withHeldKeys(action.keys, () => page.mouse.move(action.x, action.y));
			break;
		case "screenshot":
			break;
		case "scroll":
			await withHeldKeys(action.keys, async () => {
				await page.mouse.move(action.x, action.y);
				await page.mouse.wheel({ deltaX: action.scroll_x, deltaY: action.scroll_y });
			});
			break;
		case "type":
			await page.keyboard.type(action.text);
			break;
		case "wait":
			await wait(${WAIT_MS});
			break;
	}
}
const screenshot = await page.screenshot({
	type: "png",
	encoding: "base64",
	fullPage: false,
	captureBeyondViewport: false
});
display({ type: "image", data: screenshot, mimeType: "image/png" });
`;
}
