import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { engineHelp as commandHelp } from "../cli/command-help";
import { runEngineService } from "../engine/service";

export default class Engine extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "start, serve, status, stop or restart",
			required: false,
			options: ["start", "serve", "status", "stop", "restart"],
		}),
	};
	static flags = {
		device: Flags.string({ description: "Stable device id" }),
		"engine-id": Flags.string({ description: "Stable Engine id" }),
		"runtime-dir": Flags.string({ description: "Engine runtime directory" }),
		database: Flags.string({ description: "Engine SQLite path" }),
		"nats-server": Flags.string({ description: "Absolute nats-server executable path" }),
		"artifact-cache": Flags.string({ description: "ClientHost Artifact cache directory" }),
		"server-url": Flags.string({ description: "Hosted Grimoire base URL" }),
		"token-env": Flags.string({ description: "Environment variable containing the hosted bearer token" }),
		"client-id": Flags.string({ description: "Hosted Grimoire client id" }),
		"no-hosted": Flags.boolean({ description: "Run the local Engine without the hosted bridge" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Engine);
		if (!args.action) {
			renderCommandHelp("omp", "engine", Engine);
			return;
		}
		const runtimeDir = path.resolve(flags["runtime-dir"] ?? path.join(getAgentDir(), "engine"));
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
