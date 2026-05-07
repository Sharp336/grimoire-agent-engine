/**
 * Gateway configuration loading and validation.
 *
 * Loads from ~/.pi/gateway.json with sensible defaults.
 */

import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { z } from "zod";
import type { ChannelConfig, DingTalkConfig, GatewayConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════
// Schema
// ═══════════════════════════════════════════════════════════════════════

const channelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	allowedUsers: z.array(z.string()).optional(),
	allowedGroups: z.array(z.string()).optional(),
});

const dingtalkConfigSchema = channelConfigSchema.extend({
	appKey: z.string().min(1),
	appSecret: z.string().min(1),
	robotCode: z.string().optional(),
});

const agentConfigSchema = z.object({
	ompPath: z.string().optional(),
	model: z.string().optional(),
	maxConcurrentSessions: z.number().int().positive().optional(),
});

const sessionConfigSchema = z.object({
	idleTimeoutMinutes: z.number().int().positive().optional(),
	resetPolicy: z.enum(["none", "daily", "idle"]).optional(),
	dailyResetHour: z.number().int().min(0).max(23).optional(),
});

const gatewayConfigSchema = z.object({
	channels: z.record(z.string(), z.any()).default({}),
	agent: agentConfigSchema.optional(),
	session: sessionConfigSchema.optional(),
	dataDir: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════════
// Defaults
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: GatewayConfig = {
	channels: {},
	agent: {
		ompPath: "omp",
		maxConcurrentSessions: 3,
	},
	session: {
		idleTimeoutMinutes: 60,
		resetPolicy: "idle",
	},
};

// ═══════════════════════════════════════════════════════════════════════
// Config Path Resolution
// ═══════════════════════════════════════════════════════════════════════

export function getConfigPath(): string {
	return path.join(os.homedir(), ".pi", "gateway.json");
}

export function getDataDir(config?: GatewayConfig): string {
	if (config?.dataDir) return config.dataDir;
	return path.join(os.homedir(), ".pi", "gateway-data");
}

// ═══════════════════════════════════════════════════════════════════════
// Config Loading
// ═══════════════════════════════════════════════════════════════════════

export async function loadConfig(configPath?: string): Promise<GatewayConfig> {
	const filePath = configPath ?? getConfigPath();

	try {
		const raw = await Bun.file(filePath).text();
		const parsed = Bun.JSON5.parse(raw);
		const validated = gatewayConfigSchema.parse(parsed);

		return {
			...DEFAULT_CONFIG,
			...validated,
			agent: { ...DEFAULT_CONFIG.agent, ...validated.agent },
			session: { ...DEFAULT_CONFIG.session, ...validated.session },
		};
	} catch (err) {
		if (isEnoent(err)) {
			logger.debug("No gateway config found, using defaults", { path: filePath });
			return DEFAULT_CONFIG;
		}
		if (err instanceof Error) {
			logger.error("Failed to parse gateway config", { path: filePath, error: err.message });
		}
		return DEFAULT_CONFIG;
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Channel Config Helpers
// ═══════════════════════════════════════════════════════════════════════

export function getDingTalkConfig(config: GatewayConfig): DingTalkConfig | null {
	const raw = config.channels.dingtalk;
	if (!raw) return null;

	try {
		const parsed = dingtalkConfigSchema.parse(raw);
		return parsed as DingTalkConfig;
	} catch {
		logger.warn("Invalid DingTalk config, skipping");
		return null;
	}
}

export function getEnabledChannels(config: GatewayConfig): Array<{ id: string; config: ChannelConfig }> {
	const result: Array<{ id: string; config: ChannelConfig }> = [];

	for (const [id, raw] of Object.entries(config.channels)) {
		try {
			const parsed = channelConfigSchema.parse(raw);
			if (parsed.enabled) {
				result.push({ id, config: parsed });
			}
		} catch {
			logger.warn(`Invalid channel config for "${id}", skipping`);
		}
	}

	return result;
}

export type { GatewayConfig } from "./types";
