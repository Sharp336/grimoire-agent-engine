import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { NativeVerifiedExecutable } from "../src/mcp/runtime-command";
import {
	type ChatGptWebRuntimeEpoch,
	ChatGptWebRuntimeLifecycle,
	createChatGptWebRuntimeEpochFactory,
	type InstalledTunnelArtifact,
	type LifecycleControlAction,
	type LifecycleControlRequest,
	type NativeLaunchEnvironment,
	type NativeOwnedFile,
	type NativeOwnedProcess,
	type NativePeerConnection,
	type NativeVerifiedTunnelExecutable,
	type OmpBrokerEndpoint,
	type OmpConnectorBootstrap,
	type OmpTunnelBootstrap,
	type OmpTunnelProcessIdentity,
	type OmpTurnBrokerLifecycleHost,
	TUNNEL_ARTIFACTS,
} from "../src/mcp/tunnel";
import type { ChatGptWebRuntimeAdmission, ChatGptWebRuntimeGate } from "../src/provider/types";

const CONTROL_TOKEN = "control-token-that-is-at-least-thirty-two-bytes-long";
const CONNECTION_NONCE = "connection-nonce-0001";

function admission(label: string): ChatGptWebRuntimeAdmission {
	return {
		runtimeEpoch: label,
		lifecycleGeneration: 1,
		__opaque: Symbol(label),
	} as unknown as ChatGptWebRuntimeAdmission;
}

function gate(events: string[], label: string): ChatGptWebRuntimeGate {
	const active = new Set<object>();
	const drainWaiters = new Set<() => void>();
	return {
		async admit() {
			events.push(`${label}:gate-admit`);
			const handle = admission(label);
			active.add(handle);
			return handle;
		},
		retain() {
			throw new Error("retain is not used by this lifecycle fixture");
		},
		release(handle) {
			events.push(`${label}:gate-release`);
			active.delete(handle);
			if (active.size === 0) {
				for (const resolve of drainWaiters) resolve();
				drainWaiters.clear();
			}
		},
		async drain() {
			events.push(`${label}:gate-drain`);
			if (active.size > 0) await new Promise<void>(resolve => drainWaiters.add(resolve));
		},
		async resume() {
			throw new Error("epochs are recreated instead of resuming this gate");
		},
	};
}

function executable(onClose: () => void = () => {}): NativeVerifiedExecutable {
	return {
		identity: "verified-package-cli",
		packageName: "@oh-my-pi/pi-chatgpt-web",
		packageVersion: "17.2.4",
		cliName: "chatgpt-web",
		close: onClose,
		__nativeVerifiedExecutable: Symbol("package-cli"),
	};
}

function tunnelExecutable(): NativeVerifiedTunnelExecutable {
	return {
		identity: "verified-tunnel-client",
		close() {},
		__nativeVerifiedTunnelExecutable: Symbol("tunnel-client"),
	};
}

function installedArtifact(): InstalledTunnelArtifact {
	return {
		tuple: "win32-x64",
		archiveSha256: TUNNEL_ARTIFACTS["win32-x64"].sha256,
		binarySha256: "b".repeat(64),
		binaryVersion: "0.0.10",
		fileIdentity: "held-installed-tunnel",
		executable: tunnelExecutable(),
		__installedTunnelArtifact: Symbol("installed"),
	};
}

interface FixtureOptions {
	readonly mode?: "browser-only" | "full";
	readonly assertArtifact?: () => Promise<void>;
	readonly authorize?: () => Promise<void>;
	readonly spawn?: () => Promise<void>;
	readonly ready?: () => Promise<void>;
	readonly terminate?: () => Promise<void>;
	readonly assertInactive?: () => Promise<void>;
	readonly abortTunnelSpawn?: () => Promise<void>;
	readonly restartLimit?: number;
}

function createFixture(options: FixtureOptions = {}) {
	const mode = options.mode ?? "full";
	const events: string[] = [];
	const bootstraps: string[] = [];
	const runtimeKeys: string[] = [];
	const epochs: ChatGptWebRuntimeEpoch[] = [];
	let epochNumber = 0;
	let processNumber = 0;
	let peerAllowed = true;
	const endpoint = { kind: "owner-local", __opaque: Symbol("endpoint") } as unknown as OmpBrokerEndpoint;

	const epochFactory = {
		async create(requestedMode: "browser-only" | "full"): Promise<ChatGptWebRuntimeEpoch> {
			epochNumber += 1;
			const label = `epoch-${epochNumber}`;
			const runtimeGate = gate(events, label);
			events.push(`${label}:create:${requestedMode}`);
			if (requestedMode === "browser-only") {
				const epoch = {
					runtimeEpoch: label,
					lifecycleGeneration: epochNumber,
					gate: runtimeGate,
					async cancelBrowserTurns() {
						events.push(`${label}:cancel-browser`);
					},
				};
				epochs.push(epoch);
				return epoch;
			}
			let spawnNumber = 0;
			const broker: OmpTurnBrokerLifecycleHost = {
				gate: runtimeGate,
				async listen() {
					events.push(`${label}:listen`);
					return { endpoint, runtimeEpoch: label, lifecycleGeneration: epochNumber };
				},
				async prepareTunnelSpawn() {
					spawnNumber += 1;
					const bootstrapLabel = `${label}:bootstrap-${spawnNumber}`;
					bootstraps.push(bootstrapLabel);
					events.push(`${bootstrapLabel}:prepare`);
					return {
						connectorBootstrap: { __opaque: Symbol(bootstrapLabel) } as unknown as OmpConnectorBootstrap,
						tunnelBootstrap: {
							kind: "private-owned-bootstrap-file",
							__opaque: Symbol(bootstrapLabel),
						} as unknown as OmpTunnelBootstrap,
						tunnelAdmission: await runtimeGate.admit("tunnel"),
						instanceNonce: `${bootstrapLabel}:instance`,
					};
				},
				async abortTunnelSpawn(_bootstrap, tunnelAdmission) {
					events.push(`${label}:abort-tunnel-spawn`);
					await options.abortTunnelSpawn?.();
					runtimeGate.release(tunnelAdmission);
				},
				async authorizeTunnel() {
					events.push(`${label}:authorize`);
					await options.authorize?.();
				},
				async waitForTunnelReady() {
					events.push(`${label}:broker-ready`);
				},
				async drain() {
					events.push(`${label}:broker-drain`);
				},
				async close() {
					events.push(`${label}:broker-close`);
				},
			};
			const runtimeKey = {
				async duplicateForSpawn(runtimeEpoch: string, generation: number): Promise<NativeOwnedFile> {
					const keyLabel = `${runtimeEpoch}:key-${spawnNumber}:${generation}`;
					runtimeKeys.push(keyLabel);
					events.push(`${keyLabel}:duplicate`);
					return {
						identity: keyLabel,
						async consume() {
							events.push(`${keyLabel}:consume`);
						},
						async cleanup() {
							events.push(`${keyLabel}:cleanup`);
						},
						async close() {
							events.push(`${keyLabel}:close`);
						},
					};
				},
				async close() {
					events.push(`${label}:key-source-close`);
				},
			};
			const epoch = {
				runtimeEpoch: label,
				lifecycleGeneration: epochNumber,
				gate: runtimeGate,
				broker,
				runtimeKey,
				async cancelBrowserTurns() {
					events.push(`${label}:cancel-browser`);
				},
			};
			epochs.push(epoch);
			return epoch;
		},
	};

	const artifact = installedArtifact();
	const full =
		mode === "full"
			? {
					artifact,
					installHost: {
						async beginInstall() {
							throw new Error("install is not part of lifecycle startup");
						},
						async assertLaunchIdentity() {
							events.push("artifact:assert");
							await options.assertArtifact?.();
						},
					},
					connectionProfile: { __tunnelConnectionProfile: Symbol("connection") },
					processHost: {
						supportsOwnedTreeAsync: true as const,
						async spawn(request: {
							command: { argv: readonly string[] };
							signal: AbortSignal;
						}): Promise<NativeOwnedProcess> {
							processNumber += 1;
							const processLabel = `process-${processNumber}`;
							events.push(`${processLabel}:spawn:${request.command.argv.join(" ")}`);
							if (request.signal.aborted) throw new Error("spawn received cancelled attempt");
							await options.spawn?.();
							const identity = {
								pid: processNumber,
								processStartIdentity: `${processLabel}:start`,
								executableIdentity: `${processLabel}:executable`,
								__opaque: Symbol(processLabel),
							} as unknown as OmpTunnelProcessIdentity;
							return {
								identity,
								async waitReady(signal) {
									events.push(`${processLabel}:ready`);
									if (signal.aborted) throw new Error("ready cancelled");
									await options.ready?.();
								},
								async terminateOwnedTree() {
									events.push(`${processLabel}:terminate-owned-tree`);
									await options.terminate?.();
								},
								async assertInactive() {
									events.push(`${processLabel}:inactive`);
									await options.assertInactive?.();
								},
							};
						},
					},
					environmentHost: {
						async createLaunchEnvironment(request: {
							runtimeKey: NativeOwnedFile;
							inheritedEnvironment: Readonly<Record<string, never>>;
						}) {
							expect(request.inheritedEnvironment).toEqual({});
							expect(request.runtimeKey.identity).toStartWith("epoch-");
							events.push("environment:create");
							return {
								environment: {} as NativeLaunchEnvironment,
								close: () => events.push("environment:close"),
							};
						},
					},
					runtimeCommandHost: {
						async openVerifiedPackageCli() {
							events.push("command:verify");
							return executable(() => events.push("command:close"));
						},
					},
					bundleRoot: path.resolve(import.meta.dir, "verified bundle"),
					restartLimit: options.restartLimit,
				}
			: undefined;
	const peer = { __nativePeerConnection: Symbol("owner-peer") } as NativePeerConnection;
	const otherPeer = { __nativePeerConnection: Symbol("other-peer") } as NativePeerConnection;
	const runtime = new ChatGptWebRuntimeLifecycle({
		mode,
		controlToken: CONTROL_TOKEN,
		peerHost: {
			async verifyControlPeer(candidate, nonce) {
				events.push("control:peer-verify");
				if (!peerAllowed || candidate !== peer || nonce !== CONNECTION_NONCE)
					throw new Error("native peer proof rejected");
			},
		},
		epochFactory,
		full,
	});

	return {
		runtime,
		events,
		bootstraps,
		runtimeKeys,
		epochs,
		peer,
		otherPeer,
		setPeerAllowed(value: boolean) {
			peerAllowed = value;
		},
	};
}

function control(
	runtime: ChatGptWebRuntimeLifecycle,
	action: LifecycleControlAction,
	sequence: number,
	overrides: Partial<LifecycleControlRequest> = {},
): LifecycleControlRequest {
	const health = runtime.health();
	return {
		action,
		controlToken: CONTROL_TOKEN,
		connectionNonce: CONNECTION_NONCE,
		sequence,
		runtimeEpoch: health.runtimeEpoch,
		lifecycleGeneration: health.lifecycleGeneration,
		...overrides,
	};
}

test("full mode rejects missing opaque tunnel credentials before creating an epoch", () => {
	expect(
		() =>
			new ChatGptWebRuntimeLifecycle({
				mode: "full",
				controlToken: CONTROL_TOKEN,
				peerHost: { async verifyControlPeer() {} },
				epochFactory: {
					async create() {
						throw new Error("must not create");
					},
				},
				full: {} as never,
			}),
	).toThrow("requires verified tunnel dependencies and credentials");
});

test("mode-aware epoch wiring constructs native broker authority only for full mode", async () => {
	let browserCreates = 0;
	const browserFactory = createChatGptWebRuntimeEpochFactory({
		mode: "browser-only",
		async createBrowserEpoch() {
			browserCreates += 1;
			return {
				runtimeEpoch: "browser-epoch",
				lifecycleGeneration: 1,
				gate: gate([], "browser"),
				async cancelBrowserTurns() {},
			};
		},
	});
	expect((await browserFactory.create("browser-only")).broker).toBeUndefined();
	await expect(browserFactory.create("full")).rejects.toThrow("cannot change");
	expect(browserCreates).toBe(1);

	const unavailableFullFactory = createChatGptWebRuntimeEpochFactory({
		mode: "full",
		runtimeKeySourceFactory() {
			throw new Error("must not open runtime key");
		},
		environmentHostFactory() {
			throw new Error("must not create environment host");
		},
		async waitForTunnelReady() {},
		async cancelBrowserTurns() {},
	});
	await expect(unavailableFullFactory.create("full")).rejects.toThrow("authority is unavailable");
});

describe("broker-first full runtime", () => {
	test("binds the broker before spawn and uses fresh handle-bound bootstraps on restart", async () => {
		const fixture = createFixture();
		const started = await fixture.runtime.start();
		expect(started).toMatchObject({ mode: "full", state: "running", tunnelReady: true, runtimeEpoch: "epoch-1" });
		const listenIndex = fixture.events.indexOf("epoch-1:listen");
		const spawnIndex = fixture.events.findIndex(event => event.startsWith("process-1:spawn"));
		expect(listenIndex).toBeGreaterThanOrEqual(0);
		expect(spawnIndex).toBeGreaterThan(listenIndex);
		expect(fixture.events[spawnIndex]).toBe("process-1:spawn:mcp --broker-handoff");
		expect(fixture.events.indexOf("epoch-1:key-1:1:consume")).toBeGreaterThan(
			fixture.events.indexOf("epoch-1:broker-ready"),
		);
		expect(fixture.events.indexOf("epoch-1:authorize")).toBeGreaterThan(spawnIndex);
		expect(fixture.bootstraps).toEqual(["epoch-1:bootstrap-1"]);
		expect(fixture.runtimeKeys).toEqual(["epoch-1:key-1:1"]);

		const restarted = await fixture.runtime.dispatchControl(control(fixture.runtime, "restart", 1), fixture.peer);
		expect(restarted).toMatchObject({ state: "running", runtimeEpoch: "epoch-1", tunnelReady: true });
		expect(fixture.bootstraps).toEqual(["epoch-1:bootstrap-1", "epoch-1:bootstrap-2"]);
		expect(fixture.runtimeKeys).toEqual(["epoch-1:key-1:1", "epoch-1:key-2:1"]);
		expect(fixture.events.filter(event => event === "epoch-1:listen")).toHaveLength(1);
		expect(fixture.events).toContain("process-1:terminate-owned-tree");
	});

	test("revalidates the installed executable immediately before spawn and fails closed on a path race", async () => {
		const fixture = createFixture({
			assertArtifact: async () => {
				throw new Error("reparse identity changed");
			},
		});
		await expect(fixture.runtime.start()).rejects.toThrow("reparse identity changed");
		expect(fixture.events.some(event => event.includes(":spawn:"))).toBe(false);
		expect(fixture.events).toContain("epoch-1:gate-drain");
		expect(fixture.events).toContain("epoch-1:broker-close");
	});

	test("aborts the broker-owned spawn once when native process creation fails", async () => {
		const fixture = createFixture({
			async spawn() {
				throw new Error("native spawn failed");
			},
		});

		await expect(fixture.runtime.start()).rejects.toThrow("native spawn failed");
		expect(fixture.events.filter(event => event === "epoch-1:abort-tunnel-spawn")).toHaveLength(1);
		expect(fixture.events.filter(event => event === "epoch-1:gate-release")).toHaveLength(1);
		expect(fixture.events).not.toContain("process-1:terminate-owned-tree");
		expect(fixture.events).toContain("epoch-1:broker-drain");
		expect(fixture.events).toContain("epoch-1:broker-close");
	});

	test("retires an authorized spawn after readiness fails and drains without a second gate release", async () => {
		const fixture = createFixture({
			async ready() {
				throw new Error("tunnel readiness failed");
			},
		});

		await expect(fixture.runtime.start()).rejects.toThrow("tunnel readiness failed");
		expect(fixture.events).toContain("epoch-1:authorize");
		const terminateIndex = fixture.events.indexOf("process-1:terminate-owned-tree");
		const abortIndex = fixture.events.indexOf("epoch-1:abort-tunnel-spawn");
		expect(terminateIndex).toBeGreaterThanOrEqual(0);
		expect(abortIndex).toBeGreaterThan(terminateIndex);
		expect(fixture.events.filter(event => event === "epoch-1:abort-tunnel-spawn")).toHaveLength(1);
		expect(fixture.events.filter(event => event === "epoch-1:gate-release")).toHaveLength(1);
		expect(fixture.events).toContain("epoch-1:broker-drain");
		expect(fixture.events).toContain("epoch-1:broker-close");
	});

	test("rejects an authorize-in-flight start when drain wins and admits no child afterward", async () => {
		let releaseAuthorization!: () => void;
		const authorization = new Promise<void>(resolve => {
			releaseAuthorization = resolve;
		});
		const fixture = createFixture({ authorize: () => authorization });
		const starting = fixture.runtime.start();
		while (!fixture.events.includes("epoch-1:authorize")) await Promise.resolve();
		const draining = fixture.runtime.dispatchControl(control(fixture.runtime, "drain", 1), fixture.peer);
		releaseAuthorization();
		await expect(starting).rejects.toThrow("cancelled");
		expect(await draining).toMatchObject({ state: "drained", tunnelReady: false });
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(1);
		expect(fixture.events).toContain("process-1:terminate-owned-tree");
	});

	test("keeps a failed startup process and epoch tracked until cleanup can be retried", async () => {
		let authorizeAttempts = 0;
		let terminationAllowed = false;
		const fixture = createFixture({
			async authorize() {
				authorizeAttempts += 1;
				if (authorizeAttempts === 1) throw new Error("authorization failed");
			},
			async terminate() {
				if (!terminationAllowed) throw new Error("owned process still active");
			},
		});

		await expect(fixture.runtime.start()).rejects.toThrow("Runtime startup and cleanup failed");
		expect(fixture.runtime.health()).toMatchObject({
			state: "drained",
			runtimeEpoch: "epoch-1",
			tunnelReady: false,
		});
		expect(fixture.events).not.toContain("epoch-1:gate-release");
		expect(fixture.events).toContain("epoch-1:broker-drain");
		expect(fixture.events).toContain("epoch-1:broker-close");
		expect(fixture.events).toContain("epoch-1:key-source-close");
		expect(fixture.events).toContain("command:close");

		terminationAllowed = true;
		const drained = await fixture.runtime.dispatchControl(control(fixture.runtime, "drain", 1), fixture.peer);
		expect(drained).toMatchObject({ state: "drained", runtimeEpoch: "epoch-1", tunnelReady: false });
		const resumed = await fixture.runtime.dispatchControl(control(fixture.runtime, "resume", 2), fixture.peer);
		expect(resumed).toMatchObject({ state: "running", runtimeEpoch: "epoch-2", tunnelReady: true });
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(2);
	});

	test("drains broker authority while retaining a live process, then permits retry", async () => {
		let terminationAllowed = false;
		const fixture = createFixture({
			async terminate() {
				if (!terminationAllowed) throw new Error("owned process still active");
			},
		});
		await fixture.runtime.start();
		await expect(fixture.runtime.dispatchControl(control(fixture.runtime, "drain", 1), fixture.peer)).rejects.toThrow(
			"Runtime drain failed",
		);
		expect(fixture.runtime.health()).toMatchObject({
			state: "drained",
			runtimeEpoch: "epoch-1",
			tunnelReady: false,
		});
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(1);
		expect(fixture.events).not.toContain("epoch-1:gate-release");
		expect(fixture.events).toContain("epoch-1:broker-drain");
		expect(fixture.events).toContain("epoch-1:broker-close");
		expect(fixture.events).toContain("epoch-1:key-source-close");
		expect(fixture.events).toContain("command:close");

		terminationAllowed = true;
		const drained = await fixture.runtime.dispatchControl(control(fixture.runtime, "drain", 2), fixture.peer);
		expect(drained).toMatchObject({ state: "drained", runtimeEpoch: "epoch-1", tunnelReady: false });
		const resumed = await fixture.runtime.dispatchControl(control(fixture.runtime, "resume", 3), fixture.peer);
		expect(resumed).toMatchObject({ state: "running", runtimeEpoch: "epoch-2", tunnelReady: true });
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(2);
	});

	test("rejects restart after inactive assertion failure and spawns only after a cleanup retry", async () => {
		let inactiveAllowed = false;
		const fixture = createFixture({
			async assertInactive() {
				if (!inactiveAllowed) throw new Error("owned process remains active");
			},
		});
		await fixture.runtime.start();

		await expect(
			fixture.runtime.dispatchControl(control(fixture.runtime, "restart", 1), fixture.peer),
		).rejects.toThrow("Tunnel shutdown failed");
		expect(fixture.runtime.health()).toMatchObject({
			state: "running",
			runtimeEpoch: "epoch-1",
			tunnelReady: true,
		});
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(1);
		expect(fixture.events).not.toContain("epoch-1:gate-release");

		inactiveAllowed = true;
		const restarted = await fixture.runtime.dispatchControl(control(fixture.runtime, "restart", 2), fixture.peer);
		expect(restarted).toMatchObject({ state: "running", runtimeEpoch: "epoch-1", tunnelReady: true });
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(2);
		const releaseIndex = fixture.events.indexOf("epoch-1:gate-release");
		const replacementIndex = fixture.events.findIndex(event => event.startsWith("process-2:spawn:"));
		expect(releaseIndex).toBeGreaterThanOrEqual(0);
		expect(replacementIndex).toBeGreaterThan(releaseIndex);
	});

	test("retains the active tunnel until broker admission release succeeds", async () => {
		let abortAllowed = false;
		const fixture = createFixture({
			async abortTunnelSpawn() {
				if (!abortAllowed) throw new Error("broker admission remains active");
			},
		});
		await fixture.runtime.start();

		await expect(
			fixture.runtime.dispatchControl(control(fixture.runtime, "restart", 1), fixture.peer),
		).rejects.toThrow("Tunnel shutdown failed");
		expect(fixture.runtime.health()).toMatchObject({ state: "running", tunnelReady: true });
		expect(fixture.events).not.toContain("epoch-1:gate-release");
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(1);

		abortAllowed = true;
		const restarted = await fixture.runtime.dispatchControl(control(fixture.runtime, "restart", 2), fixture.peer);
		expect(restarted).toMatchObject({ state: "running", runtimeEpoch: "epoch-1", tunnelReady: true });
		expect(fixture.events).toContain("epoch-1:gate-release");
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(2);
	});

	test("keeps close retryable until owned-process cleanup succeeds", async () => {
		let terminationAllowed = false;
		const fixture = createFixture({
			async terminate() {
				if (!terminationAllowed) throw new Error("owned process still active");
			},
		});
		await fixture.runtime.start();

		await expect(fixture.runtime.close()).rejects.toThrow("Runtime drain failed");
		expect(fixture.runtime.health()).toMatchObject({
			state: "drained",
			runtimeEpoch: "epoch-1",
			tunnelReady: false,
		});
		expect(fixture.events).toContain("epoch-1:broker-close");
		expect(fixture.events).toContain("epoch-1:key-source-close");
		expect(fixture.events).toContain("command:close");

		terminationAllowed = true;
		await fixture.runtime.close();
		expect(fixture.runtime.health()).toMatchObject({
			state: "stopped",
			runtimeEpoch: "epoch-1",
			tunnelReady: false,
		});
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(1);
	});
});

describe("epoch lifecycle controls", () => {
	test("drain tears down an active owned tunnel before broker wait and resumes with no old handle reuse", async () => {
		const fixture = createFixture();
		await fixture.runtime.start();
		const oldIdentity = fixture.runtime.health();
		const drained = await fixture.runtime.dispatchControl(control(fixture.runtime, "drain", 1), fixture.peer);
		expect(drained).toMatchObject({ state: "drained", tunnelReady: false, runtimeEpoch: "epoch-1" });
		const gateDrainIndex = fixture.events.indexOf("epoch-1:gate-drain");
		const terminateIndex = fixture.events.indexOf("process-1:terminate-owned-tree");
		expect(gateDrainIndex).toBeGreaterThanOrEqual(0);
		expect(terminateIndex).toBeGreaterThan(gateDrainIndex);
		const brokerDrainIndex = fixture.events.indexOf("epoch-1:broker-drain");
		expect(brokerDrainIndex).toBeGreaterThan(terminateIndex);
		expect(fixture.events).toContain("process-1:inactive");

		const resumed = await fixture.runtime.dispatchControl(control(fixture.runtime, "resume", 2), fixture.peer);
		expect(resumed).toMatchObject({
			state: "running",
			tunnelReady: true,
			runtimeEpoch: "epoch-2",
			lifecycleGeneration: 2,
		});
		expect(fixture.bootstraps).toEqual(["epoch-1:bootstrap-1", "epoch-2:bootstrap-1"]);
		expect(fixture.runtimeKeys).toEqual(["epoch-1:key-1:1", "epoch-2:key-1:2"]);
		await expect(
			fixture.runtime.dispatchControl(
				control(fixture.runtime, "drain", 3, {
					runtimeEpoch: oldIdentity.runtimeEpoch,
					lifecycleGeneration: oldIdentity.lifecycleGeneration,
				}),
				fixture.peer,
			),
		).rejects.toThrow("stale runtime epoch");
	});

	test("rejects stolen tokens, cross-connection peers, replay, and preserves running state", async () => {
		const fixture = createFixture();
		await fixture.runtime.start();
		await expect(
			fixture.runtime.dispatchControl(
				control(fixture.runtime, "drain", 1, { controlToken: "x".repeat(CONTROL_TOKEN.length) }),
				fixture.peer,
			),
		).rejects.toThrow("authentication failed");
		await expect(
			fixture.runtime.dispatchControl(control(fixture.runtime, "drain", 1), fixture.otherPeer),
		).rejects.toThrow("native peer proof rejected");
		expect(fixture.runtime.health()).toMatchObject({ state: "running", tunnelReady: true });

		await fixture.runtime.dispatchControl(control(fixture.runtime, "cancel-browser-turns", 1), fixture.peer);
		await expect(
			fixture.runtime.dispatchControl(control(fixture.runtime, "cancel-browser-turns", 1), fixture.peer),
		).rejects.toThrow("replay");
		expect(fixture.runtime.health()).toMatchObject({ state: "running", tunnelReady: true });
	});

	test("enforces restart budget and starts no child after drain", async () => {
		const fixture = createFixture({ restartLimit: 1 });
		await fixture.runtime.start();
		await fixture.runtime.dispatchControl(control(fixture.runtime, "restart", 1), fixture.peer);
		await expect(
			fixture.runtime.dispatchControl(control(fixture.runtime, "restart", 2), fixture.peer),
		).rejects.toThrow("budget exhausted");
		await fixture.runtime.dispatchControl(control(fixture.runtime, "drain", 3), fixture.peer);
		const spawns = fixture.events.filter(event => event.includes(":spawn:")).length;
		await expect(
			fixture.runtime.dispatchControl(control(fixture.runtime, "restart", 4), fixture.peer),
		).rejects.toThrow("running full runtime");
		expect(fixture.events.filter(event => event.includes(":spawn:"))).toHaveLength(spawns);
	});

	test("health and process descriptors contain no control, key, endpoint, or bootstrap material", async () => {
		const fixture = createFixture();
		const health = await fixture.runtime.start();
		const exposed = JSON.stringify(health);
		expect(exposed).not.toContain(CONTROL_TOKEN);
		expect(exposed).not.toContain("private-");
		expect(exposed).not.toContain("bootstrap");
		expect(exposed).not.toContain("endpoint");
		expect(Object.keys(health).sort()).toEqual([
			"lifecycleGeneration",
			"mode",
			"runtimeEpoch",
			"state",
			"tunnelReady",
		]);
	});
});

describe("browser-only mode", () => {
	test("never constructs broker/tunnel state and rejects full-only restart", async () => {
		const fixture = createFixture({ mode: "browser-only" });
		const health = await fixture.runtime.start();
		expect(health).toMatchObject({ mode: "browser-only", state: "running", tunnelReady: false });
		expect(fixture.events.some(event => event.includes(":listen") || event.includes(":spawn:"))).toBe(false);
		await expect(
			fixture.runtime.dispatchControl(control(fixture.runtime, "restart", 1), fixture.peer),
		).rejects.toThrow("Browser-only mode rejects tunnel restart");
	});

	test("rejects accidentally supplied full-mode capabilities at construction", () => {
		expect(
			() =>
				new ChatGptWebRuntimeLifecycle({
					mode: "browser-only",
					controlToken: CONTROL_TOKEN,
					peerHost: { async verifyControlPeer() {} },
					epochFactory: {
						async create() {
							throw new Error("unused");
						},
					},
					full: {} as never,
				}),
		).toThrow();
	});
});
