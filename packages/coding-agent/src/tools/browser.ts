import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import browserDescription from "../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "../session/streaming-output";
import { truncateForPrompt } from "./approval";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import { acquireBrowser, type BrowserHandle, type BrowserKind, type BrowserKindTag } from "./browser/registry";
import type { Observation, ScreenshotResult } from "./browser/tab-protocol";
import {
	acquireTab,
	dropHeadlessTabs,
	getTab,
	releaseAllTabs,
	releaseTab,
	runInTab,
	startTabRecording,
	stopTabRecording,
} from "./browser/tab-supervisor";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export {
	type AriaSnapshotOptions,
	buildAriaSnapshotScript,
	parseAriaRefSelector,
} from "./browser/aria/aria-snapshot";
export { cmuxSnapshotToObservation, mapWaitUntil, resolveCmuxKind, serializeEval } from "./browser/cmux/rpc";
export { CmuxSocketClient } from "./browser/cmux/socket-client";
export { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "./browser/readable";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";

const appSchema = type({
	"path?": type("string").describe("binary path to spawn"),
	"cdp_url?": type("string").describe("existing cdp endpoint"),
	"args?": type("string[]").describe("extra cli args"),
	"target?": type("string").describe("substring to pick a window"),
});

const browserSchema = type({
	action: type("'open' | 'close' | 'run' | 'start_recording' | 'stop_recording'").describe("operation"),
	"name?": type("string").describe("tab id (default 'main')"),
	"url?": type("string").describe("url to open"),
	"app?": appSchema,
	"viewport?": {
		width: "number",
		height: "number",
		"scale?": "number",
	},
	"wait_until?": type("'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'").describe(
		"navigation wait condition",
	),
	"dialogs?": type("'accept' | 'dismiss'").describe("auto-handle dialogs"),
	"code?": type("string").describe("js body to run in tab"),
	"domains?": type("string[]").describe("recording scope: exact http(s) origins (default: the tab's current origin)"),
	"timeout?": type("number").describe("timeout in seconds"),
	"all?": type("boolean").describe("close every tab"),
	"kill?": type("boolean").describe("also kill spawned-app browsers"),
});

/** Input schema for the browser tool. */
export type BrowserParams = typeof browserSchema.infer;

/** Details describing a browser tool execution result (for renderers + transcript). */
export interface BrowserToolDetails {
	action: BrowserParams["action"];
	name?: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	observation?: Observation;
	screenshots?: ScreenshotResult[];
	result?: string;
	meta?: OutputMeta;
	/** start_recording: normalized effective recording scope (origins). */
	scope?: readonly string[];
	/** stop_recording: artifact id holding the sanitized HAR (`artifact://<id>`); never the HAR itself. */
	artifactId?: string;
	/** stop_recording: bounded capture statistics; never the captured traffic. */
	recording?: {
		entryCount: number;
		capturedBodyCount: number;
		omittedBodyCount: number;
		totalBytes: number;
		truncated: boolean;
	};
}

function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		return { kind: "spawned", path: exe };
	}
	const cmuxKind = resolveCmuxKind({
		settingEnabled: session.settings.get("browser.cmux") as boolean | undefined,
	});
	if (cmuxKind) {
		return cmuxKind;
	}
	const headless = session.settings.get("browser.headless") as boolean;
	return { kind: "headless", headless };
}

/**
 * Fields that are meaningless for each recording action. The flat schema keeps every field
 * optional (so intent injection + OpenAI strict-mode normalization stay satisfiable), so we
 * reject action-irrelevant fields here rather than silently ignoring them.
 */
const RECORDING_DISALLOWED_FIELDS = {
	start_recording: ["url", "app", "viewport", "wait_until", "dialogs", "code", "all", "kill"],
	stop_recording: ["url", "app", "viewport", "wait_until", "dialogs", "code", "domains", "all", "kill"],
} as const satisfies Record<"start_recording" | "stop_recording", readonly (keyof BrowserParams)[]>;

/** Format provider-controlled recording origins without echoing invalid or secret-bearing input. */
export function formatRecordingScopeForDisplay(domains: readonly unknown[]): string {
	return domains
		.map(domain => {
			if (typeof domain !== "string") return "(invalid origin)";
			try {
				const url = new URL(domain);
				if (
					(url.protocol !== "http:" && url.protocol !== "https:") ||
					url.username ||
					url.password ||
					url.pathname !== "/" ||
					url.search ||
					url.hash ||
					url.hostname.includes("*")
				) {
					return "(invalid origin)";
				}
				return url.origin.toLowerCase();
			} catch {
				return "(invalid origin)";
			}
		})
		.join(", ");
}

function assertBrowserParams(params: BrowserParams): void {
	if (params.action !== "start_recording" && params.domains !== undefined) {
		throw new ToolError('Field domains is only accepted for action "start_recording".');
	}
	assertRecordingParams(params);
}
function assertRecordingParams(params: BrowserParams): void {
	if (params.action !== "start_recording" && params.action !== "stop_recording") return;
	const disallowed = RECORDING_DISALLOWED_FIELDS[params.action].filter(field => params[field] !== undefined);
	if (disallowed.length > 0) {
		throw new ToolError(`Action ${JSON.stringify(params.action)} does not accept: ${disallowed.join(", ")}`);
	}
}

/**
 * Browser tool: stateful, multi-tab. Five actions:
 * - `open`  → acquire/create a named tab on a browser kind (headless | spawned | connected) and optionally goto a url.
 * - `close` → release a named tab (or all tabs); dispose browser when refcount hits 0.
 * - `run`   → execute JS code against an existing tab with `page`/`browser`/`tab` helpers in scope.
 * - `start_recording` / `stop_recording` → capture the tab's sanitized network traffic to an `artifact://` HAR.
 */
export class BrowserTool implements AgentTool<typeof browserSchema, BrowserToolDetails> {
	readonly name = "browser";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<BrowserParams>;
		const lines = [`Action: ${typeof params.action === "string" ? params.action : "(missing)"}`];
		const tabName = typeof params.name === "string" ? params.name : DEFAULT_TAB_NAME;
		lines.push(`Tab: ${truncateForPrompt(tabName)}`);
		if (typeof params.url === "string" && params.url.length > 0) {
			lines.push(`URL: ${truncateForPrompt(params.url)}`);
		}
		if (typeof params.code === "string" && params.code.length > 0) {
			lines.push(`Code:\n${truncateForPrompt(params.code)}`);
		}
		if (params.action === "start_recording") {
			if (Array.isArray(params.domains) && params.domains.length > 0) {
				lines.push(`Scope: ${truncateForPrompt(formatRecordingScopeForDisplay(params.domains))}`);
			}
			lines.push(
				"Records this tab's network requests and responses. These may contain account or personal data " +
					"(auth tokens, cookies, emails, account IDs) and will be sanitized and persisted to a bounded artifact file.",
			);
		} else if (params.action === "stop_recording") {
			lines.push(
				"Finalizes this tab's recording, persists the sanitized HAR to a bounded artifact file, and returns only its URI and summary counts.",
			);
		}
		return lines;
	};
	readonly label = "Browser";
	readonly loadMode = "discoverable";
	readonly summary =
		"Control a headless browser to navigate, interact, and record network traffic to sanitized HAR artifacts";
	readonly parameters = browserSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof browserSchema.infer>[] = [
		{
			caption: "Open a tab",
			call: { action: "open", name: "docs", url: "https://example.com" },
		},
		{
			caption: "Read structured page data in the opened tab",
			call: {
				action: "run",
				name: "docs",
				code: "const obs = await tab.observe(); display(obs); return obs.elements.length;",
			},
		},
		{
			caption: "Click an observed element by id",
			call: {
				action: "run",
				name: "docs",
				code: "const obs = await tab.observe(); const link = obs.elements.find(e => e.role === 'link' && e.name === 'Sign in'); assert(link, 'Sign in link missing'); await (await tab.id(link.id)).click();",
			},
		},
		{
			caption: "Fill and submit a form via selectors",
			call: {
				action: "run",
				name: "docs",
				code: "await tab.fill('input[name=email]', 'me@example.com'); await tab.click('text/Continue');",
			},
		},
		{
			caption: "Screenshot to look at the page — no save path",
			call: {
				action: "run",
				name: "docs",
				code: "await tab.screenshot();",
			},
		},
		{
			caption: "Attach to an existing Electron app",
			call: {
				action: "open",
				name: "cursor",
				app: { path: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
			},
		},
		{
			caption: "Close every tab and kill spawned-app processes",
			call: { action: "close", all: true, kill: true },
		},
		{
			caption: "Start a scoped sanitized network recording",
			call: { action: "start_recording", name: "docs", domains: ["https://example.com"] },
		},
		{
			caption: "Stop recording and persist its HAR artifact",
			call: { action: "stop_recording", name: "docs" },
		},
	];

	constructor(private readonly session: ToolSession) {}
	#description?: string;
	get description(): string {
		this.#description ??= prompt.render(browserDescription, {});
		return this.#description;
	}

	/** Restart browser to apply mode changes (e.g. headless toggle). Drops only headless browsers. */
	async restartForModeChange(): Promise<void> {
		await dropHeadlessTabs();
	}

	async execute(
		_toolCallId: string,
		params: BrowserParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<BrowserToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		try {
			throwIfAborted(signal);
			const timeoutSeconds = clampTimeout("browser", params.timeout);
			const timeoutMs = timeoutSeconds * 1000;
			const name = params.name ?? DEFAULT_TAB_NAME;
			const details: BrowserToolDetails = { action: params.action, name };
			assertBrowserParams(params);
			switch (params.action) {
				case "open":
					return await this.#open(name, params, details, timeoutMs, signal);
				case "close":
					return await this.#close(name, params, details, timeoutMs, signal);
				case "run":
					return await this.#run(name, params, details, timeoutMs, signal);
				case "start_recording":
					return await this.#startRecording(name, params, details, timeoutMs, signal);
				case "stop_recording":
					return await this.#stopRecording(name, details, timeoutMs, signal);
				default:
					throw new ToolError(`Unsupported action: ${(params as BrowserParams).action}`);
			}
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			if (error instanceof Error && error.name === "AbortError") {
				throw new ToolAbortError();
			}
			throw error;
		}
	}

	async #open(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kind = resolveBrowserKind(params, this.session);
		details.browser = kind.kind;

		// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
		const existing = getTab(name);
		if (existing && !sameBrowserKind(existing.browser.kind, kind)) {
			throw new ToolError(
				`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
			);
		}

		const browser = await untilAborted(signal, () =>
			acquireBrowser(kind, {
				cwd: this.session.cwd,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				appArgs: params.app?.args,
				signal,
			}),
		);

		const result = await untilAborted(signal, () =>
			acquireTab(name, browser, {
				url: params.url,
				waitUntil: params.wait_until,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				target: params.app?.target,
				timeoutMs,
				dialogs: params.dialogs,
				signal,
				ownerSessionId: this.session.getSessionId?.() ?? undefined,
			}),
		);
		const tab = result.tab;
		const url = tab.info.url;
		const title = tab.info.title ?? "";
		details.url = url;
		details.viewport = tab.info.viewport;
		const verb = result.created ? "Opened" : "Reused";
		const lines = [
			`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`,
			`URL: ${url}`,
			title ? `Title: ${title}` : null,
		].filter((l): l is string => typeof l === "string");
		details.result = lines.join("\n");
		return toolResult(details).text(lines.join("\n")).done();
	}

	async #close(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const kill = !!params.kill;
		if (params.all) {
			const count = await untilAborted(signal, () => releaseAllTabs({ kill, timeoutMs }));
			details.result = `Closed ${count} tab(s)`;
			return toolResult(details).text(details.result).done();
		}
		const closed = await untilAborted(signal, () => releaseTab(name, { kill, timeoutMs }));
		details.result = closed ? `Closed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
		return toolResult(details).text(details.result).done();
	}

	async #run(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		if (!params.code?.trim()) {
			throw new ToolError("Missing required parameter 'code' for action 'run'.");
		}
		const tab = getTab(name);
		if (tab) {
			details.browser = tab.browser.kind.kind;
			details.url = tab.info.url;
		}

		const { displays, returnValue, screenshots } = await runInTab(name, {
			code: params.code,
			timeoutMs,
			signal,
			session: this.session,
		});

		if (screenshots.length) details.screenshots = screenshots;

		const content = [...displays];
		if (returnValue !== undefined) {
			content.push({ type: "text", text: stringifyReturnValue(returnValue) });
		}
		if (!content.length) {
			content.push({ type: "text", text: `Ran code on tab ${JSON.stringify(name)}` });
		}
		const textOnly = content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		// Final defense at the tool-result boundary: a single run can display
		// tens of KB (large JSON returns, dumped observations). Cap the combined
		// text inline; the full text stays recoverable via the artifact footer
		// when allocation succeeds.
		const cappedText = await enforceInlineByteCap(textOnly, {
			saveArtifact: full => saveBrowserOutputArtifact(this.session, full),
		});
		details.result = cappedText;
		if (cappedText !== textOnly) {
			const nonText = content.filter(c => c.type !== "text");
			return toolResult(details)
				.content([...nonText, { type: "text", text: cappedText }])
				.done();
		}
		return toolResult(details).content(content).done();
	}

	async #startRecording(
		name: string,
		params: BrowserParams,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const result = await startTabRecording(name, { domains: params.domains, timeoutMs, signal });
		details.browser = result.backend;
		const tab = getTab(name);
		if (tab) details.url = tab.info.url;
		details.scope = result.scope;

		const scopeText = result.scope.length > 0 ? result.scope.join(", ") : "(current origin)";
		const lines = [
			`Recording network traffic on tab ${JSON.stringify(name)} (${result.backend})`,
			`Scope: ${scopeText}`,
			"Requests and responses within scope may include account or personal data; the capture is sanitized and " +
				"saved to a bounded artifact when you stop the recording.",
		];
		details.result = lines.join("\n");
		return toolResult(details).text(details.result).done();
	}

	async #stopRecording(
		name: string,
		details: BrowserToolDetails,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BrowserToolDetails>> {
		const result = await stopTabRecording(name, { timeoutMs, signal });
		details.browser = result.backend;
		const tab = getTab(name);
		if (tab) details.url = tab.info.url;

		// Persist the HAR to an artifact before surfacing anything: the captured
		// traffic must never enter the tool text/details. Require both id and path,
		// and never serialize the HAR when the slot is unavailable.
		const alloc = await this.session.allocateOutputArtifact?.("browser-har");
		if (!alloc?.id || !alloc.path) {
			throw new ToolError(
				`Recording on tab ${JSON.stringify(name)} stopped, but no artifact slot is available to persist the HAR.`,
			);
		}
		try {
			await writeHarArtifact(alloc.path, result.har);
		} catch (error) {
			throw new ToolError("Failed to persist browser recording artifact.", { cause: error });
		}
		details.artifactId = alloc.id;
		details.recording = {
			entryCount: result.entryCount,
			capturedBodyCount: result.capturedBodyCount,
			omittedBodyCount: result.omittedBodyCount,
			totalBytes: result.totalBytes,
			truncated: result.truncated,
		};
		const lines = [
			`Stopped recording on tab ${JSON.stringify(name)} (${result.backend})`,
			`Sanitized HAR saved to artifact://${alloc.id}`,
			`Entries: ${result.entryCount} (bodies captured: ${result.capturedBodyCount}, omitted: ${result.omittedBodyCount})`,
			`Approx sanitized bytes: ${result.totalBytes}${result.truncated ? " (truncated at capture limit)" : ""}`,
			`Read it with: read artifact://${alloc.id}`,
		];
		details.result = lines.join("\n");
		return toolResult(details).text(details.result).done();
	}
}

/** Persist over-cap browser run output as a session artifact; mirrors the bash minimizer's save path. */
async function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("browser-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

/**
 * Injectable IO seam for {@link writeHarArtifact}. Defaults to real `node:fs/promises`
 * primitives; a test may override any subset (e.g. force `EXDEV` on rename, or a size
 * mismatch on stat) to exercise the cross-device and cleanup paths without `mock.module`.
 */
export interface HarArtifactIo {
	writeExclusive0600(target: string, content: string, onCreated?: () => void): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	stat(target: string): Promise<{ size: number }>;
	rm(target: string): Promise<void>;
}

const defaultHarArtifactIo: HarArtifactIo = {
	async writeExclusive0600(target, content, onCreated) {
		// Exclusive create at 0600, write, flush to disk, close.
		const handle = await fs.open(target, "wx", 0o600);
		try {
			onCreated?.();
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
	async rename(from, to) {
		await fs.rename(from, to);
	},
	async stat(target) {
		return { size: (await fs.stat(target)).size };
	},
	async rm(target) {
		await fs.rm(target, { force: true });
	},
};

let harArtifactIo: HarArtifactIo = defaultHarArtifactIo;

/** Test-only: override the atomic HAR write primitives; pass `undefined` to restore the real fs seam. */
export function setHarArtifactIoForTest(overrides: Partial<HarArtifactIo> | undefined): void {
	harArtifactIo = overrides ? { ...defaultHarArtifactIo, ...overrides } : defaultHarArtifactIo;
}

/**
 * Persist the sanitized HAR to `finalPath` atomically at 0600, matching the
 * artifact manager's hidden-temp convention. Stage the JSON at a leading-dot
 * random sibling, open it exclusively at 0600, fsync + close, then atomically
 * rename. On `EXDEV` (cross-device rename), write the final path directly
 * (exclusive, 0600), fsync, verify its byte size, then drop the sibling. Any
 * failure removes the hidden/partial files, so no incomplete or
 * over-permissioned artifact is ever left behind.
 */
async function writeHarArtifact(finalPath: string, har: Record<string, unknown>): Promise<void> {
	const json = JSON.stringify(har);
	const expectedBytes = Buffer.byteLength(json, "utf8");
	const dir = path.dirname(finalPath);
	const tmpPath = path.join(dir, `.${path.basename(finalPath)}.${Snowflake.next()}.tmp`);
	let ownsFinalPath = false;
	try {
		await harArtifactIo.writeExclusive0600(tmpPath, json);
		try {
			await harArtifactIo.rename(tmpPath, finalPath);
			ownsFinalPath = true;
		} catch (renameError) {
			const crossDevice = renameError instanceof Error && "code" in renameError && renameError.code === "EXDEV";
			if (!crossDevice) throw renameError;
			await harArtifactIo.writeExclusive0600(finalPath, json, () => {
				ownsFinalPath = true;
			});
			const { size } = await harArtifactIo.stat(finalPath);
			if (size !== expectedBytes) {
				throw new ToolError(`HAR artifact verification failed: wrote ${size} of ${expectedBytes} bytes`);
			}
			await harArtifactIo.rm(tmpPath).catch(() => {});
		}
	} catch (error) {
		await harArtifactIo.rm(tmpPath).catch(() => {});
		if (ownsFinalPath) await harArtifactIo.rm(finalPath).catch(() => {});
		throw error;
	}
}

function describeBrowser(handle: BrowserHandle): string {
	if (!("browser" in handle)) {
		return `cmux browser (${handle.kind.surface ?? "split"})`;
	}
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.surface ?? "split"}`;
	}
}

function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless;
	if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
	if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
	if (a.kind === "cmux" && b.kind === "cmux") return a.socketPath === b.socketPath;
	return false;
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
