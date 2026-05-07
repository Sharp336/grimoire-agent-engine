/**
 * CLI entry point for the gateway.
 *
 * Usage:
 *   pi-gateway start                    Start the gateway in foreground
 *   pi-gateway status                   Show gateway status
 *   pi-gateway config                   Show resolved configuration
 *   pi-gateway service install          Install as system service
 *   pi-gateway service uninstall        Remove system service
 *   pi-gateway service start            Start system service
 *   pi-gateway service stop             Stop system service
 *   pi-gateway service status           Show service status
 */

import { logger } from "@oh-my-pi/pi-utils";
import { getConfigPath, loadConfig } from "./config";
import { Gateway } from "./gateway";
import { getServiceStatus, installService, startService, stopService, uninstallService } from "./service-installer";

// ═══════════════════════════════════════════════════════════════════════
// CLI Parsing
// ═══════════════════════════════════════════════════════════════════════

function parseArgs(): { command: string; subcommand?: string; config?: string } {
	const args = process.argv.slice(2);
	const command = args[0] ?? "start";
	const subcommand = args[1];
	const configIdx = args.indexOf("--config");
	const config = configIdx >= 0 ? args[configIdx + 1] : undefined;
	return { command, subcommand, config };
}

// ═══════════════════════════════════════════════════════════════════════
// Gateway Commands
// ═══════════════════════════════════════════════════════════════════════

async function cmdStart(configPath?: string): Promise<void> {
	const config = await loadConfig(configPath);
	const gateway = new Gateway(config);

	const shutdown = async () => {
		logger.debug("Shutting down...");
		await gateway.stop();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await gateway.start();
	await new Promise(() => {});
}

async function cmdStatus(configPath?: string): Promise<void> {
	const config = await loadConfig(configPath);
	const gateway = new Gateway(config);
	const status = await gateway.getStatus();

	console.log("Gateway Status:");
	console.log(`  Running: ${status.running}`);
	console.log(`  Channels: ${status.channels.length}`);
	for (const ch of status.channels) {
		console.log(`    - ${ch.name} (${ch.id}): ${ch.connected ? "connected" : "disconnected"}`);
	}
	console.log(`  Active Sessions: ${status.sessions}`);
}

async function cmdConfig(configPath?: string): Promise<void> {
	const path = configPath ?? getConfigPath();
	const config = await loadConfig(configPath);
	console.log(`Config file: ${path}`);
	console.log(JSON.stringify(config, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════
// Service Commands
// ═══════════════════════════════════════════════════════════════════════

async function cmdServiceInstall(): Promise<void> {
	const cliPath = import.meta.path;
	await installService(cliPath);
	console.log("Service installed. Run 'pi-gateway service start' to begin.");
}

async function cmdServiceUninstall(): Promise<void> {
	await uninstallService();
	console.log("Service uninstalled.");
}

async function cmdServiceStart(): Promise<void> {
	await startService();
	console.log("Service started.");
}

async function cmdServiceStop(): Promise<void> {
	await stopService();
	console.log("Service stopped.");
}

async function cmdServiceStatus(): Promise<void> {
	const status = await getServiceStatus();
	console.log("Service Status:");
	console.log(`  Platform: ${status.platform}`);
	console.log(`  Installed: ${status.installed}`);
	console.log(`  Running: ${status.running}`);
	if (status.pid) console.log(`  PID: ${status.pid}`);
}

async function cmdService(subcommand?: string): Promise<void> {
	switch (subcommand) {
		case "install":
			await cmdServiceInstall();
			break;
		case "uninstall":
			await cmdServiceUninstall();
			break;
		case "start":
			await cmdServiceStart();
			break;
		case "stop":
			await cmdServiceStop();
			break;
		case "status":
			await cmdServiceStatus();
			break;
		default:
			console.log(`
Service management commands:
  pi-gateway service install     Install as system service
  pi-gateway service uninstall   Remove system service
  pi-gateway service start       Start system service
  pi-gateway service stop        Stop system service
  pi-gateway service status      Show service status
`);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

const { command, subcommand, config: configPath } = parseArgs();

switch (command) {
	case "start":
		await cmdStart(configPath);
		break;
	case "status":
		await cmdStatus(configPath);
		break;
	case "config":
		await cmdConfig(configPath);
		break;
	case "service":
		await cmdService(subcommand);
		break;
	case "help":
	case "--help":
	case "-h":
		console.log(`
pi-gateway — IM Gateway for Oh My Pi

Usage:
  pi-gateway start [--config <path>]      Start gateway in foreground
  pi-gateway status [--config <path>]     Show gateway status
  pi-gateway config [--config <path>]     Show resolved configuration
  pi-gateway service install              Install as system service
  pi-gateway service uninstall            Remove system service
  pi-gateway service start                Start system service
  pi-gateway service stop                 Stop system service
  pi-gateway service status               Show service status
  pi-gateway help                         Show this help

Config file: ~/.pi/gateway.json
`);
		break;
	default:
		console.error(`Unknown command: ${command}`);
		console.log("Run 'pi-gateway help' for usage");
		process.exit(1);
}
