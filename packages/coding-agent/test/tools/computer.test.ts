import { describe, expect, it } from "bun:test";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { toolWireSchema, validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	type AcquireBrowserOptions,
	type BrowserHandle,
	type BrowserKind,
	getBrowsersMapForTest,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { RunResultOk } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	type AcquireTabOptions,
	type AcquireTabResult,
	getTabsMapForTest,
	type RunInTabOptions,
	releaseTabsForOwner,
	type TabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { type ComputerParams, ComputerTool, type ComputerToolRuntime } from "@oh-my-pi/pi-coding-agent/tools/computer";
import { getImageDimensions } from "@oh-my-pi/pi-tui";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type Event = { op: string; args: unknown[] };

type AsyncBody = (...args: unknown[]) => Promise<unknown>;
type AsyncBodyConstructor = new (...args: string[]) => AsyncBody;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as AsyncBodyConstructor;

class FakePage {
	readonly events: Event[] = [];
	failClick = false;

	readonly keyboard = {
		down: async (key: string): Promise<void> => this.#record("keyboard.down", key),
		up: async (key: string): Promise<void> => this.#record("keyboard.up", key),
		press: async (key: string): Promise<void> => this.#record("keyboard.press", key),
		type: async (text: string): Promise<void> => this.#record("keyboard.type", text),
	};

	readonly mouse = {
		move: async (x: number, y: number): Promise<void> => this.#record("mouse.move", x, y),
		click: async (x: number, y: number, options: Record<string, unknown>): Promise<void> => {
			this.#record("mouse.click", x, y, options);
			if (this.failClick) throw new Error("pointer failed");
		},
		down: async (options: Record<string, unknown>): Promise<void> => this.#record("mouse.down", options),
		up: async (options: Record<string, unknown>): Promise<void> => this.#record("mouse.up", options),
		wheel: async (options: Record<string, unknown>): Promise<void> => this.#record("mouse.wheel", options),
	};

	async screenshot(options: Record<string, unknown>): Promise<string> {
		this.#record("page.screenshot", options);
		return PNG_BASE64;
	}

	#record(op: string, ...args: unknown[]): void {
		this.events.push({ op, args });
	}
}

class FakeRuntime implements ComputerToolRuntime {
	readonly browser = {} as BrowserHandle;
	readonly tabs = new Map<string, TabSession>();
	readonly browserCalls: Array<{ kind: BrowserKind; opts: AcquireBrowserOptions }> = [];
	readonly tabCalls: Array<{ name: string; opts: AcquireTabOptions }> = [];
	readonly runCalls: Array<{ name: string; opts: RunInTabOptions }> = [];

	constructor(readonly page: FakePage) {}

	async acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
		this.browserCalls.push({ kind, opts });
		return this.browser;
	}

	async acquireTab(name: string, _browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult> {
		this.tabCalls.push({ name, opts });
		const tab = {
			name,
			ownerSessionId: opts.ownerSessionId,
			browser: this.browser,
			state: "alive",
		} as TabSession;
		this.tabs.set(name, tab);
		return { tab, created: true };
	}

	getTab(name: string): TabSession | undefined {
		return this.tabs.get(name);
	}

	async runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
		this.runCalls.push({ name, opts });
		const displays: Array<TextContent | ImageContent> = [];
		const display = (value: unknown): void => {
			if (!isImageContent(value)) throw new Error("Computer script displayed non-image output");
			displays.push(value);
		};
		const wait = async (milliseconds: unknown): Promise<void> => {
			this.page.events.push({ op: "wait", args: [milliseconds] });
		};
		const body = new AsyncFunction("page", "display", "wait", opts.code);
		await body(this.page, display, wait);
		return { displays, returnValue: undefined, screenshots: [] };
	}
}

function isImageContent(value: unknown): value is ImageContent {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { type?: unknown; data?: unknown; mimeType?: unknown };
	return candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string";
}

function makeSession(id: string, overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: `/tmp/${id}`,
		hasUI: false,
		getSessionId: () => id,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.headless": false,
			"computer.startUrl": `https://${id}.example.test/start`,
			...overrides,
		}),
	};
}

async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		const probe = Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" });
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

function event(op: string, ...args: unknown[]): Event {
	return { op, args };
}

describe("ComputerTool", () => {
	it("executes every GA action in order with normalized keys, modifiers, pointer mapping, and one PNG", async () => {
		const page = new FakePage();
		const runtime = new FakeRuntime(page);
		const tool = new ComputerTool(makeSession("actions"), runtime);
		const params: ComputerParams = {
			actions: [
				{ type: "move", x: 1, y: 2, keys: ["SHIFT"] },
				{ type: "click", x: 3, y: 4, button: "wheel", keys: ["CTRL"] },
				{ type: "double_click", x: 5, y: 6, keys: ["ALT"] },
				{
					type: "drag",
					path: [
						{ x: 7, y: 8 },
						{ x: 9, y: 10 },
						{ x: 11, y: 12 },
					],
					keys: ["CMD"],
				},
				{ type: "keypress", keys: ["CTRL", "ARROW_RIGHT"] },
				{ type: "scroll", x: 13, y: 14, scroll_x: -15, scroll_y: 16, keys: ["OPTION"] },
				{ type: "type", text: "hello" },
				{ type: "wait" },
				{ type: "screenshot" },
			],
			pendingSafetyChecks: [],
		};

		const result = await tool.execute("computer-actions", params);

		expect(page.events).toEqual([
			event("keyboard.down", "Shift"),
			event("mouse.move", 1, 2),
			event("keyboard.up", "Shift"),
			event("keyboard.down", "Control"),
			event("mouse.click", 3, 4, { button: "middle" }),
			event("keyboard.up", "Control"),
			event("keyboard.down", "Alt"),
			event("mouse.click", 5, 6, { button: "left", clickCount: 2 }),
			event("keyboard.up", "Alt"),
			event("keyboard.down", "Meta"),
			event("mouse.move", 7, 8),
			event("mouse.down", { button: "left" }),
			event("mouse.move", 9, 10),
			event("mouse.move", 11, 12),
			event("mouse.up", { button: "left" }),
			event("keyboard.up", "Meta"),
			event("keyboard.down", "Control"),
			event("keyboard.press", "ArrowRight"),
			event("keyboard.up", "Control"),
			event("keyboard.down", "Alt"),
			event("mouse.move", 13, 14),
			event("mouse.wheel", { deltaX: -15, deltaY: 16 }),
			event("keyboard.up", "Alt"),
			event("keyboard.type", "hello"),
			event("wait", 2_000),
			event("page.screenshot", {
				type: "png",
				encoding: "base64",
				fullPage: false,
				captureBeyondViewport: false,
			}),
		]);
		expect(result.content).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
		const png = Buffer.from(PNG_BASE64, "base64");
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	});

	it("reuses one fixed-viewport start-URL tab per session and records lifecycle ownership", async () => {
		const runtime = new FakeRuntime(new FakePage());
		const first = new ComputerTool(makeSession("session-a"), runtime);
		const second = new ComputerTool(makeSession("session-b"), runtime);
		const params: ComputerParams = { actions: [{ type: "screenshot" }], pendingSafetyChecks: [] };

		await first.execute("a-1", params);
		await first.execute("a-2", params);
		await second.execute("b-1", params);

		expect(runtime.browserCalls).toHaveLength(2);
		expect(runtime.browserCalls.map(call => call.kind)).toEqual([
			{ kind: "headless", headless: false },
			{ kind: "headless", headless: false },
		]);
		expect(runtime.browserCalls.map(call => call.opts.viewport)).toEqual([
			{ width: 1280, height: 720, deviceScaleFactor: 1 },
			{ width: 1280, height: 720, deviceScaleFactor: 1 },
		]);
		expect(runtime.tabCalls.map(call => ({ name: call.name, opts: call.opts }))).toEqual([
			{
				name: "computer:session-a",
				opts: {
					url: "https://session-a.example.test/start",
					viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
					timeoutMs: 30_000,
					signal: undefined,
					ownerSessionId: "session-a",
					isolateStorage: true,
				},
			},
			{
				name: "computer:session-b",
				opts: {
					url: "https://session-b.example.test/start",
					viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
					timeoutMs: 30_000,
					signal: undefined,
					ownerSessionId: "session-b",
					isolateStorage: true,
				},
			},
		]);
		expect(runtime.runCalls.map(call => call.name)).toEqual([
			"computer:session-a",
			"computer:session-a",
			"computer:session-b",
		]);
	});

	it("requires explicit approval before acknowledging pending safety checks", async () => {
		const tool = new ComputerTool(makeSession("safety"), new FakeRuntime(new FakePage()));
		const params: ComputerParams = {
			actions: [{ type: "click", x: 20, y: 30, button: "left" }],
			pendingSafetyChecks: [
				{ id: "check-1", code: "policy", message: "Confirm this action" },
				{ id: "check-2", code: null, message: null },
			],
		};
		if (typeof tool.approval !== "function") throw new Error("expected dynamic computer approval");

		expect(tool.approval(params)).toEqual({
			tier: "exec",
			alwaysPrompt: true,
			reason: "OpenAI computer safety checks require explicit confirmation",
		});
		const result = await tool.execute("computer-safety", params);

		expect(result.openaiComputer).toEqual({ acknowledgedSafetyChecks: params.pendingSafetyChecks });
		expect(tool.formatApprovalDetails(params)).toEqual([
			"Batch: 1 action",
			"1. click left at (20, 30)",
			"Safety checks: 2",
			"- check-1 [policy]: Confirm this action",
			"- check-2",
		]);
	});

	it("releases held modifiers and returns no screenshot or acknowledgment when an action fails", async () => {
		const page = new FakePage();
		page.failClick = true;
		const runtime = new FakeRuntime(page);
		const tool = new ComputerTool(makeSession("failure"), runtime);
		const params: ComputerParams = {
			actions: [{ type: "click", x: 1, y: 1, button: "left", keys: ["CTRL"] }],
			pendingSafetyChecks: [{ id: "not-acknowledged" }],
		};

		await expect(tool.execute("computer-failure", params)).rejects.toThrow("pointer failed");
		expect(page.events).toEqual([
			event("keyboard.down", "Control"),
			event("mouse.click", 1, 1, { button: "left" }),
			event("keyboard.up", "Control"),
		]);
		expect(page.events.some(entry => entry.op === "page.screenshot")).toBe(false);
	});

	it("is strict, essential, native, exclusive, and rejects malformed action shapes", () => {
		const tool = new ComputerTool(makeSession("schema"), new FakeRuntime(new FakePage()));
		const schema = toolWireSchema(tool);

		expect(tool.strict).toBe(true);
		expect(tool.loadMode).toBe("essential");
		expect(tool.openaiNativeTool).toBe("computer");
		expect(tool.concurrency).toBe("exclusive");
		expect(validateJsonSchemaValue(schema, { actions: [{ type: "wait" }], pendingSafetyChecks: [] }).success).toBe(
			true,
		);
		expect(
			validateJsonSchemaValue(schema, {
				actions: [{ type: "click", x: 1, y: 2, button: "left", unexpected: true }],
				pendingSafetyChecks: [],
			}).success,
		).toBe(false);
		expect(
			validateJsonSchemaValue(schema, {
				actions: [{ type: "unknown" }],
				pendingSafetyChecks: [],
			}).success,
		).toBe(false);
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("ComputerTool browser context isolation", () => {
	it("isolates cookies across concurrent sessions and closes each owned context with its tab", async () => {
		let firstProbeCookie: string | null | undefined;
		let secondNavigationCookie: string | null | undefined;
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname === "/session-a") {
					return new Response('<!doctype html><title>A</title><img src="/probe-a">', {
						headers: {
							"content-type": "text/html",
							"set-cookie": "computer_session=from-a; Path=/; SameSite=Lax",
						},
					});
				}
				if (pathname === "/probe-a") {
					firstProbeCookie = request.headers.get("cookie");
					return new Response(null, { status: 204 });
				}
				if (pathname === "/session-b") {
					secondNavigationCookie = request.headers.get("cookie");
					return new Response("<!doctype html><title>B</title>", {
						headers: { "content-type": "text/html" },
					});
				}
				return new Response(null, { status: 404 });
			},
		});
		const suffix = crypto.randomUUID();
		const sessionAId = `computer-isolation-a-${suffix}`;
		const sessionBId = `computer-isolation-b-${suffix}`;
		const sessionA = makeSession(sessionAId, {
			"browser.headless": true,
			"computer.startUrl": `http://127.0.0.1:${server.port}/session-a`,
		});
		const sessionB = makeSession(sessionBId, {
			"browser.headless": true,
			"computer.startUrl": `http://127.0.0.1:${server.port}/session-b`,
		});
		const first = new ComputerTool(sessionA);
		const second = new ComputerTool(sessionB);
		const params: ComputerParams = { actions: [{ type: "screenshot" }], pendingSafetyChecks: [] };

		try {
			const firstResult = await first.execute("first", params);
			const secondResult = await second.execute("second", params);

			expect(firstProbeCookie).toContain("computer_session=from-a");
			expect(secondNavigationCookie).toBeNull();
			expect(firstResult.details).toMatchObject({
				tab: `computer:${sessionAId}`,
				viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
			});
			expect(secondResult.details).toMatchObject({
				tab: `computer:${sessionBId}`,
				viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
			});
			const firstScreenshot = firstResult.content[0];
			if (firstScreenshot?.type !== "image") throw new Error("Expected a PNG computer screenshot");
			expect(getImageDimensions(firstScreenshot.data, firstScreenshot.mimeType)).toEqual({
				widthPx: 1280,
				heightPx: 720,
			});

			const tabA = getTabsMapForTest().get(`computer:${sessionAId}`);
			const tabB = getTabsMapForTest().get(`computer:${sessionBId}`);
			if (tabA?.backend !== "worker" || !tabB || tabB.backend !== "worker") {
				throw new Error("Expected two live Puppeteer computer tabs");
			}
			expect(tabA.browser).toBe(tabB.browser);
			expect(typeof tabA.browserContextId).toBe("string");
			expect(typeof tabB.browserContextId).toBe("string");
			expect(tabA.browserContextId).not.toBe(tabB.browserContextId);

			const contextAId = tabA.browserContextId!;
			const contextBId = tabB.browserContextId!;
			expect(await releaseTabsForOwner(sessionAId, { kill: true })).toBe(1);
			expect(getTabsMapForTest().has(`computer:${sessionAId}`)).toBe(false);
			expect(getTabsMapForTest().has(`computer:${sessionBId}`)).toBe(true);
			const browserSession = await tabB.browser.browser.target().createCDPSession();
			try {
				const { browserContextIds } = await browserSession.send("Target.getBrowserContexts");
				expect(browserContextIds).not.toContain(contextAId);
				expect(browserContextIds).toContain(contextBId);
			} finally {
				await browserSession.detach();
			}
			await second.execute("second-after-first-cleanup", params);

			expect(await releaseTabsForOwner(sessionBId, { kill: true })).toBe(1);
			expect(getTabsMapForTest().has(`computer:${sessionBId}`)).toBe(false);
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			await releaseTabsForOwner(sessionAId, { kill: true }).catch(() => undefined);
			await releaseTabsForOwner(sessionBId, { kill: true }).catch(() => undefined);
			server.stop(true);
		}
	}, 60_000);
});
