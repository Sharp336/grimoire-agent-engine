import { type DaemonBrokerClient, DaemonBrokerRejectedError, daemonClientForGlobal } from "../../launch/client";
import type { DaemonSpec } from "../../launch/protocol";

const PRIME_BRIDGE_BROKER_SCOPE = "prime-bridge";
const PRIME_BRIDGE_DAEMON_NAME = "prime-bridge";
const PRIME_BRIDGE_APPLICATION = "omp-prime-bridge";
const PRIME_BRIDGE_READY_TIMEOUT_MS = 30_000;
const inFlightEnsures = new Map<string, Promise<void>>();

/** Settings needed to decide whether the machine-global Prime bridge should start. */
export interface PrimeBridgeLifecycleSettings {
	enabled: boolean;
	autoStart: boolean;
	url?: string;
	tokenPath?: string;
}

/** Injectable broker lookup used to keep lifecycle tests hermetic. */
export interface PrimeBridgeLifecycleDependencies {
	daemonClientForGlobal?: (scope: string) => Promise<DaemonBrokerClient>;
}

/**
 * Ensures one detached machine-global Prime bridge daemon exists.
 *
 * `detached: true` lets the bridge survive an OMP broker exit. `restart: "always"`
 * supervises later crashes only while the broker has recovered its lifecycle record,
 * so this function does not promise restart during the interval before broker recovery.
 */
export async function ensurePrimeBridge(
	settings: PrimeBridgeLifecycleSettings,
	dependencies: PrimeBridgeLifecycleDependencies = {},
): Promise<void> {
	if (!settings.enabled || !settings.autoStart) return;
	const endpoint = parseLoopbackHttpUrl(settings.url, settings.tokenPath);
	const key = `${PRIME_BRIDGE_BROKER_SCOPE}:${endpoint.url.href}:${endpoint.tokenPath ?? ""}`;
	const existing = inFlightEnsures.get(key);
	if (existing !== undefined) return await existing;
	const ensure = ensurePrimeBridgeOnce(endpoint, dependencies).finally(() => {
		inFlightEnsures.delete(key);
	});
	inFlightEnsures.set(key, ensure);
	return await ensure;
}

interface PrimeBridgeEndpoint {
	url: URL;
	host: string;
	port: number;
	tokenPath?: string;
}

function parseLoopbackHttpUrl(value: string | undefined, tokenPath: string | undefined): PrimeBridgeEndpoint {
	if (value === undefined || value.length === 0) throw new Error("Prime bridge URL is required");
	if (tokenPath !== undefined && tokenPath.length === 0) throw new Error("Prime bridge tokenPath is required");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Prime bridge URL must be a loopback HTTP URL");
	}
	const normalizedHost = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const loopback = normalizedHost === "localhost" || normalizedHost === "127.0.0.1";
	if (url.protocol !== "http:" || !loopback || url.username !== "" || url.password !== "") {
		throw new Error("Prime bridge URL must be a loopback HTTP URL");
	}
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
		throw new Error("Prime bridge URL must not contain a path, query, or fragment");
	}
	const port = url.port === "" ? 80 : Number(url.port);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("Prime bridge URL must contain a valid port");
	}
	return { url, host: normalizedHost, port, tokenPath };
}

async function ensurePrimeBridgeOnce(
	endpoint: PrimeBridgeEndpoint,
	dependencies: PrimeBridgeLifecycleDependencies,
): Promise<void> {
	const client = await (dependencies.daemonClientForGlobal ?? daemonClientForGlobal)(PRIME_BRIDGE_BROKER_SCOPE);
	const spec = primeBridgeSpec(client, endpoint);
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error("Prime bridge broker returned an invalid list response");
	const existing = listed.daemons.find(daemon => daemon.name === PRIME_BRIDGE_DAEMON_NAME);
	if (existing !== undefined) {
		await ensureExistingPrimeBridge(client, spec);
		return;
	}
	try {
		const started = await client.request({ op: "start", spec });
		if (started.op !== "start") throw new Error("Prime bridge broker returned an invalid start response");
		if (started.readyTimedOut) throw new Error("Prime bridge did not become ready before the broker timeout");
	} catch (error) {
		if (!(error instanceof DaemonBrokerRejectedError)) throw error;
		await ensureExistingPrimeBridge(client, spec);
	}
}

async function ensureExistingPrimeBridge(client: DaemonBrokerClient, expected: DaemonSpec): Promise<void> {
	const described = await client.request({ op: "describe", name: PRIME_BRIDGE_DAEMON_NAME });
	if (described.op !== "describe") throw new Error("Prime bridge broker returned an invalid describe response");
	if (!sameDaemonSpec(described.spec, expected)) {
		throw new Error("Prime bridge daemon has a conflicting launch specification");
	}
	switch (described.daemon.state) {
		case "ready":
			return;
		case "starting":
		case "restarting":
		case "running":
			await waitForPrimeBridge(client, expected);
			return;
		case "failed":
		case "exited": {
			const restarted = await client.request({ op: "restart", name: PRIME_BRIDGE_DAEMON_NAME });
			if (restarted.op !== "restart") throw new Error("Prime bridge broker returned an invalid restart response");
			await waitForPrimeBridge(client, expected);
			return;
		}
		default:
			throw new Error(`Prime bridge daemon is ${described.daemon.state}`);
	}
}

async function waitForPrimeBridge(client: DaemonBrokerClient, expected: DaemonSpec): Promise<void> {
	const waited = await client.request({
		op: "wait",
		name: PRIME_BRIDGE_DAEMON_NAME,
		for: "ready",
		timeoutMs: expected.ready?.timeoutMs ?? PRIME_BRIDGE_READY_TIMEOUT_MS,
	});
	if (waited.op !== "wait") throw new Error("Prime bridge broker returned an invalid wait response");
	if (waited.timedOut) throw new Error("Prime bridge did not become ready before the broker timeout");
}

function primeBridgeSpec(client: DaemonBrokerClient, endpoint: PrimeBridgeEndpoint): DaemonSpec {
	const args = ["--port", String(endpoint.port)];
	if (endpoint.tokenPath !== undefined) args.push("--token-file", endpoint.tokenPath);
	return {
		name: PRIME_BRIDGE_DAEMON_NAME,
		application: PRIME_BRIDGE_APPLICATION,
		args,
		env: {},
		cwd: client.projectDir,
		pty: false,
		ready: { host: endpoint.host, port: endpoint.port, timeoutMs: PRIME_BRIDGE_READY_TIMEOUT_MS },
		restart: "always",
		persist: true,
		detached: true,
	};
}

function sameDaemonSpec(actual: DaemonSpec, expected: DaemonSpec): boolean {
	if (
		actual.name !== expected.name ||
		actual.application !== expected.application ||
		actual.cwd !== expected.cwd ||
		actual.pty !== expected.pty ||
		actual.restart !== expected.restart ||
		actual.persist !== expected.persist ||
		actual.detached !== expected.detached ||
		actual.args.length !== expected.args.length
	) {
		return false;
	}
	for (let index = 0; index < expected.args.length; index++) {
		if (actual.args[index] !== expected.args[index]) return false;
	}
	const actualEnvKeys = Object.keys(actual.env);
	const expectedEnvKeys = Object.keys(expected.env);
	if (actualEnvKeys.length !== expectedEnvKeys.length) return false;
	for (const key of expectedEnvKeys) {
		if (actual.env[key] !== expected.env[key]) return false;
	}
	if (actual.ready === undefined || expected.ready === undefined) return actual.ready === expected.ready;
	return (
		actual.ready.log === expected.ready.log &&
		actual.ready.port === expected.ready.port &&
		actual.ready.host === expected.ready.host &&
		actual.ready.timeoutMs === expected.ready.timeoutMs
	);
}
