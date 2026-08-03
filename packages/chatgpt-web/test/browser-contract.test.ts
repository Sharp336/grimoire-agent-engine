import { describe, expect, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { ChatGptWebRuntimeAdmission } from "../src/provider/types";
import {
	assertBrowserFilterTarget,
	assertBrowserKey,
	assertBrowserRoleTarget,
	assertBrowserSelectorKey,
	BROWSER_LIMITS,
	type BrowserAttachment,
	type BrowserHost,
	type BrowserPage,
	validateAttachmentDisplayName,
	validateComposerSnapshot,
	validateHealthSnapshot,
	validateLocatorCount,
	validateLocatorTexts,
	validateResponseSnapshot,
} from "../src/runtime/host";
import {
	BrowserAttachmentRegistry,
	LocalBrowserHost,
	type NativeOwnedBrowserProcessLike,
	type SecureBrowserRuntimeAuthority,
	type SecureStagedAttachment,
} from "../src/runtime/local-host";

// These expect-errors are compile gates: if the closed facade grows a generic/endpoint-bearing API,
// the directive becomes unused and the package type-check fails.
// biome-ignore lint/correctness/noConstantCondition: compile-only type assertions must remain unreachable.
if (false) {
	const page = null as unknown as BrowserPage;
	const host = null as unknown as BrowserHost;
	// @ts-expect-error arbitrary selectors never cross the facade
	page.locator("body > iframe");
	// @ts-expect-error arbitrary URLs never cross the facade
	page.goto("https://example.invalid");
	// @ts-expect-error arbitrary JavaScript never crosses the facade
	page.evaluate("document.cookie");
	// @ts-expect-error cookie access is forbidden
	page.context().cookies();
	// @ts-expect-error CDP endpoints are forbidden
	host.wsEndpoint;
	// @ts-expect-error storage state is forbidden
	page.storageState();
}

describe("closed browser contract", () => {
	test("accepts only closed selector, role, filter, and key values", () => {
		expect(() => assertBrowserSelectorKey("composer")).not.toThrow();
		expect(() => assertBrowserSelectorKey("css=.secret")).toThrow("unknown_selector_key");
		expect(() => assertBrowserKey("Enter")).not.toThrow();
		expect(() => assertBrowserKey("F12")).toThrow("unknown_keyboard_key");
		expect(() => assertBrowserRoleTarget({ role: "button", name: "Send" })).not.toThrow();
		expect(() => assertBrowserRoleTarget({ role: "button", name: "Export data" })).toThrow("invalid_role_target");
		expect(() => assertBrowserFilterTarget({ key: "reasoning", hasText: "High" })).not.toThrow();
		expect(() => assertBrowserFilterTarget({ key: "reasoning", has: { css: "*" } })).toThrow("invalid_filter_target");
	});

	test("rejects oversized, malformed, and unexpectedly deep snapshots", () => {
		expect(() => validateComposerSnapshot({ ready: true, text: "ok", canSubmit: true })).not.toThrow();
		expect(() =>
			validateComposerSnapshot({
				ready: true,
				text: "x".repeat(BROWSER_LIMITS.composerTextBytes + 1),
				canSubmit: true,
			}),
		).toThrow("composer_text_too_large");
		expect(() =>
			validateResponseSnapshot({
				userText: "u",
				assistantText: "a",
				reasoningText: "r",
				generationId: null,
				settled: true,
				nested: { secret: true },
			}),
		).toThrow("invalid_response_snapshot");
		expect(() => validateHealthSnapshot({ temporaryChat: true, ready: false, errorClass: "raw_exception" })).toThrow(
			"invalid_health_error_class",
		);
		expect(() => validateLocatorCount(BROWSER_LIMITS.locatorCount + 1)).toThrow("invalid_locator_count");
		expect(() => validateLocatorTexts(Array.from({ length: BROWSER_LIMITS.locatorTexts + 1 }, () => "x"))).toThrow(
			"invalid_locator_texts",
		);
	});

	test("rejects path-like/control attachment display names", () => {
		for (const name of ["../secret", "a/b", "a\\b", "C:\\secret", "\\\\server\\share", "nul\0name", "line\nname"]) {
			expect(() => validateAttachmentDisplayName(name)).toThrow("invalid_attachment_name");
		}
		expect(validateAttachmentDisplayName("diagram 01.png")).toBe("diagram 01.png");
	});

	test("attachment records expose metadata only", () => {
		const attachment = Object.freeze({
			id: "opaque",
			name: "a.png",
			size: 3,
			sha256: "f".repeat(64),
		}) as BrowserAttachment;
		expect(Object.keys(attachment).sort()).toEqual(["id", "name", "sha256", "size"]);
		expect(JSON.stringify(attachment)).not.toContain("path");
		expect(JSON.stringify(attachment)).not.toContain("descriptor");
	});

	test("rejects structural clones, cross-lease references, and replay", () => {
		const firstLease = new BrowserAttachmentRegistry();
		const siblingLease = new BrowserAttachmentRegistry();
		const reference = Object.freeze({
			id: "opaque",
			name: "a.png",
			size: 3,
			sha256: "f".repeat(64),
		}) as BrowserAttachment;
		const staged: SecureStagedAttachment = {
			id: reference.id,
			name: reference.name,
			size: reference.size,
			sha256: reference.sha256,
			async close() {},
		};
		firstLease.register(reference, staged);
		expect(firstLease.resolve([reference])).toEqual([staged]);
		expect(() => firstLease.resolve([{ ...reference } as BrowserAttachment])).toThrow("invalid_attachment_reference");
		expect(() => siblingLease.resolve([reference])).toThrow("invalid_attachment_reference");
		firstLease.consume([reference]);
		expect(() => firstLease.resolve([reference])).toThrow("invalid_attachment_reference");
	});

	test("shares one native browser across five idempotent page leases", async () => {
		let launches = 0;
		let nativeTerminates = 0;
		let authorityCloses = 0;
		let browserCloses = 0;
		const pageCloses: number[] = [];
		const pipe = {
			nonBlocking: true as const,
			async *read() {},
			write() {},
			close() {},
		};
		const native: NativeOwnedBrowserProcessLike = {
			pipe,
			process: {
				async wait() {
					return { exitCode: 0, signal: null };
				},
				async terminate() {
					nativeTerminates++;
				},
				close() {},
			},
		};
		const authority: SecureBrowserRuntimeAuthority = {
			available: true,
			ownerGeneration: "owner-generation",
			async revalidate() {},
			async launch() {
				launches++;
				return native;
			},
			async stageAttachment() {
				throw new Error("unused");
			},
			async uploadAttachments() {
				throw new Error("unused");
			},
			async close() {
				authorityCloses++;
			},
		};
		const browserContext = {
			async newPage() {
				const index = pageCloses.push(0) - 1;
				const fakePage = {
					isClosed: () => pageCloses[index] !== 0,
					async close() {
						pageCloses[index] = (pageCloses[index] ?? 0) + 1;
					},
				};
				return fakePage as unknown as Page;
			},
		} as unknown as BrowserContext;
		const browser = {
			async close() {
				browserCloses++;
			},
		} as unknown as Browser;
		const host = new LocalBrowserHost({
			authority,
			loginHost: {
				async login() {
					throw new Error("unused");
				},
				async close() {},
			},
			connect: async () => ({ browser, context: browserContext }),
		});
		const runtimeAdmission = Object.freeze({
			runtimeEpoch: "epoch",
			lifecycleGeneration: 1,
		}) as ChatGptWebRuntimeAdmission;
		const request = (turnId: string, headed = false) => ({
			sessionId: "session",
			turnId,
			modelKey: "high",
			mode: "browser-only" as const,
			headed,
		});
		const leases = await Promise.all(
			Array.from({ length: 5 }, (_, index) => host.lease(request(String(index)), runtimeAdmission)),
		);
		expect(launches).toBe(1);
		expect(pageCloses).toEqual([0, 0, 0, 0, 0]);
		await expect(host.lease(request("sixth"), runtimeAdmission)).rejects.toThrow("browser_lease_limit");
		await leases[0]!.close();
		await leases[0]!.close();
		expect(pageCloses[0]).toBe(1);
		const replacement = await host.lease(request("replacement"), runtimeAdmission);
		expect(launches).toBe(1);
		await replacement.close();
		await expect(host.lease(request("headed", true), runtimeAdmission)).rejects.toThrow("browser_mode_conflict");
		expect(pageCloses.slice(1, 5)).toEqual([0, 0, 0, 0]);
		await host.close();
		expect(pageCloses).toEqual([1, 1, 1, 1, 1, 1]);
		expect(browserCloses).toBe(1);
		expect(nativeTerminates).toBe(1);
		expect(authorityCloses).toBe(1);
	});

	test("close waits for a late browser connection and cleans up its native process", async () => {
		let pipeCloses = 0;
		let processTerminates = 0;
		let processCloses = 0;
		let browserCloses = 0;
		const connected = Promise.withResolvers<void>();
		const released = Promise.withResolvers<{ browser: Browser; context: BrowserContext }>();
		const native: NativeOwnedBrowserProcessLike = {
			pipe: {
				nonBlocking: true,
				async *read() {},
				write() {},
				async close() {
					pipeCloses++;
				},
			},
			process: {
				async wait() {
					return { exitCode: null, signal: null };
				},
				async terminate() {
					processTerminates++;
				},
				close() {
					processCloses++;
				},
			},
		};
		const authority: SecureBrowserRuntimeAuthority = {
			available: true,
			ownerGeneration: "owner-generation",
			async revalidate() {},
			async launch() {
				return native;
			},
			async stageAttachment() {
				throw new Error("unused");
			},
			async uploadAttachments() {
				throw new Error("unused");
			},
			async close() {},
		};
		const host = new LocalBrowserHost({
			authority,
			loginHost: {
				async login() {
					throw new Error("unused");
				},
				async close() {},
			},
			connect: async () => {
				connected.resolve();
				return released.promise;
			},
		});
		const pending = host.lease(
			{
				sessionId: "session",
				turnId: "connect-race",
				modelKey: "high",
				mode: "browser-only",
				headed: false,
			},
			{ runtimeEpoch: "epoch", lifecycleGeneration: 1 } as ChatGptWebRuntimeAdmission,
		);
		await connected.promise;
		const closing = host.close();
		expect(await Promise.race([closing.then(() => "closed"), Promise.resolve("pending")])).toBe("pending");
		expect(host.close()).toBe(closing);
		released.resolve({
			browser: {
				async close() {
					browserCloses++;
				},
			} as unknown as Browser,
			context: {
				async newPage() {
					throw new Error("unused");
				},
			} as unknown as BrowserContext,
		});
		await expect(pending).rejects.toMatchObject({ errorClass: "browser_unavailable", message: "host_closed" });
		await closing;
		expect(browserCloses).toBe(1);
		expect(pipeCloses).toBe(1);
		expect(processTerminates).toBe(1);
		expect(processCloses).toBe(1);
	});

	test("close waits for a late page and closes it before rejecting the lease", async () => {
		let pageCloses = 0;
		let browserCloses = 0;
		let processTerminates = 0;
		const pageStarted = Promise.withResolvers<void>();
		const pageReleased = Promise.withResolvers<Page>();
		const native: NativeOwnedBrowserProcessLike = {
			pipe: {
				nonBlocking: true,
				async *read() {},
				write() {},
				close() {},
			},
			process: {
				async wait() {
					return { exitCode: null, signal: null };
				},
				async terminate() {
					processTerminates++;
				},
				close() {},
			},
		};
		const authority: SecureBrowserRuntimeAuthority = {
			available: true,
			ownerGeneration: "owner-generation",
			async revalidate() {},
			async launch() {
				return native;
			},
			async stageAttachment() {
				throw new Error("unused");
			},
			async uploadAttachments() {
				throw new Error("unused");
			},
			async close() {},
		};
		const context = {
			async newPage() {
				pageStarted.resolve();
				return pageReleased.promise;
			},
		} as unknown as BrowserContext;
		const host = new LocalBrowserHost({
			authority,
			loginHost: {
				async login() {
					throw new Error("unused");
				},
				async close() {},
			},
			connect: async () => ({
				browser: {
					async close() {
						browserCloses++;
					},
				} as unknown as Browser,
				context,
			}),
		});
		const pending = host.lease(
			{
				sessionId: "session",
				turnId: "page-race",
				modelKey: "high",
				mode: "browser-only",
				headed: false,
			},
			{ runtimeEpoch: "epoch", lifecycleGeneration: 1 } as ChatGptWebRuntimeAdmission,
		);
		await pageStarted.promise;
		const closing = host.close();
		expect(await Promise.race([closing.then(() => "closed"), Promise.resolve("pending")])).toBe("pending");
		pageReleased.resolve({
			isClosed: () => pageCloses !== 0,
			async close() {
				pageCloses++;
			},
		} as unknown as Page);
		await expect(pending).rejects.toMatchObject({ errorClass: "browser_unavailable", message: "host_closed" });
		await closing;
		expect(pageCloses).toBe(1);
		expect(browserCloses).toBe(1);
		expect(processTerminates).toBe(1);
	});

	test("local host fails closed without native verification authority", () => {
		expect(
			() =>
				new LocalBrowserHost({
					authority: {
						available: false,
						ownerGeneration: "",
						async revalidate() {},
						async launch() {
							throw new Error("unreachable");
						},
						async stageAttachment() {
							throw new Error("unreachable");
						},
						async uploadAttachments() {
							throw new Error("unreachable");
						},
						async close() {},
					},
					loginHost: {
						async login() {
							throw new Error("unreachable");
						},
						async close() {},
					},
				}),
		).toThrow("native_security_unavailable");
	});
});
