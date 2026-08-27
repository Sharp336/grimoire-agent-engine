import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AGENT_MESSAGE_STREAM,
	ENGINE_COMMAND_STREAM,
	ENGINE_EVENT_STREAM,
	type EngineCommandEnvelope,
	NatsEngineAdapter,
} from "@oh-my-pi/pi-coding-agent/engine/nats-adapter";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const installedNatsServer = path.join(process.env.LOCALAPPDATA ?? "", "Grimoire", "bin", "nats-server.exe");
const natsServer = process.env.GRIMOIRE_NATS_SERVER ?? installedNatsServer;

describe.skipIf(!fs.existsSync(natsServer))("NatsEngineAdapter", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) removeSyncWithRetries(tempDir);
		tempDir = undefined;
	});

	it("runs two agent command routes, event outbox and an offline durable mailbox", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-engine-nats-${Snowflake.next()}-`));
		const broker = await startNatsServer(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const cwd = path.join(tempDir, "workspace");
		fs.mkdirSync(cwd);
		let dispatchCount = 0;
		const runtime = await EngineRuntime.create({
			databasePath: path.join(tempDir, "engine.sqlite"),
			dispatchPrompt: async () => {
				dispatchCount++;
				return true;
			},
			sessionDefaults: {
				cwd,
				agentDir: path.join(tempDir, "agent"),
				settings: Settings.isolated({ "bash.autoBackground.enabled": true }),
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
		const errors: Error[] = [];
		const profile = { spawns: "", profileDigest: "leaf-profile-v1", enableMCP: false, enableLsp: false };
		const adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: "device-1",
			engineId: "engine-1",
			servers: broker.url,
			authorizeCommand: () => {},
			authorizeMessage: () => {},
			resolveLaunchProfile: () => profile,
			onError: error => errors.push(error),
		});
		const client = await connect({ servers: broker.url });
		try {
			const js = jetstream(client);
			const manager = await jetstreamManager(client);
			const decoder = new TextDecoder();
			const eventsA: Array<Record<string, unknown>> = [];
			const eventsB: Array<Record<string, unknown>> = [];
			const subA = client.subscribe(adapter.eventSubject("agent-a", "*"), {
				callback: (_error, message) => {
					eventsA.push(JSON.parse(decoder.decode(message.data)));
				},
			});
			const subB = client.subscribe(adapter.eventSubject("agent-b", "*"), {
				callback: (_error, message) => {
					eventsB.push(JSON.parse(decoder.decode(message.data)));
				},
			});

			const commandA = startCommand(runtime.engineGeneration, "agent-a", "a", cwd);
			const commandB = startCommand(runtime.engineGeneration, "agent-b", "b", cwd);
			await Promise.all([
				js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(commandA), {
					msgID: commandA.commandId,
				}),
				js.publish(adapter.commandSubject("agent-b", "start"), JSON.stringify(commandB), {
					msgID: commandB.commandId,
				}),
			]);
			await waitFor(async () =>
				(await Promise.all([runtime.store.getAttempt("attempt-a"), runtime.store.getAttempt("attempt-b")])).every(
					attempt => attempt?.state === "completed",
				),
			);
			await adapter.flushEvents();
			await waitFor(() => eventsA.length >= 3 && eventsB.length >= 3);
			expect(eventsA.every(event => event.agentInstanceId === "agent-a")).toBeTrue();
			expect(eventsB.every(event => event.agentInstanceId === "agent-b")).toBeTrue();
			expect(eventsA.map(event => event.type)).toEqual(["command.accepted", "attempt.started", "attempt.completed"]);
			expect(eventsB.map(event => event.type)).toEqual(["command.accepted", "attempt.started", "attempt.completed"]);
			expect(dispatchCount).toBe(2);

			const commandConsumer = `engine_${adapter.engineRoute}`;
			const deliveredBefore = (await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer)).delivered
				.consumer_seq;
			const duplicateA = { ...commandA, commandId: "command-a-redelivery", issuedAt: Date.now() };
			await js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(duplicateA), {
				msgID: duplicateA.commandId,
			});
			await waitFor(
				async () =>
					(await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer)).delivered.consumer_seq >
					deliveredBefore,
			);
			expect(dispatchCount).toBe(2);

			const deliveredAfterDuplicate = (await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer))
				.delivered.consumer_seq;
			const oldGenerationA = {
				...startCommand(runtime.engineGeneration - 1, "agent-a", "old-generation", cwd),
				commandId: "command-a-old-generation",
			};
			await js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(oldGenerationA), {
				msgID: oldGenerationA.commandId,
			});
			await waitFor(async () => {
				const info = await manager.consumers.info(ENGINE_COMMAND_STREAM, commandConsumer);
				return info.delivered.consumer_seq > deliveredAfterDuplicate && info.num_ack_pending === 0;
			});
			await adapter.flushEvents();
			expect(eventsA.some(event => event.causationCommandId === oldGenerationA.commandId)).toBeFalse();
			expect(dispatchCount).toBe(2);

			const futureGenerationA = {
				...startCommand(runtime.engineGeneration + 1, "agent-a", "stale", cwd),
				commandId: "command-a-stale",
			};
			await js.publish(adapter.commandSubject("agent-a", "start"), JSON.stringify(futureGenerationA), {
				msgID: futureGenerationA.commandId,
			});
			await waitFor(() => eventsA.some(event => event.type === "command.rejected"));
			expect(dispatchCount).toBe(2);
			subA.unsubscribe();
			subB.unsubscribe();

			await adapter.provisionMailbox("agent-c");
			const message = {
				schema: "grimoire.agent.message.v1",
				messageId: "message-a-c",
				fromAgentInstanceId: "agent-a",
				toAgentInstanceId: "agent-c",
				authorityGeneration: 1,
				sentAt: Date.now(),
				kind: "text",
				payload: { body: "hello from A" },
			};
			await js.publish(adapter.messageSubject("agent-a", "agent-c"), JSON.stringify(message), {
				msgID: message.messageId,
			});
			const mailboxName = `agent_${adapter.messageSubject("agent-a", "agent-c").split(".")[6]}`;
			await waitFor(async () => (await manager.streams.info(AGENT_MESSAGE_STREAM)).state.messages === 1);

			const commandC = startCommand(runtime.engineGeneration, "agent-c", "c", cwd);
			await js.publish(adapter.commandSubject("agent-c", "start"), JSON.stringify(commandC), {
				msgID: commandC.commandId,
			});
			await waitFor(async () => (await manager.streams.info(AGENT_MESSAGE_STREAM)).state.messages === 0);
			expect((await manager.consumers.info(AGENT_MESSAGE_STREAM, mailboxName)).num_ack_pending).toBe(0);

			expect((await manager.streams.info(ENGINE_COMMAND_STREAM)).config.retention).toBe("workqueue");
			expect((await manager.streams.info(ENGINE_EVENT_STREAM)).config.retention).toBe("limits");
			expect((await manager.streams.info(AGENT_MESSAGE_STREAM)).config.retention).toBe("workqueue");
			expect(errors).toEqual([]);
		} finally {
			await client.drain();
			await adapter.dispose();
			await runtime.dispose();
			authStorage.close();
			broker.process.kill();
			await broker.process.exited;
		}
	}, 60000);
});

function startCommand(
	engineGeneration: number,
	agentInstanceId: string,
	suffix: string,
	cwd: string,
): EngineCommandEnvelope {
	return {
		schema: "grimoire.engine.command.v1",
		commandId: `command-${suffix}`,
		op: "start",
		deviceId: "device-1",
		engineId: "engine-1",
		engineGeneration,
		agentInstanceId,
		executionId: `execution-${suffix}`,
		attemptId: `attempt-${suffix}`,
		authorityGeneration: 1,
		issuedAt: Date.now(),
		payload: { cwd, input: suffix.toUpperCase(), profileDigest: "leaf-profile-v1" },
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
