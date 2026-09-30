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
import { type EngineApprovalDecision, type EngineSemanticBindingSnapshot, EngineBindingPendingError, EngineRoutingQueuedError, EngineTargetError, MAX_ENGINE_CHILD_ASSIGNMENT_BYTES, sameSemanticBinding, validateSemanticBinding } from "./contracts";
import { type EngineControlQueryServer, runEngineCommand, startEngineControlQueryServer, validateEngineCommand } from "./control-query";
import { HostedBridgeUnavailableError, HostedEngineBridge, HostedGrimoireRpc } from "./hosted-bridge";
import { NatsEngineAdapter } from "./nats-adapter";
import { EngineExecutionResolver } from "./execution-resolver";
import { ProviderAdmissionClient } from "./provider-admission";
import { ProviderExecutionClient } from "./provider-execution";
import { engineAgentInstanceId } from "./route";
import { EngineRuntime, type ApprovalAncestor, type EngineRuntimeOptions } from "./runtime";
import { waitForEngineWake } from "./wake";

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
		/** Actual installed ClientHost package sequence; Core owns the B0/B1 floor. */
		installedSequence?: number;
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
		const providerAdmissionClient = config.hosted
			? new ProviderAdmissionClient(providerAdmissionUrl(config.hosted.serverUrl), config.hosted.token)
			: undefined;
		const providerExecutionClient = config.hosted
			? new ProviderExecutionClient(providerExecutionUrl(config.hosted.serverUrl), config.hosted.token)
			: undefined;
		const executionResolver = new EngineExecutionResolver(
			path.join(config.runtimeDir, "credentials"),
			config.localCredentialDbPath,
			providerAdmissionClient,
			providerExecutionClient,
		);
		runtime = await EngineRuntime.create({
			databasePath,
			deviceId: config.deviceId,
			mcpServer: config.hosted ? hostedCoreMcpConfig(config.hosted) : undefined,
			childHistoryTtlMinutes: config.childHistoryTtlMinutes,
			childHistoryRetention: config.childHistoryRetention,
			resolveExecution: (execution, frozen, attempt, cwd, signal) =>
				executionResolver.resolve(execution, frozen, attempt, cwd, signal),
			verifyOriginReceipt: rpc
				? async identity => {
						let verified: Record<string, unknown>;
						try {
							verified = await rpc.call("verify_origin_receipt", identity);
						} catch (error) {
							if (error instanceof HostedBridgeUnavailableError)
								throw new EngineBindingPendingError("Origin verification outcome is unknown; retry exact command");
							throw error;
						}
						if (verified.verified !== true ||
							(["originReceiptId", "commandId", "agentInstanceRef", "attemptId", "principalId"] as const)
								.some(key => verified[key] !== identity[key]) ||
							(typeof verified.dispatchHash !== "string" && typeof verified.commandHash !== "string") ||
							typeof verified.authContextId !== "string" ||
							(typeof verified.dispatchHash === "string" && !verified.bindingSnapshot))
							throw new EngineTargetError("stale_target", "Origin receipt verification returned a different command");
						return verified as unknown as {
							verified: true;
							dispatchHash?: string;
							commandHash?: string;
							bindingSnapshot?: EngineSemanticBindingSnapshot;
							authContextId: string;
							approvalSettings: { timeout_seconds: number; settings_revision: number; settings_hash: string } | null;
							specialApproval: { kind: "consultant"; unavailable_pin: unknown; proposed_reselection_hash: string } | null;
						};
					}
				: undefined,
			verifyApprovalReceipt: rpc
				? async identity => {
						const verified = await rpc.call("verify_approval_receipt", identity);
						if (verified.verified !== true || !verified.approvalDecision ||
							(verified.expectedInputRevision !== null &&
								(!Number.isSafeInteger(verified.expectedInputRevision) || Number(verified.expectedInputRevision) < 0)) ||
							!("expectedInputRevision" in verified))
							throw new EngineTargetError("stale_target", "Approval receipt verification returned no captured decision or input revision");
						return verified as unknown as { verified: true; approvalDecision: EngineApprovalDecision["approvalDecision"]; expectedInputRevision: number | null };
					}
				: undefined,
			approvalAncestor: rpc
				? async identity => await rpc.call("approval_origin", { action: "ancestor", ...identity })
					as unknown as ApprovalAncestor
				: undefined,
			reserveChild: rpc
				? async request => {
						const { signal, ...identity } = request;
						const reserved = await rpc.call("prepare_child_start", { ...identity, reserve: true }, signal);
						if (reserved.reserved !== true || typeof reserved.admission_id !== "string" ||
							typeof reserved.child_dispatch_hash !== "string" ||
							typeof reserved.ceiling_hash !== "string" ||
							!Number.isSafeInteger(reserved.requested_depth) ||
							!Number.isSafeInteger(reserved.requested_child_ordinal) ||
							!Array.isArray(reserved.exceeded))
							throw new EngineTargetError("stale_target", "Child reserve lacks exact approval subject");
						return reserved as unknown as {
							admission_id: string; child_dispatch_hash: string;
							requested_depth: number; requested_child_ordinal: number;
							exceeded: Array<"max_depth" | "max_children">; ceiling_hash: string;
						};
					}
				: undefined,
			launchChild: rpc
				? request => {
						if (!runtime) throw new Error("Engine runtime is unavailable");
						return launchLocalEngineChild(runtime, rpc, {
							...request,
							deviceId: config.deviceId,
							engineId: config.engineId,
							provisionMailbox: id => adapter?.provisionMailbox(id),
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
			onError: reportServiceError,
		});
		controlQuery = await startEngineControlQueryServer({
			runtime,
			runtimeDir: config.runtimeDir,
			deviceId: config.deviceId,
			engineId: config.engineId,
			provisionMailbox: agentInstanceId => adapter?.provisionMailbox(agentInstanceId),
		});
		if (config.hosted && rpc) {
			bridge = await HostedEngineBridge.connect({
				rpc,
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
	rpc: HostedGrimoireRpc,
	request: Parameters<NonNullable<EngineRuntimeOptions["launchChild"]>>[0] & {
		deviceId: string;
		engineId: string;
		provisionMailbox?(agentInstanceId: string): void | Promise<void>;
	},
): Promise<EngineChildLaunchResult> {
	request.signal?.throwIfAborted();
	const assignment = request.assignment.trim();
	if (!assignment || Buffer.byteLength(assignment, "utf8") > MAX_ENGINE_CHILD_ASSIGNMENT_BYTES)
		throw new EngineTargetError("invalid_request", "Child assignment must contain 1..32768 UTF-8 bytes");
	validateSemanticBinding(request.parentBindingSnapshot, request.parentAgentInstanceRef);
	if (!request.principalId)
		throw new EngineTargetError("invalid_request", "Child launch requires the admitted principal");
	if (!request.target.task_ref || (request.target.work_step_id !== null && !request.target.work_step_id))
		throw new EngineTargetError("invalid_request", "Child launch requires a real Task or WorkStep");
	const prepared = await rpc.call("prepare_child_start", {
		parentAgentInstanceRef: request.parentAgentInstanceRef,
		parentAttemptId: request.parentAttemptId,
		parentBindingSnapshot: request.parentBindingSnapshot,
		principalId: request.principalId,
		authorityGeneration: request.authorityGeneration,
		target: request.target,
		assignment,
		toolCallId: request.toolCallId,
		cwd: request.cwd,
		...(request.spawnApprovalReceiptId ? { spawnApprovalReceiptId: request.spawnApprovalReceiptId } : {}),
	}, request.signal);
	const command = validateEngineCommand(prepared.command);
	const agentInstanceRef = prepared.agentInstanceRef;
	const agentInstanceId = prepared.agentInstanceId;
	const attemptId = command.attemptId;
	if (typeof agentInstanceRef !== "string" || typeof agentInstanceId !== "string" ||
		typeof attemptId !== "string" || command.op !== "start" ||
		command.agentInstanceRef !== agentInstanceRef || command.agentInstanceId !== agentInstanceId ||
		engineAgentInstanceId(agentInstanceRef) !== agentInstanceId ||
		command.parentAgentInstanceId !== request.parentAgentInstanceId ||
		command.parentAgentInstanceRef !== request.parentAgentInstanceRef ||
		command.bindingSnapshot?.taskRef !== request.target.task_ref ||
		command.bindingSnapshot?.workStepId !== request.target.work_step_id ||
		command.bindingSnapshot?.parentAttemptId !== request.parentAttemptId ||
		command.bindingSnapshot?.parentBindingRevision !== request.parentBindingSnapshot.bindingRevision ||
		command.principalId !== request.principalId ||
		command.authorityGeneration !== request.authorityGeneration ||
		command.deviceId !== request.deviceId || command.engineId !== request.engineId ||
		!sameSemanticBinding(prepared.bindingSnapshot as EngineSemanticBindingSnapshot, command.bindingSnapshot))
		throw new EngineTargetError("stale_target", "Prepared child Start differs from the parent or requested target");
	const cancellationTarget = {
		agentInstanceId, executionId: command.executionId!, attemptId, commandId: command.commandId,
		authorityGeneration: request.authorityGeneration, engineGeneration: runtime.engineGeneration,
		principalId: request.principalId,
	};
	const cancel = () => {
		void runtime.cancelAgentInstance(cancellationTarget, "Parent task aborted").catch(reportServiceError);
	};
	request.signal?.addEventListener("abort", cancel, { once: true });
	try {
		request.signal?.throwIfAborted();
		await request.enrollChild(agentInstanceRef, attemptId);
		const runner = {
			runtime,
			deviceId: request.deviceId,
			engineId: request.engineId,
			provisionMailbox: async (id: string) => {
				await request.provisionMailbox?.(id);
				request.signal?.throwIfAborted();
			},
		};
		for (;;) {
			request.signal?.throwIfAborted();
			try {
				await runEngineCommand(runner, command);
				break;
			} catch (error) {
				if (!(error instanceof EngineBindingPendingError || error instanceof EngineRoutingQueuedError)) throw error;
				await waitForEngineWake(runtime.store.changeSignal(), 1_000, request.signal);
			}
		}
		const result = await runtime.store.waitAttemptResult(agentInstanceId, command.commandId, attemptId, request.signal);
		if (result.attemptId) await request.enrollChild(agentInstanceRef, result.attemptId);
		return {
			agentInstanceId,
			agentInstanceRef,
			status: result.state === "completed" ? "completed" : result.state === "cancelled" ? "cancelled" : "failed",
			assistantFinal: typeof result.payload.assistantFinal === "string" ? result.payload.assistantFinal : undefined,
			...(result.state === "completed" && result.payload.structuredOutput
				? { structuredOutput: result.payload.structuredOutput as EngineChildLaunchResult["structuredOutput"] }
				: {}),
			transcriptRef: typeof result.payload.transcriptRef === "string" ? result.payload.transcriptRef : undefined,
			...(result.payload.outputTruncated === true ? { outputTruncated: true } : {}),
			...(result.state === "completed" ? {} : { error: String(result.payload.error ?? result.state) }),
		};
	} catch (error) {
		if (!request.signal?.aborted) throw error;
		await runtime.cancelAgentInstance(cancellationTarget, "Parent task aborted");
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
			"X-Grimoire-Client-Features": '["grimoire.task.v5","agent_binding.v1","grimoire.dispatch.v2"]',
			...(hosted.installedSequence !== undefined
				? { "X-Grimoire-Client-Installed-Sequence": String(hosted.installedSequence) } : {}),
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
