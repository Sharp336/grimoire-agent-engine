import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { engineHelp as commandHelp } from "../cli/command-help";
import {
	EngineControlQueryClient,
	type EngineControlQueryMethod,
	type EnginePublicSnapshot,
} from "../engine/control-query";
import type { EngineCommandEnvelope, EngineCommandOp } from "../engine/nats-adapter";
import { runEngineService } from "../engine/service";

export default class Engine extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Engine lifecycle, diagnostics, query or control action",
			required: false,
			options: [
				"start",
				"serve",
				"status",
				"stop",
				"restart",
				"capabilities",
				"doctor",
				"snapshots",
				"show",
				"events",
				"result",
				"pause",
				"resume",
				"cancel",
				"steer",
				"approve",
				"deny",
				"reconcile",
				"request",
			],
		}),
	};
	static flags = {
		device: Flags.string({ description: "Stable device id" }),
		"engine-id": Flags.string({ description: "Stable Engine id" }),
		"runtime-dir": Flags.string({ description: "Engine runtime directory" }),
		database: Flags.string({ description: "Engine SQLite path" }),
		"nats-server": Flags.string({ description: "Absolute nats-server executable path" }),
		"artifact-cache": Flags.string({ description: "ClientHost Artifact cache directory" }),
		"child-history-ttl-minutes": Flags.integer({
			description: "Delete terminal child OMP history after this many minutes",
			min: 1,
			max: 525_600,
		}),
		"child-history-retention": Flags.string({
			description: "Child OMP history at TTL: off deletes locally; grimoire archives then deletes",
			options: ["off", "grimoire"],
		}),
		"server-url": Flags.string({ description: "Hosted Grimoire base URL" }),
		"token-env": Flags.string({ description: "Environment variable containing the hosted bearer token" }),
		"client-id": Flags.string({ description: "Hosted Grimoire client id" }),
		"no-hosted": Flags.boolean({ description: "Run the local Engine without the hosted bridge" }),
		attempt: Flags.string({ description: "Exact Attempt id" }),
		text: Flags.string({ description: "Steering text" }),
		reason: Flags.string({ description: "Cancellation or approval reason" }),
		approval: Flags.string({ description: "Tool approval id" }),
		"command-id": Flags.string({ description: "Caller-stable idempotency key" }),
		cursor: Flags.string({ description: "Opaque query cursor" }),
		limit: Flags.integer({ description: "Query page size", min: 1, max: 1000 }),
		method: Flags.string({ description: "Exact Control + Query method for engine request" }),
		params: Flags.string({ description: "JSON object params for engine request" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Engine);
		if (!args.action) {
			renderCommandHelp("omp", "engine", Engine);
			return;
		}
		const runtimeDir = path.resolve(flags["runtime-dir"] ?? path.join(getAgentDir(), "engine"));
		if (
			[
				"capabilities",
				"doctor",
				"snapshots",
				"show",
				"events",
				"result",
				"pause",
				"resume",
				"cancel",
				"steer",
				"approve",
				"deny",
				"reconcile",
				"request",
			].includes(args.action)
		) {
			await runControlQueryAction(runtimeDir, args.action, flags);
			return;
		}
		if (args.action === "status") {
			process.stdout.write(`${JSON.stringify(await readStatus(runtimeDir), null, 2)}\n`);
			return;
		}
		if (args.action === "stop" || args.action === "restart") {
			await requestStop(runtimeDir);
			if (args.action === "stop") return;
		}
		if (args.action === "start" || args.action === "restart") {
			await startDetached(runtimeDir);
			return;
		}
		const tokenEnv = flags["token-env"] ?? "GRIMOIRE_ACCESS_TOKEN";
		const serverUrl = flags["server-url"] ?? process.env.GRIMOIRE_SERVER_URL;
		const token = process.env[tokenEnv] ?? process.env.GRIMOIRE_TOKEN ?? process.env.GRIMOIRE_OIDC_BEARER_TOKEN;
		const defaultArtifactCacheRoot = process.env.LOCALAPPDATA
			? path.join(process.env.LOCALAPPDATA, "Grimoire", "offline-cache", "default", "artifacts")
			: undefined;
		if (!flags["no-hosted"] && (!serverUrl || !token)) {
			throw new Error(`Hosted mode requires --server-url and a bearer token in ${tokenEnv}`);
		}
		const stopPath = path.join(runtimeDir, "stop.request");
		await fs.rm(stopPath, { force: true });
		await runEngineService(
			{
				deviceId: flags.device ?? os.hostname(),
				engineId: flags["engine-id"] ?? "grimoire-agent-engine",
				runtimeDir,
				databasePath: path.resolve(flags.database ?? path.join(runtimeDir, "engine.sqlite")),
				natsServerPath: path.resolve(
					flags["nats-server"] ??
						process.env.GRIMOIRE_NATS_SERVER ??
						path.join(process.env.LOCALAPPDATA ?? "", "Grimoire", "bin", "nats-server.exe"),
				),
				artifactCacheRoot: flags["artifact-cache"]
					? path.resolve(flags["artifact-cache"])
					: process.env.GRIMOIRE_CLIENT_ARTIFACT_CACHE_ROOT
						? path.resolve(process.env.GRIMOIRE_CLIENT_ARTIFACT_CACHE_ROOT)
						: defaultArtifactCacheRoot,
				childHistoryTtlMinutes: flags["child-history-ttl-minutes"] ?? 60,
				childHistoryRetention: (flags["child-history-retention"] ?? "off") as "off" | "grimoire",
				hosted:
					flags["no-hosted"] || !serverUrl || !token
						? undefined
						: {
								serverUrl,
								token,
								clientId:
									flags["client-id"] ?? process.env.GRIMOIRE_CLIENT_ID ?? `agent-engine:${os.hostname()}`,
								clientVersion: process.env.GRIMOIRE_CLIENT_VERSION,
								protocolVersion: process.env.GRIMOIRE_CLIENT_PROTOCOL_VERSION,
								sourceSignature: process.env.GRIMOIRE_CLIENT_SOURCE_SIGNATURE,
							},
			},
			waitForStopRequest(stopPath),
		);
	}
}

interface EngineControlFlags {
	attempt?: string;
	text?: string;
	reason?: string;
	approval?: string;
	"command-id"?: string;
	cursor?: string;
	limit?: number;
	method?: string;
	params?: string;
}

async function runControlQueryAction(runtimeDir: string, action: string, flags: EngineControlFlags): Promise<void> {
	const client = new EngineControlQueryClient(runtimeDir);
	if (action === "request") {
		const method = requiredFlag(flags.method, "--method") as EngineControlQueryMethod;
		const params = flags.params ? JSON.parse(flags.params) : undefined;
		if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params))) {
			throw new Error("--params must be a JSON object");
		}
		return printJson(await client.request(method, params as Record<string, unknown> | undefined));
	}
	if (action === "capabilities") return printJson(await client.request("capabilities"));
	if (action === "doctor") {
		return printJson({ status: await readStatus(runtimeDir), capabilities: await client.request("capabilities") });
	}
	if (action === "snapshots") {
		return printJson(await client.request("snapshots.list", { cursor: flags.cursor, limit: flags.limit }));
	}
	const attemptId = flags.attempt?.trim();
	if (!attemptId) throw new Error(`engine ${action} requires --attempt`);
	if (action === "show") return printJson(await client.request("snapshots.get", { attemptId }));
	if (action === "events") {
		return printJson(await client.request("events.list", { attemptId, cursor: flags.cursor, limit: flags.limit }));
	}
	if (action === "result") return printJson(await client.request("result.get", { attemptId }));

	const snapshot = (await client.request("snapshots.get", { attemptId })) as EnginePublicSnapshot | undefined;
	if (!snapshot) throw new Error(`Attempt ${attemptId} was not found`);
	const capabilities = (await client.request("capabilities")) as Record<string, unknown>;
	const op = commandOperation(action);
	const payload: Record<string, unknown> = {};
	if (op === "pause" || op === "resume") payload.initiator = { kind: "human" };
	if (op === "steer") payload.text = requiredFlag(flags.text, "--text");
	if (op === "cancel" && flags.reason) payload.reason = flags.reason;
	if (op === "resolve_tool_approval") {
		payload.approvalId = requiredFlag(flags.approval, "--approval");
		payload.decision = action;
		if (flags.reason) payload.reason = flags.reason;
	}
	const command: EngineCommandEnvelope = {
		schema: "grimoire.engine.command.v1",
		commandId: flags["command-id"]?.trim() || randomUUID(),
		op,
		deviceId: String(capabilities.deviceId),
		engineId: String(capabilities.engineId),
		engineGeneration: snapshot.engineGeneration,
		agentInstanceId: snapshot.agentInstanceId,
		runtimeBindingId: snapshot.bindingId,
		bindingGeneration: snapshot.bindingGeneration,
		executionId: snapshot.executionId,
		attemptId: snapshot.attemptId,
		authorityGeneration: snapshot.authorityGeneration,
		issuedAt: Date.now(),
		payload,
	};
	const receipt = await client.request("command", { command });
	printJson({ receipt, snapshot: await client.request("snapshots.get", { attemptId }) });
}

function commandOperation(action: string): EngineCommandOp {
	if (action === "approve" || action === "deny") return "resolve_tool_approval";
	if (["pause", "resume", "cancel", "steer", "reconcile"].includes(action)) return action as EngineCommandOp;
	throw new Error(`Unsupported Engine control action ${action}`);
}

function requiredFlag(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`${name} is required`);
	return value;
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readStatus(runtimeDir: string): Promise<Record<string, unknown>> {
	try {
		const value = JSON.parse(await fs.readFile(path.join(runtimeDir, "status.json"), "utf8")) as Record<
			string,
			unknown
		>;
		if (value.status === "running" && !pidAlive(Number(value.pid))) return { ...value, status: "stale" };
		return value;
	} catch {
		return { status: "not_started", runtimeDir };
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

async function requestStop(runtimeDir: string): Promise<void> {
	const status = await readStatus(runtimeDir);
	if (status.status !== "running") return;
	await fs.writeFile(path.join(runtimeDir, "stop.request"), new Date().toISOString(), "utf8");
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const current = await readStatus(runtimeDir);
		if (current.status !== "running") return;
		await Bun.sleep(100);
	}
	throw new Error("Engine did not stop within 15 seconds");
}

async function startDetached(runtimeDir: string): Promise<void> {
	const status = await readStatus(runtimeDir);
	if (status.status === "running") return;
	const engineIndex = process.argv.indexOf("engine");
	if (engineIndex < 0) throw new Error("Cannot reconstruct the Engine CLI invocation");
	const child = Bun.spawn(
		[process.execPath, ...process.argv.slice(1, engineIndex + 1), "serve", ...process.argv.slice(engineIndex + 2)],
		{
			detached: true,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
		},
	);
	child.unref();
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const current = await readStatus(runtimeDir);
		if (current.status === "running") return;
		if (child.exitCode !== null) throw new Error(`Engine failed to start with code ${child.exitCode}`);
		await Bun.sleep(100);
	}
	throw new Error("Engine did not start within 15 seconds");
}

async function waitForStopRequest(stopPath: string): Promise<void> {
	for (;;) {
		if (
			await fs.access(stopPath).then(
				() => true,
				() => false,
			)
		)
			return;
		await Bun.sleep(100);
	}
}
