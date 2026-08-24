/**
 * Check for and install updates.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { CliUsageError } from "../cli/usage-error";
import { initTheme } from "../modes/theme/theme";

const NETWORK_ERROR_FIELDS = ["code", "hostname", "host", "port", "address"] as const;

function hasEnv(...names: string[]): boolean {
	return names.some(name => Boolean(process.env[name]));
}

function errorField(error: unknown, field: (typeof NETWORK_ERROR_FIELDS)[number]): unknown {
	if (typeof error !== "object" || error === null) return undefined;
	return Reflect.get(error, field);
}

function errorCause(error: unknown): unknown {
	if (typeof error !== "object" || error === null) return undefined;
	return Reflect.get(error, "cause");
}

function formatError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

function logNetworkFailure(url: string, error: unknown): void {
	console.error("Update network request failed:");
	console.error(`  URL: ${url}`);
	console.error("  Proxy environment:");
	console.error(`    HTTPS_PROXY/https_proxy: ${hasEnv("HTTPS_PROXY", "https_proxy") ? "set" : "not set"}`);
	console.error(`    HTTP_PROXY/http_proxy: ${hasEnv("HTTP_PROXY", "http_proxy") ? "set" : "not set"}`);
	console.error(`    NO_PROXY/no_proxy: ${hasEnv("NO_PROXY", "no_proxy") ? "set" : "not set"}`);

	let current: unknown = error;
	const seen = new Set<unknown>();
	for (let depth = 0; current !== undefined && current !== null && depth < 5 && !seen.has(current); depth += 1) {
		seen.add(current);
		console.error(`  ${depth === 0 ? "Error" : `Cause[${depth}]`}: ${formatError(current)}`);
		for (const field of NETWORK_ERROR_FIELDS) {
			const value = errorField(current, field);
			if (value !== undefined) console.error(`    ${field}: ${String(value)}`);
		}
		current = errorCause(current);
	}
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

async function withUpdateNetworkDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		try {
			return await originalFetch(input, init);
		} catch (error) {
			logNetworkFailure(requestUrl(input), error);
			throw error;
		}
	};
	try {
		return await fn();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		canary: Flags.boolean({ description: "Switch to the canary channel and update", default: false }),
		stable: Flags.boolean({ description: "Switch back to the stable channel", default: false }),
	};

	static examples = [
		"omp update",
		"omp update --check",
		"omp update --canary",
		"# If GitHub rate-limits release metadata, set GITHUB_TOKEN or GH_TOKEN\n  GITHUB_TOKEN=... omp update",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.canary && flags.stable) throw new CliUsageError("--canary and --stable are mutually exclusive");
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			await withUpdateNetworkDiagnostics(() =>
				updateCli.runUpdateCommand({
					force: flags.force,
					check: flags.check,
					channel: flags.canary ? "canary" : flags.stable ? "stable" : undefined,
				}),
			);
		}
	}
}
