import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import type { PeerTransportBackend } from "@oh-my-pi/pi-coding-agent/irc/bus";
import {
	AgentRegistry,
	type RemoteRegisterInput,
	type RemoteRegistryBackend,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { runWithRemoteRuntimeConfig } from "@oh-my-pi/pi-coding-agent/remote-runtime/bootstrap";
import {
	REMOTE_RUNTIME_MAX_FRAME_BYTES,
	REMOTE_RUNTIME_REQUIRED_CAPABILITIES,
} from "@oh-my-pi/pi-coding-agent/remote-runtime/client";
import { REMOTE_RUNTIME_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/remote-runtime/config";
import {
	currentRemoteRuntime,
	type RemoteRuntimeBindings,
	remoteRuntimeSealActive,
	runWithRemoteRuntime,
} from "@oh-my-pi/pi-coding-agent/remote-runtime/scope";
import type { StructuredSubagentBackend } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { TempDir } from "@oh-my-pi/pi-utils";

function bindings(label: string): RemoteRuntimeBindings {
	const subagentBackend: StructuredSubagentBackend = {
		run: async () => {
			throw new Error(label);
		},
	};
	const registryBackend: RemoteRegistryBackend = {
		status: async identity => ({ identity: { ...identity }, value: "running" }),
		progress: async identity => ({ identity: { ...identity }, value: { sequence: 1, message: label } }),
		cancel: async identity => ({ identity: { ...identity }, value: "cancelled" }),
		result: async identity => ({ identity: { ...identity }, value: { outcome: "completed", output: label } }),
	};
	const peerTransport: PeerTransportBackend = {
		deliver: async delivery => ({ ...delivery, outcome: "accepted" }),
		cancel: async () => {},
	};
	return { subagentBackend, registryBackend, peerTransport };
}

function descriptor(socketPath: string): Record<string, unknown> {
	return {
		version: REMOTE_RUNTIME_PROTOCOL_VERSION,
		socketPath,
		controllerId: "controller-a",
		executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		rootExecutionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		parentExecutionId: null,
		assignmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
		depth: 0,
		revision: "a".repeat(40),
		grantId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
		policyDigest: `sha256:${"b".repeat(64)}`,
		budgetRef: "budget:root-1",
		schemaRef: "schema:root-1",
		requestTimeoutMs: 1_000,
	};
}

describe("sealed remote runtime bootstrap", () => {
	it("installs before the production callback and removes exactly that scope on teardown", async () => {
		using tempDir = TempDir.createSync("@omp-remote-bootstrap-");
		const socketPath = tempDir.join("runtime.sock");
		const configPath = tempDir.join("runtime.json");
		await Bun.write(configPath, JSON.stringify(descriptor(socketPath)));
		await fs.chmod(configPath, 0o600);
		const socketClosed = Promise.withResolvers<void>();
		const server = net.createServer(socket => {
			let residual = "";
			socket.on("data", data => {
				residual += data.toString("utf8");
				const newline = residual.indexOf("\n");
				if (newline === -1) return;
				const request = JSON.parse(residual.slice(0, newline)) as { requestId: string };
				socket.write(
					`${JSON.stringify({
						protocol: REMOTE_RUNTIME_PROTOCOL_VERSION,
						kind: "result",
						requestId: request.requestId,
						result: {
							version: REMOTE_RUNTIME_PROTOCOL_VERSION,
							capabilities: REMOTE_RUNTIME_REQUIRED_CAPABILITIES,
							maxFrameBytes: REMOTE_RUNTIME_MAX_FRAME_BYTES,
						},
					})}\n`,
				);
			});
			socket.on("close", socketClosed.resolve);
		});
		const listening = Promise.withResolvers<void>();
		server.once("listening", listening.resolve);
		server.once("error", listening.reject);
		server.listen(socketPath);
		await listening.promise;
		await fs.chmod(socketPath, 0o600);
		try {
			expect(currentRemoteRuntime()).toBeUndefined();
			expect(remoteRuntimeSealActive()).toBe(false);
			await runWithRemoteRuntimeConfig(configPath, async () => {
				const installed = currentRemoteRuntime();
				expect(remoteRuntimeSealActive()).toBe(true);
				expect(installed).toBeDefined();
				expect(installed?.subagentBackend.constructor.name).toBe("SocketStructuredSubagentBackend");
				expect(installed?.registryBackend.constructor.name).toBe("SocketRemoteRegistryBackend");
				expect(installed?.peerTransport.constructor.name).toBe("SocketPeerTransportBackend");
			});
			expect(currentRemoteRuntime()).toBeUndefined();
			expect(remoteRuntimeSealActive()).toBe(false);
			await socketClosed.promise;
		} finally {
			const closed = Promise.withResolvers<void>();
			server.close(error => (error ? closed.reject(error) : closed.resolve()));
			await closed.promise;
		}
	});

	it("keeps concurrent command scopes isolated and rejects nested replacement", async () => {
		const first = bindings("first");
		const second = bindings("second");
		const firstGate = Promise.withResolvers<void>();
		const secondGate = Promise.withResolvers<void>();
		const firstRun = runWithRemoteRuntime(first, async () => {
			expect(currentRemoteRuntime()).toBe(first);
			firstGate.resolve();
			await secondGate.promise;
			expect(currentRemoteRuntime()).toBe(first);
			expect(() => runWithRemoteRuntime(second, () => undefined)).toThrow("already installed");
		});
		const secondRun = runWithRemoteRuntime(second, async () => {
			await firstGate.promise;
			expect(currentRemoteRuntime()).toBe(second);
			secondGate.resolve();
		});
		await Promise.all([firstRun, secondRun]);
		expect(currentRemoteRuntime()).toBeUndefined();
	});

	it("binds remote refs to explicit owners and rejects a different ambient backend", async () => {
		const owner = bindings("owner");
		const different = bindings("different");
		const registry = new AgentRegistry({ remoteBackend: owner.registryBackend });
		const input: RemoteRegisterInput = {
			id: "RemoteChild",
			displayName: "remote child",
			kind: "sub",
			parentId: "Main",
			status: "running",
			identity: { controllerId: "controller-a", executionId: "execution-a", generation: 1 },
			createdAt: 1,
		};
		const ref = registry.registerRemote(input);

		await expect(registry.refreshRemote("RemoteChild")).resolves.toMatchObject({ activity: "owner" });
		await runWithRemoteRuntime(different, async () => {
			await expect(registry.refreshRemote("RemoteChild")).rejects.toThrow("different sealed runtime");
			expect(() => registry.settleRemote({ ...input, status: "idle" }, ref, different.registryBackend)).toThrow(
				"different sealed runtime",
			);
			expect(() =>
				new AgentRegistry().registerRemote({
					...input,
					id: "OwnerlessChild",
					identity: { ...input.identity, executionId: "execution-b" },
				}),
			).toThrow("explicit or constructor backend owner");
		});
		expect(ref.status).toBe("running");
	});
});
