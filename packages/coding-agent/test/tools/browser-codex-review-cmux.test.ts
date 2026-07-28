import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxCodexBrowserAdapter } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/codex-adapter";
import {
	type CodexBrowserFacade,
	type CodexClipboardItem,
	createCodexBrowserFacade,
} from "@oh-my-pi/pi-coding-agent/tools/browser/codex-facade";
import { parseHTML } from "linkedom";

type RpcCall = {
	method: string;
	params: Record<string, unknown>;
	timeoutMs?: number;
};

function adapterAndFacadeFor(overrides: Record<string, unknown>): {
	adapter: CmuxCodexBrowserAdapter;
	browser: CodexBrowserFacade;
} {
	const tab = {
		surfaceId: "surface-contract",
		async codexUrl() {
			return "https://fixture.test/current";
		},
		async title() {
			return "Current fixture";
		},
		async codexPersistFile(path: string, data: Uint8Array) {
			await Bun.write(path, data);
		},
		...overrides,
	} as never;
	const adapter = new CmuxCodexBrowserAdapter(tab);
	return { adapter, browser: createCodexBrowserFacade(adapter) };
}

function facadeFor(overrides: Record<string, unknown>): CodexBrowserFacade {
	return adapterAndFacadeFor(overrides).browser;
}

async function selectedTab(browser: CodexBrowserFacade) {
	const tab = await browser.tabs.selected();
	if (!tab) throw new Error("Expected a selected cmux tab");
	return tab;
}

async function caughtError(run: () => unknown | Promise<unknown>): Promise<{ name: string; message: string }> {
	try {
		await run();
		return { name: "NO_ERROR", message: "" };
	} catch (error) {
		return { name: (error as Error).name, message: (error as Error).message };
	}
}

function runPageEvaluator(
	source: string,
	args: unknown[],
	bindings: {
		document: unknown;
		window: unknown;
		navigator?: unknown;
		ClipboardItem?: unknown;
		Element?: unknown;
		Blob?: unknown;
		CSS?: unknown;
	},
): unknown {
	const evaluate = new Function(
		"document",
		"window",
		"navigator",
		"ClipboardItem",
		"Blob",
		"Element",
		"CSS",
		"args",
		`return (${source})(...args);`,
	) as (...values: unknown[]) => unknown;
	return evaluate(
		bindings.document,
		bindings.window,
		bindings.navigator ?? {},
		bindings.ClipboardItem,
		bindings.Blob,
		bindings.Element,
		bindings.CSS ?? { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_") },
		args,
	);
}

function runCmuxEvalScript(
	script: string,
	bindings: { document: unknown; window: unknown; Event: unknown; MouseEvent: unknown; getComputedStyle?: unknown },
): unknown {
	const globals = globalThis as unknown as Record<string, unknown>;
	const descriptors = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries(bindings)) {
		descriptors.set(name, Object.getOwnPropertyDescriptor(globals, name));
		Object.defineProperty(globals, name, { value, configurable: true, writable: true });
	}
	try {
		return new Function(`return (${script});`)();
	} finally {
		for (const [name, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globals, name, descriptor);
			else delete globals[name];
		}
	}
}

type SelectProbe = {
	document: unknown;
	view: unknown;
	events: string[];
	selectedValues(): string[];
};

function selectProbe(values: string[], initiallySelected: string, multiple = false, size = 1) {
	const events: string[] = [];
	const view = {
		Event: class {
			readonly type: string;
			constructor(type: string) {
				this.type = type;
			}
		},
		getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
	};
	let options: Array<Record<string, unknown>> = [];
	const document = {
		defaultView: view,
		querySelectorAll: (selector: string) => (selector === "#choice" || selector === "*" ? [select] : []),
	};
	const select = {
		tagName: "SELECT",
		multiple,
		size,
		hidden: false,
		disabled: false,
		ownerDocument: document,
		get options() {
			return options;
		},
		get selectedOptions() {
			return options.filter(option => option.selected === true);
		},
		getAttribute: () => null,
		getBoundingClientRect: () => ({ width: 120, height: 24 }),
		scrollIntoView: () => undefined,
		focus: () => undefined,
		dispatchEvent: (event: { type: string }) => {
			events.push(event.type);
			return true;
		},
	};
	options = values.map((value, index) => {
		let selected = false;
		const option: Record<string, unknown> = { value, label: value, index };
		Object.defineProperty(option, "selected", {
			get: () => selected,
			set: (next: boolean) => {
				if (next && !multiple) {
					for (const other of options) {
						if (other !== option) Reflect.set(other, "selected", false);
					}
				}
				selected = next;
			},
		});
		return option;
	});
	const initial = options.find(option => option.value === initiallySelected);
	if (initial) Reflect.set(initial, "selected", true);
	return {
		document,
		view,
		events,
		selectedValues: () => options.filter(option => option.selected === true).map(option => String(option.value)),
	};
}

function facadeForSelect(probe: SelectProbe): CodexBrowserFacade {
	return facadeFor({
		async codexEvaluate(source: string, args: unknown[]) {
			return runPageEvaluator(source, args, { document: probe.document, window: probe.view });
		},
		async codexWait() {
			throw new Error("A present select should not need to poll");
		},
	});
}

function labelProbe() {
	const view = {};
	const labelsById = new Map([
		["first-label", { innerText: "ARIA", textContent: "ARIA" }],
		["second-label", { innerText: "Labelled By", textContent: "Labelled By" }],
	]);
	let controls: Array<Record<string, unknown>> = [];
	const document = {
		defaultView: view,
		getElementById: (id: string) => labelsById.get(id),
		querySelectorAll: (selector: string) => (selector === "*" ? controls : []),
	};
	const associatedLabel = {
		tagName: "LABEL",
		children: [],
		ownerDocument: document,
		innerText: "Associated Label",
		textContent: "Associated Label",
		getAttribute: () => null,
	};
	const combinedControl = {
		tagName: "INPUT",
		type: "text",
		children: [],
		labels: [associatedLabel],
		ownerDocument: document,
		getAttribute: (name: string) =>
			({ "aria-label": "Direct ARIA Label", "aria-labelledby": "first-label second-label" })[name] ?? null,
	};
	const nativeLabel = {
		tagName: "LABEL",
		children: [],
		ownerDocument: document,
		innerText: "Native Name",
		textContent: "Native Name",
		getAttribute: () => null,
	};
	const ariaPreferredControl = {
		tagName: "INPUT",
		type: "text",
		children: [],
		labels: [nativeLabel],
		ownerDocument: document,
		getAttribute: (name: string) => (name === "aria-label" ? "Preferred ARIA" : null),
	};
	controls = [associatedLabel, combinedControl, nativeLabel, ariaPreferredControl];
	return { document, view };
}

function observerProbe(multiple = false, inShadowRoot = false, inFrame = false, frameInitiallyPresent = true) {
	type ClickEvent = {
		target: ElementProbe;
		defaultPrevented: boolean;
		isTrusted: boolean;
		composedPath?: () => ElementProbe[];
		preventDefault(): void;
	};
	let clickListener: ((event: ClickEvent) => void) | undefined;
	let clickCapture = false;
	let frameClickListener: ((event: ClickEvent) => void) | undefined;
	let frameClickCapture = false;
	let frameMounted = inFrame && frameInitiallyPresent;
	class ElementProbe {
		readonly attributes = new Map<string, string>();
		readonly kind: "file" | "button";
		readonly multiple: boolean;
		readonly tagName: "INPUT" | "BUTTON";
		shadowRoot?: { querySelectorAll(selector: string): ElementProbe[] };
		ownerDocument?: unknown;
		root?: unknown;

		constructor(kind: "file" | "button") {
			this.kind = kind;
			this.multiple = kind === "file" && multiple;
			this.tagName = kind === "file" ? "INPUT" : "BUTTON";
		}

		closest(selector: string): ElementProbe | null {
			if (selector === 'input[type="file"]') return this.kind === "file" ? this : null;
			if (selector === "button") return this.kind === "button" ? this : null;
			return null;
		}

		getRootNode(): unknown {
			return this.root ?? this.ownerDocument;
		}
		getAttribute(name: string): string | null {
			return this.attributes.get(name) ?? null;
		}

		setAttribute(name: string, value: string): void {
			this.attributes.set(name, value);
		}

		removeAttribute(name: string): void {
			this.attributes.delete(name);
		}
	}
	const file = new ElementProbe("file");
	file.setAttribute("id", "upload");
	file.setAttribute("type", "file");
	const anchor = new ElementProbe("button");
	if (inShadowRoot) {
		anchor.shadowRoot = {
			querySelectorAll(selector: string) {
				if (selector === "*") return [file];
				return selector.includes("data-omp-codex-file-token") && file.getAttribute("data-omp-codex-file-token")
					? [file]
					: [];
			},
		};
	}
	const elements = [file, anchor];
	const frameAttributes = new Map<string, string>();
	const frameDocument = {
		addEventListener(type: string, listener: (event: ClickEvent) => void, capture = false) {
			if (type === "click") {
				frameClickListener = listener;
				frameClickCapture = capture;
			}
		},
		removeEventListener(type: string, listener: (event: ClickEvent) => void, capture = false) {
			if (type === "click" && frameClickListener === listener && frameClickCapture === capture)
				frameClickListener = undefined;
		},
		querySelectorAll(selector: string) {
			if (selector === "*" || selector === "#upload") return [file];
			return selector.includes("data-omp-codex-file-token") && file.getAttribute("data-omp-codex-file-token")
				? [file]
				: [];
		},
	};
	const frame = {
		tagName: "IFRAME",
		contentDocument: frameDocument,
		querySelectorAll: () => [],
		getAttribute: (name: string) => frameAttributes.get(name) ?? null,
		hasAttribute: (name: string) => frameAttributes.has(name),
		removeAttribute: (name: string) => frameAttributes.delete(name),
		setAttribute: (name: string, value: string) => frameAttributes.set(name, value),
	};
	const document = {
		addEventListener(type: string, listener: (event: ClickEvent) => void, capture = false) {
			if (type === "click") {
				clickListener = listener;
				clickCapture = capture;
			}
		},
		removeEventListener(type: string, listener: (event: ClickEvent) => void, capture = false) {
			if (type === "click" && clickListener === listener && clickCapture === capture) clickListener = undefined;
		},
		querySelectorAll(selector: string) {
			if (frameMounted) {
				if (selector === "*" || selector === "#frame") return [frame];
				const actionToken = String(frame.getAttribute("data-omp-codex-action-token") ?? "");
				if (actionToken && selector === `[data-omp-codex-action-token="${actionToken}"]`) return [frame];
				const fileFrameToken = String(frame.getAttribute("data-omp-codex-file-frame-token") ?? "");
				if (fileFrameToken && selector === `[data-omp-codex-file-frame-token="${fileFrameToken}"]`) return [frame];
				return [];
			}
			if (selector === "*") return inShadowRoot ? [anchor] : elements;
			if (selector === "#upload") return inShadowRoot ? [] : [file];
			const visibleElements = inShadowRoot ? [anchor] : elements;
			return visibleElements.filter(element => {
				if (selector.includes("data-omp-codex-file-token") && element.getAttribute("data-omp-codex-file-token"))
					return true;
				return (
					selector.includes("data-omp-codex-download-token") &&
					!!element.getAttribute("data-omp-codex-download-token")
				);
			});
		},
	};
	const frameView = { frameElement: frame };
	Reflect.set(frameDocument, "defaultView", frameView);
	Reflect.set(frame, "ownerDocument", document);
	Reflect.set(frame, "getRootNode", () => document);
	file.ownerDocument = inFrame ? frameDocument : document;
	file.root = inShadowRoot ? anchor.shadowRoot : file.ownerDocument;
	anchor.ownerDocument = inFrame ? frameDocument : document;
	anchor.root = anchor.ownerDocument;
	const fire = (
		target: ElementProbe,
		cancelled = false,
		stopped = false,
		isTrusted = true,
		composedPath?: ElementProbe[],
	) => {
		const event: ClickEvent = {
			target,
			defaultPrevented: cancelled,
			isTrusted,
			composedPath: composedPath ? () => composedPath : undefined,
			preventDefault() {
				this.defaultPrevented = true;
			},
		};
		const inObservedFrame = inFrame && target.ownerDocument === frameDocument;
		if (!stopped || (inObservedFrame ? frameClickCapture : clickCapture)) {
			(inObservedFrame ? frameClickListener : clickListener)?.(event);
		}
	};
	const mountFrame = () => {
		frameMounted = inFrame;
	};
	return { document, frameDocument, frame, ElementProbe, file, anchor, fire, mountFrame };
}

type ObserverAdapterProbe = {
	document: unknown;
	ElementProbe: unknown;
};

function adapterForObserver(
	probe: ObserverAdapterProbe,
	codexWait?: (timeoutMs: number) => void | Promise<void>,
	codexUploadFile?: (selector: string, files: readonly string[], timeoutMs: number) => void | Promise<void>,
): CmuxCodexBrowserAdapter {
	const evaluate = (source: string, args: unknown[]) =>
		runPageEvaluator(source, args, {
			document: probe.document,
			window: {},
			Element: probe.ElementProbe,
		});
	return new CmuxCodexBrowserAdapter({
		surfaceId: "surface-observer",
		codexEvaluate: evaluate,
		codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
		codexWait,
		codexUploadFile,
	} as never);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("cmux Codex browser review regressions", () => {
	it("waits for a temporary content tab to load and spends one shrinking deadline before reading", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const calls: RpcCall[] = [];
		let temporaryTabOpen = false;
		const browser = facadeFor({
			async codexRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				calls.push({ method, params, timeoutMs });
				try {
					switch (method) {
						case "browser.tab.list":
							return {
								tabs: temporaryTabOpen
									? [
											{ id: "main", focused: true },
											{ id: "temporary", focused: false },
										]
									: [{ id: "main", focused: true }],
							};
						case "browser.tab.new":
							temporaryTabOpen = true;
							return { surface_id: "surface-temporary" };
						case "browser.wait":
							return {};
						case "browser.snapshot":
							return { page: { title: "Loaded fixture" } };
						case "browser.eval":
							return { value: "loaded body text" };
						default:
							throw new Error(`Unexpected content RPC: ${method}`);
					}
				} finally {
					now += 100;
				}
			},
			async codexCleanupRequest(method: string) {
				if (method === "browser.tab.close") temporaryTabOpen = false;
				return {};
			},
		});

		const rows = await browser.tabs.content({
			urls: ["https://fixture.test/loaded"],
			contentType: "text",
			timeoutMs: 1_000,
		});
		expect(rows).toEqual([
			{ url: "https://fixture.test/loaded", title: "Loaded fixture", content: "loaded body text" },
		]);

		const waitIndex = calls.findIndex(call => call.method === "browser.wait");
		const firstReadIndex = calls.findIndex(
			call => call.method === "browser.snapshot" || call.method === "browser.eval",
		);
		expect(waitIndex).toBeGreaterThan(-1);
		expect(waitIndex).toBeLessThan(firstReadIndex);
		const timeouts = calls.map(call => call.timeoutMs);
		for (let index = 1; index < timeouts.length; index++) {
			expect(timeouts[index]).toBeLessThan(timeouts[index - 1] as number);
		}
		const wait = calls[waitIndex];
		expect(wait?.params).toMatchObject({ load_state: "complete", timeout_ms: wait.timeoutMs });
	});

	it("returns outerHTML for html content and the cmux snapshot representation for domSnapshot", async () => {
		let temporaryId: string | undefined;
		let sequence = 0;
		const urlsBySurface = new Map<string, string>();
		const browser = facadeFor({
			async codexRequest(method: string, params: Record<string, unknown>) {
				switch (method) {
					case "browser.tab.list":
						return {
							tabs: temporaryId
								? [
										{ id: "main", focused: true },
										{ id: temporaryId, focused: false },
									]
								: [{ id: "main", focused: true }],
						};
					case "browser.tab.new": {
						sequence++;
						temporaryId = `temporary-${sequence}`;
						const surface = `surface-${sequence}`;
						urlsBySurface.set(surface, String(params.url));
						return { surface_id: surface };
					}
					case "browser.wait":
						return {};
					case "browser.snapshot": {
						const url = urlsBySurface.get(String(params.surface_id));
						return {
							snapshot: `cmux snapshot for ${url}`,
							page: { title: `Title for ${url}`, html: `snapshot html for ${url}` },
						};
					}
					case "browser.eval": {
						const url = urlsBySurface.get(String(params.surface_id));
						return { value: `<html data-loaded-url="${url}"><body>outer html</body></html>` };
					}
					default:
						throw new Error(`Unexpected content RPC: ${method}`);
				}
			},
			async codexCleanupRequest(method: string) {
				if (method === "browser.tab.close") temporaryId = undefined;
				return {};
			},
		});

		const htmlUrl = "https://fixture.test/html";
		const snapshotUrl = "https://fixture.test/snapshot";
		const [html] = await browser.tabs.content({ urls: [htmlUrl], contentType: "html", timeoutMs: 1_000 });
		const [domSnapshot] = await browser.tabs.content({
			urls: [snapshotUrl],
			contentType: "domSnapshot",
			timeoutMs: 1_000,
		});

		expect(html).toEqual({
			url: htmlUrl,
			title: `Title for ${htmlUrl}`,
			content: `<html data-loaded-url="${htmlUrl}"><body>outer html</body></html>`,
		});
		expect(domSnapshot).toEqual({
			url: snapshotUrl,
			title: `Title for ${snapshotUrl}`,
			content: `cmux snapshot for ${snapshotUrl}`,
		});
	});

	it("uses an independent bounded cleanup budget after tabs.content times out", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);

		const runTimedOutContent = async (temporaryKind: "tab" | "surface") => {
			let temporaryOpen = false;
			let focusedTabId = temporaryKind === "tab" ? "main" : undefined;
			const cleanupCalls: Array<{ method: string; timeoutMs: number }> = [];
			const browser = facadeFor({
				async codexRequest(method: string) {
					switch (method) {
						case "browser.tab.list":
							if (temporaryKind === "surface") return { tabs: [] };
							return {
								tabs: temporaryOpen
									? [
											{ id: "main", focused: focusedTabId === "main" },
											{ id: "temporary", focused: focusedTabId === "temporary" },
										]
									: [{ id: "main", focused: true }],
							};
						case "browser.tab.new":
							temporaryOpen = true;
							if (temporaryKind === "tab") focusedTabId = "temporary";
							return { surface_id: "surface-temporary" };
						case "browser.wait":
							now += 6;
							return {};
						default:
							throw new Error(`Timed-out content should not call ${method}`);
					}
				},
				async codexCleanupRequest(method: string, params: Record<string, unknown>, timeoutMs: number) {
					cleanupCalls.push({ method, timeoutMs });
					if (timeoutMs <= 1) throw new Error("Cleanup requires more than 1 ms");
					switch (method) {
						case "browser.tab.close":
						case "surface.close":
							temporaryOpen = false;
							break;
						case "browser.tab.switch":
							focusedTabId = String(params.tab_id);
							break;
						default:
							throw new Error(`Unexpected cleanup RPC: ${method}`);
					}
					return {};
				},
			});

			const rows = await browser.tabs.content({
				urls: [`https://fixture.test/timed-out-${temporaryKind}`],
				contentType: "text",
				timeoutMs: 5,
			});
			return { rows, temporaryOpen, focusedTabId, cleanupCalls };
		};

		const nativeTab = await runTimedOutContent("tab");
		const fallbackSurface = await runTimedOutContent("surface");

		expect(nativeTab.rows).toEqual([{ url: "https://fixture.test/timed-out-tab", title: null, content: null }]);
		expect(fallbackSurface.rows).toEqual([
			{ url: "https://fixture.test/timed-out-surface", title: null, content: null },
		]);
		expect(nativeTab.cleanupCalls.map(call => call.method)).toEqual(["browser.tab.close", "browser.tab.switch"]);
		expect(fallbackSurface.cleanupCalls.map(call => call.method)).toEqual(["surface.close"]);
		expect(
			[...nativeTab.cleanupCalls, ...fallbackSurface.cleanupCalls].every(
				call => call.timeoutMs > 1 && call.timeoutMs <= 3_000,
			),
		).toBe(true);
		expect(nativeTab.temporaryOpen).toBe(false);
		expect(nativeTab.focusedTabId).toBe("main");
		expect(fallbackSurface.temporaryOpen).toBe(false);
	});

	it("closes a newly opened tabs.content surface when relisting native tabs fails", async () => {
		let listCalls = 0;
		const cleanupCalls: RpcCall[] = [];
		const browser = facadeFor({
			async codexRequest(method: string) {
				switch (method) {
					case "browser.tab.list":
						if (listCalls++ === 0) return { tabs: [{ id: "main", focused: true }] };
						throw new Error("native tab relist failed");
					case "browser.tab.new":
						return { surface_id: "opened-before-relist" };
					default:
						throw new Error(`Unexpected tabs.content RPC: ${method}`);
				}
			},
			async codexCleanupRequest(method: string, params: Record<string, unknown>, timeoutMs: number) {
				cleanupCalls.push({ method, params, timeoutMs });
				return {};
			},
		});

		expect(
			await browser.tabs.content({
				urls: ["https://fixture.test/relist-failure"],
				contentType: "text",
				timeoutMs: 1_000,
			}),
		).toEqual([{ url: "https://fixture.test/relist-failure", title: null, content: null }]);
		expect(cleanupCalls).toEqual([
			{ method: "surface.close", params: { surface_id: "opened-before-relist" }, timeoutMs: 3_000 },
		]);
	});

	it("reports missing and malformed native tab lists as the named open-tabs capability", async () => {
		const outcomes = await Promise.all(
			[{}, { tabs: "not-an-array" }].map(async response => {
				const browser = facadeFor({
					async codexRequest(method: string) {
						if (method !== "browser.tab.list") throw new Error(`Unexpected open-tabs RPC: ${method}`);
						return response;
					},
				});
				return await caughtError(() => browser.user.openTabs());
			}),
		);

		expect(outcomes).toEqual([
			{
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: browser.user.openTabs",
			},
			{
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: browser.user.openTabs",
			},
		]);
	});

	it("normalizes only unsupported native tab-list failures for user.openTabs", async () => {
		const openTabsOutcome = async (message: string) => {
			const browser = facadeFor({
				async codexRequest(method: string) {
					if (method !== "browser.tab.list") throw new Error(`Unexpected open-tabs RPC: ${method}`);
					throw new Error(message);
				},
			});
			return await caughtError(() => browser.user.openTabs());
		};
		const unsupported = await Promise.all(
			[
				"method_not_found: browser.tab.list",
				"unknown_method: browser.tab.list",
				"unsupported_method: browser.tab.list",
				"not_implemented: browser.tab.list",
			].map(openTabsOutcome),
		);
		const operational = await openTabsOutcome("cmux tab-list transport disconnected");

		expect({ unsupported, operational }).toEqual({
			unsupported: Array.from({ length: 4 }, () => ({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: browser.user.openTabs",
			})),
			operational: { name: "Error", message: "cmux tab-list transport disconnected" },
		});
	});

	it("rejects cmux download waits without invoking the unacknowledged transport", async () => {
		let waitCalls = 0;
		const current = await selectedTab(
			facadeFor({
				async codexDownloadWait() {
					waitCalls++;
					return { download: {} };
				},
			}),
		);

		expect(await caughtError(() => current.playwright.waitForEvent("download", { timeoutMs: 250 }))).toEqual({
			name: "BrowserCapabilityError",
			message: "Browser capability is unavailable: playwright.waitForEvent",
		});
		expect(waitCalls).toBe(0);
	});

	it("fully writes complex multi-item clipboards or rejects with the named capability before mutation", async () => {
		let appendedNodes = 0;
		let legacyCopies = 0;
		const nativeWrites: unknown[][] = [];
		const rpcCalls: RpcCall[] = [];
		const document = {
			body: {
				appendChild: () => {
					appendedNodes++;
				},
			},
			createElement: () => ({
				value: "",
				style: {},
				setAttribute: () => undefined,
				select: () => undefined,
				remove: () => undefined,
			}),
			execCommand: () => {
				legacyCopies++;
				return true;
			},
		};
		class BlobProbe {
			readonly parts: unknown[];
			readonly type: string;
			constructor(parts: unknown[], options: { type: string }) {
				this.parts = parts;
				this.type = options.type;
			}
		}
		class ClipboardItemProbe {
			readonly entries: Record<string, unknown>;
			constructor(entries: Record<string, unknown>) {
				this.entries = entries;
			}
		}
		const navigator = {
			clipboard: {
				write: async (items: unknown[]) => {
					nativeWrites.push(items);
				},
			},
		};
		const browser = facadeFor({
			async codexRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				rpcCalls.push({ method, params, timeoutMs });
				return {};
			},
			async codexEvaluate(source: string, args: unknown[]) {
				return await runPageEvaluator(source, args, {
					document,
					window: { document, navigator },
					navigator,
					ClipboardItem: ClipboardItemProbe,
					Blob: BlobProbe,
				});
			},
		});
		const current = await selectedTab(browser);
		const items: [CodexClipboardItem, ...CodexClipboardItem[]] = [
			{
				entries: [
					{ mimeType: "text/plain", text: "first plain value" },
					{ mimeType: "text/html", text: "<b>first rich value</b>" },
				],
			},
			{
				entries: [
					{ mimeType: "text/plain", text: "second plain value" },
					{ mimeType: "application/json", text: '{"item":2}' },
				],
			},
		];

		const error = await caughtError(() => current.clipboard.write(items));
		expect(appendedNodes).toBe(0);
		expect(legacyCopies).toBe(0);
		if (error.name !== "NO_ERROR") {
			expect(error).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: tab.clipboard.write",
			});
			expect(nativeWrites).toEqual([]);
		} else {
			const [writtenItems] = nativeWrites as ClipboardItemProbe[][];
			expect(nativeWrites).toHaveLength(1);
			expect(
				writtenItems?.map(item =>
					Object.entries(item.entries).map(([mimeType, blob]) => ({
						mimeType,
						parts: (blob as BlobProbe).parts,
						type: (blob as BlobProbe).type,
					})),
				),
			).toEqual([
				[
					{ mimeType: "text/plain", parts: ["first plain value"], type: "text/plain" },
					{ mimeType: "text/html", parts: ["<b>first rich value</b>"], type: "text/html" },
				],
				[
					{ mimeType: "text/plain", parts: ["second plain value"], type: "text/plain" },
					{ mimeType: "application/json", parts: ['{"item":2}'], type: "application/json" },
				],
			]);
		}
	});

	it("rejects a missing select option without changing the current selection", async () => {
		const probe = selectProbe(["current", "other"], "current");
		const current = await selectedTab(facadeForSelect(probe));
		const outcome = await caughtError(() => current.playwright.locator("#choice").selectOption("missing"));

		expect(outcome.name).not.toBe("NO_ERROR");
		expect(probe.selectedValues()).toEqual(["current"]);
		expect(probe.events).toEqual([]);
	});

	it("keeps the first requested match when selecting several options on a non-multiple select", async () => {
		const probe = selectProbe(["preferred", "backup"], "backup");
		const current = await selectedTab(facadeForSelect(probe));
		const selected = await current.playwright.locator("#choice").selectOption(["preferred", "backup"]);

		expect(selected).toEqual(["preferred"]);
		expect(probe.selectedValues()).toEqual(["preferred"]);
	});

	it("matches string labels and resolves label descendants to their select controls", async () => {
		const { document, window } = parseHTML(`
			<html><body>
				<label>Country <span id="country-label">Choose</span>
					<select id="country">
						<option value="us">United States</option>
						<option value="ca">Canada</option>
					</select>
				</label>
			</body></html>
		`);
		interface SelectOptionFixture {
			value: string;
			textContent: string | null;
			selected: boolean;
		}
		const select = document.querySelector("#country") as unknown as {
			selectedOptions: ArrayLike<SelectOptionFixture>;
		} | null;
		if (!select) throw new Error("Expected country select");
		const selectOptions = Array.from(
			document.querySelectorAll("#country option"),
		) as unknown as SelectOptionFixture[];
		for (const [index, option] of selectOptions.entries()) {
			Reflect.set(option, "index", index);
			Reflect.set(option, "label", option.textContent ?? "");
			let selected = false;
			Object.defineProperty(option, "selected", {
				configurable: true,
				get: () => selected,
				set: (value: boolean) => {
					selected = value;
				},
			});
		}
		Object.defineProperty(select, "options", { configurable: true, value: selectOptions });
		Object.defineProperty(select, "selectedOptions", {
			configurable: true,
			get: () => selectOptions.filter(option => option.selected),
		});
		Reflect.set(window, "getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "1" }));
		for (const element of document.querySelectorAll("*")) {
			Reflect.set(element, "getBoundingClientRect", () => ({ x: 0, y: 0, width: 100, height: 20 }));
			Reflect.set(element, "scrollIntoView", () => undefined);
		}
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window, Element: window.Element });
				},
			}),
		);

		const fromLabel = await current.playwright.locator("#country-label").selectOption("ca");
		const fromString = await current.playwright.locator("#country").selectOption("United States");

		expect({ fromLabel, fromString, current: Array.from(select.selectedOptions, option => option.value) }).toEqual({
			fromLabel: ["ca"],
			fromString: ["us"],
			current: ["us"],
		});
	});

	it("propagates log RPC failures instead of fabricating an empty log history", async () => {
		const browser = facadeFor({
			async codexRequest(method: string) {
				throw new Error(`cmux log RPC failed: ${method}`);
			},
			async codexEvaluate() {
				return [];
			},
		});
		const current = await selectedTab(browser);

		await expect(current.dev.logs()).rejects.toThrow("cmux log RPC failed: browser.console.list");
	});

	it("resolves associated labels, aria-label, and space-separated aria-labelledby accessible names", async () => {
		const probe = labelProbe();
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document: probe.document, window: probe.view });
				},
			}),
		);

		const counts = await Promise.all(
			["Associated Label", "Direct ARIA Label", "ARIA Labelled By"].map(label =>
				current.playwright.getByLabel(label, { exact: true }).count(),
			),
		);

		expect(counts).toEqual([1, 1, 1]);
	});

	it("resolves aria-labelledby references within an open shadow root", async () => {
		const { document, window } = parseHTML("<html><body><div id=host></div></body></html>");
		const host = document.getElementById("host");
		if (!host) throw new Error("Expected shadow host");
		const shadowRoot = host.attachShadow({ mode: "open" });
		shadowRoot.innerHTML = '<span id="shadow-label">Shadow Label</span><input aria-labelledby="shadow-label">';
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window });
				},
			}),
		);

		expect(await current.playwright.getByLabel("Shadow Label", { exact: true }).count()).toBe(1);
	});

	it("uses aria-labelledby, then aria-label, before native labels for role queries", async () => {
		const probe = labelProbe();
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document: probe.document, window: probe.view });
				},
			}),
		);

		expect(await current.playwright.getByRole("textbox", { name: "ARIA Labelled By", exact: true }).count()).toBe(1);
		expect(await current.playwright.getByRole("textbox", { name: "Preferred ARIA", exact: true }).count()).toBe(1);
		expect(await current.playwright.getByRole("textbox", { name: "Native Name", exact: true }).count()).toBe(0);
	});

	it("rejects ambiguous cmux single-element reads while preserving multi-element counts", async () => {
		const { document, window } = parseHTML("<html><body><button>First</button><button>Second</button></body></html>");
		Reflect.set(window, "getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "1" }));
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window });
				},
			}),
		);
		const locator = current.playwright.getByRole("button");

		expect(await locator.count()).toBe(2);
		expect(await caughtError(() => locator.innerText())).toEqual({
			name: "Error",
			message: "locator.innerText resolved to 2 elements; use first() or nth()",
		});
	});

	it("rejects ambiguous cmux waitFor visible locators instead of using the first match", async () => {
		const { document, window } = parseHTML("<html><body><button>First</button><button>Second</button></body></html>");
		Reflect.set(window, "getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "1" }));
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window });
				},
			}),
		);

		expect(await caughtError(() => current.playwright.getByRole("button").waitFor({ state: "visible" }))).toEqual({
			name: "Error",
			message: "locator.waitFor resolved to 2 elements; use first() or nth()",
		});
	});

	it("uses canonical implicit roles and accessible names in elementInfo", async () => {
		const nativeLabel = { innerText: "Native Name", textContent: "Native Name" };
		const checkbox = {
			tagName: "INPUT",
			type: "checkbox",
			labels: [nativeLabel],
			innerText: "",
			textContent: "",
			outerHTML: '<input type="checkbox" aria-label="Preferred ARIA">',
			getAttribute: (name: string) => (name === "aria-label" ? "Preferred ARIA" : null),
			hasAttribute: (name: string) => name === "type",
			closest: () => checkbox,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 40 }),
		};
		const document = { elementFromPoint: () => checkbox, getElementById: () => null };
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window: {} });
				},
			}),
		);

		expect(await current.playwright.elementInfo({ x: 11, y: 21 })).toEqual([
			expect.objectContaining({ tagName: "input", role: "checkbox", ariaName: "Preferred ARIA" }),
		]);
	});

	it("descends through open shadow roots for cmux elementInfo", async () => {
		const view = {};
		let host: Record<string, unknown>;
		let shadowRoot: Record<string, unknown>;
		const document = {
			defaultView: view,
			elementFromPoint: () => host,
			getElementById: () => null,
		};
		const button = {
			tagName: "BUTTON",
			children: [],
			ownerDocument: document,
			parentElement: null,
			innerText: "Shadow Action",
			textContent: "Shadow Action",
			outerHTML: "<button>Shadow Action</button>",
			getRootNode: () => shadowRoot,
			getAttribute: () => null,
			hasAttribute: () => false,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 90, height: 30 }),
		};
		shadowRoot = { host: undefined, elementFromPoint: () => button };
		host = {
			tagName: "DIV",
			children: [],
			ownerDocument: document,
			parentElement: null,
			shadowRoot,
			getAttribute: () => null,
			hasAttribute: () => false,
		};
		Reflect.set(shadowRoot, "host", host);
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window: view });
				},
			}),
		);

		expect(await current.playwright.elementInfo({ x: 20, y: 25 })).toEqual([
			expect.objectContaining({ tagName: "button", role: "button", visibleText: "Shadow Action" }),
		]);
	});

	it("descends into same-origin frames for elementInfo and visible DOM coordinates", async () => {
		const computedStyle = () => ({ display: "block", visibility: "visible" });
		const localPoints: Array<[number, number]> = [];
		let frame: Record<string, unknown>;
		const frameView: Record<string, unknown> = { getComputedStyle: computedStyle };
		const frameDocument: Record<string, unknown> = {
			defaultView: frameView,
			getElementById: () => null,
			querySelectorAll: () => [],
		};
		const buttonAttributes = new Map<string, string>();
		const button = {
			children: [],
			getAttribute: (name: string) => buttonAttributes.get(name) ?? null,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 30 }),
			getRootNode: () => frameDocument,
			hasAttribute: (name: string) => buttonAttributes.has(name),
			innerText: "Frame Action",
			isContentEditable: false,
			outerHTML: "<button>Frame Action</button>",
			ownerDocument: frameDocument,
			parentElement: null,
			removeAttribute: (name: string) => buttonAttributes.delete(name),
			setAttribute: (name: string, value: string) => buttonAttributes.set(name, value),
			tabIndex: 0,
			tagName: "BUTTON",
			textContent: "Frame Action",
		};
		Reflect.set(frameDocument, "elementFromPoint", (x: number, y: number) => {
			localPoints.push([x, y]);
			return button;
		});
		Reflect.set(frameDocument, "querySelectorAll", (selector: string) => (selector === "*" ? [button] : []));
		const topView = { getComputedStyle: computedStyle };
		const document: Record<string, unknown> = {
			defaultView: topView,
			elementFromPoint: () => frame,
			getElementById: () => null,
			querySelectorAll: (selector: string) => (selector === "*" ? [frame] : []),
		};
		const frameAttributes = new Map<string, string>([["id", "frame-shell"]]);
		frame = {
			clientLeft: 2,
			clientTop: 3,
			contentDocument: frameDocument,
			getAttribute: (name: string) => frameAttributes.get(name) ?? null,
			getBoundingClientRect: () => ({ x: 100, y: 50, width: 200, height: 100 }),
			getRootNode: () => document,
			hasAttribute: (name: string) => frameAttributes.has(name),
			ownerDocument: document,
			parentElement: null,
			querySelectorAll: () => [],
			removeAttribute: (name: string) => frameAttributes.delete(name),
			setAttribute: (name: string, value: string) => frameAttributes.set(name, value),
			tagName: "IFRAME",
		};
		Reflect.set(frameView, "frameElement", frame);
		const evaluate = (source: string, args: unknown[]) =>
			runPageEvaluator(source, args, { document, window: topView });
		const nativeCalls: string[] = [];
		let selectedFrame = false;
		const current = await selectedTab(
			facadeFor({
				async ariaSnapshot() {
					return "";
				},
				codexEvaluate: evaluate,
				codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
				async codexRequest(method: string, params: Readonly<Record<string, unknown>>) {
					expect(method).toBe("browser.frame.select");
					expect(params.selector).toMatch(/^\[data-omp-codex-action-token=/);
					nativeCalls.push(`${method}:${String(params.selector)}`);
					selectedFrame = true;
					return {};
				},
				async codexCleanupRequest(method: string) {
					expect(method).toBe("browser.frame.main");
					nativeCalls.push(`${method}:main`);
					selectedFrame = false;
					return {};
				},
				async click(selector: string) {
					expect(selectedFrame).toBe(true);
					expect(selector).toMatch(/^\[data-omp-codex-action-token=/);
					nativeCalls.push(`click:${selector}`);
				},
			}),
		);

		expect(await current.playwright.elementInfo({ x: 120, y: 80 })).toEqual([
			expect.objectContaining({
				tagName: "button",
				visibleText: "Frame Action",
				boundingBox: { x: 112, y: 73, width: 80, height: 30 },
				selector: { primary: null, candidates: ["button"], frameSelectors: ["#frame-shell"] },
			}),
		]);
		expect(localPoints).toEqual([[18, 27]]);
		const snapshot = await current.dom_cua.get_visible_dom();
		expect(snapshot.nodes).toEqual([
			expect.objectContaining({ node_id: "e1", text: "Frame Action", x: 112, y: 73, width: 80, height: 30 }),
		]);
		await current.dom_cua.click({ node_id: "e1" });
		expect(nativeCalls).toHaveLength(3);
		expect(nativeCalls[0]).toStartWith("browser.frame.select:");
		expect(nativeCalls[1]).toStartWith("click:");
		expect(nativeCalls[2]).toBe("browser.frame.main:main");
		expect(buttonAttributes.has("data-omp-codex-action-token")).toBe(false);
		expect(frameAttributes.has("data-omp-codex-action-token")).toBe(false);
	});

	it("dispatches bare action-token selectors through the trusted CmuxTab click RPC", async () => {
		const selector = '[data-omp-codex-action-token="native-click"]';
		const calls: RpcCall[] = [];
		const client = {
			async request(
				method: string,
				params: Record<string, unknown>,
				options: { timeoutMs?: number } = {},
			): Promise<Record<string, unknown>> {
				calls.push({ method, params, timeoutMs: options.timeoutMs });
				if (method === "browser.click") return {};
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		};
		const tab = new CmuxTab({ client: client as never, surfaceId: "surface-contract" });

		await tab.click(selector, 250);

		expect(calls.map(call => call.method)).toEqual(["browser.click"]);
		expect(calls[0]?.params).toEqual({ surface_id: "surface-contract", selector });
	});

	it("rejects framed shadow DOM-CUA targets instead of falling back to synthetic clicks", async () => {
		const computedStyle = () => ({ display: "block", visibility: "visible" });
		const topView: Record<string, unknown> = { getComputedStyle: computedStyle, frameElement: null };
		const frameView: Record<string, unknown> = { getComputedStyle: computedStyle };
		const buttonAttributes = new Map<string, string>();
		const frameAttributes = new Map<string, string>();
		let frame: Record<string, unknown>;
		let host: Record<string, unknown>;
		let button: Record<string, unknown>;
		const shadowRoot: Record<string, unknown> = {
			querySelectorAll: (selector: string) => (selector === "*" ? [button] : []),
		};
		const frameDocument: Record<string, unknown> = {
			defaultView: frameView,
			getElementById: () => null,
			querySelectorAll: (selector: string) => (selector === "*" ? [host] : []),
		};
		button = {
			children: [],
			getAttribute: (name: string) => buttonAttributes.get(name) ?? null,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 30 }),
			getRootNode: () => shadowRoot,
			hasAttribute: (name: string) => buttonAttributes.has(name),
			innerText: "Framed shadow action",
			isConnected: true,
			isContentEditable: false,
			ownerDocument: frameDocument,
			parentElement: null,
			removeAttribute: (name: string) => buttonAttributes.delete(name),
			setAttribute: (name: string, value: string) => buttonAttributes.set(name, value),
			tabIndex: 0,
			tagName: "BUTTON",
			textContent: "Framed shadow action",
		};
		host = {
			children: [],
			getAttribute: () => null,
			getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 50 }),
			getRootNode: () => frameDocument,
			hasAttribute: () => false,
			ownerDocument: frameDocument,
			parentElement: null,
			shadowRoot,
			tabIndex: -1,
			tagName: "DIV",
		};
		Reflect.set(shadowRoot, "host", host);
		const document: Record<string, unknown> = {
			defaultView: topView,
			getElementById: () => null,
			querySelectorAll: (selector: string) => (selector === "*" ? [frame] : []),
		};
		frame = {
			clientLeft: 0,
			clientTop: 0,
			contentDocument: frameDocument,
			getAttribute: (name: string) => frameAttributes.get(name) ?? null,
			getBoundingClientRect: () => ({ x: 100, y: 50, width: 200, height: 100 }),
			getRootNode: () => document,
			hasAttribute: (name: string) => frameAttributes.has(name),
			isConnected: true,
			ownerDocument: document,
			parentElement: null,
			removeAttribute: (name: string) => frameAttributes.delete(name),
			setAttribute: (name: string, value: string) => frameAttributes.set(name, value),
			tagName: "IFRAME",
		};
		Reflect.set(frameView, "frameElement", frame);
		const fallbackSelectors: string[] = [];
		const evaluate = (source: string, args: unknown[]) =>
			runPageEvaluator(source, args, { document, window: topView });
		const { adapter, browser } = adapterAndFacadeFor({
			async ariaSnapshot() {
				return "";
			},
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async codexRequest() {
				return {};
			},
			async codexCleanupRequest() {
				return {};
			},
			async click(selector: string) {
				fallbackSelectors.push(selector);
			},
		});

		try {
			const current = await selectedTab(browser);
			const snapshot = await current.dom_cua.get_visible_dom();
			const target = snapshot.nodes.find(node => node.text === "Framed shadow action");
			if (!target) throw new Error("Expected framed shadow DOM-CUA target");

			expect(await caughtError(() => current.dom_cua.click({ node_id: target.node_id }))).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: dom_cua framed shadow action",
			});
			expect(fallbackSelectors).toEqual([]);
			expect(buttonAttributes.has("data-omp-codex-action-token")).toBe(false);
			expect(frameAttributes.has("data-omp-codex-action-token")).toBe(false);
		} finally {
			await adapter.dispose();
		}
	});

	it("awaits asynchronous cmux media publication without calling renameSync", async () => {
		const rename = Promise.withResolvers<void>();
		const asyncRename = spyOn(fs.promises, "rename").mockImplementation(async () => await rename.promise);
		const syncRename = spyOn(fs, "renameSync").mockImplementation(() => {
			throw new Error("synchronous rename used");
		});
		spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
		spyOn(fs.promises, "rm").mockResolvedValue(undefined);
		const tab = new CmuxTab({ client: {} as never, surfaceId: "surface-contract" });
		let settled = false;
		const outcome = tab
			.codexPersistFile("/tmp/cmux-media-contract.bin", new Uint8Array([1, 2, 3]), 1_000, "media download")
			.then(
				() => undefined,
				error => error,
			)
			.finally(() => {
				settled = true;
			});
		await Promise.resolve();
		await Promise.resolve();

		expect(asyncRename).toHaveBeenCalledTimes(1);
		expect(syncRename).not.toHaveBeenCalled();
		expect(settled).toBe(false);
		rename.resolve();
		expect(await outcome).toBeUndefined();
	});

	it("removes published cmux media when its run is cancelled during rename", async () => {
		const rename = Promise.withResolvers<void>();
		spyOn(fs.promises, "rename").mockImplementation(async () => await rename.promise);
		spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
		const remove = spyOn(fs.promises, "rm").mockResolvedValue(undefined);
		const controller = new AbortController();
		const destination = "/tmp/cmux-media-cancelled.bin";
		const tab = new CmuxTab({ client: {} as never, surfaceId: "surface-contract" });
		tab.setRunContext({
			session: { cwd: "/tmp" },
			output: {},
			screenshots: [],
			signal: controller.signal,
			timeoutMs: 1_000,
		} as never);
		const outcome = tab.codexPersistFile(destination, new Uint8Array([1, 2, 3]), 1_000, "media download").then(
			() => undefined,
			error => error as Error,
		);
		await Promise.resolve();
		await Promise.resolve();

		controller.abort();
		rename.resolve();

		expect((await outcome)?.name).toBe("ToolAbortError");
		expect(remove).toHaveBeenCalledWith(destination, { force: true });
	});

	it("returns one canonical visible DOM DTO with cmux ref node ids", async () => {
		const current = await selectedTab(
			facadeFor({
				async observe() {
					throw new Error("get_visible_dom must create actionable page ARIA refs");
				},
				async ariaSnapshot(_selector: unknown, options: unknown) {
					expect(options).toEqual({ boxes: true });
					return '- generic "Parent Media Asset" [ref=e6] [box=0,0,400,300]\n- link "Media Asset" [ref=e7] [box=12,24,96,32]';
				},
				async ref() {
					throw new Error("get_visible_dom must not wait for ref resolution");
				},
				elementHandle() {
					throw new Error("get_visible_dom must not issue one RPC per ARIA ref");
				},
				async codexEvaluateCleanup() {
					return true;
				},
				async codexEvaluate(source: string, args: unknown[], timeoutMs: number) {
					expect(source).toContain("_ariaRef");
					expect(args).toEqual([]);
					expect(timeoutMs).toBeGreaterThan(0);
					expect(timeoutMs).toBeLessThanOrEqual(3_000);
					return {
						nodes: [
							{
								node_id: "e7",
								tag: "a",
								role: "link",
								text: "Media Asset",
								x: 12,
								y: 24,
								width: 96,
								height: 32,
							},
						],
						pageNodeIds: [],
					};
				},
			}),
		);

		expect(await current.dom_cua.get_visible_dom()).toEqual({
			nodes: [{ node_id: "e7", tag: "a", role: "link", text: "Media Asset", x: 12, y: 24, width: 96, height: 32 }],
		});
	});

	it("downloads nested media through locator and DOM-ref page contexts", async () => {
		const payload = Buffer.from("page-authenticated-media");
		const writes: Buffer[] = [];
		let transferStarts = 0;
		let transferStatuses = 0;
		const hostFetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("host fetch must not run"));
		const { document, window } = parseHTML(
			'<html><body><button id="media"><picture><img src="blob:fixture-media"></picture></button><a href="blob:ancestor-media"><span id="media-child" tabindex="0">Child</span></a></body></html>',
		);
		const mediaButton = document.getElementById("media");
		if (!mediaButton) throw new Error("Expected media wrapper");
		Reflect.set(mediaButton, "getBoundingClientRect", () => ({ x: 0, y: 0, width: 100, height: 20 }));
		const mediaChild = document.getElementById("media-child");
		if (!mediaChild) throw new Error("Expected media child");
		Reflect.set(mediaChild, "getBoundingClientRect", () => ({ x: 0, y: 24, width: 100, height: 20 }));
		Reflect.set(window, "getComputedStyle", () => ({ display: "block", visibility: "visible" }));
		spyOn(Bun, "write").mockImplementation(async (_destination, data) => {
			writes.push(Buffer.from(data as Uint8Array));
			return writes.at(-1)?.byteLength ?? 0;
		});
		const current = await selectedTab(
			facadeFor({
				codexCwd: () => "/tmp/codex-media-contract",
				async ariaSnapshot() {
					return "";
				},
				async codexEvaluateCleanup(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window });
				},
				async codexEvaluate(source: string, args: unknown[]) {
					if (args[1] === "status") return { attached: true, visible: true, enabled: true };
					if (args[1] === "mediaUrl") return runPageEvaluator(source, args, { document, window });
					if (args[1] === "dom_cua.downloadMedia" || args.length === 0)
						return runPageEvaluator(source, args, { document, window });
					if (source.includes("__ompCodexMediaTransfers") && args.length === 2) {
						transferStarts++;
						return true;
					}
					if (source.includes("__ompCodexMediaTransfers") && args.length === 1) {
						transferStatuses++;
						return {
							url: "blob:fixture-media",
							contentType: "application/octet-stream",
							base64Chunks: [payload.toString("base64")],
						};
					}
					throw new Error("Unexpected page evaluation");
				},
				async codexWait() {
					throw new Error("Completed transfer must not poll");
				},
			}),
		);

		await current.playwright.locator("#media").downloadMedia({ timeoutMs: 250 });
		await current.playwright.locator("#media-child").downloadMedia({ timeoutMs: 250 });
		const snapshot = await current.dom_cua.get_visible_dom();
		const node = snapshot.nodes.find(candidate => candidate.text === "");
		if (!node) throw new Error("Expected media wrapper DOM node");
		await current.dom_cua.downloadMedia({ node_id: node.node_id, timeoutMs: 250 });
		const childNode = snapshot.nodes.find(candidate => candidate.text === "Child");
		if (!childNode) throw new Error("Expected media child DOM node");
		await current.dom_cua.downloadMedia({ node_id: childNode.node_id, timeoutMs: 250 });

		expect(hostFetch).not.toHaveBeenCalled();
		expect(transferStarts).toBe(4);
		expect(transferStatuses).toBe(4);
		expect(writes).toEqual([payload, payload, payload, payload]);
	});

	it("downloads coordinate media through nested open shadow roots and preserves boundary errors", async () => {
		const payload = Buffer.from("nested-shadow-media");
		const requestedUrls: string[] = [];
		const writes: Uint8Array[] = [];
		const media = { currentSrc: "https://fixture.test/nested-shadow.png" };
		const innerShadowRoot = { elementFromPoint: () => media };
		const innerHost = { shadowRoot: innerShadowRoot };
		const outerShadowRoot = { elementFromPoint: () => innerHost };
		const outerHost = { shadowRoot: outerShadowRoot };
		let topHit: object | null = outerHost;
		let coordinateEvaluations = 0;
		const document = { elementFromPoint: () => topHit };
		const current = await selectedTab(
			facadeFor({
				codexCwd: () => "/tmp/codex-media-contract",
				async codexEvaluate(source: string, args: unknown[]) {
					if (source.includes("deepestElementFromPoint")) {
						coordinateEvaluations++;
						return runPageEvaluator(source, args, { document, window: {} });
					}
					if (source.includes("__ompCodexMediaTransfers") && args.length === 2) {
						requestedUrls.push(String(args[0]));
						return true;
					}
					if (source.includes("__ompCodexMediaTransfers") && args.length === 1) {
						return {
							url: requestedUrls.at(-1),
							contentType: "image/png",
							base64Chunks: [payload.toString("base64")],
						};
					}
					throw new Error("Unexpected page evaluation");
				},
				async codexEvaluateCleanup() {
					return true;
				},
				async codexPersistFile(_path: string, data: Uint8Array) {
					writes.push(data);
				},
			}),
		);

		await expect(current.cua.downloadMedia({ x: Number.NaN, y: 24 })).rejects.toThrow(
			"cua.downloadMedia x requires a number",
		);
		expect(coordinateEvaluations).toBe(0);

		await current.cua.downloadMedia({ x: 12, y: 24, timeoutMs: 250 });
		expect(requestedUrls).toEqual([media.currentSrc]);
		expect(writes.map(data => Buffer.from(data))).toEqual([payload]);

		topHit = null;
		const missing = await caughtError(() => current.cua.downloadMedia({ x: 12, y: 24, timeoutMs: 250 }));
		expect(missing).toEqual({
			name: "ToolError",
			message: "cua.downloadMedia target has no downloadable URL",
		});
		expect(requestedUrls).toHaveLength(1);
	});

	it("resolves an enclosing composed media link for cmux coordinate downloads", async () => {
		const payload = Buffer.from("composed-ancestor-media");
		const requestedUrls: string[] = [];
		const writes: Uint8Array[] = [];
		const mediaLink = {
			tagName: "A",
			href: "https://fixture.test/enclosing-link.png",
			getAttribute: (name: string) => (name === "href" ? "https://fixture.test/enclosing-link.png" : null),
			parentElement: null,
			getRootNode: () => ({}),
		};
		const descendant = {
			tagName: "SPAN",
			parentElement: mediaLink,
			getRootNode: () => ({}),
			getAttribute: () => null,
		};
		const document = { elementFromPoint: () => descendant };
		const current = await selectedTab(
			facadeFor({
				codexCwd: () => "/tmp/codex-media-contract",
				async codexEvaluate(source: string, args: unknown[]) {
					if (source.includes("deepestElementFromPoint"))
						return runPageEvaluator(source, args, { document, window: {} });
					if (source.includes("__ompCodexMediaTransfers") && args.length === 2) {
						requestedUrls.push(String(args[0]));
						return true;
					}
					if (source.includes("__ompCodexMediaTransfers") && args.length === 1) {
						return {
							url: requestedUrls.at(-1),
							contentType: "image/png",
							base64Chunks: [payload.toString("base64")],
						};
					}
					throw new Error("Unexpected page evaluation");
				},
				async codexEvaluateCleanup() {
					return true;
				},
				async codexPersistFile(_path: string, data: Uint8Array) {
					writes.push(data);
				},
			}),
		);

		await current.cua.downloadMedia({ x: 12, y: 24, timeoutMs: 250 });
		expect(requestedUrls).toEqual([mediaLink.href]);
		expect(writes.map(data => Buffer.from(data))).toEqual([payload]);
	});

	it("downloads framed coordinate media with border-adjusted shadow traversal and stops at inaccessible frames", async () => {
		const payload = Buffer.from("framed-shadow-media");
		const frameUrl = "https://fixture.test/frame.html";
		const mediaUrl = "https://fixture.test/inner-media.png";
		const requestedUrls: string[] = [];
		const localPoints: Array<[number, number]> = [];
		const writes: Uint8Array[] = [];
		const mediaLink = { href: mediaUrl, tagName: "A" };
		const shadowRoot = {
			elementFromPoint(x: number, y: number) {
				localPoints.push([x, y]);
				return mediaLink;
			},
		};
		const shadowHost = { shadowRoot };
		const frameDocument = {
			elementFromPoint(x: number, y: number) {
				localPoints.push([x, y]);
				return shadowHost;
			},
		};
		const sameOriginFrame = {
			clientLeft: 4,
			clientTop: 6,
			contentDocument: frameDocument,
			getBoundingClientRect: () => ({ x: 100, y: 50, width: 300, height: 200 }),
			src: frameUrl,
			tagName: "IFRAME",
		};
		const inaccessibleFrame = {
			get contentDocument(): never {
				throw new Error("Blocked a frame with origin");
			},
			src: "https://cross-origin.test/frame.html",
			tagName: "IFRAME",
		};
		let topHit: object = sameOriginFrame;
		const document = { elementFromPoint: () => topHit };
		const current = await selectedTab(
			facadeFor({
				codexCwd: () => "/tmp/codex-media-contract",
				async codexEvaluate(source: string, args: unknown[]) {
					if (source.includes("deepestElementFromPoint") || source.includes("document.elementFromPoint")) {
						return runPageEvaluator(source, args, { document, window: {} });
					}
					if (source.includes("__ompCodexMediaTransfers") && args.length === 2) {
						requestedUrls.push(String(args[0]));
						return true;
					}
					if (source.includes("__ompCodexMediaTransfers") && args.length === 1) {
						return {
							url: requestedUrls.at(-1),
							contentType: "image/png",
							base64Chunks: [payload.toString("base64")],
						};
					}
					throw new Error("Unexpected page evaluation");
				},
				async codexEvaluateCleanup() {
					return true;
				},
				async codexPersistFile(_path: string, data: Uint8Array) {
					writes.push(data);
				},
			}),
		);

		await current.cua.downloadMedia({ x: 124, y: 86, timeoutMs: 250 });
		expect(localPoints).toEqual([
			[20, 30],
			[20, 30],
		]);
		expect(requestedUrls).toEqual([mediaUrl]);
		expect(writes.map(data => Buffer.from(data))).toEqual([payload]);

		topHit = inaccessibleFrame;
		const inaccessible = await caughtError(() => current.cua.downloadMedia({ x: 124, y: 86, timeoutMs: 250 }));
		expect(inaccessible).toEqual({
			name: "ToolError",
			message: "cua.downloadMedia target has no downloadable URL",
		});
		expect(requestedUrls).toEqual([mediaUrl]);
	});

	it("rejects unknown-length media before retaining a streaming chunk beyond 32 MiB", async () => {
		let reads = 0;
		let cancellations = 0;
		let arrayBufferCalls = 0;
		const writes: Uint8Array[] = [];
		const oversizedChunk = new Uint8Array(32 * 1024 * 1024 + 1);
		const response = {
			ok: true,
			status: 200,
			url: "blob:oversized-media",
			headers: {
				get(name: string) {
					return name.toLowerCase() === "content-type" ? "application/octet-stream" : null;
				},
			},
			body: {
				getReader() {
					return {
						async read() {
							reads++;
							return { done: false, value: oversizedChunk };
						},
						async cancel() {
							cancellations++;
						},
						releaseLock() {},
					};
				},
			},
			async arrayBuffer() {
				arrayBufferCalls++;
				return new Uint8Array([1]).buffer;
			},
		};
		spyOn(globalThis, "fetch").mockResolvedValue(response as never);
		spyOn(Bun, "write").mockImplementation(async (_destination, data) => {
			writes.push(new Uint8Array(data as Uint8Array));
			return writes.at(-1)?.byteLength ?? 0;
		});
		const document = { baseURI: "https://fixture.test/" };
		const current = await selectedTab(
			facadeFor({
				codexCwd: () => "/tmp/codex-media-contract",
				async codexEvaluate(source: string, args: unknown[]) {
					if (args[1] === "status") return { attached: true, visible: true, enabled: true };
					if (args[1] === "mediaUrl") return "blob:oversized-media";
					return runPageEvaluator(source, args, { document, window: {} });
				},
				async codexEvaluateCleanup() {
					return true;
				},
				async codexWait() {
					await Promise.resolve();
				},
			}),
		);

		const error = await caughtError(() => current.playwright.locator("#media").downloadMedia({ timeoutMs: 250 }));

		expect(error.message).toContain("downloadMedia response exceeds the 32 MiB limit");
		expect(reads).toBe(1);
		expect(cancellations).toBe(1);
		expect(arrayBufferCalls).toBe(0);
		expect(writes).toEqual([]);
	});

	it("revalidates bounded media after the cmux page boundary", async () => {
		const chunk = Buffer.alloc(1024).toString("base64");
		const oversizedChunks = Array.from({ length: 32 * 1024 + 1 }, () => chunk);
		let persistenceCalls = 0;
		const current = await selectedTab(
			facadeFor({
				codexCwd: () => "/tmp/codex-media-contract",
				async codexEvaluate(source: string, args: unknown[]) {
					if (args[1] === "status") return { attached: true, visible: true, enabled: true };
					if (args[1] === "mediaUrl") return "blob:mutated-media";
					if (source.includes("__ompCodexMediaTransfers") && args.length === 2) return true;
					if (source.includes("__ompCodexMediaTransfers") && args.length === 1) {
						return {
							url: "blob:mutated-media",
							contentType: "application/octet-stream",
							base64Chunks: oversizedChunks,
						};
					}
					throw new Error("Unexpected page evaluation");
				},
				async codexPersistFile() {
					persistenceCalls++;
					throw new Error("oversized media reached persistence");
				},
				async codexWait() {
					throw new Error("Completed transfer must not poll");
				},
			}),
		);

		const error = await caughtError(() => current.playwright.locator("#media").downloadMedia({ timeoutMs: 250 }));

		expect(error.message).toContain("downloadMedia response exceeds the 32 MiB limit");
		expect(persistenceCalls).toBe(0);
	});

	it("maps select size to the same implicit listbox role as Puppeteer", async () => {
		const current = await selectedTab(facadeForSelect(selectProbe(["one", "two"], "one", false, 2)));

		expect(await current.playwright.getByRole("listbox").count()).toBe(1);
		expect(await current.playwright.getByRole("combobox").count()).toBe(0);
	});

	it("uses native key input after focusing semantic locators", async () => {
		const commands: string[] = [];
		const presses: Array<{ key: string; timeoutMs?: number }> = [];
		const focuses: string[] = [];
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(_source: string, args: unknown[]) {
					const command = String(args[1]);
					commands.push(command);
					if (command === "status") return { attached: true, visible: true, enabled: true };
					if (command === "bindNativeSelector") {
						const token = String((args[2] as { token: string }).token);
						return {
							selector: `[data-omp-codex-action-token="${token}"]`,
							frameSelectors: [],
						};
					}
					return true;
				},
				async codexEvaluateCleanup() {
					return true;
				},
				async focus(selector: string) {
					focuses.push(selector);
				},
				async press(key: string, options?: { timeoutMs?: number }) {
					presses.push({ key, timeoutMs: options?.timeoutMs });
				},
			}),
		);

		await current.playwright.getByLabel("Name").press("a");
		await current.playwright.getByLabel("Name").press("ControlOrMeta+K");

		expect(commands).toEqual(["status", "bindNativeSelector", "status", "bindNativeSelector"]);
		expect(focuses).toEqual([
			expect.stringMatching(/^\[data-omp-codex-action-token=/),
			expect.stringMatching(/^\[data-omp-codex-action-token=/),
		]);
		expect(presses).toHaveLength(2);
		expect(presses[0]?.key).toBe("a");
		expect(presses[1]?.key).toBe(`${process.platform === "darwin" ? "Meta" : "Control"}+K`);
		for (const press of presses) expect(press.timeoutMs).toBeGreaterThan(0);
	});

	it("dispatches CUA key arrays as one normalized native chord", async () => {
		const presses: string[] = [];
		const current = await selectedTab(
			facadeFor({
				async press(key: string) {
					presses.push(key);
				},
			}),
		);

		await current.cua.keypress({ keys: ["Control", "L"] });
		await current.cua.keypress({ keys: ["ControlOrMeta", "K"] });

		expect(presses).toEqual(["Control+L", `${process.platform === "darwin" ? "Meta" : "Control"}+K`]);
	});

	it("routes locator clicks through native input and rejects unrepresentable options", async () => {
		const commands: string[] = [];
		const nativeClicks: string[] = [];
		const nativeDoubleClicks: string[] = [];
		const disposedTokens: string[] = [];
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(_source: string, args: unknown[]) {
					const command = String(args[1]);
					commands.push(command);
					if (command === "status") return { attached: true, visible: true, enabled: true };
					if (command === "bindNativeSelector") {
						const token = String((args[2] as { token: string }).token);
						return { selector: `[data-omp-codex-action-token="${token}"]`, frameSelectors: [] };
					}
					if (command === "click" || command === "dblclick") throw new Error("synthetic click must not run");
					if (command === "armNativeFileActivation") return false;
					return true;
				},
				async codexEvaluateCleanup(_source: string, args: unknown[]) {
					disposedTokens.push(String(args[0]));
					return true;
				},
				async click(selector: string) {
					nativeClicks.push(selector);
				},
				async dblclick(selector: string) {
					nativeDoubleClicks.push(selector);
				},
			}),
		);

		await current.playwright.locator("#primary").click({ button: "left" });
		await current.playwright.getByRole("button", { name: "Primary" }).dblclick();
		const unsupported = await Promise.all([
			caughtError(() => current.playwright.locator("#primary").click({ button: "middle" })),
			caughtError(() => current.playwright.locator("#primary").click({ modifiers: ["ControlOrMeta"] })),
			caughtError(() => current.playwright.locator("#primary").click({ force: true })),
		]);

		expect(nativeClicks).toHaveLength(1);
		expect(nativeClicks[0]).toMatch(/^\[data-omp-codex-action-token=/);
		expect(nativeDoubleClicks).toHaveLength(1);
		expect(nativeDoubleClicks[0]).toMatch(/^\[data-omp-codex-action-token=/);
		expect(disposedTokens).toHaveLength(2);
		expect(commands).not.toContain("click");
		expect(commands).not.toContain("dblclick");
		for (const error of unsupported) {
			expect(error).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: locator.click options",
			});
		}
	});

	it("uses plain CSS tokens for light-DOM locator clicks and rejects shadow targets before mutation", async () => {
		const { document, window } = parseHTML(
			'<html><body><button class="light">Light click</button><button class="light">Light double click</button><div id="host"></div></body></html>',
		);
		const lightButtons = Array.from(document.querySelectorAll("button.light")) as Element[];
		const host = document.getElementById("host");
		if (!host || lightButtons.length !== 2) throw new Error("Expected light DOM controls and shadow host");
		const shadowRoot = host.attachShadow({ mode: "open" });
		shadowRoot.innerHTML = "<button>Shadow action</button>";
		const shadowButton = shadowRoot.querySelector("button");
		if (!shadowButton) throw new Error("Expected shadow control");
		for (const element of [...lightButtons, shadowButton]) {
			Reflect.set(element, "getBoundingClientRect", () => ({ x: 0, y: 0, width: 100, height: 20 }));
			Reflect.set(element, "scrollIntoView", () => undefined);
		}
		Reflect.set(window, "getComputedStyle", () => ({ display: "block", visibility: "visible" }));
		const nativeClicks: Array<{ kind: "click" | "dblclick"; selector: string }> = [];
		const evaluate = (source: string, args: unknown[]) => runPageEvaluator(source, args, { document, window });
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async codexWait() {
				throw new Error("Controls should be immediately actionable");
			},
			async click(selector: string) {
				nativeClicks.push({ kind: "click", selector });
				expect(selector).not.toStartWith("pierce/");
				expect(document.querySelector(selector)).toBe(lightButtons[0]);
			},
			async dblclick(selector: string) {
				nativeClicks.push({ kind: "dblclick", selector });
				expect(selector).not.toStartWith("pierce/");
				expect(document.querySelector(selector)).toBe(lightButtons[1]);
			},
		});

		try {
			const current = await selectedTab(browser);
			await current.playwright.locator("button.light").first().click();
			await current.playwright.locator("button.light").nth(1).dblclick();
			const shadowError = await caughtError(() =>
				current.playwright.getByText("Shadow action", { exact: true }).click(),
			);

			expect(nativeClicks.map(call => call.kind)).toEqual(["click", "dblclick"]);
			expect(nativeClicks.every(call => call.selector.startsWith('[data-omp-codex-action-token="'))).toBe(true);
			expect(shadowError).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: dom_cua framed shadow action",
			});
			expect(lightButtons.every(button => !button.hasAttribute("data-omp-codex-action-token"))).toBe(true);
			expect(shadowButton.hasAttribute("data-omp-codex-action-token")).toBe(false);
		} finally {
			await adapter.dispose();
		}
	});

	it("propagates native overlay rejection without synthetic locator activation", async () => {
		const commands: string[] = [];
		const nativeTimeouts: number[] = [];
		let coveredTargetActivations = 0;
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(_source: string, args: unknown[]) {
					const command = String(args[1]);
					commands.push(command);
					if (command === "status") return { attached: true, visible: true, enabled: true };
					if (command === "click" || command === "dblclick") coveredTargetActivations++;
					if (command === "armNativeFileActivation") return false;
					if (command === "bindNativeSelector") {
						const token = String((args[2] as { token: string }).token);
						return { selector: `[data-omp-codex-action-token="${token}"]`, frameSelectors: [] };
					}
					return true;
				},
				async codexEvaluateCleanup() {
					return true;
				},
				async click(_selector: string, timeoutMs?: number) {
					nativeTimeouts.push(timeoutMs ?? 0);
					throw new Error("covered target does not receive pointer events");
				},
				async dblclick(_selector: string, timeoutMs?: number) {
					nativeTimeouts.push(timeoutMs ?? 0);
					throw new Error("covered target does not receive pointer events");
				},
			}),
		);

		const outcomes = await Promise.all([
			caughtError(() => current.playwright.locator("#covered").click({ timeoutMs: 250 })),
			caughtError(() => current.playwright.locator("#covered").dblclick({ timeoutMs: 250 })),
		]);

		expect(outcomes).toEqual([
			{ name: "Error", message: "covered target does not receive pointer events" },
			{ name: "Error", message: "covered target does not receive pointer events" },
		]);
		expect(nativeTimeouts).toHaveLength(2);
		expect(nativeTimeouts.every(timeout => timeout > 0 && timeout <= 250)).toBe(true);
		expect(coveredTargetActivations).toBe(0);
		expect(commands).not.toContain("click");
		expect(commands).not.toContain("dblclick");
	});

	it("rejects coordinate CUA actions instead of dispatching synthetic DOM events", async () => {
		let evaluations = 0;
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate() {
					evaluations++;
					return true;
				},
			}),
		);
		const outcomes = await Promise.all([
			caughtError(() => current.cua.click({ x: 1, y: 2, button: 1 })),
			caughtError(() => current.cua.double_click({ x: 1, y: 2 })),
			caughtError(() =>
				current.cua.drag({
					path: [
						{ x: 1, y: 2 },
						{ x: 3, y: 4 },
					],
				}),
			),
			caughtError(() => current.cua.move({ x: 1, y: 2 })),
			caughtError(() => current.cua.scroll({ x: 1, y: 2, scrollX: 3, scrollY: 4 })),
		]);

		expect(Array.from(outcomes)).toEqual(
			["cua.click", "cua.double_click", "cua.drag", "cua.move", "cua.scroll"].map(capability => ({
				name: "BrowserCapabilityError",
				message: `Browser capability is unavailable: ${capability}`,
			})),
		);
		expect(evaluations).toBe(0);
	});

	it("ignores canceled file-input activation", async () => {
		const probe = observerProbe();
		const adapter = adapterForObserver(probe, () => {
			throw new Error("Canceled activation must not create a file chooser");
		});
		await adapter.beginRun();

		try {
			probe.fire(probe.file, true);
			await Promise.resolve();
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
			expect(
				await caughtError(() =>
					adapter.invoke("playwright.waitForEvent", {
						tabId: "1",
						event: "filechooser",
						timeoutMs: 250,
					}),
				),
			).toEqual({ name: "Error", message: "Canceled activation must not create a file chooser" });
		} finally {
			await adapter.dispose();
		}
	});

	it("ignores untrusted file-input activation", async () => {
		const probe = observerProbe();
		const adapter = adapterForObserver(probe);
		await adapter.beginRun();

		try {
			probe.fire(probe.file, false, false, false);
			await Promise.resolve();
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
		} finally {
			await adapter.dispose();
		}
	});

	it("records a delegated file-input activation during a trusted user gesture", async () => {
		const probe = observerProbe();
		const adapter = adapterForObserver(probe);
		await adapter.beginRun();

		try {
			probe.fire(probe.anchor, false, false, true);
			probe.fire(probe.file, false, false, false);
			await Promise.resolve();
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toMatch(/^file-/);
		} finally {
			await adapter.dispose();
		}
	});

	it("populates and cleans up a shadow file input through a piercing selector", async () => {
		const probe = observerProbe(true, true);
		const uploadSelectors: string[] = [];
		const adapter = adapterForObserver(
			probe,
			async () => {
				probe.fire(probe.anchor, false, false, true, [probe.file, probe.anchor]);
			},
			selector => {
				uploadSelectors.push(selector);
			},
		);
		await adapter.beginRun();

		try {
			const waiting = adapter.invoke<{ token: string; multiple: boolean }>("playwright.waitForEvent", {
				tabId: "1",
				event: "filechooser",
				timeoutMs: 250,
			});
			const chooser = await waiting;
			await adapter.invoke("playwright.fileChooser.setFiles", {
				tabId: "1",
				token: chooser.token,
				files: ["fixture.txt"],
				timeoutMs: 250,
			});

			expect(uploadSelectors).toEqual([expect.stringMatching(/^pierce\/input\[data-omp-codex-file-token=/)]);
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
		} finally {
			await adapter.dispose();
		}
	});

	it("records native adapter file activation without accepting arbitrary untrusted page events", async () => {
		const probe = observerProbe(true);
		const commands: string[] = [];
		let nativeClicks = 0;
		const evaluate = (source: string, args: unknown[]) => {
			const command = args[1];
			if (typeof command === "string") commands.push(command);
			if (command === "status") return { attached: true, visible: true, enabled: true };
			return runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
			});
		};

		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async click() {
				nativeClicks++;
				probe.fire(probe.file, false, false, false);
			},
			async codexWait() {
				await Promise.resolve();
			},
		});
		try {
			const current = await selectedTab(browser);
			const chooserPromise = current.playwright.waitForEvent("filechooser", { timeoutMs: 250 });
			await Promise.resolve();

			await current.playwright.locator("#upload").click();
			const chooser = await chooserPromise;

			if (!("isMultiple" in chooser)) throw new Error("Expected file chooser event");
			expect(nativeClicks).toBe(1);
			expect(chooser.isMultiple()).toBe(true);
			expect(commands).not.toContain("recordFileActivation");
		} finally {
			await adapter.dispose();
		}
	});
	it("captures and populates a file chooser inside the selected same-origin frame", async () => {
		const probe = observerProbe(true, false, true);
		const frameCalls: string[] = [];
		let selectedFrame = false;
		let uploads = 0;
		const clickOccurred = Promise.withResolvers<void>();
		const evaluate = (source: string, args: unknown[]) => {
			if (args[1] === "status") return { attached: true, visible: true, enabled: true };
			return runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
			});
		};
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async codexRequest(method: string, params: Readonly<Record<string, unknown>>) {
				frameCalls.push(`${method}:${String(params.selector ?? "")}`);
				expect(params.selector).not.toBe("#frame");
				expect(params.selector).not.toStartWith("pierce/");
				selectedFrame = true;
				return {};
			},
			async codexCleanupRequest(method: string) {
				frameCalls.push(`${method}:main`);
				selectedFrame = false;
				return {};
			},
			async click() {
				expect(selectedFrame).toBe(true);
				probe.fire(probe.file, false, false, false);
				clickOccurred.resolve();
			},
			async codexUploadFile(selector: string) {
				expect(selectedFrame).toBe(true);
				expect(selector).toMatch(/^pierce\/input\[data-omp-codex-file-token=/);
				uploads++;
			},
			async codexWait() {
				await clickOccurred.promise;
			},
		});

		try {
			const current = await selectedTab(browser);
			const frame = current.playwright.frameLocator("#frame");
			const chooserPromise = current.playwright.waitForEvent("filechooser", { timeoutMs: 250 });
			await Promise.resolve();
			const pageState = (globalThis as unknown as { __ompCodexBrowserState?: { observedDocuments?: unknown[] } })
				.__ompCodexBrowserState;
			expect(pageState?.observedDocuments).toHaveLength(2);
			await frame.locator("#upload").click();
			await Promise.resolve();
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toMatch(/^file-/);
			const chooser = await chooserPromise;
			if (!("setFiles" in chooser)) throw new Error("Expected file chooser event");
			await chooser.setFiles(["fixture.txt"], { timeoutMs: 250 });

			expect(uploads).toBe(1);
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
			expect(probe.frame.getAttribute("data-omp-codex-action-token")).toBeNull();
			expect(probe.frame.getAttribute("data-omp-codex-file-frame-token")).toBeNull();
			expect(frameCalls).toHaveLength(4);
			expect(frameCalls[0]).toMatch(/^browser\.frame\.select:\[data-omp-codex-action-token=/);
			expect(frameCalls[1]).toBe("browser.frame.main:main");
			expect(frameCalls[2]).toMatch(/^browser\.frame\.select:\[data-omp-codex-file-frame-token=/);
			expect(frameCalls[3]).toBe("browser.frame.main:main");
		} finally {
			await adapter.dispose();
		}
	});

	it("scopes a button-delegated iframe file chooser to the accepted input frame", async () => {
		const probe = observerProbe(false, false, true);
		const frameCalls: string[] = [];
		let selectedFrame = false;
		let fired = false;
		const uploadSelectors: string[] = [];
		const requestAdapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-observer",
			codexEvaluate: (source: string, args: unknown[]) =>
				runPageEvaluator(source, args, { document: probe.document, window: {}, Element: probe.ElementProbe }),
			async codexEvaluateCleanup(source: string, args: unknown[]) {
				return runPageEvaluator(source, args, {
					document: probe.document,
					window: {},
					Element: probe.ElementProbe,
				});
			},
			async codexWait() {
				if (fired) return;
				fired = true;
				probe.fire(probe.anchor, false, false, true);
				probe.fire(probe.file, false, false, false);
				await Promise.resolve();
			},
			async codexRequest(method: string, params: Readonly<Record<string, unknown>>) {
				frameCalls.push(`${method}:${String(params.selector ?? "")}`);
				selectedFrame = true;
				return {};
			},
			async codexCleanupRequest(method: string) {
				frameCalls.push(`${method}:main`);
				selectedFrame = false;
				return {};
			},
			async codexUploadFile(selector: string) {
				expect(selectedFrame).toBe(true);
				uploadSelectors.push(selector);
			},
		} as never);

		await requestAdapter.beginRun();
		try {
			const chooser = await requestAdapter.invoke<{ token: string }>("playwright.waitForEvent", {
				tabId: "1",
				event: "filechooser",
				timeoutMs: 250,
			});
			await requestAdapter.invoke("playwright.fileChooser.setFiles", {
				tabId: "1",
				token: chooser.token,
				files: ["fixture.txt"],
				timeoutMs: 250,
			});

			expect(uploadSelectors).toEqual([expect.stringMatching(/^pierce\/input\[data-omp-codex-file-token=/)]);
			expect(frameCalls).toEqual([
				expect.stringMatching(/^browser\.frame\.select:\[data-omp-codex-file-frame-token=/),
				"browser.frame.main:main",
			]);
			expect(probe.frame.getAttribute("data-omp-codex-file-frame-token")).toBeNull();
		} finally {
			await requestAdapter.dispose();
		}
	});

	it("rescans observed documents for file inputs in frames mounted after beginRun", async () => {
		const probe = observerProbe(false, false, true, false);
		let waits = 0;
		const adapter = adapterForObserver(probe, async () => {
			if (++waits > 1) throw new Error("Late frame file chooser was not observed");
			probe.fire(probe.file);
			await Promise.resolve();
		});
		await adapter.beginRun();
		probe.mountFrame();

		try {
			const chooser = await adapter.invoke<{ token: string }>("playwright.waitForEvent", {
				tabId: "1",
				event: "filechooser",
				timeoutMs: 250,
			});
			expect(chooser.token).toMatch(/^file-/);
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toBe(chooser.token);
		} finally {
			await adapter.dispose();
		}
	});

	it("captures the observer sequence before consuming waiter readiness in a following click", async () => {
		const probe = observerProbe(true);
		let installs = 0;
		const lateInstall = Promise.withResolvers<void>();
		let clicked = false;
		let postClickWaits = 0;
		const evaluate = (source: string, args: unknown[]) => {
			if (source.includes("INSTALL_PAGE_OBSERVERS_SOURCE")) throw new Error("Unexpected source marker");
			if (source.includes("fileEventSequence") && args.length === 1) {
				installs++;
				if (installs > 1) {
					return lateInstall.promise.then(() =>
						runPageEvaluator(source, args, {
							document: probe.document,
							window: {},
							Element: probe.ElementProbe,
						}),
					);
				}
			}
			const command = args[1];
			if (command === "status") return { attached: true, visible: true, enabled: true };
			return runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
			});
		};
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async click() {
				clicked = true;
				probe.fire(probe.file);
			},
			async codexWait() {
				await Promise.resolve();
				if (clicked && ++postClickWaits > 1) throw new Error("file chooser event was missed");
			},
		});

		try {
			await adapter.beginRun();
			const current = await selectedTab(browser);
			const chooserPromise = current.playwright.waitForEvent("filechooser", { timeoutMs: 250 });
			const clickPromise = current.playwright.locator("#upload").click();
			await Promise.resolve();
			expect(clicked).toBe(false);
			lateInstall.resolve();
			await clickPromise;
			const chooser = await chooserPromise;
			if (!("isMultiple" in chooser)) throw new Error("Expected file chooser event");
			expect(chooser.isMultiple()).toBe(true);
			expect(installs).toBe(2);
		} finally {
			lateInstall.resolve();
			await adapter.dispose();
		}
	});

	it("blocks DOM CUA click and double-click until file chooser capture is ready", async () => {
		for (const action of ["click", "double_click"] as const) {
			const probe = observerProbe(true);
			let installs = 0;
			const lateInstall = Promise.withResolvers<void>();
			let activated = false;
			const evaluate = (source: string, args: unknown[]) => {
				if (source.includes("fileEventSequence") && args.length === 1) {
					installs++;
					if (installs > 1) {
						return lateInstall.promise.then(() =>
							runPageEvaluator(source, args, {
								document: probe.document,
								window: {},
								Element: probe.ElementProbe,
							}),
						);
					}
				}
				return runPageEvaluator(source, args, {
					document: probe.document,
					window: {},
					Element: probe.ElementProbe,
				});
			};
			const { adapter, browser } = adapterAndFacadeFor({
				codexEvaluate: evaluate,
				codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
				async ref() {
					const activate = async () => {
						activated = true;
						probe.fire(probe.file);
					};
					return { click: activate, dblclick: activate };
				},
				async codexWait() {
					await Promise.resolve();
				},
			});

			try {
				await adapter.beginRun();
				const current = await selectedTab(browser);
				const chooserPromise = current.playwright.waitForEvent("filechooser", { timeoutMs: 250 });
				const actionPromise =
					action === "click"
						? current.dom_cua.click({ node_id: "e1" })
						: current.dom_cua.double_click({ node_id: "e1" });
				await Promise.resolve();
				expect(activated).toBe(false);
				lateInstall.resolve();
				await actionPromise;
				const chooser = await chooserPromise;
				if (!("isMultiple" in chooser)) throw new Error("Expected file chooser event");
				expect(chooser.isMultiple()).toBe(true);
			} finally {
				lateInstall.resolve();
				await adapter.dispose();
			}
		}
	});

	it("does not synthesize a chooser after a trusted native file-input click is default-prevented", async () => {
		const probe = observerProbe();
		const waiterPolling = Promise.withResolvers<void>();
		const releaseWaiter = Promise.withResolvers<void>();
		let releasedWaits = 0;
		const evaluate = (source: string, args: unknown[]) => {
			const command = args[1];
			if (command === "status") return { attached: true, visible: true, enabled: true };
			return runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
			});
		};
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async click() {
				probe.fire(probe.file, true);
			},
			async codexWait() {
				waiterPolling.resolve();
				await releaseWaiter.promise;
				if (++releasedWaits > 1) throw new Error("No chooser token/event was recorded or returned");
			},
		});
		try {
			const current = await selectedTab(browser);
			const chooserPromise = current.playwright.waitForEvent("filechooser", { timeoutMs: 250 });
			await waiterPolling.promise;

			await current.playwright.locator("#upload").click();
			releaseWaiter.resolve();
			const outcome = await chooserPromise.then(
				chooser => {
					if (!("isMultiple" in chooser)) throw new Error("Expected file chooser event");
					return { status: "resolved", multiple: chooser.isMultiple() };
				},
				(error: Error) => ({ status: "rejected", name: error.name, message: error.message }),
			);

			expect(outcome).toEqual({
				status: "rejected",
				name: "Error",
				message: "No chooser token/event was recorded or returned",
			});
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
		} finally {
			releaseWaiter.resolve();
			await adapter.dispose();
		}
	});

	it("captures file-input activation before bubble propagation is stopped", async () => {
		const probe = observerProbe();
		const adapter = adapterForObserver(probe);
		await adapter.beginRun();

		try {
			probe.fire(probe.file, false, true);
			await Promise.resolve();
			expect(probe.file.getAttribute("data-omp-codex-file-token")).toMatch(/^file-/);
		} finally {
			await adapter.dispose();
		}
	});

	it("removes file-chooser tokens on dispose and uses run-unique tokens across adapter cycles", async () => {
		const probe = observerProbe();
		const cycles: Array<{ fileToken: string | null; attributeAfterDispose: string | null }> = [];

		for (let cycle = 0; cycle < 2; cycle++) {
			const adapter = adapterForObserver(probe);
			await adapter.beginRun();
			probe.fire(probe.file);
			await Promise.resolve();
			const fileToken = probe.file.getAttribute("data-omp-codex-file-token");

			await adapter.dispose();
			cycles.push({
				fileToken,
				attributeAfterDispose: probe.file.getAttribute("data-omp-codex-file-token"),
			});
		}

		expect(cycles.map(cycle => cycle.attributeAfterDispose)).toEqual([null, null]);
		expect(cycles.every(cycle => !!cycle.fileToken)).toBe(true);
		expect(new Set(cycles.map(cycle => cycle.fileToken)).size).toBe(2);
	});

	it("removes page file tokens after chooser timeout and aborted run", async () => {
		const probe = observerProbe();
		const adapter = adapterForObserver(probe, async () => {
			throw new Error("poll timeout");
		});
		await adapter.beginRun();
		probe.fire(probe.file);
		await Promise.resolve();
		expect(probe.file.getAttribute("data-omp-codex-file-token")).toMatch(/^file-/);
		await caughtError(() =>
			adapter.invoke("playwright.waitForEvent", { tabId: "1", event: "filechooser", timeoutMs: 1 }),
		);
		await adapter.dispose();
		expect(probe.file.getAttribute("data-omp-codex-file-token")).toBeNull();
	});

	it("ignores file-chooser clicks that predate waiter registration", async () => {
		const probe = observerProbe();
		let waitCalls = 0;
		let laterToken: string | null = null;
		const adapter = adapterForObserver(probe, async () => {
			waitCalls++;
			if (waitCalls > 1) throw new Error("Expected the later chooser click to resolve the waiter");
			probe.fire(probe.file);
			await Promise.resolve();
			laterToken = probe.file.getAttribute("data-omp-codex-file-token");
		});
		await adapter.beginRun();
		probe.fire(probe.file);
		await Promise.resolve();
		const staleToken = probe.file.getAttribute("data-omp-codex-file-token");

		try {
			const event = await adapter.invoke<{ token: string; multiple?: boolean }>("playwright.waitForEvent", {
				tabId: "1",
				event: "filechooser",
				timeoutMs: 250,
			});

			if (!laterToken) throw new Error("Later file-chooser token was not captured");
			expect(event.token).not.toBe(staleToken);
			expect(event).toEqual({ token: laterToken, multiple: false });
			expect(waitCalls).toBe(1);
		} finally {
			await adapter.dispose();
		}
	});

	it("fans one new file-chooser event out to every waiter already registered", async () => {
		const probe = observerProbe();
		const releaseWaiters = Promise.withResolvers<void>();
		let pollWaiters = 0;
		let chooserToken: string | null = null;
		const adapter = adapterForObserver(probe, async () => {
			pollWaiters++;
			if (pollWaiters > 2) throw new Error("A file-chooser event must not be consumed by only one waiter");
			if (pollWaiters === 2) {
				probe.fire(probe.file);
				await Promise.resolve();
				chooserToken = probe.file.getAttribute("data-omp-codex-file-token");
				releaseWaiters.resolve();
			}
			await releaseWaiters.promise;
		});
		await adapter.beginRun();

		try {
			const wait = () =>
				adapter.invoke<{ token: string; multiple?: boolean }>("playwright.waitForEvent", {
					tabId: "1",
					event: "filechooser",
					timeoutMs: 250,
				});
			const [first, second] = await Promise.all([wait(), wait()]);

			expect(pollWaiters).toBe(2);
			expect(chooserToken).not.toBeNull();
			if (!chooserToken) throw new Error("Concurrent file-chooser token was not captured");
			expect(first).toEqual({ token: chooserToken, multiple: false });
			expect(second).toEqual(first);
		} finally {
			await adapter.dispose();
		}
	});

	it("registers a file-chooser waiter atomically with observer preparation", async () => {
		const probe = observerProbe();
		let evaluateCalls = 0;
		let chooserToken: string | null = null;
		const evaluate = (source: string, args: unknown[]) => {
			evaluateCalls++;
			const result = runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
			});
			if (evaluateCalls === 2) {
				probe.fire(probe.file);
				queueMicrotask(() => {
					chooserToken = probe.file.getAttribute("data-omp-codex-file-token");
				});
			}
			return result;
		};
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-observer",
			codexEvaluate: evaluate,
			codexEvaluateCleanup: evaluate,
			codexWait: () => {
				throw new Error("Atomic registration must resolve without polling");
			},
		} as never);
		await adapter.beginRun();

		try {
			const event = await adapter.invoke<{ token: string; multiple?: boolean }>("playwright.waitForEvent", {
				tabId: "1",
				event: "filechooser",
				timeoutMs: 250,
			});

			expect(chooserToken).not.toBeNull();
			if (!chooserToken) throw new Error("File-chooser token was not captured");
			expect(event).toEqual({ token: chooserToken, multiple: false });
			expect(evaluateCalls).toBe(3);
		} finally {
			await adapter.dispose();
		}
	});

	it("falls back through browser.open_split when tabs.content cannot list native tabs", async () => {
		const calls: RpcCall[] = [];
		const cleanupCalls: RpcCall[] = [];
		const browser = facadeFor({
			async codexRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				calls.push({ method, params, timeoutMs });
				switch (method) {
					case "browser.tab.list":
						throw new Error("unsupported_method: browser.tab.list");
					case "browser.open_split":
						return { surface_id: "fallback-content-surface" };
					case "browser.wait":
						return {};
					case "browser.snapshot":
						return { page: { title: "Fallback content" } };
					case "browser.eval":
						return { value: "content read from fallback split" };
					default:
						throw new Error(`Unexpected fallback content RPC: ${method}`);
				}
			},
			async codexCleanupRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				cleanupCalls.push({ method, params, timeoutMs });
				return {};
			},
		});

		const rows = await browser.tabs.content({
			urls: ["https://fixture.test/fallback-content"],
			contentType: "text",
			timeoutMs: 1_000,
		});

		expect(rows).toEqual([
			{
				url: "https://fixture.test/fallback-content",
				title: "Fallback content",
				content: "content read from fallback split",
			},
		]);
		expect(calls.map(call => call.method)).toEqual([
			"browser.tab.list",
			"browser.open_split",
			"browser.wait",
			"browser.snapshot",
			"browser.eval",
		]);
		expect(cleanupCalls).toEqual([
			{
				method: "surface.close",
				params: { surface_id: "fallback-content-surface" },
				timeoutMs: 3_000,
			},
		]);
	});

	it("cleans up a native tab and distinct fallback surface before restoring focus", async () => {
		let nativeTabCreated = false;
		const cleanupCalls: RpcCall[] = [];
		const browser = facadeFor({
			async codexRequest(method: string) {
				switch (method) {
					case "browser.tab.list":
						return {
							tabs: nativeTabCreated
								? [
										{ id: "original-tab", focused: false },
										{ id: "native-temporary-tab", focused: true },
									]
								: [{ id: "original-tab", focused: true }],
						};
					case "browser.tab.new":
						nativeTabCreated = true;
						return {};
					case "browser.open_split":
						return { surface_id: "distinct-fallback-surface" };
					case "browser.wait":
						return {};
					case "browser.snapshot":
						return { page: { title: "Native plus fallback" } };
					case "browser.eval":
						return { value: "native plus fallback content" };
					default:
						throw new Error(`Unexpected native fallback RPC: ${method}`);
				}
			},
			async codexCleanupRequest(method: string, params: Record<string, unknown>, timeoutMs?: number) {
				cleanupCalls.push({ method, params, timeoutMs });
				return {};
			},
		});

		const rows = await browser.tabs.content({
			urls: ["https://fixture.test/native-with-fallback"],
			contentType: "text",
			timeoutMs: 1_000,
		});

		expect(rows).toEqual([
			{
				url: "https://fixture.test/native-with-fallback",
				title: "Native plus fallback",
				content: "native plus fallback content",
			},
		]);
		expect(cleanupCalls).toEqual([
			{ method: "browser.tab.close", params: { tab_id: "native-temporary-tab" }, timeoutMs: 3_000 },
			{ method: "surface.close", params: { surface_id: "distinct-fallback-surface" }, timeoutMs: 3_000 },
			{ method: "browser.tab.switch", params: { tab_id: "original-tab" }, timeoutMs: 3_000 },
		]);
	});
	it("maps unsupported reload and content RPCs to exact capability errors", async () => {
		const reloadBrowser = facadeFor({
			async codexRequest(method: string) {
				throw new Error(`unsupported_method: ${method}`);
			},
			async waitForNavigation(options: { signal?: AbortSignal; onReady?: () => void }) {
				const navigation = Promise.withResolvers<null>();
				options.signal?.addEventListener("abort", () => navigation.reject(options.signal?.reason), { once: true });
				options.onReady?.();
				return await navigation.promise;
			},
		});
		const reloadTab = await selectedTab(reloadBrowser);
		const contentBrowser = facadeFor({
			async codexRequest(method: string) {
				throw new Error(`unsupported_method: ${method}`);
			},
		});

		expect(await caughtError(() => reloadTab.reload())).toEqual({
			name: "BrowserCapabilityError",
			message: "Browser capability is unavailable: tab.reload",
		});
		expect(
			await caughtError(() =>
				contentBrowser.tabs.content({ urls: ["https://fixture.test/other"], contentType: "text" }),
			),
		).toEqual({ name: "BrowserCapabilityError", message: "Browser capability is unavailable: tabs.content" });
	});

	it("keeps session names in trusted adapter state instead of page globals", async () => {
		const evaluations: Array<{ source: string; args: unknown[] }> = [];
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexEvaluate(source: string, args: unknown[]) {
				evaluations.push({ source, args });
				return 0;
			},
			async codexEvaluateCleanup() {
				return true;
			},
		} as never);
		await adapter.beginRun();
		await createCodexBrowserFacade(adapter).nameSession("private logical name");
		await adapter.dispose();

		for (const evaluation of evaluations) {
			expect(evaluation.source).not.toContain("__ompCodexBrowserSessionName");
			expect(evaluation.args).not.toContain("surface-contract");
			expect(evaluation.args).not.toContain("private logical name");
		}
	});

	it("rolls back logical tab state when new-tab preparation fails", async () => {
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexEvaluate() {
				throw new Error("observer installation failed");
			},
			async codexEvaluateCleanup() {
				return true;
			},
			async codexUrl() {
				return "https://fixture.test/current";
			},
			async title() {
				return "Current fixture";
			},
		} as never);
		const browser = createCodexBrowserFacade(adapter);
		const current = await browser.tabs.selected();
		if (!current) throw new Error("Expected an initial logical tab");
		await current.close();

		try {
			await expect(browser.tabs.new()).rejects.toThrow("observer installation failed");
			expect(adapter.currentTabId).toBe(current.id);
			expect(await browser.tabs.selected()).toBeUndefined();
			expect(await browser.tabs.list()).toEqual([]);
		} finally {
			await adapter.dispose();
		}
	});

	it("uses canonical input roles and excludes accessibility-hidden role matches", async () => {
		type ProbeElement = Record<string, unknown> & {
			attributes: Record<string, string>;
			parentElement: ProbeElement | null;
		};
		let elements: ProbeElement[] = [];
		const view = {
			getComputedStyle: (element: ProbeElement) =>
				(element.style as Record<string, string> | undefined) ?? {
					display: "block",
					visibility: "visible",
					opacity: "1",
				},
		};
		const document = {
			defaultView: view,
			getElementById: () => null,
			querySelectorAll: () => elements,
		};
		const element = (
			tagName: string,
			attributes: Record<string, string>,
			parentElement: ProbeElement | null = null,
		): ProbeElement => ({
			tagName,
			attributes,
			parentElement,
			ownerDocument: document,
			children: [],
			labels: [],
			hidden: false,
			disabled: false,
			textContent: attributes["aria-label"] ?? "",
			innerText: attributes["aria-label"] ?? "",
			getAttribute(name: string) {
				return attributes[name] ?? null;
			},
			hasAttribute(name: string) {
				return Object.hasOwn(attributes, name);
			},
			getBoundingClientRect: () => ({ width: 100, height: 20 }),
		});
		const hiddenParent = element("DIV", { "aria-hidden": "true" });
		const inertParent = element("DIV", { inert: "" });
		const list = element("UL", {});
		const listItem = element("LI", {});
		listItem.textContent = "One Item";
		listItem.innerText = "One Item";
		const imageButton = element("BUTTON", {});
		const imageChild = element("IMG", { alt: "Save" }, imageButton);
		imageButton.children = [imageChild];
		const mixedText = element("DIV", {});
		mixedText.textContent = "Mixed   Case Text";
		mixedText.innerText = "Mixed   Case Text";
		const hiddenText = element("SPAN", {}, hiddenParent);
		hiddenText.textContent = "Hidden text";
		hiddenText.innerText = "Hidden text";
		const hiddenInput = element(
			"INPUT",
			{ "aria-label": "Hidden label", placeholder: "Hidden placeholder" },
			hiddenParent,
		);
		const inputButton = element("INPUT", { type: "submit", value: "Log in" });
		elements = [
			element("INPUT", { type: "search", "aria-label": "Search" }),
			element("INPUT", { type: "number", "aria-label": "Number" }),
			element("INPUT", { type: "text", list: "items", "aria-label": "Listed" }),
			element("INPUT", { type: "password", "aria-label": "Secret" }),
			element("INPUT", { type: "date", "aria-label": "Date" }),
			element("IMG", { alt: "" }),
			element("IMG", { alt: "Hero" }),
			list,
			listItem,
			imageButton,
			imageChild,
			mixedText,
			hiddenParent,
			element("BUTTON", { "aria-label": "Hidden" }, hiddenParent),
			element("BUTTON", { "aria-label": "Inert" }, inertParent),
			hiddenText,
			hiddenInput,
			inputButton,
		];
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window: view });
				},
			}),
		);

		expect(
			await Promise.all([
				current.playwright.getByRole("searchbox", { name: "Search", exact: true }).count(),
				current.playwright.getByRole("spinbutton", { name: "Number", exact: true }).count(),
				current.playwright.getByRole("combobox", { name: "Listed", exact: true }).count(),
				current.playwright.getByRole("textbox", { name: "Secret", exact: true }).count(),
				current.playwright.getByRole("textbox", { name: "Date", exact: true }).count(),
				current.playwright.getByRole("img").count(),
				current.playwright.getByRole("list").count(),
				current.playwright.getByRole("listitem", { name: "one item" }).count(),
				current.playwright.getByRole("button", { name: "Save", exact: true }).count(),
				current.playwright.getByText("mixed case").count(),
				current.playwright.getByRole("button", { name: "Hidden", exact: true }).count(),
				current.playwright.getByRole("button", { name: "Inert", exact: true }).count(),
				current.playwright.getByText("Hidden text", { exact: true }).count(),
				current.playwright.getByLabel("Hidden label", { exact: true }).count(),
				current.playwright.getByPlaceholder("Hidden placeholder", { exact: true }).count(),
				current.playwright.getByText("Log in", { exact: true }).count(),
			]),
		).toEqual([1, 1, 1, 0, 0, 2, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1]);
	});

	it("normalizes ARIA true states while keeping visual visibility independent", async () => {
		const { document, window } = parseHTML(`
			<html><body>
				<button id="visual" aria-label="Visually Present" aria-hidden=" TrUe " inert>visible</button>
				<div id="aria-disabled" aria-disabled=" TRUE "><button aria-label="ARIA Disabled">disabled</button></div>
				<fieldset id="disabled-fieldset" disabled>
					<legend><input id="legend-enabled" aria-label="Legend Enabled"></legend>
					<input id="native-disabled" aria-label="Native Disabled">
				</fieldset>
				<input id="readonly" aria-label="Read only" aria-readonly=" tRuE " value="unchanged">
				<input id="search" type="search" aria-label="Canonical Search">
			</body></html>
		`);
		const visual = document.getElementById("visual");
		const disabledFieldset = document.getElementById("disabled-fieldset");
		const legendEnabled = document.getElementById("legend-enabled");
		const nativeDisabled = document.getElementById("native-disabled");
		const readonlyInput = document.getElementById("readonly");
		if (!visual || !disabledFieldset || !legendEnabled || !nativeDisabled || !readonlyInput)
			throw new Error("Expected normalized ARIA fixtures");
		Reflect.set(window, "getComputedStyle", (element: Element) => ({
			display: "block",
			visibility: "visible",
			opacity: element === visual ? "0" : "1",
		}));
		Reflect.set(disabledFieldset, "matches", (selector: string) => selector === ":disabled");
		Reflect.set(legendEnabled, "matches", () => false);
		Reflect.set(nativeDisabled, "matches", (selector: string) => selector === ":disabled");
		for (const element of document.querySelectorAll("*")) {
			Reflect.set(element, "getBoundingClientRect", () => ({ x: 0, y: 0, width: 100, height: 20 }));
			Reflect.set(element, "scrollIntoView", () => undefined);
		}
		const inputEvents: string[] = [];
		readonlyInput.addEventListener("input", (event: { type: string }) => inputEvents.push(event.type));
		readonlyInput.addEventListener("change", (event: { type: string }) => inputEvents.push(event.type));
		let nativeTypeCalls = 0;
		const client = {
			async request(method: string, params: Record<string, unknown>) {
				if (method === "browser.url.get") return { url: "https://fixture.test/current" };
				if (method === "browser.type") {
					nativeTypeCalls++;
					return {};
				}
				if (method !== "browser.eval") throw new Error(`Unexpected normalized-state RPC: ${method}`);
				if (params.script === "document.title") return { value: "Normalized states" };
				return {
					value: runCmuxEvalScript(String(params.script), {
						document,
						window,
						Event: window.Event,
						MouseEvent: window.MouseEvent,
						getComputedStyle: Reflect.get(window, "getComputedStyle"),
					}),
				};
			},
		};
		const current = await selectedTab(
			createCodexBrowserFacade(
				new CmuxCodexBrowserAdapter(new CmuxTab({ client: client as never, surfaceId: "surface-contract" })),
			),
		);

		expect(await current.playwright.locator("#visual").isVisible()).toBe(true);
		expect(await current.playwright.getByRole("button", { name: "Visually Present", exact: true }).count()).toBe(0);
		expect(await current.playwright.getByRole("button", { name: "ARIA Disabled", exact: true }).isEnabled()).toBe(
			false,
		);
		expect(await current.playwright.getByRole("textbox", { name: "Native Disabled", exact: true }).isEnabled()).toBe(
			false,
		);
		expect(await current.playwright.getByRole("textbox", { name: "Legend Enabled", exact: true }).isEnabled()).toBe(
			true,
		);
		expect(await current.playwright.getByRole("searchbox", { name: "Canonical Search", exact: true }).count()).toBe(
			1,
		);

		const readonlyLocator = current.playwright.locator("#readonly");
		expect((await caughtError(() => readonlyLocator.fill("changed"))).name).not.toBe("NO_ERROR");
		expect((await caughtError(() => readonlyLocator.type("changed"))).name).not.toBe("NO_ERROR");
		expect(Reflect.get(readonlyInput, "value")).toBe("unchanged");
		expect(inputEvents).toEqual([]);
		expect(nativeTypeCalls).toBe(0);
	});

	it("uses exactly one native type call with selection-aware CUA and locator state", async () => {
		const { document, window } = parseHTML('<html><body><input id="field" type="text"></body></html>');
		const input = document.getElementById("field");
		if (!input) throw new Error("Expected native typing input");
		Reflect.set(input, "value", "abcdef");
		Reflect.set(input, "selectionStart", 2);
		Reflect.set(input, "selectionEnd", 4);
		Reflect.set(input, "getBoundingClientRect", () => ({ x: 0, y: 0, width: 100, height: 20 }));
		Reflect.set(input, "scrollIntoView", () => undefined);
		Reflect.set(input, "focus", () => Reflect.set(document, "activeElement", input));
		Reflect.set(document, "activeElement", input);
		Reflect.set(window, "getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "0" }));
		const nativeCalls: Array<{ selector: string; text: string }> = [];
		const evaluate = (source: string, args: unknown[]) => runPageEvaluator(source, args, { document, window });
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async codexWait() {
				throw new Error("Typing target should be immediately actionable");
			},
			async type(selector: string, text: string) {
				nativeCalls.push({ selector, text });
				const start = Number(Reflect.get(input, "selectionStart"));
				const end = Number(Reflect.get(input, "selectionEnd"));
				const value = String(Reflect.get(input, "value"));
				Reflect.set(input, "value", value.slice(0, start) + text + value.slice(end));
				Reflect.set(input, "selectionStart", start + text.length);
				Reflect.set(input, "selectionEnd", start + text.length);
			},
		});
		const current = await selectedTab(browser);

		await current.cua.type({ text: "XY" });
		expect(Reflect.get(input, "value")).toBe("abXYef");
		Reflect.set(input, "selectionStart", 6);
		Reflect.set(input, "selectionEnd", 6);
		await current.playwright.locator("#field").type("!");

		expect(Reflect.get(input, "value")).toBe("abXYef!");
		expect(nativeCalls).toHaveLength(2);
		expect(nativeCalls.map(call => call.text)).toEqual(["XY", "!"]);
		expect(input.hasAttribute("data-omp-codex-action-token")).toBe(false);
		await adapter.dispose();
	});

	it("types through a same-origin iframe and removes native action tokens", async () => {
		const { document, window } = parseHTML('<html><body><iframe id="frame"></iframe></body></html>');
		const frame = document.getElementById("frame");
		if (!frame) throw new Error("Expected iframe");
		const { document: frameDocument } = parseHTML('<html><body><input id="field"></body></html>');
		const input = frameDocument.getElementById("field");
		if (!input) throw new Error("Expected iframe input");
		Object.defineProperty(frame, "contentDocument", { configurable: true, value: frameDocument });
		Object.defineProperty(document, "activeElement", { configurable: true, value: frame });
		Object.defineProperty(frameDocument, "activeElement", { configurable: true, value: input });
		const nativeCalls: Array<{ selector: string; text: string }> = [];
		const tokenPresentDuringType: boolean[] = [];
		const frameCalls: string[] = [];
		let selectedFrame = false;
		const evaluate = (source: string, args: unknown[]) => runPageEvaluator(source, args, { document, window });
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async codexRequest(method: string, params: Readonly<Record<string, unknown>>) {
				expect(method).toBe("browser.frame.select");
				expect(params.selector).toMatch(/^\[data-omp-codex-action-token=/);
				frameCalls.push(method);
				selectedFrame = true;
				return {};
			},
			async codexCleanupRequest(method: string) {
				expect(method).toBe("browser.frame.main");
				frameCalls.push(method);
				selectedFrame = false;
				return {};
			},
			async type(selector: string, text: string) {
				expect(selectedFrame).toBe(true);
				nativeCalls.push({ selector, text });
				tokenPresentDuringType.push(input.matches(selector));
				input.value += text;
			},
		});

		try {
			const current = await selectedTab(browser);
			await current.cua.type({ text: "frame " });
			await current.dom_cua.type({ text: "text" });
			expect(input.value).toBe("frame text");
			expect(nativeCalls).toHaveLength(2);
			expect(tokenPresentDuringType).toEqual([true, true]);
			expect(frameCalls).toEqual([
				"browser.frame.select",
				"browser.frame.main",
				"browser.frame.select",
				"browser.frame.main",
			]);
			expect(frame.hasAttribute("data-omp-codex-action-token")).toBe(false);
			expect(input.hasAttribute("data-omp-codex-action-token")).toBe(false);
		} finally {
			await adapter.dispose();
		}
	});

	it("rejects active shadow typing before token mutation or a native call", async () => {
		const { document, window } = parseHTML('<html><body><div id="host"></div></body></html>');
		const host = document.getElementById("host");
		if (!host) throw new Error("Expected shadow host");
		const shadowRoot = host.attachShadow({ mode: "open" });
		const input = document.createElement("input");
		shadowRoot.append(input);
		Object.defineProperty(document, "activeElement", { configurable: true, value: host });
		Object.defineProperty(shadowRoot, "activeElement", { configurable: true, value: input });
		let tokenMutations = 0;
		let nativeCalls = 0;
		for (const element of [host, input]) {
			const setAttribute = element.setAttribute.bind(element);
			Reflect.set(element, "setAttribute", (name: string, value: string) => {
				if (name === "data-omp-codex-action-token") tokenMutations++;
				setAttribute(name, value);
			});
		}
		const evaluate = (source: string, args: unknown[]) => runPageEvaluator(source, args, { document, window });
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async type() {
				nativeCalls++;
			},
		});

		try {
			const current = await selectedTab(browser);
			expect(await caughtError(() => current.cua.type({ text: "impossible" }))).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: dom_cua framed shadow action",
			});
			expect(tokenMutations).toBe(0);
			expect(nativeCalls).toBe(0);
		} finally {
			await adapter.dispose();
		}
	});

	it("activates checkbox controls before verifying their checked state", async () => {
		const { document, window } = parseHTML('<html><body><div id="host"></div></body></html>');
		const host = document.getElementById("host");
		if (!host) throw new Error("Expected checkbox shadow host");
		const shadowRoot = host.attachShadow({ mode: "open" });
		const input = document.createElement("input") as unknown as { checked: boolean };
		Reflect.set(input, "id", "toggle");
		Reflect.set(input, "type", "checkbox");
		shadowRoot.append(input as never);
		const clickStates: boolean[] = [];
		Reflect.set(input, "getBoundingClientRect", () => ({ x: 0, y: 0, left: 0, top: 0, width: 20, height: 20 }));
		Reflect.set(input, "scrollIntoView", () => undefined);
		Reflect.set(input, "focus", () => undefined);
		Reflect.set(input, "click", () => {
			input.checked = !input.checked;
			clickStates.push(input.checked);
		});
		Reflect.set(shadowRoot, "elementFromPoint", () => input);
		Reflect.set(document, "elementFromPoint", () => host);
		Reflect.set(window, "getComputedStyle", () => ({ display: "block", visibility: "visible", opacity: "1" }));
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window });
				},
				async codexWait() {
					throw new Error("Checkbox should be immediately actionable");
				},
			}),
		);
		const locator = current.playwright.getByRole("checkbox");

		await locator.check();
		await locator.uncheck();
		await locator.setChecked(true);

		expect(input.checked).toBe(true);
		expect(clickStates).toEqual([true, false, true]);
	});

	it("rejects fill and type on non-editable targets without mutating them", async () => {
		const events: string[] = [];
		const view = {
			Event: class {
				constructor(readonly type: string) {}
			},
			getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
		};
		let node: Record<string, unknown>;
		const document = {
			defaultView: view,
			getElementById: () => null,
			querySelectorAll: () => [node],
		};
		node = {
			tagName: "DIV",
			children: [],
			ownerDocument: document,
			textContent: "unchanged",
			innerText: "unchanged",
			value: undefined,
			isContentEditable: false,
			hidden: false,
			disabled: false,
			getAttribute: (name: string) => (name === "role" ? "button" : null),
			hasAttribute: () => false,
			getBoundingClientRect: () => ({ width: 100, height: 20 }),
			scrollIntoView: () => undefined,
			focus: () => undefined,
			dispatchEvent: (event: { type: string }) => {
				events.push(event.type);
				return true;
			},
		};
		const current = await selectedTab(
			facadeFor({
				async codexEvaluate(source: string, args: unknown[]) {
					return runPageEvaluator(source, args, { document, window: view });
				},
			}),
		);
		const target = current.playwright.getByRole("button");

		const fill = await caughtError(() => target.fill("changed"));
		Reflect.set(node, "value", undefined);
		const type = await caughtError(() => target.type("changed"));
		expect(fill.name).toBe("Error");
		expect(type.name).toBe("Error");
		expect(node.textContent).toBe("unchanged");
		expect(node.value).toBeUndefined();
		expect(events).toEqual([]);
	});

	it("includes non-interactable elements in elementInfo when requested", async () => {
		const view = { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) };
		for (const [tagName, attributes] of [
			["H1", { role: "heading" }],
			["IMG", { alt: "Hero" }],
		] as const) {
			let node: Record<string, unknown>;
			const document = { elementFromPoint: () => node, getElementById: () => null };
			node = {
				tagName,
				parentElement: null,
				ownerDocument: { defaultView: view },
				innerText: tagName === "H1" ? "Heading" : "",
				textContent: tagName === "H1" ? "Heading" : "",
				outerHTML: `<${tagName.toLowerCase()}>`,
				getAttribute: (name: string) => attributes[name as keyof typeof attributes] ?? null,
				hasAttribute: (name: string) => Object.hasOwn(attributes, name),
				closest: () => node,
				getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
			};
			const current = await selectedTab(
				facadeFor({
					async codexEvaluate(source: string, args: unknown[]) {
						return runPageEvaluator(source, args, { document, window: view });
					},
				}),
			);
			expect(await current.playwright.elementInfo({ x: 1, y: 1 })).toEqual([]);
			expect(await current.playwright.elementInfo({ x: 1, y: 1, includeNonInteractable: true })).toEqual([
				expect.objectContaining({ tagName: tagName.toLowerCase() }),
			]);
		}
	});

	it("includes observer preparation in the file chooser deadline", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const timeouts: number[] = [];
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexEvaluate(_source: string, _args: unknown[], timeoutMs: number) {
				timeouts.push(timeoutMs);
				if (timeouts.length === 1) {
					now = 80;
					return 0;
				}
				return { token: "file-current", multiple: false };
			},
		} as never);
		await adapter.invoke("playwright.waitForEvent", {
			tabId: "1",
			event: "filechooser",
			timeoutMs: 100,
		});

		expect(timeouts).toEqual([100, 20]);
	});

	it("cleans pending clipboard tokens after failure and whole-run disposal", async () => {
		const globals = globalThis as unknown as Record<string, unknown>;
		delete globals.__ompCodexClipboardWrites;
		const probe = observerProbe();
		class BlobProbe {}
		class ClipboardItemProbe {}
		const navigator = { clipboard: { write: () => Promise.withResolvers<void>().promise } };
		const evaluate = (source: string, args: unknown[]) =>
			runPageEvaluator(source, args, {
				document: probe.document,
				window: {},
				Element: probe.ElementProbe,
				navigator,
				Blob: BlobProbe,
				ClipboardItem: ClipboardItemProbe,
			});
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexUrl() {
				return "https://fixture.test/current";
			},
			async title() {
				return "Current fixture";
			},
			codexEvaluate: evaluate,
			codexEvaluateCleanup: evaluate,
			async codexWait() {
				throw new Error("stop polling");
			},
		} as never);
		let pendingAfterFailure = -1;
		let writesAfterDispose: unknown = "present";
		try {
			await adapter.beginRun();
			const current = await selectedTab(createCodexBrowserFacade(adapter));
			await caughtError(() => current.clipboard.write([{ entries: [{ mimeType: "text/plain", text: "pending" }] }]));
			pendingAfterFailure = Object.keys((globals.__ompCodexClipboardWrites as object | undefined) ?? {}).length;
			globals.__ompCodexClipboardWrites = { leftover: { done: false } };
			await adapter.dispose();
			writesAfterDispose = globals.__ompCodexClipboardWrites;
		} finally {
			delete globals.__ompCodexClipboardWrites;
			delete globals.__ompCodexBrowserState;
		}
		expect(pendingAfterFailure).toBe(0);
		expect(writesAfterDispose).toBeUndefined();
	});

	it("uses deadline-aware DOM refs, evaluation, and persistence", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const refTimeouts: Array<number | undefined> = [];
		const evaluateTimeouts: number[] = [];
		let usedUnboundedEvaluate = false;
		const write = spyOn(Bun, "write").mockResolvedValue(1);
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			codexCwd: () => "/tmp/codex-media-contract",
			async ref(_id: string, timeoutMs?: number) {
				refTimeouts.push(timeoutMs);
				return {
					async evaluate() {
						usedUnboundedEvaluate = true;
						return "blob:fixture";
					},
					async evaluateWithTimeout(_fn: unknown, _args: unknown[], timeoutMs: number) {
						evaluateTimeouts.push(timeoutMs);
						return "blob:fixture";
					},
				};
			},
			async codexEvaluate(_source: string, args: unknown[]) {
				if (args.length === 2) return true;
				now = 101;
				return {
					url: "blob:fixture",
					contentType: "application/octet-stream",
					base64Chunks: [Buffer.from("x").toString("base64")],
				};
			},
			async codexEvaluateCleanup() {
				return true;
			},
		} as never);

		const error = await caughtError(() =>
			adapter.invoke("dom_cua.downloadMedia", {
				tabId: "1",
				nodeId: "e1",
				timeoutMs: 100,
			}),
		);
		expect(error.message).toContain("timed out");
		expect(refTimeouts).toEqual([100]);
		expect(evaluateTimeouts).toEqual([100]);
		expect(usedUnboundedEvaluate).toBe(false);
		expect(write).not.toHaveBeenCalled();
	});

	it("shares one deadline across goto and history preparation stages", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		const gotoTimeouts: number[] = [];
		const gotoPrepareTimeouts: number[] = [];
		const gotoAdapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async goto(_url: string, options: { timeoutMs: number }) {
				gotoTimeouts.push(options.timeoutMs);
				now = 90;
			},
			async codexEvaluate(_source: string, _args: unknown[], timeoutMs: number) {
				gotoPrepareTimeouts.push(timeoutMs);
				return 0;
			},
		} as never);

		await gotoAdapter.invoke("tab.goto", {
			tabId: "1",
			url: "https://fixture.test/next",
			timeoutMs: 100,
		});

		now = 0;
		const navigationTimeouts: number[] = [];
		const historyTimeouts: number[] = [];
		const historyPrepareTimeouts: number[] = [];
		const historyAdapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async waitForNavigation(options: { timeout: number; onReady?: () => void }) {
				navigationTimeouts.push(options.timeout);
				now = 40;
				options.onReady?.();
				return null;
			},
			async codexEvaluate(source: string, _args: unknown[], timeoutMs: number) {
				if (source.includes("history.go")) {
					historyTimeouts.push(timeoutMs);
					now = 90;
					return true;
				}
				historyPrepareTimeouts.push(timeoutMs);
				return 0;
			},
		} as never);

		await historyAdapter.invoke("tab.back", { tabId: "1", timeoutMs: 100 });

		expect(gotoTimeouts).toEqual([100]);
		expect(gotoPrepareTimeouts).toEqual([10]);
		expect(navigationTimeouts).toEqual([100]);
		expect(historyTimeouts).toEqual([60]);
		expect(historyPrepareTimeouts).toEqual([10]);
	});

	it("uses the ref-aware native double-click primitive", async () => {
		const events: string[] = [];
		const refTimeouts: Array<number | undefined> = [];
		const current = await selectedTab(
			facadeFor({
				async ref(_id: string, timeoutMs?: number) {
					refTimeouts.push(timeoutMs);
					return {
						async click() {
							events.push("click");
						},
						async dblclick() {
							events.push("dblclick");
						},
					};
				},
			}),
		);
		await current.dom_cua.double_click({ node_id: "e1" });

		expect(events).toEqual(["dblclick"]);
		expect(refTimeouts[0]).toBeGreaterThan(0);
	});

	it("removes every Codex page global on endRun and dispose", async () => {
		const globals = globalThis as unknown as Record<string, unknown>;
		const names = [
			"__ompCodexBrowserState",
			"__ompCodexBrowserTokenSequence",
			"__ompCodexClipboardWrites",
			"__ompCodexDomRefs",
			"__ompCodexMediaTransfers",
		] as const;
		const cleanupModes = [
			async (adapter: CmuxCodexBrowserAdapter) => adapter.endRun(),
			async (adapter: CmuxCodexBrowserAdapter) => adapter.dispose(),
		];

		try {
			for (const cleanup of cleanupModes) {
				for (const name of names) delete globals[name];
				const adapter = adapterForObserver(observerProbe());
				await adapter.beginRun();
				globals.__ompCodexClipboardWrites = { pending: true };
				globals.__ompCodexDomRefs = { e1: {} };
				globals.__ompCodexMediaTransfers = {};
				await cleanup(adapter);
				expect(names.filter(name => Object.hasOwn(globals, name))).toEqual([]);
			}
		} finally {
			for (const name of names) delete globals[name];
		}
	});

	it("focuses an aria-ref fallback click target before immediate DOM CUA typing", async () => {
		const events: string[] = [];
		const attributes = new Map<string, string>();
		class EventProbe {
			constructor(readonly type: string) {}
		}
		class MouseEventProbe extends EventProbe {}
		const document = {
			activeElement: null as Record<string, unknown> | null,
			querySelectorAll: () => [input],
			querySelector: () => input,
			elementFromPoint: () => input,
		};
		const input: Record<string, unknown> = {
			_ariaRef: { ref: "e1" },
			isConnected: true,
			tagName: "INPUT",
			type: "text",
			value: "",
			selectionStart: 0,
			selectionEnd: 0,
			disabled: false,
			readOnly: false,
			inert: false,
			parentElement: null,
			ownerDocument: document,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 120, height: 32 }),
			scrollIntoView: () => undefined,
			getAttribute: (name: string) => attributes.get(name) ?? null,
			setAttribute: (name: string, value: string) => attributes.set(name, String(value)),
			removeAttribute: (name: string) => attributes.delete(name),
			setRangeText(text: string, start: number, end: number) {
				this.value = String(this.value).slice(0, start) + text + String(this.value).slice(end);
				this.selectionStart = start + text.length;
				this.selectionEnd = start + text.length;
			},
			focus: () => {
				document.activeElement = input;
				events.push("focus");
			},
			dispatchEvent: (event: EventProbe) => {
				events.push(event.type);
				return true;
			},
			click: () => events.push("click"),
		};
		const window = {};
		const nativeMethods: string[] = [];
		const client = {
			async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
				if (method === "browser.url.get") return { url: "https://fixture.test/current" };
				if (method === "browser.type") {
					nativeMethods.push(method);
					const text = String(params.text ?? "");
					(input.dispatchEvent as (event: EventProbe) => boolean)(new EventProbe("beforeinput"));
					Reflect.apply(input.setRangeText as (...args: unknown[]) => unknown, input, [
						text,
						Number(input.selectionStart),
						Number(input.selectionEnd),
					]);
					(input.dispatchEvent as (event: EventProbe) => boolean)(new EventProbe("input"));
					return {};
				}
				if (method === "browser.fill") {
					nativeMethods.push(method);
					input.value = String(params.text ?? "");
					input.selectionStart = String(input.value).length;
					input.selectionEnd = String(input.value).length;
					(input.dispatchEvent as (event: EventProbe) => boolean)(new EventProbe("input"));
					return {};
				}
				if (method !== "browser.eval") throw new Error(`Unexpected cmux RPC: ${method}`);
				return {
					value: runCmuxEvalScript(String(params.script), {
						document,
						window,
						Event: EventProbe,
						MouseEvent: MouseEventProbe,
					}),
				};
			},
		};
		const current = await selectedTab(
			createCodexBrowserFacade(
				new CmuxCodexBrowserAdapter(new CmuxTab({ client: client as never, surfaceId: "surface-contract" })),
			),
		);

		await current.dom_cua.click({ node_id: "e1" });
		await current.dom_cua.type({ text: "typed" });

		expect(input.value).toBe("typed");
		expect(events).toEqual(["focus", "mousedown", "mouseup", "click", "beforeinput", "input"]);
		expect(nativeMethods).toEqual(["browser.type"]);

		await current.dom_cua.type({ text: " padded " });
		expect(input.value).toBe("typed padded ");
		expect(nativeMethods).toEqual(["browser.type", "browser.type"]);
	});

	it("keeps shadow-root DOM refs actionable through composed hit testing", async () => {
		const events: string[] = [];
		class EventProbe {
			constructor(readonly type: string) {}
		}
		class MouseEventProbe extends EventProbe {}
		let button: Record<string, unknown>;
		let host: Record<string, unknown>;
		let shadowRoot: Record<string, unknown>;
		const view = {
			Event: EventProbe,
			MouseEvent: MouseEventProbe,
			getComputedStyle: () => ({ display: "block", visibility: "visible" }),
		};
		const document = {
			defaultView: view,
			querySelectorAll: () => [button],
			elementFromPoint: () => host,
		};
		host = { parentElement: null };
		shadowRoot = { host, elementFromPoint: () => button };
		Reflect.set(host, "shadowRoot", shadowRoot);
		button = {
			_ariaRef: { ref: "e1" },
			isConnected: true,
			tagName: "BUTTON",
			ownerDocument: document,
			parentElement: null,
			getRootNode: () => shadowRoot,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 30 }),
			scrollIntoView: () => undefined,
			matches: () => false,
			inert: false,
			disabled: false,
			hasAttribute: () => false,
			getAttribute: () => null,
			dispatchEvent: (event: EventProbe) => {
				events.push(event.type);
				return true;
			},
		};
		const client = {
			async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
				if (method === "browser.url.get") return { url: "https://fixture.test/current" };
				if (method !== "browser.eval") throw new Error(`Unexpected shadow-root RPC: ${method}`);
				return {
					value: runCmuxEvalScript(String(params.script), {
						document,
						window: view,
						Event: EventProbe,
						MouseEvent: MouseEventProbe,
						getComputedStyle: view.getComputedStyle,
					}),
				};
			},
		};
		const current = await selectedTab(
			createCodexBrowserFacade(
				new CmuxCodexBrowserAdapter(new CmuxTab({ client: client as never, surfaceId: "surface-contract" })),
			),
		);

		await current.dom_cua.click({ node_id: "e1" });
		expect(events).toEqual(["mousedown", "mouseup", "click"]);
	});

	it("dispatches two complete aria-ref mouse sequences before dblclick", async () => {
		const events: string[] = [];
		class EventProbe {
			constructor(readonly type: string) {}
		}
		class MouseEventProbe extends EventProbe {}
		const document = { querySelectorAll: () => [button], elementFromPoint: () => button };
		const button = {
			_ariaRef: { ref: "e1" },
			isConnected: true,
			tagName: "BUTTON",
			scrollIntoView: () => undefined,
			inert: false,
			disabled: false,
			parentElement: null,
			ownerDocument: document,
			getAttribute: () => null,
			getBoundingClientRect: () => ({ x: 10, y: 20, width: 120, height: 32 }),
			focus: () => events.push("focus"),
			dispatchEvent: (event: EventProbe) => {
				events.push(event.type);
				return true;
			},
		};
		const window = {};
		const client = {
			async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
				if (method === "browser.url.get") return { url: "https://fixture.test/current" };
				if (method !== "browser.eval") throw new Error(`Unexpected cmux RPC: ${method}`);
				return {
					value: runCmuxEvalScript(String(params.script), {
						document,
						window,
						Event: EventProbe,
						MouseEvent: MouseEventProbe,
					}),
				};
			},
		};
		const current = await selectedTab(
			createCodexBrowserFacade(
				new CmuxCodexBrowserAdapter(new CmuxTab({ client: client as never, surfaceId: "surface-contract" })),
			),
		);

		await current.dom_cua.double_click({ node_id: "e1" });

		expect(events).toEqual(["focus", "mousedown", "mouseup", "click", "mousedown", "mouseup", "click", "dblclick"]);
	});

	it("rejects covered aria-ref click and double-click without firing the target", async () => {
		const events: string[] = [];
		class EventProbe {
			constructor(readonly type: string) {}
		}
		class MouseEventProbe extends EventProbe {}
		const overlay = { parentElement: null };
		const document = {
			querySelectorAll: () => [button],
			elementFromPoint: () => overlay,
		};
		const button = {
			_ariaRef: { ref: "e1" },
			isConnected: true,
			tagName: "BUTTON",
			ownerDocument: document,
			parentElement: null,
			disabled: false,
			inert: false,
			getAttribute: () => null,
			getBoundingClientRect: () => ({ x: 20, y: 30, width: 100, height: 40 }),
			scrollIntoView: () => undefined,
			focus: () => events.push("focus"),
			dispatchEvent: (event: EventProbe) => {
				events.push(event.type);
				return true;
			},
		};
		const window = {};
		const client = {
			async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
				if (method === "browser.url.get") return { url: "https://fixture.test/current" };
				if (method !== "browser.eval") throw new Error(`Unexpected cmux RPC: ${method}`);
				return {
					value: runCmuxEvalScript(String(params.script), {
						document,
						window,
						Event: EventProbe,
						MouseEvent: MouseEventProbe,
					}),
				};
			},
		};
		const current = await selectedTab(
			createCodexBrowserFacade(
				new CmuxCodexBrowserAdapter(new CmuxTab({ client: client as never, surfaceId: "surface-contract" })),
			),
		);

		const outcomes = await Promise.all([
			caughtError(() => current.dom_cua.click({ node_id: "e1" })),
			caughtError(() => current.dom_cua.double_click({ node_id: "e1" })),
		]);

		expect(outcomes.every(outcome => outcome.message.includes("does not receive pointer events"))).toBe(true);
		expect(events).toEqual([]);
	});

	it("keeps visible-DOM identities stable across playwright.domSnapshot", async () => {
		let boundNode: "original" | "replacement" | undefined = "original";
		let cleanupCalls = 0;
		let snapshotOptions: unknown;
		const clicked: string[] = [];
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexUrl() {
				return "https://fixture.test/current";
			},
			async title() {
				return "Current fixture";
			},
			async codexEvaluateCleanup() {
				cleanupCalls++;
				boundNode = undefined;
				return true;
			},
			async ariaSnapshot(_selector: unknown, options: unknown) {
				snapshotOptions = options;
				if (!boundNode) boundNode = "replacement";
				return "snapshot";
			},
			async ref() {
				const node = boundNode;
				if (!node) throw new Error("stale DOM ref");
				return {
					async click() {
						clicked.push(node);
					},
				};
			},
		} as never);
		const current = await selectedTab(createCodexBrowserFacade(adapter));

		await current.playwright.domSnapshot();
		await current.dom_cua.click({ node_id: "e1" });

		expect(clicked).toEqual(["original"]);
		expect(cleanupCalls).toBe(0);
		expect(snapshotOptions).toEqual({ preserveRefs: true });
	});

	it("resolves cmux navigation readiness only after its baseline is installed", async () => {
		const completion = Promise.withResolvers<null>();
		let onReady: (() => void) | undefined;
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async waitForNavigation(options: { onReady?: () => void }) {
				onReady = options.onReady;
				return await completion.promise;
			},
		} as never);
		const args = { tabId: "1", navigationId: "ready", timeoutMs: 1_000 };
		let armed = false;
		const readiness = adapter.invoke("playwright.expectNavigation.ready", args).then(() => {
			armed = true;
		});
		await Promise.resolve();

		expect(onReady).toBeDefined();
		expect(armed).toBe(false);
		onReady?.();
		await readiness;
		const navigation = adapter.invoke("playwright.expectNavigation", args);
		completion.resolve(null);
		await navigation;
	});

	it("aborts and settles the underlying cmux navigation poll when expectNavigation is canceled", async () => {
		let pollSignal: AbortSignal | undefined;
		let pollSettled = false;
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async waitForNavigation(options: { signal?: AbortSignal; onReady?: () => void }) {
				pollSignal = options.signal;
				const navigation = Promise.withResolvers<null>();
				options.signal?.addEventListener(
					"abort",
					() => {
						pollSettled = true;
						navigation.reject(options.signal?.reason ?? new Error("navigation canceled"));
					},
					{ once: true },
				);
				options.onReady?.();
				return await navigation.promise;
			},
		} as never);
		const args = { tabId: "1", navigationId: "cancel-me", timeoutMs: 1_000 };
		await adapter.invoke("playwright.expectNavigation.ready", args);
		const navigation = adapter.invoke("playwright.expectNavigation", args);
		await Promise.resolve();

		await adapter.invoke("playwright.expectNavigation.cancel", { tabId: "1", navigationId: "cancel-me" });
		await navigation;

		expect(pollSignal?.aborted).toBe(true);
		expect(pollSettled).toBe(true);
	});

	it("uses one expectNavigation deadline for baseline, poll, and load settlement", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		let urlRead = 0;
		const calls: RpcCall[] = [];
		const client = {
			async request(
				method: string,
				params: Record<string, unknown>,
				options: { timeoutMs?: number } = {},
			): Promise<Record<string, unknown>> {
				calls.push({ method, params, timeoutMs: options.timeoutMs });
				now += 10;
				if (method === "browser.eval") {
					if (String(params.script).includes("setTimeout")) {
						return { value: { url: "https://fixture.test/start" } };
					}
					return { value: true };
				}
				if (method === "browser.url.get") {
					urlRead++;
					return { url: "https://fixture.test/next" };
				}
				if (method === "browser.wait") return {};
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		};
		const adapter = new CmuxCodexBrowserAdapter(
			new CmuxTab({ client: client as never, surfaceId: "surface-contract" }),
		);

		const args = {
			tabId: "1",
			navigationId: "deadline",
			waitUntil: "load",
			timeoutMs: 100,
		};
		await adapter.invoke("playwright.expectNavigation.ready", args);
		await adapter.invoke("playwright.expectNavigation", args);

		expect(urlRead).toBe(1);
		expect(calls.slice(0, 3).map(call => [call.method, call.timeoutMs])).toEqual([
			["browser.eval", 100],
			["browser.url.get", 90],
			["browser.wait", 80],
		]);
	});

	it("uses one absolute deadline for history navigation, load settlement, and observer preparation", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		let navigationTimeout: number | undefined;
		let historyTimeout: number | undefined;
		let prepareTimeout: number | undefined;
		const navigationDone = Promise.withResolvers<null>();
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			waitForNavigation(options: { timeout?: number; onReady?: () => void }) {
				navigationTimeout = options.timeout;
				options.onReady?.();
				return navigationDone.promise;
			},
			async codexEvaluate(source: string, _args: unknown[], timeoutMs: number) {
				if (source.includes("history.go")) {
					historyTimeout = timeoutMs;
					now = 60;
					navigationDone.resolve(null);
					return true;
				}
				prepareTimeout = timeoutMs;
				return 0;
			},
		} as never);

		await adapter.invoke("tab.back", { tabId: "1", timeoutMs: 100 });

		expect({ navigationTimeout, historyTimeout, prepareTimeout }).toEqual({
			navigationTimeout: 100,
			historyTimeout: 100,
			prepareTimeout: 40,
		});
	});
	it("arms same-URL document detection before the public trigger and spends one deadline", async () => {
		let markerPresent = false;
		const calls: RpcCall[] = [];
		const client = {
			async request(
				method: string,
				params: Record<string, unknown>,
				options: { timeoutMs?: number } = {},
			): Promise<Record<string, unknown>> {
				calls.push({ method, params, timeoutMs: options.timeoutMs });
				if (method === "browser.reload") {
					markerPresent = false;
					return {};
				}
				if (method === "browser.url.get") return { url: "https://fixture.test/same" };
				if (method === "browser.eval") {
					const script = String(params.script);
					if (script.includes("setTimeout")) {
						markerPresent = true;
						return { value: { url: "https://fixture.test/same" } };
					}
					if (script.includes("Boolean")) return { value: markerPresent };
					if (script.includes("delete globalThis")) markerPresent = false;
					return { value: true };
				}
				if (method === "browser.wait") return {};
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		};
		const tab = new CmuxTab({ client: client as never, surfaceId: "surface-contract" });

		const navigation = tab.waitForNavigation({ waitUntil: "load", timeout: 100 });
		const reload = client.request("browser.reload", {}, {});
		await expect(Promise.all([navigation, reload])).resolves.toEqual([null, {}]);
		expect(calls[0]?.method).toBe("browser.eval");
		expect(calls[1]?.method).toBe("browser.reload");
		const wait = calls.find(call => call.method === "browser.wait");
		expect(wait?.params.timeout_ms).toBeGreaterThan(0);
		expect(wait?.params.timeout_ms).toBeLessThanOrEqual(100);
		const waitBudget = wait?.params.timeout_ms;
		if (typeof waitBudget !== "number") throw new Error("Expected numeric same-URL wait budget");
		expect(wait?.timeoutMs).toBe(waitBudget);
	});

	it("propagates only the remaining navigation budget to the load-state wait", async () => {
		let now = 0;
		spyOn(Date, "now").mockImplementation(() => now);
		let atomicBaseline = false;
		const calls: RpcCall[] = [];
		const client = {
			async request(
				method: string,
				params: Record<string, unknown>,
				options: { timeoutMs?: number } = {},
			): Promise<Record<string, unknown>> {
				calls.push({ method, params, timeoutMs: options.timeoutMs });
				if (method === "browser.eval") {
					if (String(params.script).includes("setTimeout")) {
						atomicBaseline = true;
						return { value: { url: "https://fixture.test/start" } };
					}
					return { value: true };
				}
				if (method === "browser.url.get") {
					if (!atomicBaseline) return { url: "https://fixture.test/start" };
					now = 20;
					return { url: "https://fixture.test/next" };
				}
				if (method === "browser.wait") return {};
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		};
		const tab = new CmuxTab({ client: client as never, surfaceId: "surface-contract" });

		await tab.waitForNavigation({ waitUntil: "load", timeout: 100 });
		const wait = calls.find(call => call.method === "browser.wait");
		expect(wait?.params.timeout_ms).toBeLessThan(100);
		const remainingWaitBudget = wait?.params.timeout_ms;
		if (typeof remainingWaitBudget !== "number") throw new Error("Expected numeric remaining wait budget");
		expect(wait?.timeoutMs).toBe(remainingWaitBudget);
	});

	it("tests raw RegExp URL patterns from index zero on every poll", async () => {
		const pattern = /ready/g;
		pattern.lastIndex = 100;
		const client = {
			async request(method: string): Promise<Record<string, unknown>> {
				if (method === "browser.url.get") return { url: "https://fixture.test/ready" };
				throw new Error(`Unexpected cmux RPC: ${method}`);
			},
		};
		const tab = new CmuxTab({ client: client as never, surfaceId: "surface-contract" });

		await expect(tab.waitForUrl(pattern, { timeout: 1 })).resolves.toBe("https://fixture.test/ready");
	});

	it("treats selectOption constraints conjunctively without mutating on a partial match", async () => {
		const probe = selectProbe(["preferred", "backup"], "backup");
		const current = await selectedTab(facadeForSelect(probe));

		const outcome = await caughtError(() =>
			current.playwright.locator("#choice").selectOption({ value: "preferred", label: "backup" }),
		);

		expect(outcome.name).not.toBe("NO_ERROR");
		expect(probe.selectedValues()).toEqual(["backup"]);
		expect(probe.events).toEqual([]);
	});

	it("respects requested developer-log limits above one thousand", async () => {
		const entries = Array.from({ length: 1_205 }, (_, index) => ({ level: "info", text: `entry-${index}` }));
		const current = await selectedTab(
			facadeFor({
				async codexRequest(method: string) {
					if (method === "browser.console.list") return { entries };
					if (method === "browser.errors.list") return { entries: [] };
					throw new Error(`Unexpected log RPC: ${method}`);
				},
			}),
		);

		const logs = await current.dev.logs({ limit: 1_200 });
		expect(logs).toHaveLength(1_200);
		expect(logs[0]).toEqual(entries[5]);
	});

	it("closes every ambiguous native tab created by tabs.content and restores original focus", async () => {
		let listCalls = 0;
		const cleanupCalls: RpcCall[] = [];
		const browser = facadeFor({
			async codexRequest(method: string) {
				switch (method) {
					case "browser.tab.list":
						return listCalls++ === 0
							? { tabs: [{ id: "original", focused: true }] }
							: {
									tabs: [
										{ id: "original", focused: false },
										{ id: "temporary-a", focused: true },
										{ id: "temporary-b", focused: false },
									],
								};
					case "browser.tab.new":
						return { surface_id: "temporary-surface" };
					case "browser.wait":
						return {};
					case "browser.snapshot":
						return { page: { title: "Temporary" } };
					case "browser.eval":
						return { value: "temporary content" };
					default:
						throw new Error(`Unexpected content RPC: ${method}`);
				}
			},
			async codexCleanupRequest(method: string, params: Record<string, unknown>, timeoutMs: number) {
				cleanupCalls.push({ method, params, timeoutMs });
				return {};
			},
		});

		await browser.tabs.content({ urls: ["https://fixture.test/ambiguous"], contentType: "text" });

		expect(cleanupCalls.map(call => [call.method, call.params])).toEqual([
			["browser.tab.close", { tab_id: "temporary-a" }],
			["browser.tab.close", { tab_id: "temporary-b" }],
			["browser.tab.switch", { tab_id: "original" }],
		]);
	});

	it("keeps chooser-timeout cleanup isolated until endRun owns full cleanup", async () => {
		const globals = globalThis as unknown as Record<string, unknown>;
		const probe = observerProbe();
		const adapter = adapterForObserver(probe, async () => {
			throw new Error("poll timeout");
		});
		try {
			await adapter.beginRun();
			globals.__ompCodexDomRefs = { unrelated: true };
			globals.__ompCodexMediaTransfers = { unrelated: { controller: { abort: () => undefined } } };
			globals.__ompCodexClipboardWrites = { unrelated: { done: false } };

			await caughtError(() =>
				adapter.invoke("playwright.waitForEvent", { tabId: "1", event: "filechooser", timeoutMs: 1 }),
			);

			expect(globals.__ompCodexBrowserState).toBeDefined();
			expect(globals.__ompCodexDomRefs).toEqual({ unrelated: true });
			expect(globals.__ompCodexMediaTransfers).toBeDefined();
			expect(globals.__ompCodexClipboardWrites).toBeDefined();
			await adapter.endRun();
			expect(globals.__ompCodexBrowserState).toBeUndefined();
			expect(globals.__ompCodexDomRefs).toBeUndefined();
			expect(globals.__ompCodexMediaTransfers).toBeUndefined();
			expect(globals.__ompCodexClipboardWrites).toBeUndefined();
		} finally {
			delete globals.__ompCodexBrowserState;
			delete globals.__ompCodexBrowserTokenSequence;
			delete globals.__ompCodexDomRefs;
			delete globals.__ompCodexMediaTransfers;
			delete globals.__ompCodexClipboardWrites;
		}
	});

	it("preserves aria refs recursively in nested open shadow roots", async () => {
		const { document, window } = parseHTML("<html><body><div id=host></div></body></html>");
		const host = document.getElementById("host");
		if (!host) throw new Error("Expected shadow host");
		const firstRoot = host.attachShadow({ mode: "open" });
		const nestedHost = document.createElement("section");
		firstRoot.appendChild(nestedHost);
		const secondRoot = nestedHost.attachShadow({ mode: "open" });
		const button = document.createElement("button");
		secondRoot.appendChild(button);
		Reflect.set(host, "_ariaRef", { ref: "e1" });
		Reflect.set(nestedHost, "_ariaRef", { ref: "e2" });
		Reflect.set(button, "_ariaRef", { ref: "e3" });
		const original = [host, nestedHost, button].map(element => Reflect.get(element, "_ariaRef"));
		Reflect.set(document, "__mutateAriaRefs", () => {
			for (const element of [host, nestedHost, button]) Reflect.set(element, "_ariaRef", { ref: "replacement" });
		});
		const client = {
			async request(method: string, params: Record<string, unknown>) {
				if (method !== "browser.eval") throw new Error(`Unexpected snapshot RPC: ${method}`);
				const script = String(params.script);
				const tryStart = script.indexOf("try { return (");
				const finallyStart = script.indexOf("finally {", tryStart);
				if (tryStart < 0 || finallyStart < 0) throw new Error("Expected preserveRefs wrapper");
				const fixtureScript = `${script.slice(0, tryStart)}try {
					document.__mutateAriaRefs();
					return "snapshot";
				}
				${script.slice(finallyStart)}`;
				return {
					value: runCmuxEvalScript(fixtureScript, {
						document,
						window,
						Event: window.Event,
						MouseEvent: window.MouseEvent,
					}),
				};
			},
		};
		const tab = new CmuxTab({ client: client as never, surfaceId: "surface-contract" });

		expect(await tab.ariaSnapshot(undefined, { preserveRefs: true })).toBe("snapshot");
		expect([host, nestedHost, button].map(element => Reflect.get(element, "_ariaRef"))).toEqual(original);
	});

	it("returns fresh run adapters while preserving CmuxTab logical session state", async () => {
		let pageOwner: string | undefined;
		const client = {
			async request(method: string, params: Record<string, unknown>) {
				if (method === "browser.eval") {
					const script = String(params.script);
					if (script === "document.title") return { value: "Current fixture" };
					throw new Error("Lifecycle fixture must not execute the full page runtime");
				}
				if (method === "browser.url.get") return { url: "https://fixture.test/current" };
				throw new Error(`Unexpected run-state RPC: ${method}`);
			},
		};
		const tab = new CmuxTab({ client: client as never, surfaceId: "surface-contract" });
		Reflect.set(tab, "codexEvaluate", async (_source: string, args: unknown[]) => {
			const owner = String(args[0]);
			if (pageOwner && pageOwner !== owner) throw new Error("Page runtime already has an owner");
			pageOwner = owner;
			return 0;
		});
		Reflect.set(tab, "codexEvaluateCleanup", async (_source: string, args: unknown[]) => {
			if (pageOwner === String(args[0])) pageOwner = undefined;
			return true;
		});

		const first = tab.codexAdapter();
		await first.beginRun();
		await first.invoke("browser.nameSession", { name: "logical session" });
		await first.invoke("tab.close", { tabId: "1" });
		await first.endRun();

		const second = tab.codexAdapter();
		expect(second).not.toBe(first);
		await second.beginRun();
		const tabs = await second.invoke("tab.list", {});
		expect(tabs as unknown[]).toEqual([]);
		expect(await caughtError(() => first.invoke("tab.list", {}))).toEqual({
			name: "Error",
			message: "Browser adapter run has ended",
		});
		await second.endRun();
		await second.endRun();
		expect(pageOwner).toBeUndefined();
	});

	it("rolls back failed beginRun setup and permits a clean retry", async () => {
		let installs = 0;
		let cleanups = 0;
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			async codexEvaluate() {
				if (installs++ === 0) throw new Error("prepare failed");
				return 0;
			},
			async codexEvaluateCleanup() {
				cleanups++;
				return true;
			},
		} as never);

		await expect(adapter.beginRun()).rejects.toThrow("prepare failed");
		await adapter.beginRun();
		await adapter.endRun();
		await adapter.endRun();
		expect(cleanups).toBe(2);
	});

	it("arms reload navigation before the native reload and aborts the waiter after settlement", async () => {
		const sequence: string[] = [];
		let navigationSignal: AbortSignal | undefined;
		const navigation = Promise.withResolvers<null>();
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			waitForNavigation(options: { signal?: AbortSignal; onReady?: () => void }) {
				sequence.push("arm");
				navigationSignal = options.signal;
				options.onReady?.();
				return navigation.promise;
			},
			async codexRequest(method: string) {
				expect(method).toBe("browser.reload");
				sequence.push("reload");
				navigation.resolve(null);
				return {};
			},
			async codexEvaluate() {
				sequence.push("prepare");
				return 0;
			},
		} as never);

		await adapter.invoke("tab.reload", { tabId: "1", timeoutMs: 100 });
		expect(sequence).toEqual(["arm", "reload", "prepare"]);
		expect(navigationSignal?.aborted).toBe(true);
	});
	it("selects the exact resolved iframe token for scoped nth frame locators", async () => {
		const view = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
		const topDocument: Record<string, unknown> = { defaultView: view };
		const makeAttributes = () => {
			const values = new Map<string, string>();
			return {
				getAttribute: (name: string) => values.get(name) ?? null,
				hasAttribute: (name: string) => values.has(name),
				removeAttribute: (name: string) => values.delete(name),
				setAttribute: (name: string, value: string) => values.set(name, value),
			};
		};
		const frameAttributes = [makeAttributes(), makeAttributes()];
		const buttonAttributes = [makeAttributes(), makeAttributes()];
		const frameDocuments: Array<Record<string, unknown>> = [];
		const frames: Array<Record<string, unknown>> = [];
		const buttons: Array<Record<string, unknown>> = [];
		for (let index = 0; index < 2; index++) {
			const frameView: Record<string, unknown> = { getComputedStyle: view.getComputedStyle };
			const frameDocument: Record<string, unknown> = { defaultView: frameView };
			const button = {
				...buttonAttributes[index],
				children: [],
				disabled: false,
				getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
				getRootNode: () => frameDocument,
				innerText: `Action ${index}`,
				matches: () => false,
				ownerDocument: frameDocument,
				parentElement: null,
				scrollIntoView: () => undefined,
				tagName: "BUTTON",
				textContent: `Action ${index}`,
			};
			Reflect.set(frameDocument, "querySelectorAll", (selector: string) => {
				if (selector === "*" || selector === "#action") return [button];
				return buttonAttributes[index]?.getAttribute("data-omp-codex-action-token") &&
					selector ===
						`[data-omp-codex-action-token="${buttonAttributes[index]?.getAttribute("data-omp-codex-action-token")}"]`
					? [button]
					: [];
			});
			const frame = {
				...frameAttributes[index],
				contentDocument: frameDocument,
				getRootNode: () => topDocument,
				ownerDocument: topDocument,
				parentElement: null,
				querySelectorAll: () => [],
				tagName: "IFRAME",
			};
			Reflect.set(frameView, "frameElement", frame);
			frameDocuments.push(frameDocument);
			frames.push(frame);
			buttons.push(button);
		}
		const frameScope = {
			ownerDocument: topDocument,
			querySelectorAll: (selector: string) => (selector === "iframe" || selector === "*" ? frames : []),
		};
		Reflect.set(topDocument, "querySelectorAll", (selector: string) =>
			selector === "#frames" ? [frameScope] : selector === "*" ? [frameScope, ...frames] : [],
		);
		const evaluate = (source: string, args: unknown[]) =>
			runPageEvaluator(source, args, { document: topDocument, window: view });
		let selectedFrame = -1;
		const nativeSelectors: string[] = [];
		const { adapter, browser } = adapterAndFacadeFor({
			codexEvaluate: evaluate,
			codexEvaluateCleanup: async (source: string, args: unknown[]) => evaluate(source, args),
			async codexRequest(method: string, params: Readonly<Record<string, unknown>>) {
				expect(method).toBe("browser.frame.select");
				const selector = String(params.selector);
				expect(selector).not.toBe("iframe");
				expect(selector).not.toStartWith("pierce/");
				selectedFrame = frames.findIndex(
					(_frame, index) =>
						selector ===
						`[data-omp-codex-action-token="${frameAttributes[index]?.getAttribute("data-omp-codex-action-token")}"]`,
				);
				expect(selectedFrame).toBe(1);
				return {};
			},
			async codexCleanupRequest(method: string) {
				expect(method).toBe("browser.frame.main");
				selectedFrame = -1;
				return {};
			},
			async click(selector: string) {
				nativeSelectors.push(selector);
				expect(selector).not.toStartWith("pierce/");
				expect(selectedFrame).toBe(1);
				const selectedDocument = frameDocuments[selectedFrame];
				if (!selectedDocument || typeof selectedDocument.querySelectorAll !== "function") {
					throw new Error("Selected frame document is unavailable");
				}
				expect(selectedDocument.querySelectorAll(selector)).toEqual([buttons[1]]);
			},
		});

		try {
			const current = await selectedTab(browser);
			const action = current.playwright.locator("#frames").frameLocator("iframe").nth(1).locator("#action");
			await action.click();
			Reflect.set(frames[1] as object, "getRootNode", () => ({ host: {} }));
			const shadowFrameError = await caughtError(() => action.click());

			expect(nativeSelectors).toHaveLength(1);
			expect(shadowFrameError).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: dom_cua framed shadow action",
			});
			expect(frameAttributes.every(attributes => !attributes.hasAttribute("data-omp-codex-action-token"))).toBe(
				true,
			);
			expect(buttonAttributes.every(attributes => !attributes.hasAttribute("data-omp-codex-action-token"))).toBe(
				true,
			);
		} finally {
			await adapter.dispose();
		}
	});

	it("keeps same-origin frame locator actions inside their resolved frame context", async () => {
		const commands: string[] = [];
		let clicked = false;
		let typed = "";
		let syntheticActions = 0;
		const nativeActions: string[] = [];
		const frameCalls: string[] = [];
		const { adapter, browser } = adapterAndFacadeFor({
			async codexEvaluate(_source: string, args: unknown[]) {
				const command = String(args[1]);
				commands.push(command);
				if (command === "status") return { attached: true, visible: true, enabled: true };
				if (command === "editableValue") return typed;
				if (command === "bindNativeSelector") {
					const token = String((args[2] as { token: string }).token);
					const nested = JSON.stringify(args[0]).includes("#nested-frame");
					return {
						selector: `[data-omp-codex-action-token="${token}"]`,
						frameSelectors: Array.from(
							{ length: nested ? 2 : 1 },
							(_value, index) => `[data-omp-codex-action-token="${token}-frame-${index}"]`,
						),
					};
				}
				if (command === "armNativeFileActivation") return false;
				if (command === "click" || command === "type") {
					syntheticActions++;
					if (command === "click") clicked = true;
					return true;
				}
				return false;
			},
			async codexEvaluateCleanup() {
				return true;
			},
			async codexRequest(method: string, params: Readonly<Record<string, unknown>>) {
				frameCalls.push(`${method}:${String(params.selector ?? "")}`);
				return {};
			},
			async codexCleanupRequest(method: string) {
				frameCalls.push(`${method}:main`);
				return {};
			},
			async click() {
				nativeActions.push("click");
			},
			async type(_selector: string, text: string) {
				nativeActions.push(`type:${text}`);
				typed += text;
			},
		});

		try {
			const frame = (await selectedTab(browser)).playwright.frameLocator("#frame");
			const frameText = "line\n🧑‍💻";
			await frame.locator("#button").click();
			await frame.locator("#editor").type(frameText);
			await frame.locator("#button").and(frame.getByText("Save")).click();
			await frame.locator("#editor").or(frame.getByLabel("Editor")).type(" combined");
			const nestedError = await caughtError(() => frame.frameLocator("#nested-frame").locator("#button").click());

			expect({ clicked, typed }).toEqual({ clicked: false, typed: `${frameText} combined` });
			expect(nativeActions).toEqual(["click", `type:${frameText}`, "click", "type: combined"]);
			expect(syntheticActions).toBe(0);
			expect(frameCalls).toHaveLength(8);
			for (let index = 0; index < frameCalls.length; index += 2) {
				expect(frameCalls[index]).toMatch(/^browser\.frame\.select:\[data-omp-codex-action-token=/);
				expect(frameCalls[index + 1]).toBe("browser.frame.main:main");
			}
			expect(nestedError).toEqual({
				name: "BrowserCapabilityError",
				message: "Browser capability is unavailable: playwright.frameLocator nested native action",
			});
		} finally {
			await adapter.dispose();
		}
	});
	it("uses the generated ARIA runtime through two same-origin frame realms", async () => {
		class TopRealmElement {}
		const deepTarget = { tagName: "BUTTON", querySelectorAll: () => [] };
		const deepestDocument = {
			querySelectorAll: (selector: string) => (selector === "#deep-target" || selector === "*" ? [deepTarget] : []),
		};
		const innerFrame = {
			tagName: "IFRAME",
			contentDocument: deepestDocument,
			querySelectorAll: () => [],
		};
		const outerDocument = {
			querySelectorAll: (selector: string) => (selector === "#inner-frame" || selector === "*" ? [innerFrame] : []),
		};
		const outerFrame = Object.assign(new TopRealmElement(), {
			tagName: "IFRAME",
			contentDocument: outerDocument,
			querySelectorAll: () => [],
		});
		const topDocument = {
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			querySelectorAll: (selector: string) => (selector === "#outer-frame" || selector === "*" ? [outerFrame] : []),
		};
		const evaluate = (source: string, args: unknown[]) =>
			runPageEvaluator(source, args, {
				document: topDocument,
				window: {},
				Element: TopRealmElement,
			});
		const adapter = new CmuxCodexBrowserAdapter({
			surfaceId: "surface-contract",
			codexUrl: async () => "about:blank",
			title: async () => "Nested frames",
			codexEvaluate: evaluate,
			codexEvaluateCleanup: evaluate,
		} as never);
		await adapter.beginRun();
		try {
			const current = await selectedTab(createCodexBrowserFacade(adapter));
			expect(
				await current.playwright
					.frameLocator("#outer-frame")
					.frameLocator("#inner-frame")
					.locator("#deep-target")
					.count(),
			).toBe(1);
		} finally {
			await adapter.endRun();
		}
	});
});
