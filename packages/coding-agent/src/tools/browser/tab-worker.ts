import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import type { HTMLElement } from "linkedom";
import type { Browser, CDPSession, Dialog, ElementHandle, Locator, Page, Response } from "patchright";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import type { JsDisplayOutput } from "../../eval/js/shared/types";
import { resizeImage } from "../../utils/image-resize";
import { resolveToCwd } from "../path-utils";
import { formatScreenshot } from "../render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import { applyViewport, connectBrowser, connectOverCDP, DEFAULT_VIEWPORT, pageTargetId } from "./launch";
import { extractReadableFromHtml, type ReadableFormat } from "./readable";
import type {
	Observation,
	ObservationEntry,
	ReadyInfo,
	RunErrorPayload,
	RunResultOk,
	ScreenshotResult,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
	WorkerInitPayload,
} from "./tab-protocol";

declare global {
	interface Element extends HTMLElement {}
	function getComputedStyle(element: Element): Record<string, unknown>;
	var innerWidth: number;
	var innerHeight: number;
	var document: {
		elementFromPoint(x: number, y: number): Element | null;
	};
}

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

type DialogPolicy = "accept" | "dismiss";
type DragTarget = string | { readonly x: number; readonly y: number };
type ActionabilityResult = { ok: true; x: number; y: number } | { ok: false; reason: string };

/**
 * Per-op ceiling for puppeteer-internal helpers that should resolve quickly
 * (`observe`, `screenshot`, `extract`). Kept below the default 30s cell budget so a
 * single stalled helper fails fast with a named error and leaves budget for the rest
 * of the cell. Effective cap is `min(cellBudget, QUICK_OP_TIMEOUT_MS)`.
 */
const QUICK_OP_TIMEOUT_MS = 20_000;

interface ScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	save?: string;
	silent?: boolean;
}

interface TabApi {
	readonly name: string;
	readonly page: Page;
	readonly signal?: AbortSignal;
	url(): string;
	title(): Promise<string>;
	goto(
		url: string,
		opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" },
	): Promise<void>;
	observe(opts?: { includeAll?: boolean; viewportOnly?: boolean }): Promise<Observation>;
	screenshot(opts?: ScreenshotOptions): Promise<ScreenshotResult>;
	extract(format?: ReadableFormat): Promise<string>;
	click(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	fill(selector: string, value: string): Promise<void>;
	press(key: string, opts?: { selector?: string }): Promise<void>;
	scroll(deltaX: number, deltaY: number): Promise<void>;
	drag(from: DragTarget, to: DragTarget): Promise<void>;
	waitFor(selector: string): Promise<Locator>;
	evaluate<TResult, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => TResult | Promise<TResult>),
		...args: TArgs
	): Promise<TResult>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: string[]): Promise<string[]>;
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
	waitForResponse(
		pattern: string | RegExp | ((response: Response) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<Response>;
	id(n: string): Promise<Locator>;
}

function normalizeSelector(selector: string): string {
	if (!selector) return selector;
	// Reject unknown p- prefixes (only the documented legacy ones are translated).
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(
			`Unsupported selector prefix. Use CSS or query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
		);
	}
	// Translate Puppeteer-style query-handler selectors to Playwright equivalents.
	// Puppeteer used slash syntax (aria/X, text/X); Playwright uses engine=value (text=X, xpath=X)
	// and pierces shadow DOM by default (no pierce/ prefix needed).
	if (selector.startsWith("p-text/")) return `text=${selector.slice("p-text/".length)}`;
	if (selector.startsWith("text/")) return `text=${selector.slice("text/".length)}`;
	if (selector.startsWith("p-xpath/")) return `xpath=${selector.slice("p-xpath/".length)}`;
	if (selector.startsWith("xpath/")) return `xpath=${selector.slice("xpath/".length)}`;
	if (selector.startsWith("p-pierce/")) return selector.slice("p-pierce/".length);
	if (selector.startsWith("pierce/")) return selector.slice("pierce/".length);
	if (selector.startsWith("p-aria/") || selector.startsWith("aria/")) {
		const rest = selector.startsWith("p-aria/") ? selector.slice("p-aria/".length) : selector.slice("aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		const accessibleName = (name ?? rest).trim();
		// Puppeteer's aria/ handler matched the computed accessible name (aria-label,
		// visible text, title). Use Playwright's role= engine with [name="..."] which
		// also matches the accessible name. When no explicit role was given (aria/X
		// with just a name), use a generic role=* match by omitting the role.
		// Only infer a role when the syntax is `role[name="..."]` (word followed
		// by `[`). A bare word like "Save" is the accessible name, not a role.
		const roleMatch = rest.match(/^(\w+)\s*\[\s*name\s*=/);
		const role = roleMatch?.[1];
		if (role) {
			return `role=${role}[name="${accessibleName}"]`;
		}
		// No role prefix — just match by accessible name via text= as a fallback.
		return `text=${accessibleName}`;
	}
	return selector;
}

function cloneSafe(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		structuredClone(value);
		return value;
	} catch {}
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {}
	return String(value);
}

/**
 * Strip `user:pass@` from a URL before surfacing it in tool outputs / details
 * so Basic Auth credentials don't leak into transcripts. Returns the original
 * string verbatim when it doesn't parse as a URL or when there are no
 * credentials to redact.
 */
function redactUrlCredentials(url: string): string {
	if (!url || (!url.includes("@") && !url.includes("//"))) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

function errorPayload(error: unknown): RunErrorPayload {
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: true, isAbort: false };
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
	}
	return { name: "Error", message: String(error), isToolError: false, isAbort: false };
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function replyError(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const Ctor = payload.isToolError ? ToolError : Error;
	const err = new Ctor(payload.message);
	if (payload.name) err.name = payload.name;
	if (payload.stack) err.stack = payload.stack;
	return err;
}

async function resolveActionableQueryHandlerClickTarget(handles: ElementHandle[]): Promise<ElementHandle | null> {
	const candidates: Array<{
		handle: ElementHandle;
		rect: { x: number; y: number; w: number; h: number };
		ownedProxy?: ElementHandle;
	}> = [];
	for (const handle of handles) {
		let clickable: ElementHandle = handle;
		let clickableProxy: ElementHandle | null = null;
		try {
			const proxy = await handle.evaluateHandle(el => {
				const target =
					(el as Element).closest(
						'a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]',
					) ?? el;
				return target;
			});
			clickableProxy = proxy.asElement() as ElementHandle | null;
			if (clickableProxy) clickable = clickableProxy;
		} catch {}
		try {
			const intersecting = await clickable.isVisible();
			if (!intersecting) continue;
			const rect = (await clickable.evaluate(el => {
				const r = (el as Element).getBoundingClientRect();
				return {
					x: r.left,
					y: r.top,
					w: r.width,
					h: r.height,
					inViewport:
						r.left < globalThis.innerWidth && r.right > 0 && r.top < globalThis.innerHeight && r.bottom > 0,
				};
			})) as { x: number; y: number; w: number; h: number; inViewport: boolean };
			if (rect.w < 1 || rect.h < 1) continue;
			// Filter out off-viewport elements before sorting — isVisible() only
			// checks CSS visibility, not viewport intersection. Without this, an
			// off-screen element with a lower y position wins the sort, and
			// isClickActionable rejects it as off-viewport every retry until timeout.
			if (!rect.inViewport) continue;
			candidates.push({ handle: clickable, rect, ownedProxy: clickableProxy ?? undefined });
		} catch {
		} finally {
			if (clickableProxy && clickableProxy !== handle && clickable !== clickableProxy) {
				await clickableProxy.dispose().catch(() => undefined);
			}
		}
	}
	if (!candidates.length) return null;
	candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
	const winner = candidates[0]?.handle ?? null;
	for (let i = 1; i < candidates.length; i++) {
		const candidate = candidates[i]!;
		if (candidate.ownedProxy) await candidate.ownedProxy.dispose().catch(() => undefined);
	}
	return winner;
}

async function isClickActionable(handle: ElementHandle): Promise<ActionabilityResult> {
	return (await handle.evaluate(el => {
		const element = el as HTMLElement;
		const style = globalThis.getComputedStyle(element);
		if (style.display === "none") return { ok: false as const, reason: "display:none" };
		if (style.visibility === "hidden") return { ok: false as const, reason: "visibility:hidden" };
		if (style.pointerEvents === "none") return { ok: false as const, reason: "pointer-events:none" };
		if (Number(style.opacity) === 0) return { ok: false as const, reason: "opacity:0" };
		const r = element.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return { ok: false as const, reason: "zero-size" };
		const left = Math.max(0, Math.min(globalThis.innerWidth, r.left));
		const right = Math.max(0, Math.min(globalThis.innerWidth, r.right));
		const top = Math.max(0, Math.min(globalThis.innerHeight, r.top));
		const bottom = Math.max(0, Math.min(globalThis.innerHeight, r.bottom));
		if (right - left < 1 || bottom - top < 1) return { ok: false as const, reason: "off-viewport" };
		const x = Math.floor((left + right) / 2);
		const y = Math.floor((top + bottom) / 2);
		const topEl = globalThis.document.elementFromPoint(x, y);
		if (!topEl) return { ok: false as const, reason: "elementFromPoint-null" };
		if (topEl === element || element.contains(topEl) || (topEl as Element).contains(element))
			return { ok: true as const, x, y };
		return { ok: false as const, reason: "obscured" };
	})) as ActionabilityResult;
}

async function clickQueryHandlerText(
	page: Page,
	selector: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const clickSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const start = Date.now();
	let lastSeen = 0;
	let lastReason: string | null = null;
	while (Date.now() - start < timeoutMs) {
		throwIfAborted(clickSignal);
		const handles = (await untilAborted(clickSignal, () =>
			page.locator(selector).elementHandles(),
		)) as ElementHandle[];
		try {
			lastSeen = handles.length;
			const target = await resolveActionableQueryHandlerClickTarget(handles);
			if (!target) {
				lastReason = handles.length ? "no-visible-candidate" : "no-matches";
				await Bun.sleep(100);
				continue;
			}
			const actionability = await isClickActionable(target);
			if (!actionability.ok) {
				lastReason = actionability.reason;
				await Bun.sleep(100);
				continue;
			}
			try {
				await untilAborted(clickSignal, () => target.click());
				return;
			} catch (err) {
				lastReason = err instanceof Error ? err.message : String(err);
				await Bun.sleep(100);
			}
		} finally {
			await Promise.all(handles.map(async handle => handle.dispose().catch(() => undefined)));
		}
	}
	throw new ToolError(
		`Timed out clicking ${selector} (seen ${lastSeen} matches; last reason: ${lastReason ?? "unknown"}). ` +
			"If there are multiple matching elements, use observe + tab.id() or a more specific selector.",
	);
}

/** Roles considered interactive for aria-snapshot filtering when includeAll is false. */
const INTERACTIVE_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
]);

/** State attributes to extract from aria-snapshot [attr=val] tokens. */
const STATE_ATTRS = new Set([
	"checked",
	"pressed",
	"selected",
	"expanded",
	"disabled",
	"readonly",
	"required",
	"modal",
	"focused",
	"multiline",
	"multiselectable",
]);

interface ParsedAriaNode {
	role: string;
	name?: string;
	value?: string;
	ref?: string;
	box?: { x: number; y: number; w: number; h: number };
	states: string[];
}

/**
 * Parse the YAML-like output of `page.ariaSnapshot({ mode: "ai", boxes: true })` into
 * `ObservationEntry[]`. Each line looks like:
 *   `- role "name" [ref=eN] [box=x,y,w,h] [checked=true] [disabled] ...`
 * Indentation encodes nesting; we only need flat per-line data.
 */
function parseAriaSnapshot(
	snapshot: string,
	options: { includeAll: boolean; viewportOnly: boolean; viewportWidth: number; viewportHeight: number },
): ObservationEntry[] {
	const entries: ObservationEntry[] = [];
	const lines = snapshot.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("- ")) continue;
		const node = parseAriaLine(trimmed);
		if (!node?.ref) continue;
		// Match old isInteractiveNode: role-based OR has stateful attributes.
		const hasState = node.states.length > 0;
		if (!options.includeAll && !INTERACTIVE_ROLES.has(node.role) && !hasState) continue;
		if (options.viewportOnly && node.box) {
			// Box is [x,y,w,h] relative to viewport. Skip elements fully outside viewport.
			const fullyLeft = node.box.x + node.box.w < 0;
			const fullyAbove = node.box.y + node.box.h < 0;
			const fullyRight = node.box.x > options.viewportWidth;
			const fullyBelow = node.box.y > options.viewportHeight;
			if (fullyLeft || fullyAbove || fullyRight || fullyBelow) continue;
		}
		entries.push({
			id: node.ref,
			role: node.role,
			name: node.name,
			value: node.value,
			states: node.states.slice(),
		});
	}
	return entries;
}

/** Parse a single aria-snapshot line: `- role "name" [ref=eN] [box=x,y,w,h] [state...]: value` */
function parseAriaLine(line: string): ParsedAriaNode | null {
	// Strip leading "- "
	const rest = line.slice(2).trim();
	if (!rest) return null;

	// Extract the role and optional quoted name first, then parse attributes
	// from the remaining text. This prevents brackets inside quoted names
	// (e.g. "Docs [beta]") from being mis-parsed as attributes or truncating
	// the role/name portion.
	let role: string;
	let name: string | undefined;
	let afterName: string;

	// Match: `role "quoted name" rest...` or `role [attr=val] rest...` (no name)
	const nameMatch = rest.match(/^(\S+)\s+"((?:[^"\\]|\\.)*)"\s*(.*)$/);
	if (nameMatch) {
		role = nameMatch[1]!.replace(/:$/, "");
		name = nameMatch[2]!.replace(/\\(.)/g, "$1");
		afterName = nameMatch[3] ?? "";
	} else {
		// No quoted name — role is the first token, attributes follow in afterName
		const firstSpace = rest.search(/\s/);
		if (firstSpace >= 0) {
			role = rest.slice(0, firstSpace).replace(/:$/, "");
			afterName = rest.slice(firstSpace + 1);
		} else {
			role = rest.replace(/:$/, "").trim();
			afterName = "";
		}
	}

	// Extract bracketed attributes from the text after the name: [ref=eN], [box=x,y,w,h], etc.
	const attrs: string[] = [];
	let attrStart = -1;
	for (let i = 0; i < afterName.length; i++) {
		if (afterName[i] === "[") attrStart = i;
		else if (afterName[i] === "]" && attrStart >= 0) {
			attrs.push(afterName.slice(attrStart + 1, i));
			attrStart = -1;
		}
	}

	// Trailing text after the last `]` is the element value (e.g. textbox content).
	const lastBracket = afterName.lastIndexOf("]");
	const trailingText = lastBracket >= 0 ? afterName.slice(lastBracket + 1).trim() : afterName.trim();
	const value = trailingText.startsWith(":") ? trailingText.slice(1).trim() : trailingText || undefined;

	let ref: string | undefined;
	let box: { x: number; y: number; w: number; h: number } | undefined;
	const states: string[] = [];

	for (const attr of attrs) {
		const eqIdx = attr.indexOf("=");
		const key = eqIdx >= 0 ? attr.slice(0, eqIdx).trim() : attr.trim();
		const val = eqIdx >= 0 ? attr.slice(eqIdx + 1).trim() : "";
		if (key === "ref") {
			ref = val;
		} else if (key === "box") {
			const parts = val.split(",").map(n => Number.parseFloat(n));
			if (parts.length === 4 && parts.every(n => !Number.isNaN(n))) {
				box = { x: parts[0]!, y: parts[1]!, w: parts[2]!, h: parts[3]! };
			}
		} else if (STATE_ATTRS.has(key)) {
			states.push(val ? `${key}=${val}` : key);
		}
	}

	return { role, name, value, ref, box, states };
}

/**
 * Enrich observation entries with metadata not available in ariaSnapshot:
 * `description` (aria-description) and `keyshortcuts` (aria-keyshortcuts).
 *
 * Uses CDP `Accessibility.getFullAXTree` to fetch the full AX tree, then matches
 * CDP nodes to parsed entries by (role, name) in DOM order. Both ariaSnapshot
 * and the CDP tree traverse in DOM order, so a sequential match is reliable
 * even with duplicate elements. Stealth-safe: does not trigger Runtime.enable.
 *
 * Fails silently — if the CDP call fails, entries are returned unchanged.
 */
async function enrichWithCdpAxMetadata(page: Page, entries: ObservationEntry[]): Promise<void> {
	if (!entries.length) return;
	let session: CDPSession;
	try {
		session = await page.context().newCDPSession(page);
	} catch {
		return;
	}
	try {
		const result = (await session.send("Accessibility.getFullAXTree")) as {
			nodes?: Array<{
				role?: { value?: string };
				name?: { value?: string };
				description?: { value?: string };
				properties?: Array<{ name: string; value?: { value?: unknown } }>;
			}>;
		};
		// Build a queue of ALL CDP nodes (not just those with metadata) so the
		// sequential matcher preserves DOM order across duplicates. If we only
		// queued nodes with description/keyshortcuts, a later duplicate's metadata
		// could be applied to an earlier entry with the same role/name.
		const cdpQueue: Array<{
			role: string;
			name: string;
			description?: string;
			keyshortcuts?: string;
		}> = [];
		for (const node of result.nodes ?? []) {
			const role = node.role?.value;
			if (
				!role ||
				role === "RootWebArea" ||
				role === "none" ||
				role === "generic" ||
				role === "StaticText" ||
				role === "InlineTextBox"
			)
				continue;
			const name = node.name?.value ?? "";
			const description = node.description?.value;
			const keyshortcuts = node.properties?.find(p => p.name === "keyshortcuts")?.value?.value as string | undefined;
			cdpQueue.push({ role, name, description, keyshortcuts });
		}
		let cdpIdx = 0;
		for (const entry of entries) {
			while (cdpIdx < cdpQueue.length) {
				const cdp = cdpQueue[cdpIdx]!;
				if (cdp.role === entry.role && cdp.name === (entry.name ?? "")) {
					// Only enrich if this CDP node actually has metadata.
					if (cdp.description) entry.description = cdp.description;
					if (cdp.keyshortcuts) entry.keyshortcuts = cdp.keyshortcuts;
					cdpIdx++;
					break;
				}
				cdpIdx++;
			}
		}
	} catch {
		// CDP Accessibility domain may not be available — silently skip.
	} finally {
		await session.detach().catch(() => undefined);
	}
}
export interface InflightOp {
	label: string;
	startedAt: number;
}

interface ActiveRun {
	id: string;
	ac: AbortController;
	displays: RunResultOk["displays"];
	screenshots: ScreenshotResult[];
	pendingTools: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
	/** Helper invocations currently awaiting the page/network, keyed by op id. */
	inflight: Map<number, InflightOp>;
	opCounter: number;
}

/** Human-readable label for a screenshot op, used in op tracking + timeout errors. */
export function describeScreenshot(opts?: ScreenshotOptions): string {
	if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
	if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
	return "tab.screenshot()";
}

/** Map an explicit save path's extension to a puppeteer capture format (default png). */
export function imageFormatForPath(filePath: string): "png" | "jpeg" | "webp" {
	switch (path.extname(filePath).toLowerCase()) {
		case ".webp":
			return "webp";
		case ".jpg":
		case ".jpeg":
			return "jpeg";
		default:
			return "png";
	}
}

/** Summarize still-running helpers (oldest first) so a cell timeout names what stalled. */
export function describeInflight(inflight: Map<number, InflightOp>): string {
	const now = Date.now();
	return [...inflight.values()]
		.sort((a, b) => a.startedAt - b.startedAt)
		.map(op => `${op.label} (${((now - op.startedAt) / 1000).toFixed(1)}s)`)
		.join(", ");
}

export class WorkerCore {
	#transport: Transport;
	#browser?: Browser;
	#page?: Page;
	#targetId?: string;
	#validRefs = new Set<string>();
	#active: ActiveRun | null = null;
	#runtime: JsRuntime | null = null;
	#unsub: () => void;
	#mode?: WorkerInitPayload["mode"];
	#dialogPolicy?: DialogPolicy;
	#dialogHandler?: (dialog: Dialog) => void;

	constructor(transport: Transport) {
		this.#transport = transport;
		this.#unsub = this.#transport.onMessage(msg => {
			void this.#handleMessage(msg as WorkerInbound);
		});
	}

	async #handleMessage(msg: WorkerInbound): Promise<void> {
		switch (msg.type) {
			case "init":
				await this.#init(msg.payload);
				return;
			case "run":
				await this.#run(msg);
				return;
			case "abort":
				if (this.#active?.id === msg.id) this.#active.ac.abort(new ToolAbortError());
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				await this.#close();
				return;
		}
	}

	async #init(payload: WorkerInitPayload): Promise<void> {
		try {
			this.#mode = payload.mode;
			if (payload.mode === "headless") {
				this.#browser = await connectBrowser(payload.endpoint);
				this.#page = await this.#browser.newPage();
				await applyViewport(this.#page, payload.viewport);
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
				if (payload.url) {
					const rawWaitUntil = payload.waitUntil ?? "load";
					const waitUntil =
						rawWaitUntil === "networkidle0" || rawWaitUntil === "networkidle2" ? "networkidle" : rawWaitUntil;
					await this.#page.goto(payload.url, {
						// Default to "load" because dev servers with HMR/WS never reach networkidle.
						waitUntil,
						timeout: payload.timeoutMs,
					});
				}
			} else {
				this.#browser = await connectOverCDP(payload.endpoint);
				this.#page = await this.#findAttachedPage(payload.targetId);
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			}
			this.#targetId = await pageTargetId(this.#page);
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#transport.send({ type: "init-failed", error: errorPayload(error) });
		}
	}

	async #findAttachedPage(targetId: string): Promise<Page> {
		if (!this.#browser) throw new ToolError("Browser is not connected");
		const pages = this.#browser.contexts().flatMap(ctx => ctx.pages());
		for (const page of pages) {
			const tid = await pageTargetId(page).catch(() => "");
			if (tid === targetId) return page;
		}
		throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
	}

	async #currentReadyInfo(): Promise<ReadyInfo> {
		const page = this.#requirePage();
		const targetId = this.#targetId ?? (await pageTargetId(page));
		this.#targetId = targetId;
		return {
			url: redactUrlCredentials(page.url()),
			title: await page.title().catch(() => undefined),
			viewport: page.viewportSize() ?? { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
			targetId,
		};
	}

	#applyDialogPolicy(policy: DialogPolicy): void {
		const page = this.#requirePage();
		if (this.#dialogPolicy === policy && this.#dialogHandler) return;
		if (this.#dialogHandler) page.off("dialog", this.#dialogHandler);
		const handler = (dialog: Dialog): void => {
			const action = policy === "accept" ? dialog.accept() : dialog.dismiss();
			void action.catch(err =>
				this.#log("debug", "Dialog auto-handler failed", {
					policy,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		};
		page.on("dialog", handler);
		this.#dialogPolicy = policy;
		this.#dialogHandler = handler;
	}

	async #postReadyInfo(): Promise<void> {
		try {
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo() });
		} catch (error) {
			this.#log("debug", "Failed to refresh tab info", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #run(msg: Extract<WorkerInbound, { type: "run" }>): Promise<void> {
		if (this.#active) {
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: false,
				error: errorPayload(new ToolError("Tab worker is busy")),
			});
			return;
		}
		const timeoutSignal = AbortSignal.timeout(msg.timeoutMs);
		const ac = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal]);
		const displays: RunResultOk["displays"] = [];
		const screenshots: ScreenshotResult[] = [];
		const active: ActiveRun = {
			id: msg.id,
			ac,
			displays,
			screenshots,
			pendingTools: new Map(),
			inflight: new Map(),
			opCounter: 0,
		};
		this.#active = active;
		try {
			throwIfAborted(signal);
			const page = this.#requirePage();
			const browser = this.#requireBrowser();
			const tabApi = this.#createTabApi(msg.name, msg.timeoutMs, signal, msg.session, displays, screenshots, active);
			const runtime = this.#ensureRuntime(msg.session);
			runtime.setCwd(msg.session.cwd);
			runtime.setRunScope({
				page,
				browser,
				tab: tabApi,
				assert: (cond: unknown, text?: string): void => {
					if (!cond) throw new ToolError(text ?? "Assertion failed");
				},
				wait: (ms: number): Promise<void> => Bun.sleep(ms),
			});
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				if (timeoutSignal.aborted) {
					const stalled = describeInflight(active.inflight);
					rejectCancel(
						new ToolError(
							`Browser code execution timed out after ${msg.timeoutMs}ms${stalled ? ` (stalled on ${stalled})` : ""}`,
						),
					);
				} else {
					rejectCancel(new ToolAbortError());
				}
				// Cancel in-flight tool calls so user code's awaited proxies reject promptly.
				for (const pending of active.pendingTools.values()) {
					pending.reject(new ToolAbortError());
				}
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				const hooks = this.#hooksForActiveRun();
				if (!hooks) throw new ToolError("Browser runtime started without an active run");
				const returnValue = await Promise.race([
					runtime.run(msg.code, `browser-run-${msg.id}.js`, hooks, { runId: msg.id, cwd: msg.session.cwd }),
					cancelRejection,
				]);
				await this.#postReadyInfo();
				this.#transport.send({
					type: "result",
					id: msg.id,
					ok: true,
					payload: { displays, returnValue: cloneSafe(returnValue), screenshots },
				});
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(error) });
		} finally {
			if (this.#active?.id === msg.id) this.#active = null;
		}
	}

	#ensureRuntime(session: SessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({
			initialCwd: session.cwd,
			sessionId: `browser-tab-${this.#targetId ?? "unknown"}`,
		});
		return this.#runtime;
	}

	#hooksForActiveRun(): RuntimeHooks | null {
		const active = this.#active;
		if (!active) return null;
		return {
			// console.* output stays on the supervisor log channel — matches pre-runtime behavior
			// where browser cells didn't surface `console.log` to the model.
			onText: chunk => this.#log("debug", chunk.replace(/\n$/, "")),
			onDisplay: output => this.#pushDisplay(active.displays, output),
			callTool: (name, args) => this.#callTool(active, name, args),
		};
	}

	#pushDisplay(displays: RunResultOk["displays"], output: JsDisplayOutput): void {
		if (output.type === "image") {
			displays.push({ type: "image", data: output.data, mimeType: output.mimeType });
			return;
		}
		if (output.type === "json") {
			displays.push({ type: "text", text: safeJsonStringify(output.data) });
			return;
		}
		// status — surface as compact JSON so helper side effects (read/write/tree) appear in
		// the cell result alongside explicit display() output.
		displays.push({ type: "text", text: safeJsonStringify(output.event) });
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tab-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const active = this.#active;
		if (!active) return;
		const pending = active.pendingTools.get(id);
		if (!pending) return;
		active.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	/**
	 * Wrap a tab helper so it (a) registers in the active run's in-flight map for
	 * timeout diagnostics and (b) honors an optional per-op deadline that fails fast
	 * with a named error instead of silently consuming the whole cell budget. Pass
	 * `Number.POSITIVE_INFINITY` for `perOpTimeoutMs` to bound the op only by the cell
	 * budget (used for `evaluate` running user code and for locator helpers that already
	 * carry puppeteer's own `.setTimeout(timeoutMs)`).
	 */
	async #runOp<T>(
		active: ActiveRun,
		label: string,
		cellSignal: AbortSignal,
		perOpTimeoutMs: number,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const opId = active.opCounter++;
		active.inflight.set(opId, { label, startedAt: Date.now() });
		const capped = Number.isFinite(perOpTimeoutMs) && perOpTimeoutMs > 0;
		const opTimeout = capped ? AbortSignal.timeout(perOpTimeoutMs) : undefined;
		const opSignal = opTimeout ? AbortSignal.any([cellSignal, opTimeout]) : cellSignal;
		try {
			return await fn(opSignal);
		} catch (err) {
			// Per-op deadline fired (not the cell budget, not an explicit abort) → named, actionable error.
			if (opTimeout?.aborted && !cellSignal.aborted) {
				throw new ToolError(`${label} timed out after ${perOpTimeoutMs}ms`);
			}
			throw err;
		} finally {
			active.inflight.delete(opId);
		}
	}

	#createTabApi(
		name: string,
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
		displays: RunResultOk["displays"],
		screenshots: ScreenshotResult[],
		active: ActiveRun,
	): TabApi {
		const page = this.#requirePage();
		const quickOpMs = Math.min(timeoutMs, QUICK_OP_TIMEOUT_MS);
		const INF = Number.POSITIVE_INFINITY;
		const op = <T>(label: string, perOpMs: number, fn: (sig: AbortSignal) => Promise<T>): Promise<T> =>
			this.#runOp(active, label, signal, perOpMs, fn);
		return {
			name,
			page,
			signal,
			url: () => page.url(),
			title: () => op("tab.title()", INF, sig => untilAborted(sig, () => page.title())),
			goto: (url, opts) =>
				op(`tab.goto(${JSON.stringify(url)})`, INF, async sig => {
					this.#clearElementCache();
					const waitUntil = opts?.waitUntil ?? "load";
					// Map puppeteer waitUntil values to Playwright equivalents.
					const mapped = waitUntil === "networkidle0" || waitUntil === "networkidle2" ? "networkidle" : waitUntil;
					await untilAborted(sig, () => page.goto(url, { waitUntil: mapped, timeout: timeoutMs }));
				}),
			observe: opts => op("tab.observe()", quickOpMs, sig => this.#collectObservation({ ...opts, signal: sig })),
			screenshot: opts =>
				op(describeScreenshot(opts), quickOpMs, sig =>
					this.#captureScreenshot(session, displays, screenshots, sig, opts),
				),
			extract: (format = "markdown") =>
				op(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async sig => {
					const html = (await untilAborted(sig, () => page.content())) as string;
					const result = await extractReadableFromHtml(html, page.url(), format);
					if (!result) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) found no readable content on ${page.url()}`,
						);
					}
					const content = format === "markdown" ? result.markdown : result.text;
					if (!content) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${page.url()}`,
						);
					}
					return content;
				}),
			click: selector =>
				op(`tab.click(${JSON.stringify(selector)})`, INF, async sig => {
					const resolved = normalizeSelector(selector);
					if (resolved.startsWith("text=")) await clickQueryHandlerText(page, resolved, timeoutMs, sig);
					else await untilAborted(sig, () => page.locator(resolved).click({ timeout: timeoutMs }));
				}),
			type: (selector, text) =>
				op(`tab.type(${JSON.stringify(selector)})`, INF, async sig => {
					const handle = (await untilAborted(sig, () =>
						page.locator(normalizeSelector(selector)).elementHandle({ timeout: timeoutMs }),
					)) as ElementHandle;
					try {
						await untilAborted(sig, () => handle.type(text, { delay: 0 }));
					} finally {
						await handle.dispose();
					}
				}),
			fill: (selector, value) =>
				op(`tab.fill(${JSON.stringify(selector)})`, INF, sig =>
					untilAborted(sig, () => page.locator(normalizeSelector(selector)).fill(value, { timeout: timeoutMs })),
				),
			press: (key, opts) =>
				op(`tab.press(${JSON.stringify(key)})`, INF, async sig => {
					const selector = opts?.selector;
					if (selector) await untilAborted(sig, () => page.focus(normalizeSelector(selector)));
					await untilAborted(sig, () => page.keyboard.press(key));
				}),
			scroll: (deltaX, deltaY) =>
				op("tab.scroll()", INF, sig => untilAborted(sig, () => page.mouse.wheel(deltaX, deltaY))),
			drag: (from, to) => op("tab.drag()", INF, sig => this.#drag(from, to, sig)),
			waitFor: selector =>
				op(`tab.waitFor(${JSON.stringify(selector)})`, INF, async sig => {
					const loc = page.locator(normalizeSelector(selector));
					await untilAborted(sig, () => loc.waitFor({ state: "attached", timeout: timeoutMs }));
					return loc;
				}),
			evaluate: (fn, ...args) =>
				op("tab.evaluate()", INF, sig =>
					untilAborted(sig, () => {
						if (typeof fn === "string") return page.evaluate(fn);
						// Playwright's page.evaluate forwards only one optional arg, not variadic
						// args like Puppeteer's. For 0-1 args, pass directly. For 2+ args, pack
						// into an array and use Function.toString() + eval to reconstruct the
						// callback inside the page (functions aren't serializable as arg values).
						const pageFn = fn as (...a: unknown[]) => unknown;
						if (args.length <= 1) return page.evaluate(pageFn as never, args[0] as never);
						return page.evaluate(
							({ src, args: a }: { src: string; args: unknown[] }) => {
								const f = new Function(`return (${src})`)() as (...a: unknown[]) => unknown;
								return f(...a);
							},
							{ src: pageFn.toString(), args } as never,
						);
					}),
				) as never,
			scrollIntoView: selector =>
				op(`tab.scrollIntoView(${JSON.stringify(selector)})`, INF, async sig => {
					const handle = (await untilAborted(sig, () =>
						page.locator(normalizeSelector(selector)).elementHandle({ timeout: timeoutMs }),
					)) as ElementHandle;
					try {
						await untilAborted(sig, () =>
							handle.evaluate(el => {
								const target = el as unknown as {
									scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
								};
								target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
							}),
						);
					} finally {
						await handle.dispose().catch(() => undefined);
					}
				}),
			select: (selector, ...values) =>
				op(`tab.select(${JSON.stringify(selector)})`, INF, sig => this.#select(selector, values, timeoutMs, sig)),
			uploadFile: (selector, ...filePaths) =>
				op(`tab.uploadFile(${JSON.stringify(selector)})`, INF, sig =>
					this.#uploadFile(selector, filePaths, timeoutMs, sig, session),
				),
			waitForUrl: (pattern, opts) =>
				op("tab.waitForUrl()", INF, sig => this.#waitForUrl(pattern, opts?.timeout ?? timeoutMs, sig)),
			waitForResponse: (pattern, opts) =>
				op("tab.waitForResponse()", INF, sig => this.#waitForResponse(pattern, opts?.timeout ?? timeoutMs, sig)),
			id: id => this.#resolveCachedHandle(id),
		};
	}

	async #collectObservation(options: {
		includeAll?: boolean;
		viewportOnly?: boolean;
		signal?: AbortSignal;
	}): Promise<Observation> {
		const page = this.#requirePage();
		this.#clearElementCache();
		const includeAll = options.includeAll ?? false;
		const viewportOnly = options.viewportOnly ?? false;
		// Use Playwright's ariaSnapshot (mode: "ai" includes [ref=eN] element references + [box=x,y,w,h])
		const snapshot = await untilAborted(options.signal, () => page.ariaSnapshot({ mode: "ai", boxes: true }));
		const vp = page.viewportSize() ?? { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
		const entries = parseAriaSnapshot(snapshot, {
			includeAll,
			viewportOnly,
			viewportWidth: vp.width,
			viewportHeight: vp.height,
		});
		// Cache the refs for tab.id() validation
		for (const entry of entries) this.#validRefs.add(entry.id);
		// Enrich with CDP AX metadata (description, keyshortcuts) not available in ariaSnapshot.
		// Stealth-safe: Accessibility.getFullAXTree does not trigger Runtime.enable.
		await untilAborted(options.signal, () => enrichWithCdpAxMetadata(page, entries));
		const scroll = (await untilAborted(options.signal, () =>
			page.evaluate(() => {
				const win = globalThis as unknown as {
					scrollX: number;
					scrollY: number;
					innerWidth: number;
					innerHeight: number;
					document: { documentElement: { scrollWidth: number; scrollHeight: number } };
				};
				const doc = win.document.documentElement;
				return {
					x: win.scrollX,
					y: win.scrollY,
					width: win.innerWidth,
					height: win.innerHeight,
					scrollWidth: doc.scrollWidth,
					scrollHeight: doc.scrollHeight,
				};
			}),
		)) as Observation["scroll"];
		return {
			url: page.url(),
			title: (await untilAborted(options.signal, () => page.title())) as string,
			viewport: vp,
			scroll,
			elements: entries,
		};
	}

	async #captureScreenshot(
		session: SessionSnapshot,
		displays: RunResultOk["displays"],
		screenshots: ScreenshotResult[],
		signal: AbortSignal | undefined,
		opts: ScreenshotOptions = {},
	): Promise<ScreenshotResult> {
		const page = this.#requirePage();
		const fullPage = opts.selector ? false : (opts.fullPage ?? false);
		const explicitPath = opts.save ? resolveToCwd(opts.save, session.cwd) : undefined;
		// Playwright only supports png/jpeg screenshot types (no webp). When a .webp
		// save path is requested, capture as png and let resizeImage handle webp encoding.
		const pathFormat = explicitPath ? imageFormatForPath(explicitPath) : "png";
		const captureType: "png" | "jpeg" = pathFormat === "jpeg" ? "jpeg" : "png";
		const captureMime = `image/${captureType}` as const;
		let buffer: Buffer;
		if (opts.selector) {
			const handle = (await untilAborted(signal, () =>
				page.locator(normalizeSelector(opts.selector!)).elementHandle({ timeout: QUICK_OP_TIMEOUT_MS }),
			)) as ElementHandle | null;
			if (!handle) throw new ToolError("Screenshot selector did not resolve to an element");
			try {
				await untilAborted(signal, () =>
					handle.evaluate(el => {
						const target = el as unknown as {
							scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
						};
						target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
					}),
				).catch(() => undefined);
				buffer = (await untilAborted(signal, () => handle.screenshot({ type: captureType }))) as Buffer;
			} finally {
				await handle.dispose().catch(() => undefined);
			}
		} else {
			buffer = (await untilAborted(signal, () => page.screenshot({ type: captureType, fullPage }))) as Buffer;
		}
		// resizeImage picks the smallest of PNG/JPEG/WebP and can fast-path the
		// original PNG, so it does NOT guarantee WebP output. When saving to a
		// .webp path, explicitly encode the saved buffer as WebP via Bun.Image so
		// the file bytes match the extension.
		const resized = await resizeImage(
			{ type: "image", data: buffer.toBase64(), mimeType: captureMime },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
		);
		const saveFullRes = !!(explicitPath || session.browserScreenshotDir);
		let savedBuffer: Buffer;
		let savedMimeType: string;
		if (pathFormat === "webp") {
			// Explicit WebP encode for .webp save paths — don't let resizeImage's
			// "pick smallest" fallback write PNG/JPEG bytes to a .webp file.
			// Encode at the original dimensions (like the non-webp full-res path)
			// to preserve aspect ratio — resize(1024, 1024) would squash non-square
			// screenshots.
			const webpBytes = await new Bun.Image(buffer).webp({ quality: 80 }).bytes();
			savedBuffer = Buffer.from(webpBytes);
			savedMimeType = "image/webp";
		} else if (saveFullRes) {
			savedBuffer = buffer;
			savedMimeType = captureMime;
		} else {
			savedBuffer = resized.buffer as Buffer;
			savedMimeType = resized.mimeType;
		}
		// Names must match the bytes we actually write.
		const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
		const dest =
			explicitPath ??
			(session.browserScreenshotDir
				? path.join(
						session.browserScreenshotDir,
						`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
					)
				: path.join(os.tmpdir(), `omp-sshots-${Snowflake.next()}.${ext}`));
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await Bun.write(dest, savedBuffer);
		const info: ScreenshotResult = {
			dest,
			mimeType: savedMimeType,
			bytes: savedBuffer.length,
			width: pathFormat === "webp" ? resized.originalWidth : resized.width,
			height: pathFormat === "webp" ? resized.originalHeight : resized.height,
		};
		screenshots.push(info);
		if (!opts.silent) {
			const lines = formatScreenshot({
				saveFullRes,
				savedMimeType,
				savedByteLength: savedBuffer.length,
				dest,
				resized,
			});
			displays.push({ type: "text", text: lines.join("\n") });
			displays.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		return info;
	}

	async #drag(from: DragTarget, to: DragTarget, signal: AbortSignal): Promise<void> {
		const page = this.#requirePage();
		const resolveDragPoint = async (
			target: DragTarget,
			role: "from" | "to",
		): Promise<{ x: number; y: number; handle?: ElementHandle }> => {
			if (typeof target === "string") {
				const handle = (await untilAborted(signal, () =>
					page.locator(normalizeSelector(target)).elementHandle({ timeout: QUICK_OP_TIMEOUT_MS }),
				)) as ElementHandle | null;
				if (!handle) throw new ToolError(`Drag ${role} selector did not resolve: ${target}`);
				const box = (await untilAborted(signal, () => handle.boundingBox())) as {
					x: number;
					y: number;
					width: number;
					height: number;
				} | null;
				if (!box) {
					await handle.dispose().catch(() => undefined);
					throw new ToolError(`Drag ${role} element has no bounding box (likely not visible): ${target}`);
				}
				return { x: box.x + box.width / 2, y: box.y + box.height / 2, handle };
			}
			if (
				target !== null &&
				typeof target === "object" &&
				typeof (target as { x: unknown }).x === "number" &&
				typeof (target as { y: unknown }).y === "number"
			) {
				return { x: (target as { x: number }).x, y: (target as { y: number }).y };
			}
			throw new ToolError(
				`Drag ${role} must be a selector string or { x: number, y: number } point. Got: ${typeof target}`,
			);
		};
		const start = await resolveDragPoint(from, "from");
		let end: { x: number; y: number; handle?: ElementHandle } | undefined;
		try {
			end = await resolveDragPoint(to, "to");
			await untilAborted(signal, () => page.mouse.move(start.x, start.y));
			await untilAborted(signal, () => page.mouse.down());
			await untilAborted(signal, () => page.mouse.move(end!.x, end!.y, { steps: 12 }));
			await untilAborted(signal, () => page.mouse.up());
		} finally {
			if (start.handle) await start.handle.dispose().catch(() => undefined);
			if (end?.handle) await end.handle.dispose().catch(() => undefined);
		}
	}

	async #select(selector: string, values: string[], timeoutMs: number, signal: AbortSignal): Promise<string[]> {
		const page = this.#requirePage();
		const handle = (await untilAborted(signal, () =>
			page.locator(normalizeSelector(selector)).elementHandle({ timeout: timeoutMs }),
		)) as ElementHandle;
		try {
			return (await untilAborted(signal, () =>
				handle.evaluate((el, vals) => {
					interface SelectOption {
						value: string;
						selected: boolean;
					}
					interface SelectLike {
						tagName: string;
						options: ArrayLike<SelectOption>;
						dispatchEvent: (event: unknown) => boolean;
					}
					const select = el as unknown as SelectLike;
					if (select?.tagName !== "SELECT") throw new Error("tab.select() requires a <select> element");
					const EventCtor = (
						globalThis as unknown as { Event: new (type: string, init?: { bubbles: boolean }) => unknown }
					).Event;
					const wanted = new Set(vals as string[]);
					const selected: string[] = [];
					for (let i = 0; i < select.options.length; i++) {
						const opt = select.options[i] as SelectOption;
						opt.selected = wanted.has(opt.value);
						if (opt.selected) selected.push(opt.value);
					}
					select.dispatchEvent(new EventCtor("input", { bubbles: true }));
					select.dispatchEvent(new EventCtor("change", { bubbles: true }));
					return selected;
				}, values),
			)) as string[];
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	async #uploadFile(
		selector: string,
		filePaths: string[],
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<void> {
		if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
		const page = this.#requirePage();
		const handle = (await untilAborted(signal, () =>
			page.locator(normalizeSelector(selector)).elementHandle({ timeout: timeoutMs }),
		)) as ElementHandle;
		try {
			const absolute = filePaths.map(filePath => resolveToCwd(filePath, session.cwd));
			const tagName = (await untilAborted(signal, () =>
				handle.evaluate(el => (el as unknown as { tagName: string }).tagName),
			)) as string;
			if (tagName !== "INPUT")
				throw new ToolError(
					`tab.uploadFile() requires an <input type="file"> element (got <${tagName.toLowerCase()}>)`,
				);
			await untilAborted(signal, () => handle.setInputFiles(absolute));
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	async #waitForUrl(pattern: string | RegExp, timeout: number, signal: AbortSignal): Promise<string> {
		const page = this.#requirePage();
		const isRegex = pattern instanceof RegExp;
		const matcher = isRegex ? pattern.source : pattern;
		const flags = isRegex ? pattern.flags : "";
		await untilAborted(signal, () =>
			page.waitForFunction(
				(args: { m: string; isRe: boolean; fl: string }) => {
					const url = (globalThis as unknown as { location: { href: string } }).location.href;
					return args.isRe ? new RegExp(args.m, args.fl).test(url) : url.includes(args.m);
				},
				{ m: matcher, isRe: isRegex, fl: flags },
				{ timeout, polling: 200 },
			),
		);
		return page.url();
	}

	async #waitForResponse(
		pattern: string | RegExp | ((response: Response) => boolean | Promise<boolean>),
		timeout: number,
		signal: AbortSignal,
	): Promise<Response> {
		const page = this.#requirePage();
		const predicate: (response: Response) => boolean | Promise<boolean> =
			typeof pattern === "function"
				? pattern
				: pattern instanceof RegExp
					? response => pattern.test(response.url())
					: response => response.url().includes(pattern);
		return (await untilAborted(signal, () => page.waitForResponse(predicate, { timeout }))) as Response;
	}

	async #resolveCachedHandle(id: string): Promise<Locator> {
		if (!this.#validRefs.has(id))
			throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
		return this.#requirePage().locator(`aria-ref=${id}`);
	}
	#clearElementCache(): void {
		this.#validRefs.clear();
	}

	async #close(): Promise<void> {
		this.#unsub();
		this.#clearElementCache();
		const page = this.#page;
		if (this.#dialogHandler && page && !page.isClosed()) page.off("dialog", this.#dialogHandler);
		if (this.#mode === "headless" && page && !page.isClosed()) await page.close().catch(() => undefined);
		// For headless mode, close the wsEndpoint connection (disconnects from the
		// launchServer without killing it — pages created via this connection are
		// closed). For attach mode (connectOverCDP), skip browser.close() entirely:
		// Playwright's Browser has no disconnect(), and close() can tear down
		// contexts/pages on the user's attached app. The CDP connection is cleaned
		// up when the worker process exits.
		if (this.#mode === "headless" && this.#browser?.isConnected()) await this.#browser.close().catch(() => undefined);
		this.#transport.send({ type: "closed" });
		this.#transport.close();
	}

	#requirePage(): Page {
		if (!this.#page) throw new ToolError("Tab worker is not initialized");
		return this.#page;
	}

	#requireBrowser(): Browser {
		if (!this.#browser) throw new ToolError("Tab worker is not initialized");
		return this.#browser;
	}

	#log(level: "debug" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
		this.#transport.send({ type: "log", level, msg, meta });
	}
}
