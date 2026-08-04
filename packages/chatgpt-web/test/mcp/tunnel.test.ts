import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import {
	commitVerifiedTunnelExecutable,
	createNativeFullRuntimeEpochFactory,
	extractPinnedTunnelExecutable,
	installTunnelClient,
	MAX_TUNNEL_DOWNLOAD_BYTES,
	materializeTunnelSpawnEnvironment,
	type NativeLaunchEnvironment,
	type NativeLocalEndpointCapability,
	type NativeOwnedFile,
	type NativeTunnelInstallHost,
	type OmpBrokerEndpoint,
	type OmpConnectorBootstrap,
	type OmpTunnelBootstrap,
	PiNativeTunnelEnvironmentHost,
	TUNNEL_ARTIFACTS,
	TUNNEL_VERSION,
	type TunnelHttpClient,
	type TunnelHttpResponse,
} from "../../src/mcp/tunnel";

function response(
	status: number,
	options: {
		headers?: Record<string, string>;
		chunks?: readonly Uint8Array[];
		onRead?: () => void;
		onCancel?: () => void;
	} = {},
): TunnelHttpResponse {
	return {
		status,
		headers: options.headers ?? {},
		body: {
			async *[Symbol.asyncIterator]() {
				options.onRead?.();
				for (const chunk of options.chunks ?? []) yield chunk;
			},
		},
		cancel: options.onCancel ?? (() => undefined),
	};
}

function unavailableInstaller(onBegin?: () => void): NativeTunnelInstallHost {
	return {
		async beginInstall() {
			onBegin?.();
			throw new Error("installer should not be reached");
		},
		async assertLaunchIdentity() {
			throw new Error("installer should not be reached");
		},
	};
}

function firstCentralDirectoryOffset(bytes: Uint8Array): number {
	for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
		if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true) === 0x0201_4b50) {
			return offset;
		}
	}
	throw new Error("test ZIP has no central directory");
}

describe("pinned tunnel manifest", () => {
	test("is a closed six-tuple 0.0.10 manifest with source release checksums", () => {
		expect(Object.keys(TUNNEL_ARTIFACTS).sort()).toEqual([
			"darwin-arm64",
			"darwin-x64",
			"linux-arm64",
			"linux-x64",
			"win32-arm64",
			"win32-x64",
		]);
		expect(TUNNEL_VERSION).toBe("0.0.10");
		expect(TUNNEL_ARTIFACTS).toEqual({
			"darwin-arm64": {
				url: "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-darwin-arm64.zip",
				sha256: "288accc7fd20cfee1d495adb933773af9e19ebc0cdef3173f7fb544afa5065b2",
				executableName: "tunnel-client",
				semanticVersion: "0.0.10",
				binaryVersion: "0.0.10",
			},
			"darwin-x64": {
				url: "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-darwin-amd64.zip",
				sha256: "1a48616e584484f8bef4c1128d515ac96cf44d0d9609c1462abccc1793f4b847",
				executableName: "tunnel-client",
				semanticVersion: "0.0.10",
				binaryVersion: "0.0.10",
			},
			"linux-arm64": {
				url: "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-linux-arm64.zip",
				sha256: "b842a9b2352eebd80514cf01a1fbb1c0d400a7d24a4015e85a7ea5f1aeaa5b30",
				executableName: "tunnel-client",
				semanticVersion: "0.0.10",
				binaryVersion: "0.0.10",
			},
			"linux-x64": {
				url: "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-linux-amd64.zip",
				sha256: "b9e0388a343f2d7adeff3992f411a0bd3d916a64bc56534aac5fd15ac1b20cd5",
				executableName: "tunnel-client",
				semanticVersion: "0.0.10",
				binaryVersion: "0.0.10",
			},
			"win32-arm64": {
				url: "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-windows-arm64.zip",
				sha256: "08954ccda078abfeac9382f9b19d178ce0656cfe1e84f5941f0f8a5c4e91ea78",
				executableName: "tunnel-client.exe",
				semanticVersion: "0.0.10",
				binaryVersion: "0.0.10",
			},
			"win32-x64": {
				url: "https://github.com/openai/tunnel-client/releases/download/v0.0.10/tunnel-client-v0.0.10-windows-amd64.zip",
				sha256: "5e64a056f1d96786da0a6f8db1da5f5f4a03fd19a90d951a25cf2ca8d9093d00",
				executableName: "tunnel-client.exe",
				semanticVersion: "0.0.10",
				binaryVersion: "0.0.10",
			},
		});
		for (const artifact of Object.values(TUNNEL_ARTIFACTS)) {
			expect(Object.keys(artifact).sort()).toEqual([
				"binaryVersion",
				"executableName",
				"semanticVersion",
				"sha256",
				"url",
			]);
			expect(Object.isFrozen(artifact)).toBe(true);
			expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
		}
	});
});

describe("bounded pinned download", () => {
	test("rejects unsupported hosts before any request", async () => {
		let requested = false;
		await expect(
			installTunnelClient({
				platform: "freebsd",
				arch: "x64",
				http: {
					async request() {
						requested = true;
						return response(500);
					},
				},
				native: unavailableInstaller(),
			}),
		).rejects.toThrow("No pinned tunnel client");
		expect(requested).toBe(false);
	});

	test("validates redirect scheme and host on every hop", async () => {
		const requests: string[] = [];
		const http: TunnelHttpClient = {
			async request(url) {
				requests.push(url.href);
				return response(302, { headers: { location: "http://attacker.invalid/payload.zip" } });
			},
		};
		await expect(
			installTunnelClient({ platform: "linux", arch: "x64", http, native: unavailableInstaller() }),
		).rejects.toThrow("outside the pinned HTTPS release hosts");
		expect(requests).toHaveLength(1);
	});

	test("rejects oversized declared bodies before iteration or buffering", async () => {
		let read = false;
		let cancelled = false;
		await expect(
			installTunnelClient({
				platform: "linux",
				arch: "x64",
				http: {
					async request() {
						return response(200, {
							headers: { "content-length": String(MAX_TUNNEL_DOWNLOAD_BYTES + 1) },
							onRead: () => {
								read = true;
							},
							onCancel: () => {
								cancelled = true;
							},
						});
					},
				},
				native: unavailableInstaller(),
			}),
		).rejects.toThrow("exceeds the maximum size");
		expect(read).toBe(false);
		expect(cancelled).toBe(true);
	});

	test("cancels streamed overflow and rejects checksum mismatches before install", async () => {
		let cancelled = false;
		let beganInstall = false;
		const oversizedChunk = { byteLength: MAX_TUNNEL_DOWNLOAD_BYTES + 1 } as Uint8Array;
		await expect(
			installTunnelClient({
				platform: "linux",
				arch: "x64",
				http: {
					async request() {
						return response(200, {
							chunks: [oversizedChunk],
							onCancel: () => {
								cancelled = true;
							},
						});
					},
				},
				native: unavailableInstaller(() => {
					beganInstall = true;
				}),
			}),
		).rejects.toThrow("exceeds the maximum size");
		expect(cancelled).toBe(true);

		const archive = zipSync({ "tunnel-client": new Uint8Array([1, 2, 3]) });
		await expect(
			installTunnelClient({
				platform: "linux",
				arch: "x64",
				http: {
					async request() {
						return response(200, { chunks: [archive] });
					},
				},
				native: unavailableInstaller(() => {
					beganInstall = true;
				}),
			}),
		).rejects.toThrow("checksum mismatch");
		expect(beganInstall).toBe(false);
	});

	test("honors caller cancellation and timeout", async () => {
		const cancelled = new AbortController();
		cancelled.abort();
		const abortingHttp: TunnelHttpClient = {
			async request(_url, { signal }) {
				if (signal.aborted) throw signal.reason;
				throw new Error("expected abort");
			},
		};
		await expect(
			installTunnelClient({
				platform: "linux",
				arch: "x64",
				http: abortingHttp,
				native: unavailableInstaller(),
				signal: cancelled.signal,
			}),
		).rejects.toThrow("cancelled");

		const waitingHttp: TunnelHttpClient = {
			async request(_url, { signal }) {
				await new Promise<void>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
				);
				throw new Error("unreachable");
			},
		};
		await expect(
			installTunnelClient({
				platform: "linux",
				arch: "x64",
				http: waitingHttp,
				native: unavailableInstaller(),
				timeoutMs: 1,
			}),
		).rejects.toThrow("timed out");
	});
});

describe("archive boundary", () => {
	test("accepts one exact regular executable", () => {
		const binary = new Uint8Array([1, 2, 3, 4]);
		expect(extractPinnedTunnelExecutable(zipSync({ "tunnel-client": binary }), "tunnel-client")).toEqual(binary);
	});

	test("rejects traversal, extra entries, corrupt archives, and link metadata", () => {
		expect(() =>
			extractPinnedTunnelExecutable(zipSync({ "../tunnel-client": new Uint8Array([1]) }), "tunnel-client"),
		).toThrow("path");
		expect(() =>
			extractPinnedTunnelExecutable(
				zipSync({ "tunnel-client": new Uint8Array([1]), other: new Uint8Array([2]) }),
				"tunnel-client",
			),
		).toThrow("exactly");
		expect(() => extractPinnedTunnelExecutable(new Uint8Array([1, 2, 3]), "tunnel-client")).toThrow("corrupt");

		const symlink = zipSync({ "tunnel-client": new Uint8Array([1]) });
		const central = firstCentralDirectoryOffset(symlink);
		new DataView(symlink.buffer, symlink.byteOffset, symlink.byteLength).setUint32(
			central + 38,
			(0o120777 << 16) >>> 0,
			true,
		);
		expect(() => extractPinnedTunnelExecutable(symlink, "tunnel-client")).toThrow("links");
	});
});

describe("atomic native install", () => {
	test("rolls back a corrupt or version-mismatched executable before commit", async () => {
		const events: string[] = [];
		await expect(
			commitVerifiedTunnelExecutable({
				tuple: "linux-x64",
				archiveSha256: TUNNEL_ARTIFACTS["linux-x64"].sha256,
				executable: new Uint8Array([1, 2, 3]),
				native: {
					async beginInstall(name) {
						events.push(`begin:${name}`);
						return {
							async writeExecutable() {
								events.push("write");
							},
							async verifyBinaryVersion(version) {
								events.push(`version:${version}`);
								throw new Error("binary version mismatch");
							},
							async commit() {
								throw new Error("must not commit");
							},
							async rollback() {
								events.push("rollback");
							},
						};
					},
					async assertLaunchIdentity() {
						throw new Error("must not assert");
					},
				},
			}),
		).rejects.toThrow("version mismatch");
		expect(events).toEqual(["begin:tunnel-client", "write", "version:0.0.10", "rollback"]);
	});

	test("rolls back when destination or held-file identity changes after atomic commit", async () => {
		let rolledBack = false;
		await expect(
			commitVerifiedTunnelExecutable({
				tuple: "win32-x64",
				archiveSha256: TUNNEL_ARTIFACTS["win32-x64"].sha256,
				executable: new Uint8Array([9, 8, 7]),
				native: {
					async beginInstall() {
						return {
							async writeExecutable() {},
							async verifyBinaryVersion() {},
							async commit(request) {
								return {
									...request,
									fileIdentity: "opened-destination",
									executable: {
										identity: "opened-executable",
										close() {},
										__nativeVerifiedTunnelExecutable: Symbol("executable"),
									},
									__installedTunnelArtifact: Symbol("installed"),
								};
							},
							async rollback() {
								rolledBack = true;
							},
						};
					},
					async assertLaunchIdentity() {
						throw new Error("reparse destination swap");
					},
				},
			}),
		).rejects.toThrow("reparse destination swap");
		expect(rolledBack).toBe(true);
	});
});

describe("native full runtime epoch factory", () => {
	test("binds epoch construction to the exact injected native module", async () => {
		let launchCapabilityReads = 0;
		let listenerCapabilityReads = 0;
		let ownedFileCapabilityReads = 0;
		const nativeModule = {
			get NativeLocalListener() {
				listenerCapabilityReads++;
				return {
					create() {
						throw new Error("not listening in this test");
					},
				};
			},
			get NativeOwnedFile() {
				ownedFileCapabilityReads++;
				return {
					createPrivate() {
						throw new Error("not preparing a spawn in this test");
					},
				};
			},
			connectLocal() {
				throw new Error("not connecting in this test");
			},
			matchesProcessIdentity() {
				return true;
			},
			verifyPeerDescendant() {
				return true;
			},
			get createLaunchEnvironment() {
				launchCapabilityReads++;
				return () => ({}) as NativeLaunchEnvironment;
			},
		};
		const epochFactory = createNativeFullRuntimeEpochFactory({
			nativeModule,
			runtimeRoot: {
				identity: "runtime-root",
				read: () => new Uint8Array(),
				consume() {},
				cleanup() {},
				close() {},
			},
			runtimeKeySourceFactory: () => ({
				async duplicateForSpawn() {
					throw new Error("not spawning in this test");
				},
				async close() {},
			}),
			async waitForTunnelReady() {},
			async cancelBrowserTurns() {},
		});

		const epoch = await epochFactory.create("full");

		expect(listenerCapabilityReads).toBe(1);
		expect(ownedFileCapabilityReads).toBe(1);
		expect(launchCapabilityReads).toBe(1);
		await epoch.close?.();
	});
});

describe("handle-bound runtime-key handoff", () => {
	test("bridges opaque capabilities to the exact native tunnel-child profile without JS bytes or paths", async () => {
		const runtimeKey: NativeOwnedFile = {
			identity: "runtime-key-handle",
			consume() {},
			cleanup() {},
			close() {},
		};
		const bootstrapFile: NativeOwnedFile = {
			identity: "bootstrap-handle",
			consume() {},
			cleanup() {},
			close() {},
		};
		const broker = { __nativeLocalEndpoint: Symbol("broker") } as NativeLocalEndpointCapability;
		const connector = { __opaque: Symbol("connector") } as unknown as OmpConnectorBootstrap;
		const tunnel = {
			kind: "private-owned-bootstrap-file",
			__opaque: Symbol("tunnel"),
		} as unknown as OmpTunnelBootstrap;
		const endpoint = { kind: "owner-local", __opaque: Symbol("endpoint") } as unknown as OmpBrokerEndpoint;
		let closed = false;
		let profile: unknown;
		const host = new PiNativeTunnelEnvironmentHost(
			{
				createLaunchEnvironment(value) {
					profile = value;
					return {} as NativeLaunchEnvironment;
				},
			},
			{
				takeBootstrap(actualConnector, actualTunnel) {
					expect(actualConnector).toBe(connector);
					expect(actualTunnel).toBe(tunnel);
					return {
						file: bootstrapFile,
						close: () => {
							closed = true;
						},
					};
				},
				brokerEndpoint(actualEndpoint) {
					expect(actualEndpoint).toBe(endpoint);
					return broker;
				},
			},
		);
		const created = await host.createLaunchEnvironment({
			runtimeKey,
			endpoint,
			connectorBootstrap: connector,
			tunnelBootstrap: tunnel,
			runtimeEpoch: "epoch-native",
			lifecycleGeneration: 7,
			inheritedEnvironment: {},
		});
		expect(profile).toEqual({
			kind: "tunnel-child",
			bootstrap: bootstrapFile,
			broker,
			runtimeKey,
			runtimeEpoch: "epoch-native",
		});
		expect(JSON.stringify(profile)).not.toContain("path");
		created.close();
		expect(closed).toBe(true);
	});

	test("consumes the held handle into an empty-inheritance native profile exactly once", async () => {
		const events: string[] = [];
		const file: NativeOwnedFile = {
			identity: "held-runtime-key",
			async consume() {
				events.push("consume");
			},
			async cleanup() {
				events.push("cleanup");
			},
			async close() {
				events.push("close");
			},
		};
		const environment = {} as NativeLaunchEnvironment;
		const tunnelBootstrap = {
			kind: "private-owned-bootstrap-file",
			__opaque: Symbol("tunnel"),
		} as unknown as OmpTunnelBootstrap;
		let captured = "";
		const request = {
			runtimeKey: file,
			endpoint: { kind: "owner-local", __opaque: Symbol("endpoint") } as unknown as OmpBrokerEndpoint,
			connectorBootstrap: { __opaque: Symbol("connector") } as unknown as OmpConnectorBootstrap,
			tunnelBootstrap,
			runtimeEpoch: "epoch-1",
			lifecycleGeneration: 1,
			native: {
				async createLaunchEnvironment(value: {
					runtimeKey: NativeOwnedFile;
					inheritedEnvironment: Readonly<Record<string, never>>;
				}) {
					captured = value.runtimeKey.identity;
					expect(value.inheritedEnvironment).toEqual({});
					return { environment, close: () => events.push("environment-close") };
				},
			},
		};
		const spawnEnvironment = await materializeTunnelSpawnEnvironment(request);
		expect(spawnEnvironment.environment).toBe(environment);
		expect(events).toEqual([]);
		expect(captured).toBe("held-runtime-key");
		await spawnEnvironment.completeSpawnHandoff();
		expect(events).toEqual(["cleanup", "consume"]);
		await spawnEnvironment.close();
		expect(events).toEqual(["cleanup", "consume", "environment-close", "close"]);
		await expect(materializeTunnelSpawnEnvironment(request)).rejects.toThrow("already consumed");
	});

	test("fails closed on a replacement race and never materializes an environment", async () => {
		let materialized = false;
		let closed = false;
		let cleaned = false;
		const file: NativeOwnedFile = {
			identity: "raced-runtime-key",
			async consume() {
				throw new Error("must not consume");
			},
			async cleanup() {
				cleaned = true;
			},
			async close() {
				closed = true;
			},
		};
		await expect(
			materializeTunnelSpawnEnvironment({
				runtimeKey: file,
				endpoint: { kind: "owner-local", __opaque: Symbol() } as unknown as OmpBrokerEndpoint,
				connectorBootstrap: { __opaque: Symbol() } as unknown as OmpConnectorBootstrap,
				tunnelBootstrap: {
					kind: "private-owned-bootstrap-file",
					__opaque: Symbol(),
				} as unknown as OmpTunnelBootstrap,
				runtimeEpoch: "epoch-race",
				lifecycleGeneration: 2,
				native: {
					async createLaunchEnvironment() {
						materialized = true;
						throw new Error("no-follow identity changed");
					},
				},
			}),
		).rejects.toThrow("identity changed");
		expect(materialized).toBe(true);
		expect(closed).toBe(true);
		expect(cleaned).toBe(true);
	});

	test("fails closed before materialization when temporary-key cleanup authority is absent", async () => {
		let closed = false;
		let materialized = false;
		const runtimeKey = {
			identity: "key-without-cleanup",
			consume() {
				throw new Error("must not consume");
			},
			close() {
				closed = true;
			},
		} as unknown as NativeOwnedFile;
		await expect(
			materializeTunnelSpawnEnvironment({
				runtimeKey,
				endpoint: { kind: "owner-local", __opaque: Symbol() } as unknown as OmpBrokerEndpoint,
				connectorBootstrap: { __opaque: Symbol() } as unknown as OmpConnectorBootstrap,
				tunnelBootstrap: {
					kind: "private-owned-bootstrap-file",
					__opaque: Symbol(),
				} as unknown as OmpTunnelBootstrap,
				runtimeEpoch: "epoch-no-cleanup",
				lifecycleGeneration: 3,
				native: {
					async createLaunchEnvironment() {
						materialized = true;
						throw new Error("must not materialize");
					},
				},
			}),
		).rejects.toThrow("cleanup capability is unavailable");
		expect(materialized).toBe(false);
		expect(closed).toBe(true);
	});
});
