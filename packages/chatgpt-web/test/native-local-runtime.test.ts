import { describe, expect, test } from "bun:test";
import type { BrowserLoginRequest, BrowserLoginResult, LoginHost } from "../src/browser/login-host";
import type { ChatGptWebRuntimeConfig, SecureConfigHost, SecureStateSession } from "../src/config";
import type { BrowserHost } from "../src/runtime/host";
import {
	createNativeLifecycleControlPeerHost,
	createNativeLocalRuntimeBootstrap,
	type NativeLocalRuntimeUnavailableCode,
	NativeLocalRuntimeUnavailableError,
} from "../src/runtime/native-local-runtime";

const browserOnlyConfig: ChatGptWebRuntimeConfig = Object.freeze({
	mode: "browser-only",
	tunnelId: null,
	runtimeKeyConfigured: false,
});
const fullConfig: ChatGptWebRuntimeConfig = Object.freeze({
	mode: "full",
	tunnelId: `tunnel_${"a".repeat(32)}`,
	runtimeKeyConfigured: true,
});

function fakeSecureHost(): SecureConfigHost {
	return {
		available: true,
		async currentProcessIdentity() {
			return { pid: 42, processStartIdentity: "native-process-start" };
		},
		async openState(): Promise<SecureStateSession> {
			throw new Error("not used by this focused bootstrap test");
		},
	};
}

function fakeLoginHost(): LoginHost {
	return {
		async login(_request: BrowserLoginRequest): Promise<BrowserLoginResult> {
			return {
				authenticated: true,
				verifiedAt: "2026-08-02T00:00:00.000Z",
				proAvailable: false,
				profileIdentity: "native-profile-identity",
				executable: { identity: "native-executable-identity", sha256: "b".repeat(64), version: "1" },
			};
		},
		async close() {},
	};
}

function fakeBrowserHost(): BrowserHost {
	return {
		...fakeLoginHost(),
		async lease(): Promise<never> {
			throw new Error("not used by this focused bootstrap test");
		},
	};
}

async function expectUnavailable(
	promise: Promise<unknown>,
	code: NativeLocalRuntimeUnavailableCode,
	canary?: string,
): Promise<void> {
	let error: unknown;
	try {
		await promise;
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(NativeLocalRuntimeUnavailableError);
	expect((error as NativeLocalRuntimeUnavailableError).code).toBe(code);
	if (canary) {
		expect(String(error)).not.toContain(canary);
		expect(JSON.stringify(error)).not.toContain(canary);
	}
}

describe("native local runtime bootstrap", () => {
	test("does not import native bindings until a native operation is requested", async () => {
		let loads = 0;
		let loginHosts = 0;
		const secureHost = fakeSecureHost();
		const bootstrap = createNativeLocalRuntimeBootstrap({
			async loadNativeModule() {
				loads++;
				return {
					createChatGptWebSecureConfigHost: () => secureHost,
					createChatGptWebLoginHost: () => {
						loginHosts++;
						return fakeLoginHost();
					},
				};
			},
		});

		const lazyLoginHost = bootstrap.createLoginHost();
		expect(loads).toBe(0);
		await lazyLoginHost.close();
		expect(loads).toBe(0);
		expect(await bootstrap.secureHost.currentProcessIdentity()).toEqual({
			pid: 42,
			processStartIdentity: "native-process-start",
		});
		expect(loads).toBe(1);
		expect(loginHosts).toBe(0);
		await lazyLoginHost.login({} as BrowserLoginRequest);
		expect(loads).toBe(1);
		expect(loginHosts).toBe(1);
	});

	test("constructs an explicit browser-only gate and host", async () => {
		const secureHost = fakeSecureHost();
		const browserHost = fakeBrowserHost();
		const privatePathCanary = "C:\\private\\native-browser-profile-CANARY";
		(browserHost as BrowserHost & { privatePath: string }).privatePath = privatePathCanary;
		let browserFactories = 0;
		const bootstrap = createNativeLocalRuntimeBootstrap({
			async loadNativeModule() {
				return {
					createChatGptWebSecureConfigHost: () => secureHost,
					createChatGptWebBrowserHost: (_host: SecureConfigHost, config: ChatGptWebRuntimeConfig) => {
						expect(config).toBe(browserOnlyConfig);
						browserFactories++;
						return browserHost;
					},
				};
			},
			readConfig: async () => browserOnlyConfig,
			readLoginStatus: async () => ({ authenticated: true }),
		});

		const runtime = await bootstrap.resolveRuntime();
		expect(runtime.config).toBe(browserOnlyConfig);
		expect(runtime.host).not.toBe(browserHost);
		expect(JSON.stringify(runtime)).not.toContain(privatePathCanary);
		expect(browserFactories).toBe(1);
		const admission = await runtime.gate.admit("turn");
		expect(admission.runtimeEpoch.startsWith("epoch_")).toBe(true);
		expect(admission.lifecycleGeneration).toBe(1);
		runtime.gate.release(admission);
	});

	test("shares one process-owned browser host and gate until explicit close", async () => {
		const secureHost = fakeSecureHost();
		let browserFactories = 0;
		let browserCloses = 0;
		const bootstrap = createNativeLocalRuntimeBootstrap({
			async loadNativeModule() {
				return {
					createChatGptWebSecureConfigHost: () => secureHost,
					createChatGptWebBrowserHost: () => {
						browserFactories++;
						return {
							...fakeBrowserHost(),
							async close() {
								browserCloses++;
							},
						};
					},
				};
			},
			readConfig: async () => browserOnlyConfig,
			readLoginStatus: async () => ({ authenticated: true }),
		});
		const [first, second] = await Promise.all([bootstrap.resolveRuntime(), bootstrap.resolveRuntime()]);
		expect(first).toBe(second);
		expect(browserFactories).toBe(1);
		await bootstrap.closeRuntime();
		expect(browserCloses).toBe(1);
		const third = await bootstrap.resolveRuntime();
		expect(third).not.toBe(first);
		expect(browserFactories).toBe(2);
		await bootstrap.closeRuntime();
		expect(browserCloses).toBe(2);
	});

	test("passes the exact injected native module to full epoch construction without loading another copy", async () => {
		const secureHost = fakeSecureHost();
		const runtimeRoot = {
			identity: "runtime-root",
			read: () => new Uint8Array(),
			consume() {},
			cleanup() {},
			close() {},
		};
		const runtimeKey = {
			identity: "runtime-key",
			consume() {},
			cleanup() {},
			close() {},
		};
		const ownerIdentity = Object.freeze({
			pid: 42,
			processStartIdentity: "native-process-start",
			executableIdentity: "native-executable",
		});
		const nativeModule = {
			createChatGptWebSecureConfigHost: () => secureHost,
			openPrivateDirectory: () => runtimeRoot,
			openOwnedChild: () => runtimeKey,
			copyOwnedFilePrivate() {
				throw new Error("not spawning in this test");
			},
			currentProcessIdentity: () => ownerIdentity,
			matchesProcessIdentity: (expected: object, actual: object) => expected === actual,
			verifyPeerDescendant: () => false,
		};
		let observedNativeModule: unknown;
		const bootstrap = createNativeLocalRuntimeBootstrap({
			nativeModule,
			async loadNativeModule() {
				throw new Error("dynamic native loader must not run");
			},
			readConfig: async () => fullConfig,
			readLoginStatus: async () => ({ authenticated: true }),
			createFullEpochFactory(options) {
				observedNativeModule = options.nativeModule;
				throw new Error("stop before tunnel installation");
			},
		});

		await expectUnavailable(bootstrap.resolveRuntime(), "full-runtime-epoch-capability-unavailable");
		expect(observedNativeModule).toBe(nativeModule);
	});

	test("fails full mode before constructing any browser or partial tunnel runtime", async () => {
		let nativeLoads = 0;
		const bootstrap = createNativeLocalRuntimeBootstrap({
			async loadNativeModule() {
				nativeLoads++;
				return {};
			},
			readConfig: async () => fullConfig,
			readLoginStatus: async () => ({ authenticated: true }),
		});

		await expectUnavailable(bootstrap.resolveRuntime(), "native-secure-state-capability-unavailable");
		expect(nativeLoads).toBe(1);
	});

	test("reports stable capability errors without leaking native paths or tokens", async () => {
		const canary = "C:\\private\\profile-token-CANARY";
		const missingCapability = createNativeLocalRuntimeBootstrap({
			loadNativeModule: async () => ({ NativeOwnedFile: class {} }),
		});
		await expectUnavailable(
			missingCapability.secureHost.currentProcessIdentity(),
			"native-secure-state-capability-unavailable",
			canary,
		);

		const loadFailure = createNativeLocalRuntimeBootstrap({
			loadNativeModule: async () => {
				throw new Error(canary);
			},
		});
		await expectUnavailable(loadFailure.secureHost.currentProcessIdentity(), "native-addon-unavailable", canary);

		const browserFailure = createNativeLocalRuntimeBootstrap({
			loadNativeModule: async () => ({
				createChatGptWebSecureConfigHost: fakeSecureHost,
				createChatGptWebBrowserHost: () => {
					throw new Error(canary);
				},
			}),
			readConfig: async () => browserOnlyConfig,
			readLoginStatus: async () => ({ authenticated: true }),
		});
		await expectUnavailable(browserFailure.resolveRuntime(), "native-browser-capability-unavailable", canary);
	});
});

describe("native lifecycle control peer verification", () => {
	interface FakeIdentity {
		readonly pid: number;
		readonly processStartIdentity: string;
		readonly executableIdentity: string;
		readonly parent?: FakeIdentity;
	}

	const createFixture = () => {
		const owner: FakeIdentity = Object.freeze({
			pid: 42,
			processStartIdentity: "owner-start",
			executableIdentity: "owner-executable",
		});
		const child: FakeIdentity = Object.freeze({
			pid: 84,
			processStartIdentity: "child-start",
			executableIdentity: "child-executable",
			parent: owner,
		});
		const nativeModule = {
			currentProcessIdentity: () => owner,
			matchesProcessIdentity(expected: FakeIdentity, actual: FakeIdentity) {
				return (
					expected.pid === actual.pid &&
					expected.processStartIdentity === actual.processStartIdentity &&
					expected.executableIdentity === actual.executableIdentity
				);
			},
			verifyPeerDescendant(peer: FakeIdentity, ancestor: FakeIdentity) {
				return peer.parent === ancestor;
			},
		};
		return { child, nativeModule, owner };
	};

	test("accepts a live complete native peer descended from the runtime owner", async () => {
		const { child, nativeModule } = createFixture();
		const host = createNativeLifecycleControlPeerHost(nativeModule);
		const peer = { peer: child, currentPeer: () => child };

		await expect(host.verifyControlPeer(peer as never, "connection-nonce-1")).resolves.toBeUndefined();
		await expect(host.verifyControlPeer(peer as never, "connection-nonce-1")).resolves.toBeUndefined();
	});

	test("rejects replacement of the captured native peer identity", async () => {
		const { child, nativeModule, owner } = createFixture();
		const replacement = Object.freeze({
			...child,
			processStartIdentity: "replacement-start",
			parent: owner,
		});
		const host = createNativeLifecycleControlPeerHost(nativeModule);
		const peer = { peer: child, currentPeer: () => replacement };

		await expect(host.verifyControlPeer(peer as never, "connection-nonce-1")).rejects.toThrow(
			"Lifecycle control peer verification failed",
		);
	});

	test("rejects a live peer that is not a descendant of the runtime owner", async () => {
		const { child, nativeModule } = createFixture();
		const unrelatedParent: FakeIdentity = Object.freeze({
			pid: 21,
			processStartIdentity: "unrelated-start",
			executableIdentity: "unrelated-executable",
		});
		const nonDescendant = Object.freeze({ ...child, parent: unrelatedParent });
		const host = createNativeLifecycleControlPeerHost(nativeModule);
		const peer = { peer: nonDescendant, currentPeer: () => nonDescendant };

		await expect(host.verifyControlPeer(peer as never, "connection-nonce-1")).rejects.toThrow(
			"Lifecycle control peer verification failed",
		);
	});

	test("rejects malformed opaque peer connections and incomplete identities", async () => {
		const { child, nativeModule } = createFixture();
		const host = createNativeLifecycleControlPeerHost(nativeModule);
		const malformedPeers = [
			null,
			{ peer: child },
			{
				peer: { pid: child.pid, processStartIdentity: child.processStartIdentity },
				currentPeer: () => child,
			},
		];

		for (const peer of malformedPeers) {
			await expect(host.verifyControlPeer(peer as never, "connection-nonce-1")).rejects.toThrow(
				"Lifecycle control peer verification failed",
			);
		}
	});

	test("rejects nonce changes and reuse across native connections", async () => {
		const { child, nativeModule } = createFixture();
		const host = createNativeLifecycleControlPeerHost(nativeModule);
		const firstPeer = { peer: child, currentPeer: () => child };
		const secondPeer = { peer: child, currentPeer: () => child };

		await host.verifyControlPeer(firstPeer as never, "connection-nonce-1");
		await expect(host.verifyControlPeer(firstPeer as never, "connection-nonce-2")).rejects.toThrow(
			"Lifecycle control peer verification failed",
		);
		await expect(host.verifyControlPeer(secondPeer as never, "connection-nonce-1")).rejects.toThrow(
			"Lifecycle control peer verification failed",
		);
	});
});
