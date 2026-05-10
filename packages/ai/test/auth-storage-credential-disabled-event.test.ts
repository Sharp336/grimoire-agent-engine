import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthCredentialStore, AuthStorage, type CredentialDisabledEvent } from "../src/auth-storage";
import * as oauthUtils from "../src/utils/oauth";

describe("AuthStorage onCredentialDisabled callback", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	let events: CredentialDisabledEvent[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-credential-disabled-event-"));
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		events = [];
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: event => {
				events.push(event);
			},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("fires when an OAuth credential is disabled by a definitive refresh failure", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error(
				'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
			);
		});

		const apiKey = await authStorage.getApiKey("anthropic", "session-disabled-event");

		expect(apiKey).toBeUndefined();
		expect(events).toHaveLength(1);
		expect(events[0]?.provider).toBe("anthropic");
		expect(events[0]?.disabledCause).toContain("invalid_grant");
	});

	test("does not fire for transient (non-definitive) refresh failures", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("fetch failed: ECONNRESET");
		});

		await authStorage.getApiKey("anthropic", "session-transient-failure");

		expect(events).toHaveLength(0);
	});

	test("swallows handler exceptions so disable still completes", async () => {
		if (!authStorage) throw new Error("test setup failed");

		store?.close();
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: () => {
				throw new Error("subscriber exploded");
			},
		});

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("invalid_grant");
		});

		await expect(authStorage.getApiKey("anthropic", "session-handler-throws")).resolves.toBeUndefined();
		expect(authStorage.list()).not.toContain("anthropic");
	});

	test("swallows async handler rejections so the disable path still completes", async () => {
		if (!authStorage) throw new Error("test setup failed");

		store?.close();
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));

		const settled = Promise.withResolvers<void>();
		authStorage = new AuthStorage(store, {
			onCredentialDisabled: async () => {
				// Yield once so the rejection lands on the microtask queue, not synchronously.
				await Promise.resolve();
				settled.resolve();
				throw new Error("async subscriber exploded");
			},
		});

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("invalid_grant");
		});

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(authStorage.getApiKey("anthropic", "session-async-handler-throws")).resolves.toBeUndefined();
			// Wait for the handler's microtask + our internal .catch to run.
			await settled.promise;
			await Bun.sleep(0);
			expect(authStorage.list()).not.toContain("anthropic");
			expect(unhandled).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("setCredentialDisabledHandler replaces the constructor handler at runtime", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const lateEvents: CredentialDisabledEvent[] = [];
		authStorage.setCredentialDisabledHandler(event => {
			lateEvents.push(event);
		});

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
		});

		await authStorage.getApiKey("anthropic", "session-late-handler");

		// The constructor handler from beforeEach() must NOT have been called.
		expect(events).toHaveLength(0);
		expect(lateEvents).toHaveLength(1);
		expect(lateEvents[0]?.provider).toBe("anthropic");
		expect(lateEvents[0]?.disabledCause).toContain("invalid_grant");
	});

	test("setCredentialDisabledHandler(undefined) detaches the current handler", async () => {
		if (!authStorage) throw new Error("test setup failed");

		authStorage.setCredentialDisabledHandler(undefined);

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("invalid_grant");
		});

		await expect(authStorage.getApiKey("anthropic", "session-detached-handler")).resolves.toBeUndefined();
		// The credential is still disabled — the handler is just disconnected.
		expect(authStorage.list()).not.toContain("anthropic");
		expect(events).toHaveLength(0);
	});

	test("buffers credential_disabled events fired before any handler is attached, and replays them on attach", async () => {
		// Replace the constructor-attached AuthStorage with one that has NO handler at construction time.
		store?.close();
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const noHandlerStorage = new AuthStorage(store);

		await noHandlerStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant"}');
		});

		// Triggers a soft-disable while no handler is attached. Today this drops the event.
		// Tomorrow we want it buffered.
		await noHandlerStorage.getApiKey("anthropic", "session-pre-handler");

		// No handler ran yet (none was attached).
		const replayed: CredentialDisabledEvent[] = [];
		noHandlerStorage.setCredentialDisabledHandler(event => {
			replayed.push(event);
		});

		// Wait one microtask: the drain may schedule async handler invocation.
		await Promise.resolve();

		expect(replayed).toHaveLength(1);
		expect(replayed[0]?.provider).toBe("anthropic");
		expect(replayed[0]?.disabledCause).toContain("invalid_grant");
	});

	test("drains the buffer once: a second handler attached later does not re-receive past events", async () => {
		store?.close();
		store = await AuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const noHandlerStorage = new AuthStorage(store);

		await noHandlerStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("invalid_grant");
		});

		await noHandlerStorage.getApiKey("anthropic", "session-pre-first-handler");

		const firstHandlerEvents: CredentialDisabledEvent[] = [];
		noHandlerStorage.setCredentialDisabledHandler(event => {
			firstHandlerEvents.push(event);
		});
		await Promise.resolve();
		expect(firstHandlerEvents).toHaveLength(1);

		const secondHandlerEvents: CredentialDisabledEvent[] = [];
		noHandlerStorage.setCredentialDisabledHandler(event => {
			secondHandlerEvents.push(event);
		});
		await Promise.resolve();

		// The buffer was drained by the first handler; the second handler must not receive past events.
		expect(secondHandlerEvents).toHaveLength(0);
	});

	test("buffers events fired during a detach gap, replaying them on the next attach", async () => {
		// Constructor handler is set (from beforeEach). Detach, fire a disable, attach a new handler.
		if (!authStorage) throw new Error("test setup failed");

		authStorage.setCredentialDisabledHandler(undefined);

		await authStorage.set("anthropic", [
			{
				type: "oauth",
				access: "expired-access",
				refresh: "stale-refresh",
				expires: Date.now() - 60_000,
			},
		]);

		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async () => {
			throw new Error("invalid_grant");
		});

		await authStorage.getApiKey("anthropic", "session-detach-gap");

		// Constructor handler must not have fired (it was detached).
		expect(events).toHaveLength(0);

		const reattached: CredentialDisabledEvent[] = [];
		authStorage.setCredentialDisabledHandler(event => {
			reattached.push(event);
		});
		await Promise.resolve();

		expect(reattached).toHaveLength(1);
		expect(reattached[0]?.provider).toBe("anthropic");
	});
});
