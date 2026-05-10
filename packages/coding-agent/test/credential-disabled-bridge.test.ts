/**
 * Unit tests for the credential-disabled bridge helpers used by createAgentSession.
 *
 * Covers two helpers:
 *
 * - `installStartupBuffer(authStorage)` — captures credential_disabled events that fire
 *   between AuthStorage resolution and the per-session ExtensionRunner being constructed
 *   (model-restore + fallback-model probes inside createAgentSession can soft-disable an
 *   OAuth credential before the runner exists).
 *
 * - `installCredentialDisabledBridge(authStorage, runner, startupBuffer?)` — installs a
 *   bridge that fans events to the runner AND (composed) to whatever embedder handler was
 *   already attached. Tracks a `__disposed` flag so concurrent sibling bridges don't get
 *   re-installed by a later sibling's restore-on-dispose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AuthStorage, type CredentialDisabledEvent } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	discoverAndLoadExtensions,
	installCredentialDisabledBridge,
	installStartupBuffer,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("credential-disabled bridge helpers", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-bridge-helper-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		sessionManager = SessionManager.inMemory();
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	const newRunner = async (): Promise<ExtensionRunner> => {
		// An ExtensionRunner with zero loaded extensions is a valid no-op runner whose
		// emit() is observable via vi.spyOn. Going through discoverAndLoadExtensions so
		// the runtime shape is whatever production expects, not a hand-rolled mock.
		const result = await discoverAndLoadExtensions([], tempDir.path());
		return new ExtensionRunner(result.extensions, result.runtime, tempDir.path(), sessionManager, modelRegistry);
	};

	describe("installStartupBuffer", () => {
		it("buffers credential_disabled events fired through the wrapper", async () => {
			const startup = installStartupBuffer(authStorage);
			const wrapper = authStorage.getCredentialDisabledHandler();
			expect(wrapper).toBeDefined();

			await wrapper?.({ provider: "anthropic", disabledCause: "invalid_grant" });
			await wrapper?.({ provider: "openai", disabledCause: "401 unauthorized" });

			expect(startup.buffer).toHaveLength(2);
			expect(startup.buffer[0]).toEqual({ provider: "anthropic", disabledCause: "invalid_grant" });
			expect(startup.buffer[1]).toEqual({ provider: "openai", disabledCause: "401 unauthorized" });
		});

		it("forwards events to the embedder handler that was attached at install time", async () => {
			const embedderEvents: CredentialDisabledEvent[] = [];
			authStorage.setCredentialDisabledHandler(event => {
				embedderEvents.push(event);
			});

			const startup = installStartupBuffer(authStorage);
			const wrapper = authStorage.getCredentialDisabledHandler();

			await wrapper?.({ provider: "anthropic", disabledCause: "invalid_grant" });

			expect(startup.buffer).toHaveLength(1);
			expect(embedderEvents).toHaveLength(1);
			expect(embedderEvents[0]?.provider).toBe("anthropic");
		});

		it("remove() restores the previous handler", () => {
			const embedderHandler = (_event: CredentialDisabledEvent) => {};
			authStorage.setCredentialDisabledHandler(embedderHandler);

			const startup = installStartupBuffer(authStorage);
			expect(authStorage.getCredentialDisabledHandler()).not.toBe(embedderHandler);

			startup.remove();
			expect(authStorage.getCredentialDisabledHandler()).toBe(embedderHandler);
		});

		it("remove() is a no-op when the wrapper has been overwritten", () => {
			const embedderHandler = (_event: CredentialDisabledEvent) => {};
			authStorage.setCredentialDisabledHandler(embedderHandler);

			const startup = installStartupBuffer(authStorage);

			const laterHandler = (_event: CredentialDisabledEvent) => {};
			authStorage.setCredentialDisabledHandler(laterHandler);

			startup.remove();
			expect(authStorage.getCredentialDisabledHandler()).toBe(laterHandler);
		});

		it("remove() restores undefined when no handler was attached at install", () => {
			expect(authStorage.getCredentialDisabledHandler()).toBeUndefined();

			const startup = installStartupBuffer(authStorage);
			expect(authStorage.getCredentialDisabledHandler()).toBeDefined();

			startup.remove();
			expect(authStorage.getCredentialDisabledHandler()).toBeUndefined();
		});
	});

	describe("installCredentialDisabledBridge", () => {
		it("composes runner.emit with the embedder's pre-existing handler", async () => {
			const embedderEvents: CredentialDisabledEvent[] = [];
			const embedderHandler = (event: CredentialDisabledEvent): void => {
				embedderEvents.push(event);
			};
			authStorage.setCredentialDisabledHandler(embedderHandler);

			const runner = await newRunner();
			const emitSpy = vi.spyOn(runner, "emit");

			installCredentialDisabledBridge(authStorage, runner);

			const bridge = authStorage.getCredentialDisabledHandler();
			expect(bridge).toBeDefined();
			expect(bridge).not.toBe(embedderHandler);

			await bridge?.({ provider: "anthropic", disabledCause: "invalid_grant" });

			expect(emitSpy).toHaveBeenCalledTimes(1);
			expect(emitSpy.mock.calls[0]?.[0]).toEqual({
				type: "credential_disabled",
				provider: "anthropic",
				disabledCause: "invalid_grant",
			});
			expect(embedderEvents).toEqual([{ provider: "anthropic", disabledCause: "invalid_grant" }]);
		});

		it("dispose restores the embedder's handler when the bridge is still installed", async () => {
			const embedderHandler = (_event: CredentialDisabledEvent) => {};
			authStorage.setCredentialDisabledHandler(embedderHandler);

			const release = installCredentialDisabledBridge(authStorage, await newRunner());
			expect(authStorage.getCredentialDisabledHandler()).not.toBe(embedderHandler);

			release();
			expect(authStorage.getCredentialDisabledHandler()).toBe(embedderHandler);
		});

		it("dispose leaves a later session's bridge alone if it overwrote ours", async () => {
			const release = installCredentialDisabledBridge(authStorage, await newRunner());

			const laterHandler = (_event: CredentialDisabledEvent) => {};
			authStorage.setCredentialDisabledHandler(laterHandler);

			release();
			expect(authStorage.getCredentialDisabledHandler()).toBe(laterHandler);
		});

		it("parallel siblings: dispose walks past disposed bridges to find the still-live previous", async () => {
			const embedderHandler = (_event: CredentialDisabledEvent) => {};
			authStorage.setCredentialDisabledHandler(embedderHandler);

			// Parent installs.
			const parentRelease = installCredentialDisabledBridge(authStorage, await newRunner());
			const parentBridge = authStorage.getCredentialDisabledHandler();

			// Sub1 installs (concurrent sibling).
			const sub1Release = installCredentialDisabledBridge(authStorage, await newRunner());

			// Sub2 installs (concurrent sibling).
			const sub2Release = installCredentialDisabledBridge(authStorage, await newRunner());
			const sub2Bridge = authStorage.getCredentialDisabledHandler();

			// Sub1 disposes first; current handler is sub2's, so its restore is a no-op.
			sub1Release();
			expect(authStorage.getCredentialDisabledHandler()).toBe(sub2Bridge);

			// Sub2 disposes; restoring its previous (sub1's bridge) would land on a disposed bridge.
			// The walk-past-disposed logic must skip sub1's bridge and land on parentBridge instead.
			sub2Release();
			expect(authStorage.getCredentialDisabledHandler()).toBe(parentBridge);

			// Parent disposes; walks past nothing (parent's prev is the embedder handler) and restores it.
			parentRelease();
			expect(authStorage.getCredentialDisabledHandler()).toBe(embedderHandler);
		});

		it("disposed bridge does not fan out events when invoked indirectly via an undisposed successor", async () => {
			// Sub1 captures the embedder. Sub2 captures sub1's bridge as its previous.
			// When sub2's bridge is invoked AND sub1 has been disposed, sub1's runner.emit
			// must NOT be called (sub1's runner is dead).
			const embedderEvents: CredentialDisabledEvent[] = [];
			authStorage.setCredentialDisabledHandler(event => {
				embedderEvents.push(event);
			});

			const sub1Runner = await newRunner();
			const sub1EmitSpy = vi.spyOn(sub1Runner, "emit");
			const sub1Release = installCredentialDisabledBridge(authStorage, sub1Runner);

			const sub2Runner = await newRunner();
			const sub2EmitSpy = vi.spyOn(sub2Runner, "emit");
			installCredentialDisabledBridge(authStorage, sub2Runner);
			const sub2Bridge = authStorage.getCredentialDisabledHandler();

			// Sub1 disposes; current handler is sub2's, so dispose is a no-op for the slot.
			sub1Release();
			expect(authStorage.getCredentialDisabledHandler()).toBe(sub2Bridge);

			// Fire an event through sub2. Sub2's runner gets it; sub1's disposed runner does NOT.
			// The chain still walks down to the embedder's handler.
			await sub2Bridge?.({ provider: "anthropic", disabledCause: "invalid_grant" });

			expect(sub2EmitSpy).toHaveBeenCalledTimes(1);
			expect(sub1EmitSpy).not.toHaveBeenCalled();
			expect(embedderEvents).toHaveLength(1);
		});

		it("drains a startup buffer to runner.emit when one is provided", async () => {
			const runner = await newRunner();
			const emitSpy = vi.spyOn(runner, "emit");

			const buffer: CredentialDisabledEvent[] = [
				{ provider: "anthropic", disabledCause: "invalid_grant" },
				{ provider: "openai", disabledCause: "401" },
			];

			installCredentialDisabledBridge(authStorage, runner, buffer);

			// Wait for the (void-awaited) drain microtasks to land.
			await Promise.resolve();
			await Promise.resolve();

			expect(emitSpy).toHaveBeenCalledTimes(2);
			expect(emitSpy.mock.calls[0]?.[0]).toEqual({
				type: "credential_disabled",
				provider: "anthropic",
				disabledCause: "invalid_grant",
			});
			expect(emitSpy.mock.calls[1]?.[0]).toEqual({
				type: "credential_disabled",
				provider: "openai",
				disabledCause: "401",
			});
		});

		it("does not fire the buffered events through the embedder handler again (already received via wrapper)", async () => {
			const embedderEvents: CredentialDisabledEvent[] = [];
			authStorage.setCredentialDisabledHandler(event => {
				embedderEvents.push(event);
			});

			const buffer: CredentialDisabledEvent[] = [{ provider: "anthropic", disabledCause: "invalid_grant" }];
			installCredentialDisabledBridge(authStorage, await newRunner(), buffer);

			await Promise.resolve();
			await Promise.resolve();

			// The embedder handler must NOT have been called again — it already got these events
			// during the startup-buffer wrapper phase.
			expect(embedderEvents).toHaveLength(0);
		});
	});
});
