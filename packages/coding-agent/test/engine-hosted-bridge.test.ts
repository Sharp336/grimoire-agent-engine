import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type GrimoireRpc,
	HostedEngineBridge,
	HostedGrimoireRpc,
} from "@oh-my-pi/pi-coding-agent/engine/hosted-bridge";
import { type EngineCommandEnvelope, NatsEngineAdapter } from "@oh-my-pi/pi-coding-agent/engine/nats-adapter";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { runEngineService } from "@oh-my-pi/pi-coding-agent/engine/service";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const installedNatsServer = path.join(process.env.LOCALAPPDATA ?? "", "Grimoire", "bin", "nats-server.exe");
const natsServer = process.env.GRIMOIRE_NATS_SERVER ?? installedNatsServer;

describe.skipIf(!fs.existsSync(natsServer))("HostedEngineBridge", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
	});

	it("claims a hosted command and settles the same durable job from Engine events", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-host-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => true,
			sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: Settings.isolated({}),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
			},
		});
		const profile = { spawns: "", profileDigest: "leaf-profile-v1", enableMCP: false, enableLsp: false };
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			resolveLaunchProfile: command => command.payload.launchProfile as typeof profile,
		});
		const rpc = new FakeRpc(startCommand(cwd, profile));
		const bridge = await HostedEngineBridge.connect({
			rpc,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			engineGeneration: runtime.engineGeneration,
			servers: broker.url,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 100,
		});
		try {
			await waitFor(() => rpc.events.some(event => event.type === "attempt.completed"));
			expect((await runtime.store.getAttempt("attempt-hosted"))?.state).toBe("completed");
			expect(rpc.events.map(event => event.type)).toEqual([
				"command.accepted",
				"attempt.started",
				"attempt.completed",
			]);
			expect(rpc.terminalStatus).toBe("completed");
		} finally {
			await bridge.dispose();
			await adapter.dispose();
			await runtime.dispose();
			authStorage.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 60_000);

	it("recovers the exact hosted lease for an event after bridge state is lost", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-host-recovery-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => true,
			sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: Settings.isolated({}),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
			},
		});
		const profile = { spawns: "", profileDigest: "leaf-profile-v1", enableMCP: false, enableLsp: false };
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			resolveLaunchProfile: command => command.payload.launchProfile as typeof profile,
		});
		const command = startCommand(cwd, profile);
		await runtime.start(
			{
				commandId: command.commandId,
				agentInstanceId: command.agentInstanceId,
				executionId: command.executionId ?? "",
				attemptId: command.attemptId ?? "",
				authorityGeneration: command.authorityGeneration,
				cwd,
				input: "RECOVER",
			},
			profile,
		);
		await runtime.drain();
		const rpc = new FakeRpc(command, { exactRecoveryOnly: true });
		const bridge = await HostedEngineBridge.connect({
			rpc,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			engineGeneration: runtime.engineGeneration,
			servers: broker.url,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 100,
		});
		try {
			await waitFor(() => rpc.terminalStatus === "completed");
			expect(rpc.exactRecoveryClaims).toBe(1);
		} finally {
			await bridge.dispose();
			await adapter.dispose();
			await runtime.dispose();
			authStorage.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 60_000);

	it("keeps a live claim after one transient heartbeat failure", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-host-heartbeat-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		const prompt = Promise.withResolvers<boolean>();
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: () => prompt.promise,
			sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: Settings.isolated({}),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry,
			},
		});
		const profile = { spawns: "", profileDigest: "leaf-profile-v1", enableMCP: false, enableLsp: false };
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			resolveLaunchProfile: command => command.payload.launchProfile as typeof profile,
		});
		const rpc = new FakeRpc(startCommand(cwd, profile), { heartbeatFailures: 1 });
		const bridge = await HostedEngineBridge.connect({
			rpc,
			deviceId: "device-hosted",
			engineId: "engine-hosted",
			engineGeneration: runtime.engineGeneration,
			servers: broker.url,
			pollIntervalMs: 10,
			heartbeatIntervalMs: 25,
		});
		try {
			await waitFor(() => rpc.heartbeatCalls >= 1);
			prompt.resolve(true);
			await waitFor(() => rpc.terminalStatus === "completed");
			expect(rpc.exactRecoveryClaims).toBe(0);
		} finally {
			await bridge.dispose();
			await adapter.dispose();
			await runtime.dispose();
			authStorage.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 60_000);

	it("allows only one service owner for a runtime directory", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-service-lock-${Snowflake.next()}-`));
		const stop = Promise.withResolvers<void>();
		const config = {
			deviceId: "device-lock",
			engineId: "engine-lock",
			runtimeDir: tempDir,
			databasePath: path.join(tempDir, "engine.sqlite"),
			natsServerPath: natsServer,
		};
		const first = runEngineService(config, stop.promise);
		await waitFor(async () => {
			try {
				return JSON.parse(await Bun.file(path.join(tempDir ?? "", "status.json")).text()).status === "running";
			} catch {
				return false;
			}
		});
		await expect(runEngineService(config, Promise.resolve())).rejects.toThrow("already running");
		stop.resolve();
		await first;
	}, 60_000);
});

describe("HostedGrimoireRpc", () => {
	it("uses an exact shared-host MCP surface endpoint", async () => {
		let requestPath = "";
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				requestPath = new URL(request.url).pathname;
				return Response.json({
					jsonrpc: "2.0",
					id: 1,
					result: { structuredContent: { status: "ok" } },
				});
			},
		});
		try {
			const rpc = new HostedGrimoireRpc({
				serverUrl: `http://127.0.0.1:${server.port}/mcp/core`,
				token: "local-test-token",
				clientId: "test-client",
			});
			expect(await rpc.call("test_tool", {})).toEqual({ status: "ok" });
			expect(requestPath).toBe("/mcp/core");
		} finally {
			server.stop(true);
		}
	});
});

class FakeRpc implements GrimoireRpc {
	readonly events: Array<Record<string, unknown>> = [];
	terminalStatus: string | undefined;
	heartbeatCalls = 0;
	exactRecoveryClaims = 0;
	#claimed = false;
	#leaseToken = "lease-hosted";
	#heartbeatFailures: number;

	constructor(
		readonly command: Omit<EngineCommandEnvelope, "engineGeneration">,
		readonly options: { exactRecoveryOnly?: boolean; heartbeatFailures?: number } = {},
	) {
		this.#heartbeatFailures = options.heartbeatFailures ?? 0;
	}

	async call(_tool: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>> {
		switch (arguments_.action) {
			case "claim":
				if (this.#claimed || (this.options.exactRecoveryOnly && arguments_.job_id !== this.command.commandId)) {
					return { status: "no_job" };
				}
				this.#claimed = true;
				if (arguments_.job_id === this.command.commandId) this.exactRecoveryClaims++;
				return {
					status: "claimed",
					job_id: this.command.commandId,
					operation_type: "agent_engine_command",
					lease_token: this.#leaseToken,
					work: { kind: "command", command: this.command },
				};
			case "heartbeat":
				this.heartbeatCalls++;
				if (this.#heartbeatFailures-- > 0) throw new Error("temporary heartbeat failure");
				return { status: "renewed" };
			case "event": {
				if (arguments_.lease_token !== this.#leaseToken) throw new Error("active lease is required");
				const event = arguments_.event as Record<string, unknown>;
				this.events.push(event);
				const terminal = event.type === "attempt.completed";
				if (terminal) this.terminalStatus = "completed";
				return { status: terminal ? "completed" : "recorded" };
			}
			default:
				throw new Error(`Unexpected bridge action ${String(arguments_.action)}`);
		}
	}
}

function startCommand(cwd: string, profile: Record<string, unknown>): Omit<EngineCommandEnvelope, "engineGeneration"> {
	return {
		schema: "grimoire.engine.command.v1",
		commandId: "command-hosted",
		op: "start",
		deviceId: "device-hosted",
		engineId: "engine-hosted",
		agentInstanceId: "agent-hosted",
		executionId: "execution-hosted",
		attemptId: "attempt-hosted",
		authorityGeneration: 1,
		issuedAt: Date.now(),
		payload: {
			cwd,
			input: "HOSTED",
			profileDigest: profile.profileDigest,
			launchProfile: profile,
		},
	};
}

async function startNatsServer(root: string) {
	const portsDir = path.join(root, "ports");
	const dataDir = path.join(root, "jetstream");
	fs.mkdirSync(portsDir);
	const process = Bun.spawn(
		[natsServer, "-js", "-a", "127.0.0.1", "-p", "-1", "--ports_file_dir", portsDir, "-sd", dataDir],
		{ stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	try {
		let manifest: { nats?: string[] } | undefined;
		await waitFor(async () => {
			const files = await Array.fromAsync(new Bun.Glob("*.ports").scan({ cwd: portsDir, onlyFiles: true }));
			if (!files[0]) return false;
			manifest = (await Bun.file(path.join(portsDir, files[0])).json()) as { nats?: string[] };
			return Boolean(manifest.nats?.[0]);
		});
		return { process, url: manifest?.nats?.[0] ?? "" };
	} catch (error) {
		process.kill();
		await process.exited;
		throw error;
	}
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
		await Bun.sleep(25);
	}
}
