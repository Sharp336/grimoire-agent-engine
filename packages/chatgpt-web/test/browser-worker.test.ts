import { describe, expect, test } from "bun:test";
import { ChatGptCompletionTracker, chatGptSubmissionEvidence, runBrowserTurn } from "../src/browser/browser-worker";
import { BrowserLeaseLimiter } from "../src/browser/concurrency";
import { chatGptHtmlToMarkdown, safeTerminalLink, sanitizeLinkTarget } from "../src/browser/markdown";
import type { ChatGptWebEvent, ChatGptWebRuntimeAdmission } from "../src/provider/types";
import type {
	BrowserAttachment,
	BrowserFilterTarget,
	BrowserHost,
	BrowserKey,
	BrowserLease,
	BrowserLocator,
	BrowserPage,
	BrowserRoleTarget,
	BrowserSelectorKey,
	ComposerSnapshot,
	HealthSnapshot,
	ResponseSnapshot,
} from "../src/runtime/host";

const admission = Object.freeze({ runtimeEpoch: "epoch", lifecycleGeneration: 1 }) as ChatGptWebRuntimeAdmission;

class FakeLocator implements BrowserLocator {
	visible = true;
	enabled = true;
	countValue = 1;
	fills: string[] = [];
	presses: BrowserKey[] = [];
	files: readonly BrowserAttachment[] = [];
	constructor(
		readonly key: BrowserSelectorKey | "role",
		private readonly owner: FakePage,
	) {}
	async click(): Promise<void> {}
	async fill(text: string): Promise<void> {
		this.fills.push(text);
		this.owner.composer.text = text;
	}
	async insertText(text: string): Promise<void> {
		this.fills.push(text);
	}
	async press(key: BrowserKey): Promise<void> {
		this.presses.push(key);
	}
	async pressSequentially(text: string): Promise<void> {
		this.fills.push(text);
	}
	async setInputFiles(files: readonly BrowserAttachment[]): Promise<void> {
		this.files = files;
	}
	async isVisible(): Promise<boolean> {
		return this.visible;
	}
	async isEnabled(): Promise<boolean> {
		return this.enabled;
	}
	async count(): Promise<number> {
		return this.countValue;
	}
	nth(): BrowserLocator {
		return this;
	}
	last(): BrowserLocator {
		return this;
	}
	async allInnerTexts(): Promise<readonly string[]> {
		return [];
	}
	async textContent(): Promise<string | null> {
		return null;
	}
	filter(target: BrowserFilterTarget): BrowserLocator {
		if (target.key === "attachment-input") this.countValue = 1;
		return this;
	}
}

class FakePage implements BrowserPage {
	readonly locators = new Map<string, FakeLocator>();
	composer: ComposerSnapshot = { ready: true, text: "", canSubmit: true };
	health: HealthSnapshot = { temporaryChat: true, ready: true, errorClass: null };
	responses: ResponseSnapshot[] = [];
	closed = 0;
	navigations = 0;
	async goto(): Promise<void> {
		this.navigations += 1;
	}
	locator(target: BrowserSelectorKey): BrowserLocator {
		let locator = this.locators.get(target);
		if (!locator) {
			locator = new FakeLocator(target, this);
			this.locators.set(target, locator);
		}
		return locator;
	}
	getByRole(target: BrowserRoleTarget): BrowserLocator {
		return this.locator(target.role === "button" && target.name === "Stop generating" ? "generation" : "health");
	}
	async readComposerSnapshot(): Promise<ComposerSnapshot> {
		return { ...this.composer };
	}
	async readResponseSnapshot(): Promise<ResponseSnapshot> {
		return (
			this.responses.shift() ?? {
				userText: "prompt",
				assistantText: "<p>answer</p>",
				reasoningText: "Thinking",
				generationId: "g1",
				settled: true,
			}
		);
	}
	async readHealthSnapshot(): Promise<HealthSnapshot> {
		return { ...this.health };
	}
	async state(): Promise<"temporary-chat" | "other" | "closed"> {
		return this.closed ? "closed" : "temporary-chat";
	}
	async close(): Promise<void> {
		this.closed += 1;
	}
}

class FakeHost implements BrowserHost {
	readonly page = new FakePage();
	closeCount = 0;
	stageCount = 0;
	async login(): Promise<never> {
		throw new Error("unused");
	}
	async lease(): Promise<BrowserLease> {
		let closed = false;
		return {
			id: "lease",
			capability: Object.freeze({}) as BrowserLease["capability"],
			page: this.page,
			stageAttachment: async input => {
				this.stageCount += 1;
				return Object.freeze({
					id: `a${this.stageCount}`,
					name: input.name,
					size: input.bytes.byteLength,
					sha256: "a".repeat(64),
				}) as BrowserAttachment;
			},
			close: async () => {
				if (closed) return;
				closed = true;
				this.closeCount += 1;
				await this.page.close();
			},
		};
	}
	async close(): Promise<void> {}
}

const empty: ResponseSnapshot = {
	userText: "",
	assistantText: "",
	reasoningText: "",
	generationId: null,
	settled: false,
};

describe("browser worker", () => {
	test("requires submission evidence and stable settled response", async () => {
		const host = new FakeHost();
		host.page.responses = [
			empty,
			{ ...empty, userText: "prompt", generationId: "g1" },
			...Array.from({ length: 12 }, () => ({
				userText: "prompt",
				assistantText: "<p>answer</p>",
				reasoningText: "Thinking",
				generationId: "g1",
				settled: true,
			})),
		];
		const events: ChatGptWebEvent[] = [];
		await runBrowserTurn(
			{
				identity: { sessionId: "s", turnId: "t" },
				modelKey: "high",
				mode: "browser-only",
				headed: false,
				prompt: "prompt",
			},
			host,
			admission,
			event => events.push(event),
		);
		expect(host.page.navigations).toBe(1);
		expect(events[0]).toEqual({ type: "start", responseId: "g1" });
		expect(events).toContainEqual({ type: "reasoning", text: "Thinking", continuation: false });
		expect(events).toContainEqual({ type: "text", text: "answer", continuation: false });
		expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
		expect(host.closeCount).toBe(1);
	});

	test("stages attachments and requires visible evidence", async () => {
		const host = new FakeHost();
		host.page.responses = [
			empty,
			{ ...empty, userText: "prompt", generationId: "g1" },
			...Array.from({ length: 12 }, () => ({
				userText: "prompt",
				assistantText: "ok",
				reasoningText: "",
				generationId: "g1",
				settled: true,
			})),
		];
		await runBrowserTurn(
			{
				identity: { sessionId: "s", turnId: "t" },
				modelKey: "light",
				mode: "browser-only",
				headed: false,
				prompt: "prompt",
				attachments: [{ name: "image.png", bytes: new Uint8Array([1, 2, 3]) }],
			},
			host,
			admission,
			() => undefined,
		);
		expect(host.stageCount).toBe(1);
		expect((host.page.locator("attachment-input") as FakeLocator).files).toHaveLength(1);
	});

	test("aborts, stops generation, and closes once", async () => {
		const host = new FakeHost();
		const controller = new AbortController();
		controller.abort();
		const events: ChatGptWebEvent[] = [];
		await expect(
			runBrowserTurn(
				{
					identity: { sessionId: "s", turnId: "abort" },
					modelKey: "high",
					mode: "browser-only",
					headed: false,
					prompt: "prompt",
				},
				host,
				admission,
				event => events.push(event),
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(events).toContainEqual({ type: "error", errorClass: "aborted", retryable: false });
		expect(host.closeCount).toBe(0);
	});

	test("abort closes an active lease to interrupt an in-flight browser operation", async () => {
		const host = new FakeHost();
		const controller = new AbortController();
		const { promise: navigationStarted, resolve: markNavigationStarted } = Promise.withResolvers<void>();
		const { promise: navigationClosed, reject: rejectNavigation } = Promise.withResolvers<void>();
		host.page.goto = async () => {
			host.page.navigations++;
			markNavigationStarted();
			await navigationClosed;
		};
		host.page.close = async () => {
			host.page.closed++;
			rejectNavigation(new DOMException("aborted", "AbortError"));
		};
		const events: ChatGptWebEvent[] = [];
		const running = runBrowserTurn(
			{
				identity: { sessionId: "s", turnId: "in-flight-abort" },
				modelKey: "high",
				mode: "browser-only",
				headed: false,
				prompt: "prompt",
			},
			host,
			admission,
			event => events.push(event),
			controller.signal,
		);
		await navigationStarted;
		controller.abort();
		await expect(running).rejects.toMatchObject({ name: "AbortError" });
		expect(events).toContainEqual({ type: "error", errorClass: "aborted", retryable: false });
		expect(host.closeCount).toBe(1);
		expect(host.page.closed).toBe(1);
	});

	test("tracks settlement and submission evidence deterministically", () => {
		const tracker = new ChatGptCompletionTracker(100);
		const settled = { userText: "p", assistantText: "a", reasoningText: "", generationId: "g", settled: true };
		expect(tracker.update(settled, 1_000)).toBe(false);
		expect(tracker.update(settled, 1_099)).toBe(false);
		expect(tracker.update(settled, 1_100)).toBe(true);
		expect(chatGptSubmissionEvidence(empty, { ...empty, generationId: "g" }, "p")).toBe("generation_running");
	});

	test("shares a strict five-slot lease cap and releases idempotently", () => {
		const limiter = new BrowserLeaseLimiter();
		const slots = Array.from({ length: 5 }, (_, index) => limiter.acquire(String(index)));
		expect(() => limiter.acquire("sixth")).toThrow("browser_lease_limit");
		slots[0]!.release();
		slots[0]!.release();
		expect(limiter.acquire("replacement").id).toBe("replacement");
		expect(limiter.activeCount).toBe(5);
	});

	test("sanitizes Markdown links and preserves fenced code and GFM lists", () => {
		const markdown = chatGptHtmlToMarkdown(`
			<script>secret()</script>
			<ul><li>one</li><li>two</li></ul>
			<pre><code class="language-ts">const value = 1;</code></pre>
			<a href="https://example.com/docs">safe</a>
			<a href="javascript:alert(1)">unsafe</a>
		`);
		expect(markdown).not.toContain("secret");
		expect(markdown).toContain("- one");
		expect(markdown).toContain("```");
		expect(markdown).toContain("[safe](https://example.com/docs)");
		expect(markdown).toContain("unsafe");
		expect(markdown).not.toContain("javascript:");
	});

	test("allows OSC8 only for bounded safe schemes", () => {
		expect(sanitizeLinkTarget("https://example.com/a")).toBe("https://example.com/a");
		for (const target of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"data:text/plain,secret",
			"ftp://example.com/a",
			"//example.com/a",
			"https://example.com/\u0007secret",
			"https://user:password@example.com/",
		]) {
			expect(sanitizeLinkTarget(target)).toBeNull();
			expect(safeTerminalLink("visible", target)).toBe("visible");
		}
		expect(safeTerminalLink("visible", "https://example.com")).toContain("\u001b]8;;https://example.com");
	});
});
