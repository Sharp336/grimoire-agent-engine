/**
 * Exposure backends for the blob broker: make the loopback blob server
 * reachable by provider-side image fetchers.
 *
 * Every adapter resolves to a public base URL. Tunnel adapters own a child
 * process whose exit is observable via {@link ActiveExposure.exited} so the
 * broker can stop advertising URLs the moment the tunnel dies.
 */

import { $which, logger } from "@oh-my-pi/pi-utils";
import type { DestinationRuntimeConfig } from "./uploader-runtime";

/** User-selectable exposure strategy. */
export type ExposureKind = "direct" | "ssh";

export interface ExposureConfig {
	kind: ExposureKind;
	/**
	 * Externally reachable base URL. Required for `ssh` (the remote web server
	 * fronting the forwarded port); optional for `direct`, which otherwise
	 * advertises the bind address itself (LAN / same-host use).
	 */
	publicBaseUrl?: string;
	/** Blob server bind host. Loopback for tunnels; `0.0.0.0` for direct serving. */
	bindHost: string;
	/** `user@host[:port]` destination for the ssh reverse forward. */
	sshTarget?: string;
	/** Remote listen port of the ssh reverse forward. */
	sshRemotePort?: number;
	/** Destination-specific non-secret tunnel settings. */
	options: DestinationRuntimeConfig["options"];
	/** Destination credentials. Values must never be included in logs or errors. */
	credentials: DestinationRuntimeConfig["credentials"];
}

/** Live exposure of one local port. */
export interface ActiveExposure {
	readonly kind: ExposureKind;
	/** Public origin (no trailing slash) that reaches the local blob server. */
	readonly baseUrl: string;
	/** Resolves when the tunnel child exits; `null` for processless kinds. */
	readonly exited: Promise<void> | null;
	stop(): void;
}

const HEALTH_PATH = "/.well-known/omp-blob-health";
const DEFAULT_HEALTH_ATTEMPTS = 5;
const MAX_HEALTH_ATTEMPTS = 10;
const DEFAULT_HEALTH_BACKOFF_MS = 250;
const MAX_HEALTH_BACKOFF_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const MAX_HEALTH_TIMEOUT_MS = 30_000;

/** Retry and timeout limits for an exposure edge-to-origin health probe. */
export interface ExposureHealthProbeOptions {
	/** Maximum fetch attempts before the exposure is rejected. */
	attempts?: number;
	/** Delay between attempts, in milliseconds. */
	backoffMs?: number;
	/** Per-attempt fetch timeout, in milliseconds. */
	timeoutMs?: number;
}

/** ssh prints nothing on success; alive past this grace period means forwarded. */
const SSH_READY_GRACE_MS = 1_500;

function requireBinary(name: string): string {
	const path = $which(name);
	if (!path) {
		throw new Error(`imageUrls exposure "${name}" requires the ${name} binary on PATH`);
	}
	return path;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(0, Math.floor(value)));
}

/**
 * Verify that a public exposure reaches the local blob origin.
 *
 * Each request is cache-busted and time-bounded. Only the broker health
 * endpoint's exact 204 response is accepted; errors expose only the sanitized
 * destination origin and final status.
 */
export async function probeExposureHealth(
	baseUrl: string,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
	options: ExposureHealthProbeOptions = {},
): Promise<void> {
	const attempts = Math.max(1, boundedInteger(options.attempts, DEFAULT_HEALTH_ATTEMPTS, MAX_HEALTH_ATTEMPTS));
	const backoffMs = boundedInteger(options.backoffMs, DEFAULT_HEALTH_BACKOFF_MS, MAX_HEALTH_BACKOFF_MS);
	const timeoutMs = Math.max(1, boundedInteger(options.timeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS));
	const healthUrl = new URL(HEALTH_PATH, `${normalizeBaseUrl(baseUrl)}/`);
	const destination = healthUrl.origin;
	let finalStatus = "request failed";

	for (let attempt = 0; attempt < attempts; attempt++) {
		healthUrl.searchParams.set("nonce", `${Date.now().toString(36)}-${attempt.toString(36)}`);
		try {
			const response = await fetchFn(healthUrl, {
				cache: "no-store",
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.status === 204) return;
			finalStatus = `HTTP ${response.status}`;
			try {
				await response.body?.cancel();
			} catch {
				// The response status is authoritative even if body disposal fails.
			}
		} catch (error) {
			finalStatus = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "request failed";
		}
		if (attempt + 1 < attempts && backoffMs > 0) await Bun.sleep(backoffMs);
	}

	throw new Error(`Exposure health probe for ${destination} failed with status ${finalStatus}`);
}

/**
 * SIGTERM, escalating to SIGKILL after a grace period. `tailscale funnel`
 * observably survives a bare SIGTERM mid-startup, and a leaked funnel child
 * blocks every later funnel invocation on the machine.
 */
function killTunnelProcess(proc: Bun.Subprocess): void {
	proc.kill();
	const timer = setTimeout(() => {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	}, 2_000);
	timer.unref();
}

function processExposure(kind: ExposureKind, baseUrl: string, proc: Bun.Subprocess): ActiveExposure {
	proc.unref();
	return {
		kind,
		baseUrl,
		exited: proc.exited.then(() => undefined),
		stop: () => killTunnelProcess(proc),
	};
}

/**
 * Expose `port` per `config`. Throws when the backend is missing,
 * misconfigured, or fails to come up; the caller degrades to inline base64.
 */
export async function startExposure(config: ExposureConfig, port: number): Promise<ActiveExposure> {
	switch (config.kind) {
		case "direct": {
			const baseUrl = normalizeBaseUrl(config.publicBaseUrl ?? `http://${config.bindHost}:${port}`);
			return { kind: "direct", baseUrl, exited: null, stop: () => {} };
		}
		case "ssh": {
			if (!config.publicBaseUrl) throw new Error('imageUrls exposure "ssh" requires imageUrls.publicBaseUrl');
			if (!config.sshTarget) throw new Error('imageUrls exposure "ssh" requires imageUrls.sshTarget');
			const binary = requireBinary("ssh");
			const remotePort = config.sshRemotePort ?? 8787;
			const proc = Bun.spawn(
				[
					binary,
					"-o",
					"BatchMode=yes",
					"-o",
					"ExitOnForwardFailure=yes",
					"-N",
					"-R",
					`${remotePort}:127.0.0.1:${port}`,
					config.sshTarget,
				],
				{ env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			const early = await Promise.race([
				proc.exited.then(code => code),
				Bun.sleep(SSH_READY_GRACE_MS).then(() => null),
			]);
			if (early !== null) {
				throw new Error(`ssh reverse forward to ${config.sshTarget} exited with code ${early}`);
			}
			logger.debug("blob-broker: ssh reverse forward established", {
				target: config.sshTarget,
				remotePort,
				localPort: port,
			});
			return processExposure("ssh", normalizeBaseUrl(config.publicBaseUrl), proc);
		}
	}
}
