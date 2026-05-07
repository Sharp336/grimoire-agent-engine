/**
 * System service installer for pi-gateway.
 *
 * Supports:
 * - macOS: launchd (user-level agent)
 * - Linux: systemd (user-level service)
 *
 * User-level services do not require sudo.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const SERVICE_NAME = "com.narwal.pi-gateway";
const SERVICE_LABEL = "Oh My Pi Gateway";

// ═══════════════════════════════════════════════════════════════════════
// Platform Detection
// ═══════════════════════════════════════════════════════════════════════

export type Platform = "darwin" | "linux" | "unsupported";

export function detectPlatform(): Platform {
	const platform = process.platform;
	if (platform === "darwin") return "darwin";
	if (platform === "linux") return "linux";
	return "unsupported";
}

// ═══════════════════════════════════════════════════════════════════════
// Paths
// ═══════════════════════════════════════════════════════════════════════

export function getServicePaths() {
	const platform = detectPlatform();
	const home = os.homedir();
	const dataDir = path.join(home, ".pi", "gateway-data");
	const logDir = path.join(dataDir, "logs");

	switch (platform) {
		case "darwin":
			return {
				platform,
				configDir: path.join(home, "Library", "LaunchAgents"),
				configPath: path.join(home, "Library", "LaunchAgents", `${SERVICE_NAME}.plist`),
				logDir,
				logPath: path.join(logDir, "service.log"),
			};
		case "linux":
			return {
				platform,
				configDir: path.join(home, ".config", "systemd", "user"),
				configPath: path.join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`),
				logDir,
				logPath: path.join(logDir, "service.log"),
			};
		default:
			throw new Error(`Unsupported platform: ${process.platform}`);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Config Generation
// ═══════════════════════════════════════════════════════════════════════

function generateLaunchdPlist(cliPath: string, logPath: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${SERVICE_NAME}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${process.execPath}</string>
		<string>run</string>
		<string>${cliPath}</string>
		<string>start</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>${logPath}</string>
	<key>StandardErrorPath</key>
	<string>${logPath}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
</dict>
</plist>`;
}

function generateSystemdService(cliPath: string, logPath: string): string {
	return `[Unit]
Description=${SERVICE_LABEL}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} run ${cliPath} start
Restart=on-failure
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}
Environment="PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

[Install]
WantedBy=default.target`;
}

// ═══════════════════════════════════════════════════════════════════════
// Core Operations
// ═══════════════════════════════════════════════════════════════════════

export interface ServiceStatus {
	installed: boolean;
	running: boolean;
	pid?: number;
	platform: Platform;
}

/**
 * Install pi-gateway as a system service.
 */
export async function installService(cliPath: string): Promise<void> {
	const paths = getServicePaths();
	const platform = detectPlatform();

	logger.debug("Installing service", { platform, configPath: paths.configPath });

	// Ensure log directory exists
	await fs.mkdir(paths.logDir, { recursive: true });

	// Generate config
	const config =
		platform === "darwin"
			? generateLaunchdPlist(cliPath, paths.logPath)
			: generateSystemdService(cliPath, paths.logPath);

	// Ensure config directory exists
	await fs.mkdir(paths.configDir, { recursive: true });

	// Write config file
	await Bun.write(paths.configPath, config);

	// Load/enable service
	if (platform === "darwin") {
		await $`launchctl load -w ${paths.configPath}`.quiet().nothrow();
	} else {
		await $`systemctl --user daemon-reload`.quiet().nothrow();
		await $`systemctl --user enable ${SERVICE_NAME}.service`.quiet().nothrow();
	}

	logger.debug("Service installed", { configPath: paths.configPath });
}

/**
 * Uninstall the system service.
 */
export async function uninstallService(): Promise<void> {
	const paths = getServicePaths();
	const platform = detectPlatform();

	logger.debug("Uninstalling service", { platform, configPath: paths.configPath });

	// Stop if running
	try {
		await stopService();
	} catch {
		// ignore stop errors
	}

	// Remove config
	try {
		await fs.unlink(paths.configPath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	// Disable on Linux
	if (platform === "linux") {
		await $`systemctl --user disable ${SERVICE_NAME}.service`.quiet().nothrow();
		await $`systemctl --user daemon-reload`.quiet().nothrow();
	}

	logger.debug("Service uninstalled");
}

/**
 * Start the system service.
 */
export async function startService(): Promise<void> {
	const platform = detectPlatform();

	if (platform === "darwin") {
		const result = await $`launchctl start ${SERVICE_NAME}`.quiet().nothrow();
		if (result.exitCode !== 0) {
			throw new Error(`Failed to start service: ${result.stderr}`);
		}
	} else {
		const result = await $`systemctl --user start ${SERVICE_NAME}.service`.quiet().nothrow();
		if (result.exitCode !== 0) {
			throw new Error(`Failed to start service: ${result.stderr}`);
		}
	}

	logger.debug("Service started");
}

/**
 * Stop the system service.
 */
export async function stopService(): Promise<void> {
	const platform = detectPlatform();

	if (platform === "darwin") {
		await $`launchctl stop ${SERVICE_NAME}`.quiet().nothrow();
	} else {
		await $`systemctl --user stop ${SERVICE_NAME}.service`.quiet().nothrow();
	}

	logger.debug("Service stopped");
}

/**
 * Get service status.
 */
export async function getServiceStatus(): Promise<ServiceStatus> {
	const paths = getServicePaths();
	const platform = detectPlatform();

	// Check if config exists
	let installed = false;
	try {
		await fs.access(paths.configPath);
		installed = true;
	} catch {
		installed = false;
	}

	// Check if running
	let running = false;
	let pid: number | undefined;

	if (platform === "darwin") {
		const result = await $`launchctl list ${SERVICE_NAME}`.quiet().nothrow();
		if (result.exitCode === 0) {
			const lines = result.stdout.toString().split("\n");
			for (const line of lines) {
				if (line.includes("PID")) {
					const match = line.match(/"PID"\s*=\s*(\d+)/);
					if (match) {
						pid = Number.parseInt(match[1], 10);
						running = pid > 0;
					}
				}
			}
		}
	} else {
		const result = await $`systemctl --user is-active ${SERVICE_NAME}.service`.quiet().nothrow();
		running = result.stdout.toString().trim() === "active";
		if (running) {
			const pidResult = await $`systemctl --user show ${SERVICE_NAME}.service --property=MainPID`.quiet().nothrow();
			const match = pidResult.stdout.toString().match(/MainPID=(\d+)/);
			if (match) pid = Number.parseInt(match[1], 10);
		}
	}

	return { installed, running, pid, platform };
}
