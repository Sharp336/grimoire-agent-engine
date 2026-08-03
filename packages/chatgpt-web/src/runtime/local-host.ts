import { createHash, randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { BrowserLeaseLimiter, type BrowserLeaseSlot } from "../browser/concurrency";
import type { BrowserLoginRequest, BrowserLoginResult, LoginHost } from "../browser/login-host";
import type { ChatGptWebRuntimeAdmission } from "../provider/types";
import {
	assertBrowserFilterTarget,
	assertBrowserKey,
	assertBrowserRoleTarget,
	assertBrowserSelectorKey,
	BROWSER_LIMITS,
	type BrowserAttachment,
	BrowserContractError,
	type BrowserFilterTarget,
	type BrowserHost,
	type BrowserKey,
	type BrowserLease,
	type BrowserLeaseCapability,
	type BrowserLeaseRequest,
	type BrowserLocator,
	type BrowserNavigationTarget,
	type BrowserPage,
	type BrowserRoleTarget,
	type BrowserSelectorKey,
	validateAttachmentDisplayName,
	validateComposerSnapshot,
	validateHealthSnapshot,
	validateLocatorCount,
	validateLocatorText,
	validateLocatorTexts,
	validateResponseSnapshot,
} from "./host";
import { createPlaywrightPipeTransport, type NativeBrowserPipeLike } from "./playwright-transport";

export interface NativeOwnedProcessLike {
	wait(timeoutMs?: number): Promise<{ exitCode: number | null; signal: string | null }>;
	terminate(): Promise<void>;
	close(): void;
}
export interface NativeOwnedBrowserProcessLike {
	readonly process: NativeOwnedProcessLike;
	readonly pipe: NativeBrowserPipeLike;
}
export interface LocalBrowserConnection {
	readonly browser: Browser;
	readonly context: BrowserContext;
}
export interface SecureStagedAttachment {
	readonly id: string;
	readonly name: string;
	readonly size: number;
	readonly sha256: string;
	close(): Promise<void>;
}
export interface LocalBrowserLeaseBinding {
	readonly leaseId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly ownerGeneration: string;
	readonly capability: BrowserLeaseCapability;
}
export interface SecureBrowserRuntimeAuthority {
	readonly available: boolean;
	readonly ownerGeneration: string;
	/** Revalidates admission, marker/profile generation, executable identity, and held owner fence. */
	revalidate(request: BrowserLeaseRequest, admission: ChatGptWebRuntimeAdmission): Promise<void>;
	/** Launches only from native-held verified executable/environment capabilities. */
	launch(request: BrowserLeaseRequest): Promise<NativeOwnedBrowserProcessLike>;
	stageAttachment(
		binding: LocalBrowserLeaseBinding,
		input: { readonly name: string; readonly bytes: Uint8Array },
	): Promise<SecureStagedAttachment>;
	uploadAttachments(
		binding: LocalBrowserLeaseBinding,
		attachments: readonly SecureStagedAttachment[],
		locator: Locator,
	): Promise<void>;
	close(): Promise<void>;
}
export interface LocalBrowserHostOptions {
	readonly authority: SecureBrowserRuntimeAuthority;
	readonly loginHost: LoginHost;
	/** Package-private deterministic seam; production callers omit it and use the pinned transport. */
	readonly connect?: (pipe: NativeBrowserPipeLike) => Promise<LocalBrowserConnection>;
}

const selectors: Readonly<Record<BrowserSelectorKey, string>> = Object.freeze({
	composer: '[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"]',
	send: '[data-testid="send-button"]',
	response: '[data-testid^="conversation-turn-"][data-turn="assistant"], [data-message-author-role="assistant"]',
	reasoning: '[role="menuitemradio"]',
	commentary: '[role="status"], [data-streaming-response-status]',
	generation: '[data-testid="stop-button"]',
	"attachment-input": 'input[data-testid="upload-photos-input"], input[type="file"]',
	health: "main",
});

function safeError(errorClass: BrowserContractError["errorClass"], code: string): BrowserContractError {
	return new BrowserContractError(errorClass, code);
}

async function closeNativePipe(pipe: NativeBrowserPipeLike): Promise<void> {
	try {
		await pipe.close();
	} catch {
		// Cleanup errors are intentionally bounded; the primary lifecycle failure remains authoritative.
	}
}

/** Package-owned bridge from the native inherited pipe to Playwright; it never accepts a URL or endpoint. */
export async function connectLocalBrowserPipe(pipe: NativeBrowserPipeLike): Promise<LocalBrowserConnection> {
	const transport = createPlaywrightPipeTransport(pipe);
	const browser = await chromium.connectOverCDP(transport, { isLocal: true, noDefaults: true });
	const context = browser.contexts()[0];
	if (!context) {
		await browser.close().catch(() => undefined);
		throw safeError("browser_unavailable", "missing_browser_context");
	}
	return { browser, context };
}

export class BrowserAttachmentRegistry {
	readonly #entries = new WeakMap<object, SecureStagedAttachment>();

	register(reference: BrowserAttachment, staged: SecureStagedAttachment): void {
		this.#entries.set(reference as object, staged);
	}

	resolve(files: readonly BrowserAttachment[]): readonly SecureStagedAttachment[] {
		return files.map(file => {
			const staged = file && typeof file === "object" ? this.#entries.get(file as object) : undefined;
			if (
				!staged ||
				staged.id !== file.id ||
				staged.name !== file.name ||
				staged.size !== file.size ||
				staged.sha256 !== file.sha256
			) {
				throw safeError("malformed_browser_output", "invalid_attachment_reference");
			}
			return staged;
		});
	}

	consume(files: readonly BrowserAttachment[]): void {
		for (const file of files) this.#entries.delete(file as object);
	}
}

class PlaywrightLocatorFacade implements BrowserLocator {
	constructor(
		private readonly page: Page,
		private readonly locator: Locator,
		private readonly attachments: BrowserAttachmentRegistry,
		private readonly upload: (attachments: readonly SecureStagedAttachment[], locator: Locator) => Promise<void>,
	) {}
	async click(): Promise<void> {
		await this.locator.click();
	}
	async fill(text: string): Promise<void> {
		if (new TextEncoder().encode(text).byteLength > BROWSER_LIMITS.composerTextBytes)
			throw safeError("unsupported_context", "fill_too_large");
		await this.locator.fill(text);
	}
	async insertText(text: string): Promise<void> {
		if (new TextEncoder().encode(text).byteLength > BROWSER_LIMITS.composerTextBytes)
			throw safeError("unsupported_context", "insert_too_large");
		await this.locator.pressSequentially(text);
	}
	async press(key: BrowserKey): Promise<void> {
		assertBrowserKey(key);
		await this.locator.press(
			key === "ControlOrMeta+Enter" ? (process.platform === "darwin" ? "Meta+Enter" : "Control+Enter") : key,
		);
	}
	async pressSequentially(text: string): Promise<void> {
		if (new TextEncoder().encode(text).byteLength > BROWSER_LIMITS.composerTextBytes)
			throw safeError("unsupported_context", "input_too_large");
		await this.locator.pressSequentially(text);
	}
	async setInputFiles(files: readonly BrowserAttachment[]): Promise<void> {
		if (!Array.isArray(files) || files.length > 20)
			throw safeError("malformed_browser_output", "invalid_attachment_count");
		const stagedFiles = this.attachments.resolve(files);
		await this.upload(stagedFiles, this.locator);
		this.attachments.consume(files);
	}
	async isVisible(): Promise<boolean> {
		return this.locator.isVisible().catch(() => false);
	}
	async isEnabled(): Promise<boolean> {
		return this.locator.isEnabled().catch(() => false);
	}
	async count(): Promise<number> {
		return validateLocatorCount(await this.locator.count());
	}
	nth(index: number): BrowserLocator {
		if (!Number.isSafeInteger(index) || index < 0 || index >= BROWSER_LIMITS.locatorCount)
			throw safeError("selector_drift", "invalid_locator_index");
		return new PlaywrightLocatorFacade(this.page, this.locator.nth(index), this.attachments, this.upload);
	}
	last(): BrowserLocator {
		return new PlaywrightLocatorFacade(this.page, this.locator.last(), this.attachments, this.upload);
	}
	async allInnerTexts(): Promise<readonly string[]> {
		if ((await this.count()) > BROWSER_LIMITS.locatorTexts)
			throw safeError("malformed_browser_output", "invalid_locator_texts");
		const texts = await this.locator
			.evaluateAll(
				(elements, cap) =>
					elements.map(element => {
						// Playwright evaluates this against browser DOM nodes; this package's TS lib omits DOM globals.
						const browserElement = element as unknown as { innerText?: string; textContent?: string | null };
						const text = browserElement.innerText ?? browserElement.textContent ?? "";
						if (new TextEncoder().encode(text).byteLength > cap) throw new Error("cap");
						return text;
					}),
				BROWSER_LIMITS.locatorTextBytes,
			)
			.catch(() => {
				throw safeError("malformed_browser_output", "locator_text_too_large");
			});
		return validateLocatorTexts(texts);
	}
	async textContent(): Promise<string | null> {
		const text = await this.locator
			.evaluate((element, cap) => {
				const value = element.textContent;
				if (value !== null && new TextEncoder().encode(value).byteLength > cap) throw new Error("cap");
				return value;
			}, BROWSER_LIMITS.locatorTextBytes)
			.catch(() => {
				throw safeError("malformed_browser_output", "locator_text_too_large");
			});
		return validateLocatorText(text);
	}
	filter(target: BrowserFilterTarget): BrowserLocator {
		assertBrowserFilterTarget(target);
		let filtered: Locator;
		if (target.key === "attachment-input" && target.hasText !== undefined) {
			filtered = this.page.getByRole("group", { name: target.hasText, exact: true });
		} else if (target.key === "reasoning" && target.hasText !== undefined) {
			filtered = this.page.getByRole("menuitemradio", { name: target.hasText, exact: true });
		} else if (target.hasText !== undefined) {
			filtered = this.locator.filter({ hasText: target.hasText });
		} else {
			filtered = this.locator;
		}
		return new PlaywrightLocatorFacade(this.page, filtered, this.attachments, this.upload);
	}
}

class PlaywrightPageFacade implements BrowserPage {
	#closed = false;
	constructor(
		private readonly page: Page,
		private readonly attachments: BrowserAttachmentRegistry,
		private readonly upload: (attachments: readonly SecureStagedAttachment[], locator: Locator) => Promise<void>,
	) {}
	async goto(target: BrowserNavigationTarget): Promise<void> {
		if (!target || target.kind !== "temporary-chat" || Object.keys(target).length !== 1)
			throw safeError("selector_drift", "invalid_navigation_target");
		await this.page.goto("https://chatgpt.com/?temporary-chat=true", { waitUntil: "domcontentloaded" });
	}
	locator(target: BrowserSelectorKey): BrowserLocator {
		assertBrowserSelectorKey(target);
		return new PlaywrightLocatorFacade(
			this.page,
			this.page.locator(selectors[target]),
			this.attachments,
			this.upload,
		);
	}
	getByRole(target: BrowserRoleTarget): BrowserLocator {
		assertBrowserRoleTarget(target);
		const locator =
			target.role === "main"
				? this.page.getByRole("main")
				: this.page.getByRole(target.role, { name: target.name, exact: true });
		return new PlaywrightLocatorFacade(this.page, locator, this.attachments, this.upload);
	}
	async readComposerSnapshot() {
		try {
			const value = await this.page
				.locator(selectors.composer)
				.last()
				.evaluate((element, cap) => {
					const composer = element as unknown as {
						innerText?: string;
						textContent?: string | null;
						closest(selector: string): {
							querySelector(selector: string): { getAttribute(name: string): string | null } | null;
						} | null;
					};
					const text = composer.innerText ?? composer.textContent ?? "";
					if (new TextEncoder().encode(text).byteLength > cap) throw new Error("cap");
					const send = composer.closest("form")?.querySelector('[data-testid="send-button"]');
					return { ready: true, text, canSubmit: Boolean(send && send.getAttribute("aria-disabled") !== "true") };
				}, BROWSER_LIMITS.composerTextBytes);
			return validateComposerSnapshot(value);
		} catch {
			throw safeError("malformed_browser_output", "composer_snapshot_failed");
		}
	}
	async readResponseSnapshot() {
		try {
			const value = await this.page.evaluate(
				({ responseSelector, stopSelector, cap, maxNodes }) => {
					interface BrowserNode {
						innerText: string;
						outerHTML: string;
						parentElement: BrowserNode | null;
						getAttribute(name: string): string | null;
						querySelector(selector: string): BrowserNode | null;
						querySelectorAll(selector: string): ArrayLike<BrowserNode>;
					}
					const browser = globalThis as unknown as {
						document: {
							querySelector(selector: string): BrowserNode | null;
							querySelectorAll(selector: string): ArrayLike<BrowserNode>;
						};
					};
					const encode = (value: string): string => {
						if (new TextEncoder().encode(value).byteLength > cap) throw new Error("cap");
						return value;
					};
					const joinBounded = (values: readonly string[], separator: string): string => {
						let bytes = 0;
						const separatorBytes = new TextEncoder().encode(separator).byteLength;
						for (const value of values) {
							bytes += new TextEncoder().encode(value).byteLength;
							if (bytes > cap) throw new Error("cap");
							bytes += separatorBytes;
						}
						return values.join(separator);
					};
					const boundedNodes = (nodes: ArrayLike<BrowserNode>): BrowserNode[] => {
						if (nodes.length > maxNodes) throw new Error("count");
						const output = Array.from(nodes);
						for (const node of output) {
							let depth = 0;
							let current: BrowserNode | null = node;
							while (current) {
								depth += 1;
								if (depth > 128) throw new Error("depth");
								current = current.parentElement;
							}
						}
						return output;
					};
					const turns = boundedNodes(browser.document.querySelectorAll(responseSelector));
					const response = turns.at(-1);
					const userTurns = boundedNodes(
						browser.document.querySelectorAll(
							'[data-testid^="conversation-turn-"][data-turn="user"], [data-message-author-role="user"]',
						),
					);
					const userText = encode(userTurns.at(-1)?.innerText ?? "");
					const markdownRoots = response ? boundedNodes(response.querySelectorAll(".markdown")) : [];
					const assistantText = joinBounded(
						markdownRoots.map(root => root.outerHTML),
						"",
					);
					const reasoningText = response
						? joinBounded(
								boundedNodes(response.querySelectorAll('[role="status"], [data-streaming-response-status]'))
									.map(node => node.innerText.trim())
									.filter(Boolean),
								"\n",
							)
						: "";
					const generationId = response?.getAttribute("data-testid") ?? null;
					if (generationId && new TextEncoder().encode(generationId).byteLength > 512) throw new Error("cap");
					const running = Boolean(browser.document.querySelector(stopSelector));
					const settled =
						Boolean(response?.querySelector('button[data-testid="copy-turn-action-button"]')) && !running;
					return { userText, assistantText, reasoningText, generationId, settled };
				},
				{
					responseSelector: selectors.response,
					stopSelector: selectors.generation,
					cap: BROWSER_LIMITS.responseTextBytes,
					maxNodes: BROWSER_LIMITS.locatorTexts,
				},
			);
			return validateResponseSnapshot(value);
		} catch {
			throw safeError("malformed_browser_output", "response_snapshot_failed");
		}
	}
	async readHealthSnapshot() {
		if (this.#closed || this.page.isClosed())
			return validateHealthSnapshot({ temporaryChat: false, ready: false, errorClass: "browser_unavailable" });
		try {
			const value = await this.page.evaluate(composerSelector => {
				const browser = globalThis as unknown as {
					document: { querySelector(selector: string): object | null };
					location: { origin: string; pathname: string; search: string };
				};
				return {
					temporaryChat:
						browser.location.origin === "https://chatgpt.com" &&
						browser.location.pathname === "/" &&
						new URLSearchParams(browser.location.search).get("temporary-chat") === "true",
					ready: Boolean(browser.document.querySelector(composerSelector)),
					errorClass: null,
				};
			}, selectors.composer);
			return validateHealthSnapshot(value);
		} catch {
			return validateHealthSnapshot({ temporaryChat: false, ready: false, errorClass: "internal" });
		}
	}
	async state(): Promise<"temporary-chat" | "other" | "closed"> {
		if (this.#closed || this.page.isClosed()) return "closed";
		const health = await this.readHealthSnapshot();
		return health.temporaryChat ? "temporary-chat" : "other";
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.page.close();
	}
}

/** Opens the sole package-approved login/navigation target in an existing native browser context. */
export async function openLocalTemporaryChat(context: BrowserContext): Promise<void> {
	const page = context.pages()[0] ?? (await context.newPage());
	await page.goto("https://chatgpt.com/?temporary-chat=true", { waitUntil: "domcontentloaded" });
}

/** Verifies the login contract against the same selectors used by production browser leases. */
export async function verifyLocalBrowserContext(
	context: BrowserContext,
	profileIdentity: string,
): Promise<{
	readonly authenticated: boolean;
	readonly temporaryChat: boolean;
	readonly proAvailable: boolean;
	readonly profileIdentity: string;
}> {
	await openLocalTemporaryChat(context);
	const rawPage = context.pages()[0] ?? (await context.newPage());
	const facade = new PlaywrightPageFacade(rawPage, new BrowserAttachmentRegistry(), async () => {
		throw safeError("unsupported_context", "verification_attachments_forbidden");
	});

	const [health, composer] = await Promise.all([facade.readHealthSnapshot(), facade.readComposerSnapshot()]);
	const authenticated = health.ready && composer.ready;
	const proAvailable =
		authenticated &&
		(await rawPage
			.getByRole("menuitemradio", { name: "Pro", exact: true })
			.count()
			.then(count => count === 1)
			.catch(() => false));
	return {
		authenticated,
		temporaryChat: health.temporaryChat,
		proAvailable,
		profileIdentity,
	};
}

interface ActiveLeaseRecord {
	readonly slot: BrowserLeaseSlot;
	readonly page: PlaywrightPageFacade;
	readonly staged: Set<SecureStagedAttachment>;
	closed: boolean;
}

export class LocalBrowserHost implements BrowserHost {
	readonly #authority: SecureBrowserRuntimeAuthority;
	readonly #loginHost: LoginHost;
	readonly #connect: (pipe: NativeBrowserPipeLike) => Promise<{ browser: Browser; context: BrowserContext }>;
	readonly #limiter = new BrowserLeaseLimiter();
	readonly #leases = new Set<ActiveLeaseRecord>();
	readonly #leaseOperations = new Set<Promise<BrowserLease>>();
	#browserStart:
		| Promise<{ browser: Browser; context: BrowserContext; native: NativeOwnedBrowserProcessLike }>
		| undefined;
	#browserHeaded: boolean | undefined;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: LocalBrowserHostOptions) {
		if (!options.authority.available || !options.authority.ownerGeneration)
			throw safeError("browser_unavailable", "native_security_unavailable");
		this.#authority = options.authority;
		this.#loginHost = options.loginHost;
		this.#connect = options.connect ?? connectLocalBrowserPipe;
	}
	async login(request: BrowserLoginRequest): Promise<BrowserLoginResult> {
		this.#assertOpen();
		const result = await this.#loginHost.login(request);
		this.#assertOpen();
		return result;
	}
	#assertOpen(): void {
		if (this.#closed || !this.#authority.available) throw safeError("browser_unavailable", "host_closed");
	}

	async #disposeUnpublishedBrowser(native: NativeOwnedBrowserProcessLike, browser?: Browser): Promise<void> {
		if (browser) {
			try {
				await browser.close();
			} catch {
				// The safe lifecycle error remains authoritative.
			}
		}
		await closeNativePipe(native.pipe);
		try {
			await native.process.terminate();
		} catch {
			// Continue closing the native handle.
		}
		try {
			native.process.close();
		} catch {
			// The safe lifecycle error remains authoritative.
		}
	}

	async #ensureBrowser(request: BrowserLeaseRequest, admission: ChatGptWebRuntimeAdmission) {
		this.#assertOpen();
		if (this.#browserStart) {
			if (this.#browserHeaded !== request.headed) throw safeError("profile_conflict", "browser_mode_conflict");
			return this.#browserStart;
		}
		this.#browserHeaded = request.headed;
		const start = (async () => {
			await this.#authority.revalidate(request, admission);
			this.#assertOpen();
			const native = await this.#authority.launch(request);
			if (this.#closed) {
				await this.#disposeUnpublishedBrowser(native);
				throw safeError("browser_unavailable", "host_closed");
			}
			let connection: LocalBrowserConnection;
			try {
				connection = await this.#connect(native.pipe);
			} catch (error) {
				await this.#disposeUnpublishedBrowser(native);
				if (this.#closed) throw safeError("browser_unavailable", "host_closed");
				throw error;
			}
			if (this.#closed) {
				await this.#disposeUnpublishedBrowser(native, connection.browser);
				throw safeError("browser_unavailable", "host_closed");
			}
			return { browser: connection.browser, context: connection.context, native };
		})();
		this.#browserStart = start;
		try {
			return await start;
		} catch (error) {
			if (this.#browserStart === start) {
				this.#browserStart = undefined;
				this.#browserHeaded = undefined;
			}
			if (this.#closed) throw safeError("browser_unavailable", "host_closed");
			throw error;
		}
	}
	lease(request: BrowserLeaseRequest, admission: ChatGptWebRuntimeAdmission): Promise<BrowserLease> {
		if (this.#closed || !this.#authority.available) {
			return Promise.reject(safeError("browser_unavailable", "host_closed"));
		}
		if (request.signal?.aborted) return Promise.reject(safeError("aborted", "lease_aborted"));
		const operation = this.#createLease(request, admission).then(
			lease => {
				this.#assertOpen();
				return lease;
			},
			error => {
				if (this.#closed) throw safeError("browser_unavailable", "host_closed");
				throw error;
			},
		);
		this.#leaseOperations.add(operation);
		void operation.then(
			() => this.#leaseOperations.delete(operation),
			() => this.#leaseOperations.delete(operation),
		);
		return operation;
	}

	async #createLease(request: BrowserLeaseRequest, admission: ChatGptWebRuntimeAdmission): Promise<BrowserLease> {
		await this.#authority.revalidate(request, admission);
		this.#assertOpen();
		const leaseId = randomBytes(24).toString("hex");
		const slot = this.#limiter.acquire(leaseId);
		try {
			const running = await this.#ensureBrowser(request, admission);
			this.#assertOpen();
			await this.#authority.revalidate(request, admission);
			this.#assertOpen();
			const rawPage = await running.context.newPage();
			if (this.#closed) {
				try {
					await rawPage.close();
				} catch {
					// The safe lifecycle error remains authoritative.
				}
				throw safeError("browser_unavailable", "host_closed");
			}
			if (request.signal?.aborted) {
				await rawPage.close();
				throw safeError("aborted", "lease_aborted");
			}
			const attachments = new BrowserAttachmentRegistry();
			const capability = Object.freeze(Object.create(null)) as BrowserLeaseCapability;
			const binding: LocalBrowserLeaseBinding = Object.freeze({
				leaseId,
				sessionId: request.sessionId,
				turnId: request.turnId,
				ownerGeneration: this.#authority.ownerGeneration,
				capability,
			});
			const upload = (staged: readonly SecureStagedAttachment[], locator: Locator) =>
				this.#authority.uploadAttachments(binding, staged, locator);
			const record: ActiveLeaseRecord = {
				slot,
				page: new PlaywrightPageFacade(rawPage, attachments, upload),
				staged: new Set(),
				closed: false,
			};
			this.#leases.add(record);
			const close = async (): Promise<void> => {
				if (record.closed) return;
				record.closed = true;
				this.#leases.delete(record);
				const errors: unknown[] = [];
				try {
					await record.page.close();
				} catch (error) {
					errors.push(error);
				}
				for (const result of await Promise.allSettled([...record.staged].map(staged => staged.close()))) {
					if (result.status === "rejected") errors.push(result.reason);
				}
				record.staged.clear();
				try {
					record.slot.release();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length > 0) throw new AggregateError(errors, "Browser lease cleanup failed");
			};
			return Object.freeze({
				id: leaseId,
				capability,
				page: record.page,
				stageAttachment: async (input: { name: string; bytes: Uint8Array }): Promise<BrowserAttachment> => {
					if (record.closed) throw safeError("browser_unavailable", "lease_closed");
					const name = validateAttachmentDisplayName(input.name);
					if (
						!(input.bytes instanceof Uint8Array) ||
						input.bytes.byteLength === 0 ||
						input.bytes.byteLength > BROWSER_LIMITS.attachmentBytes
					) {
						throw safeError("unsupported_context", "invalid_attachment_bytes");
					}
					const staged = await this.#authority.stageAttachment(binding, { name, bytes: input.bytes });
					const digest = createHash("sha256").update(input.bytes).digest("hex");
					if (
						staged.name !== name ||
						staged.size !== input.bytes.byteLength ||
						staged.sha256 !== digest ||
						!/^[a-f0-9]{64}$/u.test(staged.sha256)
					) {
						await staged.close().catch(() => undefined);
						throw safeError("malformed_browser_output", "staged_attachment_mismatch");
					}
					const reference = Object.freeze({
						id: staged.id,
						name,
						size: staged.size,
						sha256: staged.sha256,
					}) as BrowserAttachment;
					attachments.register(reference, staged);
					record.staged.add(staged);
					return reference;
				},
				close,
			});
		} catch (error) {
			slot.release();
			throw error;
		}
	}
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#closePromise = this.#finishClose();
		return this.#closePromise;
	}

	async #finishClose(): Promise<void> {
		const errors: unknown[] = [];
		const dependencyClose = Promise.allSettled([this.#loginHost.close(), this.#authority.close()]);
		const leaseClose = Promise.all(
			[...this.#leases].map(async record => {
				record.closed = true;
				try {
					await record.page.close();
				} catch (error) {
					errors.push(error);
				}
				for (const result of await Promise.allSettled([...record.staged].map(staged => staged.close()))) {
					if (result.status === "rejected") errors.push(result.reason);
				}
				record.staged.clear();
				try {
					record.slot.release();
				} catch (error) {
					errors.push(error);
				}
			}),
		);
		this.#leases.clear();
		this.#limiter.close();
		await leaseClose;
		const browserStart = this.#browserStart;
		const running = await browserStart?.catch(() => undefined);
		if (running) {
			try {
				await running.browser.close();
			} catch (error) {
				errors.push(error);
			}
			try {
				await running.native.pipe.close();
			} catch (error) {
				errors.push(error);
			}
			try {
				await running.native.process.terminate();
			} catch (error) {
				errors.push(error);
			}
			try {
				running.native.process.close();
			} catch (error) {
				errors.push(error);
			}
		}
		if (this.#browserStart === browserStart) {
			this.#browserStart = undefined;
			this.#browserHeaded = undefined;
		}
		await Promise.allSettled([...this.#leaseOperations]);
		for (const result of await dependencyClose) {
			if (result.status === "rejected") errors.push(result.reason);
		}
		if (errors.length > 0) throw new AggregateError(errors, "Local browser host cleanup failed");
	}
}

export function createLocalBrowserHost(options: LocalBrowserHostOptions): BrowserHost {
	return new LocalBrowserHost(options);
}
