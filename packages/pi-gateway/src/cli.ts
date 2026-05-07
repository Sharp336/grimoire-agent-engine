/**
 * CLI entry point for the gateway.
 *
 * Usage:
 *   pi-gateway start        Start the gateway in foreground
 *   pi-gateway status       Show gateway status
 *   pi-gateway config       Show resolved configuration
 */

import { logger } from "@oh-my-pi/pi-utils";
import { getConfigPath, loadConfig } from "./config";
import { Gateway } from "./gateway";

// ═══════════════════════════════════════════════════════════════════════
// CLI Parsing (minimal, no external deps)
// ═══════════════════════════════════════════════════════════════════════

function parseArgs(): { command: string; config?: string } {
	const args = process.argv.slice(2);
	const command = args[0] ?? "start";
	const configIdx = args.indexOf("--config");
	const config = configIdx >= 0 ? args[configIdx + 1] : undefined;
	return { command, config };
}

// ═══════════════════════════════════════════════════════════════════════
// Commands
// ═══════════════════════════════════════════════════════════════════════

async function cmdStart(configPath?: string): Promise<void> {
	const config = await loadConfig(configPath);
	const gateway = new Gateway(config);

	// Graceful shutdown
	const shutdown = async () => {
		logger.debug("Shutting down...");
		await gateway.stop();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await gateway.start();

	// Keep process alive
	await new Promise(() => {});
}

async function cmdStatus(configPath?: string): Promise<void> {
	const config = await loadConfig(configPath);
	const gateway = new Gateway(config);

	// For status, we just show config summary since the gateway isn't running
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
// Main
// ═══════════════════════════════════════════════════════════════════════

const { command, config: configPath } = parseArgs();

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
	case "help":
	case "--help":
	case "-h":
		console.log(`
pi-gateway — IM Gateway for Oh My Pi

Usage:
  pi-gateway start [--config <path>]   Start the gateway
  pi-gateway status [--config <path>]  Show gateway status
  pi-gateway config [--config <path>]  Show resolved configuration
  pi-gateway help                      Show this help

Config file: ~/.pi/gateway.json
`);
		break;
	default:
		console.error(`Unknown command: ${command}`);
		console.log("Run 'pi-gateway help' for usage");
		process.exit(1);
}
