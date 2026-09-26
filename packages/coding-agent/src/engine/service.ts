import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nkeyAuthenticator, nkeys } from "@nats-io/transport-node";
import { StreamAdmissionError } from "@oh-my-pi/pi-ai/utils/stream-admission";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { interceptUnhandledRejections } from "@oh-my-pi/pi-utils/postmortem";
import type { MCPHttpServerConfig } from "../mcp/types";
import type { EngineChildLaunchResult } from "../tools";
import { type EngineLaunchProfile, EngineTargetError, MAX_ENGINE_CHILD_ASSIGNMENT_BYTES } from "./contracts";
import { type EngineControlQueryServer, runEngineCommand, startEngineControlQueryServer } from "./control-query";
import { HostedEngineBridge, HostedGrimoireRpc } from "./hosted-bridge";
import { type EngineCommandEnvelope, NatsEngineAdapter } from "./nats-adapter";
import { EngineProfileResolver } from "./profile-resolver";
import { ProviderAdmissionClient } from "./provider-admission";
import { ProviderExecutionClient } from "./provider-execution";
import { engineAgentInstanceId, engineRouteToken } from "./route";
import { EngineRuntime, type EngineRuntimeOptions } from "./runtime";

export interface EngineServiceConfig {
	deviceId: string;
	engineId: string;
	runtimeDir: string;
	databasePath: string;
	natsServerPath: string;
	artifactCacheRoot?: string;
	localCredentialDbPath?: string;
	childHistoryTtlMinutes?: number;
	childHistoryRetention?: "local" | "off" | "grimoire";
	hosted?: {
		serverUrl: string;
		token: string;
		clientId: string;
		clientVersion?: string;
		protocolVersion?: string;
		sourceSignature?: string;
	};
}

export async function runEngineService(config: EngineServiceConfig, stop?: Promise<void>): Promise<void> {
	validateConfig(config);
	await fs.mkdir(config.runtimeDir, { recursive: true });
	const databasePath = await canonicalDatabasePath(config.databasePath);
	const serviceLock = await acquireServiceLock(databasePath);
	const engineKey = nkeys.createUser();
	const bridgeKey = nkeys.createUser();
	const engineSeed = engineKey.getSeed();
	const bridgeSeed = bridgeKey.getSeed();
	let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
	let runtime: EngineRuntime | undefined;
	let adapter: NatsEngineAdapter | undefined;
	let bridge: HostedEngineBridge | undefined;
	let controlQuery: EngineControlQueryServer | undefined;
	let retentionTimer: ReturnType<typeof setInterval> | undefined;
	let retentionSweep: Promise<void> | undefined;
	const releaseCapacityGuard = interceptUnhandledRejections(isLateStreamCapacityRejection);
	try {
		const rpc = config.hosted ? new HostedGrimoireRpc(config.hosted) : undefined;
		const artifactRpc =
			config.hosted && (config.childHistoryRetention ?? "local") === "grimoire"
				? new HostedGrimoireRpc({ ...config.hosted, serverUrl: coreMcpUrl(config.hosted.serverUrl) })
				: undefined;
		const providerAdmissionClient = config.hosted
			? new ProviderAdmissionClient(providerAdmissionUrl(config.hosted.serverUrl), config.hosted.token)
			: undefined;
		const providerExecutionClient = config.hosted
			? new ProviderExecutionClient(providerExecutionUrl(config.hosted.serverUrl), config.hosted.token)
			: undefined;
		const profileResolver = config.artifactCacheRoot
			? new EngineProfileResolver(
					config.artifactCacheRoot,
					path.join(config.runtimeDir, "credentials"),
					config.localCredentialDbPath,
					providerAdmissionClient,
					providerExecutionClient,
				)
			: undefined;
		runtime = await EngineRuntime.create({
			databasePath,
			mcpServer: config.hosted ? hostedCoreMcpConfig(config.hosted) : undefined,
			childHistoryTtlMinutes: config.childHistoryTtlMinutes,
			childHistoryRetention: config.childHistoryRetention,
			archiveChildHistory: artifactRpc
				? request => archiveChildHistory(artifactRpc, config.runtimeDir, request)
				: undefined,
			resolveSessionProfile: profileResolver
				? (profile, cwd, signal) => profileResolver.resolve(profile, cwd, signal)
				: undefined,
			resolveSessionContinuation: profileResolver
				? (profile, cwd) => profileResolver.continuationDigest(profile, cwd)
				: undefined,
			launchChild: profileResolver
				? request => {
						if (!runtime) throw new Error("Engine runtime is unavailable");
						return launchLocalEngineChild(runtime, profileResolver, {
							...request,
							deviceId: config.deviceId,
							engineId: config.engineId,
							provisionMailbox: agentInstanceId => adapter?.provisionMailbox(agentInstanceId),
						});
					}
				: undefined,
		});
		await runtime.sweepExpiredChildHistory().catch(reportServiceError);
		retentionTimer = setInterval(() => {
			if (retentionSweep || !runtime) return;
			retentionSweep = runtime
				.sweepExpiredChildHistory()
				.then(() => undefined)
				.catch(reportServiceError)
				.finally(() => {
					retentionSweep = undefined;
				});
		}, 60_000);
		broker = await startBroker(config, engineKey.getPublicKey(), bridgeKey.getPublicKey());
		adapter = await NatsEngineAdapter.connect({
			runtime,
			deviceId: config.deviceId,
			engineId: config.engineId,
			servers: broker.url,
			connectionOptions: { authenticator: nkeyAuthenticator(engineSeed) },
			authorizeCommand: command => {
				if (command.deviceId !== config.deviceId || command.engineId !== config.engineId) {
					throw new Error("Command identity does not match this Engine service");
				}
			},
			authorizeMessage: () => {},
			resolveLaunchProfile: command => resolveLaunchProfile(command, Boolean(profileResolver)),
			onError: reportServiceError,
		});
		controlQuery = await startEngineControlQueryServer({
			runtime,
			runtimeDir: config.runtimeDir,
			deviceId: config.deviceId,
			engineId: config.engineId,
			resolveLaunchProfile: command => resolveLaunchProfile(command, Boolean(profileResolver)),
			provisionMailbox: agentInstanceId => adapter?.provisionMailbox(agentInstanceId),
		});
		if (config.hosted && rpc) {
			bridge = await HostedEngineBridge.connect({
				rpc,
				projectionRpc: new HostedGrimoireRpc({ ...config.hosted, serverUrl: coreMcpUrl(config.hosted.serverUrl) }),
				eventStore: runtime.store,
				deviceId: config.deviceId,
				engineId: config.engineId,
				engineGeneration: runtime.engineGeneration,
				servers: broker.url,
				connectionOptions: { authenticator: nkeyAuthenticator(bridgeSeed) },
				onError: reportServiceError,
			});
		}
		await writeStatus(config, {
			status: "running",
			pid: process.pid,
			engineGeneration: runtime.engineGeneration,
			brokerUrl: broker.url,
			controlQueryEndpoint: controlQuery.endpoint,
			hosted: Boolean(config.hosted),
		});
		const brokerExit = broker.process.exited.then(code => {
			throw new Error(`nats-server exited unexpectedly with code ${code}`);
		});
		await Promise.race([stop ? Promise.race([stop, processStopSignal()]) : processStopSignal(), brokerExit]);
	} finally {
		releaseCapacityGuard();
		if (retentionTimer) clearInterval(retentionTimer);
		await controlQuery?.close().catch(reportServiceError);
		await bridge?.stopAdmission().catch(reportServiceError);
		await adapter?.stopAdmission().catch(reportServiceError);
		await retentionSweep;
		await runtime?.dispose({ closeStore: false }).catch(reportServiceError);
		await adapter?.dispose().catch(reportServiceError);
		await bridge?.drain().catch(reportServiceError);
		await bridge?.dispose().catch(reportServiceError);
		await runtime?.store.close().catch(reportServiceError);
		broker?.process.kill();
		await broker?.process.exited.catch(() => {});
		engineSeed.fill(0);
		bridgeSeed.fill(0);
		engineKey.clear();
		bridgeKey.clear();
		await writeStatus(config, { status: "stopped", pid: process.pid }).catch(() => {});
		await serviceLock.release().catch(reportServiceError);
	}
}

/** Insurance only: stream capacity failures are delivered out of band (failed streams, aborted signal) and no
 * producer is thrown into. A rejection that still escapes carries the shared capacity error; it must not end the
 * whole Engine, but it is a defect worth a warning. Every other unhandled rejection stays fatal. */
export function isLateStreamCapacityRejection(reason: unknown): boolean {
	if (!(reason instanceof StreamAdmissionError)) return false;
	logger.warn("Unhandled stream capacity rejection after its Attempt was interrupted", { limit: reason.limit });
	return true;
}

export async function launchLocalEngineChild(
	runtime: EngineRuntime,
	profileResolver: EngineProfileResolver,
	request: Parameters<NonNullable<EngineRuntimeOptions["launchChild"]>>[0] & {
		deviceId: string;
		engineId: string;
		provisionMailbox?(agentInstanceId: string): void | Promise<void>;
	},
): Promise<EngineChildLaunchResult> {
	request.signal?.throwIfAborted();
	const assignment = request.assignment?.trim();
	if (!assignment) throw new Error("Child assignment is required");
	if (Buffer.byteLength(assignment, "utf8") > MAX_ENGINE_CHILD_ASSIGNMENT_BYTES) {
		throw new Error(`Child assignment exceeds ${MAX_ENGINE_CHILD_ASSIGNMENT_BYTES} bytes`);
	}
	const seed = [request.parentAgentInstanceRef, request.parentAttemptId, request.toolCallId].join("\0");
	const parent = /^(grimoire:\/\/tasks\/[^/]+\/[^/]+)\/agents\/[^/]+$/.exec(request.parentAgentInstanceRef);
	if (!parent) throw new Error("Parent AgentInstanceRef must belong to a Task");
	const agentInstanceRef = `${parent[1]}/agents/agent_${engineRouteToken(seed)}`;
	const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
	const commandId = `cmd_local_${engineRouteToken(`${seed}\0command`)}`;
	const executionId = `exec_local_${engineRouteToken(`${seed}\0execution`)}`;
	const attemptId = `attempt_local_${engineRouteToken(`${seed}\0attempt`)}`;
	const retained = await runtime.store.getStartConversationIdentity(commandId);
	const prior = retained?.serializedCommand
		? (JSON.parse(retained.serializedCommand) as EngineCommandEnvelope)
		: undefined;
	const launchProfile = prior
		? (prior.payload.launchProfile as EngineLaunchProfile)
		: await profileResolver.resolveChildLaunchProfile(request.profileRef, request.maxSpawnDepth);
	const command: EngineCommandEnvelope = {
		schema: "grimoire.engine.command.v1",
		commandId,
		op: "start",
		deviceId: request.deviceId,
		engineId: request.engineId,
		engineGeneration: prior?.engineGeneration ?? runtime.engineGeneration,
		agentInstanceId,
		agentInstanceRef,
		parentAgentInstanceId: request.parentAgentInstanceId,
		parentAgentInstanceRef: request.parentAgentInstanceRef,
		executionId,
		attemptId,
		authorityGeneration: request.authorityGeneration,
		principalId: request.principalId,
		issuedAt: prior?.issuedAt ?? Date.now(),
		payload: {
			input: assignment,
			cwd: request.cwd,
			profileDigest: launchProfile.profileDigest,
			launchProfile,
			localChild: {
				parentAttemptId: request.parentAttemptId,
				toolCallId: request.toolCallId,
				profileRef: request.profileRef,
				maxSpawnDepth: request.maxSpawnDepth,
				workStepId: request.workStepId,
			},
		},
	};
	const cancel = () => {
		void runtime.cancelAgentInstance(agentInstanceId, "Parent task aborted").catch(reportServiceError);
	};
	request.signal?.addEventListener("abort", cancel, { once: true });
	try {
		request.signal?.throwIfAborted();
		await request.enrollChild(agentInstanceRef, attemptId);
		request.signal?.throwIfAborted();
		await runEngineCommand(
			{
				runtime,
				deviceId: request.deviceId,
				engineId: request.engineId,
				resolveLaunchProfile: () => {
					request.signal?.throwIfAborted();
					return launchProfile;
				},
				provisionMailbox: async id => {
					await request.provisionMailbox?.(id);
					request.signal?.throwIfAborted();
				},
			},
			command,
		);
		const result = await runtime.store.waitAttemptResult(agentInstanceId, commandId, attemptId, request.signal);
		if (result.attemptId) await request.enrollChild(agentInstanceRef, result.attemptId);
		return {
			agentInstanceId,
			agentInstanceRef,
			status: result.state === "completed" ? "completed" : result.state === "cancelled" ? "cancelled" : "failed",
			assistantFinal: typeof result.payload.assistantFinal === "string" ? result.payload.assistantFinal : undefined,
			transcriptRef: typeof result.payload.transcriptRef === "string" ? result.payload.transcriptRef : undefined,
			...(result.payload.outputTruncated === true ? { outputTruncated: true } : {}),
			...(result.state === "completed" ? {} : { error: String(result.payload.error ?? result.state) }),
		};
	} catch (error) {
		if (!request.signal?.aborted) throw error;
		await runtime.cancelAgentInstance(agentInstanceId, "Parent task aborted").catch(() => {});
		return { agentInstanceId, agentInstanceRef, status: "cancelled", error: "Parent task aborted" };
	} finally {
		request.signal?.removeEventListener("abort", cancel);
	}
}

async function canonicalDatabasePath(databasePath: string): Promise<string> {
	const resolved = path.resolve(databasePath);
	await fs.mkdir(path.dirname(resolved), { recursive: true });
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved));
	}
}

async function acquireServiceLock(databasePath: string): Promise<{ release(): Promise<void> }> {
	const lockDir = `${databasePath}.engine.lock`;
	const ownerPath = path.join(lockDir, "owner.json");
	const nonce = randomUUID();
	for (;;) {
		const candidate = `${lockDir}.${process.pid}.${nonce}.tmp`;
		await fs.mkdir(candidate);
		await fs.writeFile(
			path.join(candidate, "owner.json"),
			JSON.stringify({ pid: process.pid, nonce, databasePath }),
			"utf8",
		);
		try {
			await fs.rename(candidate, lockDir);
			return {
				async release() {
					const owner = await readLockOwner(ownerPath);
					if (owner?.pid === process.pid && owner.nonce === nonce) {
						await fs.rm(lockDir, { recursive: true, force: true });
					}
				},
			};
		} catch (error) {
			await fs.rm(candidate, { recursive: true, force: true });
			if (!isAlreadyExists(error)) throw error;
			const owner = await readLockOwner(ownerPath);
			if (owner && pidAlive(owner.pid)) {
				throw new Error(`Agent Engine database is already owned by pid ${owner.pid}`);
			}
			const stale = `${lockDir}.stale.${process.pid}.${randomUUID()}`;
			try {
				await fs.rename(lockDir, stale);
			} catch (renameError) {
				if (
					isAlreadyExists(renameError) ||
					(renameError instanceof Error && "code" in renameError && renameError.code === "ENOENT")
				) {
					continue;
				}
				throw renameError;
			}
			await fs.rm(stale, { recursive: true, force: true });
		}
	}
}

async function readLockOwner(ownerPath: string): Promise<{ pid: number; nonce: string } | undefined> {
	try {
		const value = JSON.parse(await fs.readFile(ownerPath, "utf8")) as Record<string, unknown>;
		return typeof value.nonce === "string" && Number.isSafeInteger(value.pid)
			? { pid: Number(value.pid), nonce: value.nonce }
			: undefined;
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isAlreadyExists(error: unknown): boolean {
	return error instanceof Error && "code" in error && ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code));
}

function validateConfig(config: EngineServiceConfig): void {
	for (const [name, value] of Object.entries({
		deviceId: config.deviceId,
		engineId: config.engineId,
		runtimeDir: config.runtimeDir,
		databasePath: config.databasePath,
		natsServerPath: config.natsServerPath,
	})) {
		if (!value.trim()) throw new Error(`${name} is required`);
	}
	if (
		!path.isAbsolute(config.runtimeDir) ||
		!path.isAbsolute(config.databasePath) ||
		!path.isAbsolute(config.natsServerPath)
	) {
		throw new Error("runtimeDir, databasePath and natsServerPath must be absolute paths");
	}
	if (path.resolve(config.runtimeDir) === path.parse(path.resolve(config.runtimeDir)).root) {
		throw new Error("runtimeDir cannot be a filesystem root");
	}
	const ttl = config.childHistoryTtlMinutes ?? 60;
	if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 525_600) {
		throw new Error("childHistoryTtlMinutes must be an integer between 1 and 525600");
	}
	const retention = config.childHistoryRetention ?? "local";
	if (retention !== "local" && retention !== "off" && retention !== "grimoire") {
		throw new Error("childHistoryRetention must be local, off or grimoire");
	}
	if (retention === "grimoire" && !config.hosted) {
		throw new Error("childHistoryRetention=grimoire requires the hosted ClientHost bridge");
	}
}

export function hostedCoreMcpConfig(hosted: NonNullable<EngineServiceConfig["hosted"]>): MCPHttpServerConfig {
	return {
		type: "http",
		url: coreMcpUrl(hosted.serverUrl),
		headerPolicy: "origin-locked",
		headers: {
			Authorization: `Bearer ${hosted.token}`,
			"X-Grimoire-Client": hosted.clientId,
			"X-Grimoire-Client-Name": "grimoire-agent-engine",
			"X-Grimoire-Client-Version": hosted.clientVersion ?? "0.4.0",
			"X-Grimoire-Client-Surface": "agent_engine_bridge",
			"X-Grimoire-Client-Protocol-Version": hosted.protocolVersion ?? "2026-08-01",
			...(hosted.sourceSignature ? { "X-Grimoire-Client-Source-Signature": hosted.sourceSignature } : {}),
		},
	};
}

export function coreMcpUrl(serverUrl: string): string {
	const url = new URL(serverUrl);
	const pathname = url.pathname.replace(/\/+$/, "");
	if (/\/mcp\/(?:client_agents|core)$/i.test(pathname)) {
		url.pathname = pathname.replace(/\/(?:client_agents|core)$/i, "/core");
	} else if (/\/mcp$/i.test(pathname)) {
		url.pathname = `${pathname}/core`;
	} else {
		url.pathname = `${pathname}/mcp/core`;
	}
	return url.toString();
}

export function providerAdmissionUrl(serverUrl: string): string {
	const url = new URL(serverUrl);
	const pathname = url.pathname.replace(/\/+$/, "");
	url.pathname = /\/mcp\/(?:client_agents|core)$/i.test(pathname)
		? pathname.replace(/\/mcp\/(?:client_agents|core)$/i, "/provider-admission")
		: `${pathname}/provider-admission`;
	return url.toString();
}

export function providerExecutionUrl(serverUrl: string): string {
	const url = new URL(serverUrl);
	const pathname = url.pathname.replace(/\/+$/, "");
	url.pathname = /\/mcp\/(?:client_agents|core)$/i.test(pathname)
		? pathname.replace(/\/mcp\/(?:client_agents|core)$/i, "/provider-execution")
		: `${pathname}/provider-execution`;
	return url.toString();
}

export async function archiveChildHistory(
	rpc: HostedGrimoireRpc,
	runtimeDir: string,
	request: {
		agentInstanceId: string;
		agentInstanceRef: string;
		attemptId: string;
		terminalAt: number;
		content: string;
	},
): Promise<void> {
	const match = /^grimoire:\/\/tasks\/([^/]+)\/([^/]+)\/agents\/([^/]+)$/.exec(request.agentInstanceRef);
	if (!match) throw new Error("Child AgentInstanceRef cannot be scoped to a Grimoire Task");
	const [, projectId, taskId] = match;
	const rawHash = new Bun.CryptoHasher("sha256").update(request.content).digest("hex");
	const compressed = Bun.gzipSync(new TextEncoder().encode(request.content));
	const contentHash = `sha256:${new Bun.CryptoHasher("sha256").update(compressed).digest("hex")}`;
	const archiveKey = new Bun.CryptoHasher("sha256")
		.update(`${request.agentInstanceRef}\0${request.attemptId}\0${rawHash}`)
		.digest("hex");
	const tempDir = path.join(runtimeDir, "child-history-archive");
	const sourcePath = path.join(tempDir, `${rawHash}.jsonl.gz`);
	await fs.mkdir(tempDir, { recursive: true });
	await fs.writeFile(sourcePath, compressed);
	try {
		const result = await rpc.call("grimoire_artifact_import", {
			project_id: projectId,
			task_id: taskId,
			source_path: sourcePath,
			role: "agent_transcript",
			kind: "grimoire.agent_session_history.v1",
			media_type: "application/gzip",
			summary: `Expired child OMP transcript for ${request.agentInstanceId}`,
			visibility: "private",
			idempotency_key: `child-history-${archiveKey}`,
			technical_metadata: {
				schema: "grimoire.agent_session_history.v1",
				agent_instance_ref: request.agentInstanceRef,
				attempt_id: request.attemptId,
				terminal_at: new Date(request.terminalAt).toISOString(),
				encoding: "gzip",
				source_media_type: "application/x-ndjson",
				source_content_hash: `sha256:${rawHash}`,
			},
		});
		const artifact = result.artifact as Record<string, unknown> | undefined;
		if (
			!artifact ||
			typeof artifact.artifact_ref !== "string" ||
			artifact.content_hash !== contentHash ||
			Number(artifact.size_bytes) !== compressed.byteLength
		) {
			throw new Error("Grimoire child-history upload was not hash-verified");
		}
	} finally {
		await fs.rm(sourcePath, { force: true });
	}
}

async function startBroker(config: EngineServiceConfig, engineNkey: string, bridgeNkey: string) {
	const portsDir = path.join(config.runtimeDir, "ports");
	const storeDir = path.join(config.runtimeDir, "jetstream");
	const configPath = path.join(config.runtimeDir, "nats.conf");
	await fs.rm(portsDir, { recursive: true, force: true });
	await Promise.all([fs.mkdir(portsDir, { recursive: true }), fs.mkdir(storeDir, { recursive: true })]);
	await fs.writeFile(configPath, natsConfig(storeDir, engineNkey, bridgeNkey), "utf8");
	const process = Bun.spawn([config.natsServerPath, "-c", configPath, "--ports_file_dir", portsDir], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	try {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const files = await Array.fromAsync(new Bun.Glob("*.ports").scan({ cwd: portsDir, onlyFiles: true }));
			if (files[0]) {
				const manifest = (await Bun.file(path.join(portsDir, files[0])).json()) as { nats?: string[] };
				if (manifest.nats?.[0]) return { process, url: manifest.nats[0] };
			}
			if (process.exitCode !== null) {
				const stderr = await new Response(process.stderr).text();
				throw new Error(`nats-server failed with code ${process.exitCode}: ${stderr.trim().slice(-500)}`);
			}
			if (Date.now() >= deadline) throw new Error("nats-server did not become ready within 10 seconds");
			await Bun.sleep(25);
		}
	} catch (error) {
		process.kill();
		await process.exited.catch(() => {});
		throw error;
	}
}

export function natsConfig(storeDir: string, engineNkey: string, bridgeNkey: string): string {
	const eventSubjects = ["grimoire.engine.v1.d.*.e.*.a.*.evt.*"];
	const commandSubjects = ["grimoire.engine.v1.d.*.e.*.a.*.cmd.*"];
	const messageSubjects = ["grimoire.agent.v1.d.*.to.*.from.*.msg"];
	const apiSubjects = ["$JS.API.>", "$JS.ACK.>", "_INBOX.>"];
	return [
		"listen: 127.0.0.1:-1",
		"jetstream {",
		`  store_dir: ${JSON.stringify(storeDir)}`,
		"  max_file_store: 805306368",
		"}",
		"authorization {",
		"  users: [",
		`${userConfig(engineNkey, [...apiSubjects, ...eventSubjects], [...apiSubjects, ...commandSubjects, ...messageSubjects])},`,
		userConfig(
			bridgeNkey,
			[...apiSubjects, ...commandSubjects, ...messageSubjects],
			[...apiSubjects, ...eventSubjects],
		),
		"  ]",
		"}",
		"",
	].join("\n");
}

function userConfig(nkey: string, publish: string[], subscribe: string[]): string {
	return [
		"    {",
		`      nkey: ${JSON.stringify(nkey)}`,
		"      permissions: {",
		`        publish: ${JSON.stringify(publish)}`,
		`        subscribe: ${JSON.stringify(subscribe)}`,
		"      }",
		"    }",
	].join("\n");
}

function resolveLaunchProfile(command: EngineCommandEnvelope, requireArtifactRef = false): EngineLaunchProfile {
	const value = command.payload.launchProfile;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("start command has no launchProfile");
	const profile = value as unknown as EngineLaunchProfile;
	if (profile.spawns !== "" && profile.spawns !== "*") throw new Error("launchProfile.spawns must be empty or *");
	if (typeof profile.profileDigest !== "string" || profile.profileDigest !== command.payload.profileDigest) {
		throw new Error("launchProfile digest does not match the command");
	}
	if (
		profile.launchProfileRef !== undefined &&
		!/^gctx:[23456789abcdefghjkmnpqrstuvwxyz]{16}$/.test(profile.launchProfileRef)
	) {
		throw new Error("launchProfileRef must be a gctx Artifact ref");
	}
	if (requireArtifactRef && !profile.launchProfileRef) {
		throw new EngineTargetError(
			"invalid_request",
			"launchProfileRef is required for artifact-backed Engine profiles",
		);
	}
	if (
		profile.maxSpawnDepth !== undefined &&
		(!Number.isSafeInteger(profile.maxSpawnDepth) || profile.maxSpawnDepth < 0 || profile.maxSpawnDepth > 31)
	) {
		throw new Error("maxSpawnDepth must be an integer between 0 and 31");
	}
	if (
		profile.maxChildren !== undefined &&
		(!Number.isSafeInteger(profile.maxChildren) || profile.maxChildren < 0 || profile.maxChildren > 256)
	) {
		throw new Error("maxChildren must be an integer between 0 and 256");
	}
	const childProfileRefs = profile.childProfileRefs ?? [];
	if (
		!Array.isArray(childProfileRefs) ||
		childProfileRefs.some(
			ref => typeof ref !== "string" || !/^gctx:[23456789abcdefghjkmnpqrstuvwxyz]{16}$/.test(ref),
		) ||
		new Set(childProfileRefs).size !== childProfileRefs.length
	) {
		throw new Error("childProfileRefs must be a unique array of gctx Artifact refs");
	}
	const maxSpawnDepth = profile.maxSpawnDepth ?? 0;
	const maxChildren = profile.maxChildren ?? 0;
	if (
		(profile.spawns === "*") !== (maxSpawnDepth > 0 && maxChildren > 0 && childProfileRefs.length > 0) ||
		(profile.spawns === "" && (maxSpawnDepth !== 0 || maxChildren !== 0 || childProfileRefs.length !== 0))
	) {
		throw new Error("spawn rights require depth, maxChildren and an explicit childProfileRefs catalog");
	}
	if (
		profile.systemPrompt !== undefined &&
		(typeof profile.systemPrompt !== "string" || profile.systemPrompt.length > 262_144)
	) {
		throw new Error("systemPrompt must be a string no larger than 262144 characters");
	}
	if (
		profile.providerPromptCacheKey !== undefined &&
		(typeof profile.providerPromptCacheKey !== "string" ||
			!profile.providerPromptCacheKey.trim() ||
			profile.providerPromptCacheKey.length > 512)
	) {
		throw new Error("providerPromptCacheKey must contain 1..512 characters");
	}
	if (
		profile.thinkingLevel !== undefined &&
		!["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.thinkingLevel)
	) {
		throw new Error("thinkingLevel is invalid");
	}
	if (profile.minimumThinkingLevel !== undefined && profile.minimumThinkingLevel !== "high") {
		throw new Error("minimumThinkingLevel must be high");
	}
	if (profile.requireYieldTool !== undefined && typeof profile.requireYieldTool !== "boolean") {
		throw new Error("requireYieldTool must be a boolean");
	}
	if (profile.lspShared !== undefined && typeof profile.lspShared !== "boolean") {
		throw new Error("lspShared must be a boolean");
	}
	if (profile.disabledCapabilityProviders !== undefined) {
		if (
			!Array.isArray(profile.disabledCapabilityProviders) ||
			profile.disabledCapabilityProviders.some(
				provider => typeof provider !== "string" || !provider.trim() || provider.length > 128,
			)
		) {
			throw new Error("disabledCapabilityProviders must contain non-empty provider ids");
		}
	}
	if (profile.toolPolicies !== undefined) {
		if (!profile.toolPolicies || typeof profile.toolPolicies !== "object" || Array.isArray(profile.toolPolicies)) {
			throw new Error("toolPolicies must be an object");
		}
		for (const [toolName, policy] of Object.entries(profile.toolPolicies)) {
			if (!toolName.trim() || toolName.length > 128)
				throw new Error("toolPolicies keys must contain 1..128 characters");
			if (policy !== "unrestricted" && policy !== "tracked" && policy !== "permit") {
				throw new Error(`toolPolicies.${toolName} must be unrestricted, tracked or permit`);
			}
		}
	}
	if (profile.outputSchema !== undefined) {
		if (!profile.outputSchema || typeof profile.outputSchema !== "object" || Array.isArray(profile.outputSchema)) {
			throw new Error("outputSchema must be an object");
		}
		if (!profile.requireYieldTool) throw new Error("outputSchema requires requireYieldTool");
		if (JSON.stringify(profile.outputSchema).length > 262_144) {
			throw new Error("outputSchema must be no larger than 262144 characters");
		}
	}
	return profile;
}

async function writeStatus(config: EngineServiceConfig, value: Record<string, unknown>): Promise<void> {
	const statusPath = path.join(config.runtimeDir, "status.json");
	const tempPath = `${statusPath}.${process.pid}.tmp`;
	await fs.writeFile(tempPath, JSON.stringify(engineServiceStatus(config, value), null, 2), "utf8");
	await fs.rename(tempPath, statusPath);
}

export function engineServiceStatus(
	config: EngineServiceConfig,
	value: Record<string, unknown>,
): Record<string, unknown> {
	return {
		schema: "grimoire.agent_engine.service_status.v1",
		deviceId: config.deviceId,
		engineId: config.engineId,
		hostname: os.hostname(),
		updatedAt: new Date().toISOString(),
		...value,
		childHistoryTtlMinutes: config.childHistoryTtlMinutes ?? 60,
		childHistoryRetention: config.childHistoryRetention ?? "local",
	};
}

function processStopSignal(): Promise<void> {
	return new Promise(resolve => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
}

function reportServiceError(error: unknown): void {
	process.stderr.write(`[agent-engine] ${error instanceof Error ? error.message : String(error)}\n`);
}
