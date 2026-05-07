/**
 * Gateway core — orchestrates channels, sessions, and agent bridge.
 *
 * The gateway is the central hub that:
 * 1. Manages channel connections (DingTalk, Feishu, etc.)
 * 2. Routes inbound messages to the appropriate agent session
 * 3. Bridges agent responses back to the originating channel
 */

import { logger } from "@oh-my-pi/pi-utils";
import { AgentBridge } from "./agent-bridge";
import { ChannelRegistry } from "./channels/registry";
import { type GatewayConfig, getEnabledChannels } from "./config";
import { SQLiteSessionStore } from "./session-store";
import type { InboundMessage, OutboundMessage, SessionRecord } from "./types";

export class Gateway {
	#config: GatewayConfig;
	#registry = new ChannelRegistry();
	#store: SQLiteSessionStore | null = null;
	#running = false;
	#bridge: AgentBridge;

	constructor(config: GatewayConfig) {
		this.#config = config;
		this.#bridge = new AgentBridge(config.agent);
	}

	async start(): Promise<void> {
		if (this.#running) {
			logger.warn("Gateway already running");
			return;
		}

		logger.debug("Starting gateway...");

		// Initialize session store
		const dataDir = this.#config.dataDir ?? `${process.env.HOME}/.pi/gateway-data`;
		this.#store = new SQLiteSessionStore(`${dataDir}/sessions.db`);

		// Register channels
		const enabled = getEnabledChannels(this.#config);
		for (const { id } of enabled) {
			if (id === "dingtalk") {
				const { DingTalkChannel } = await import("./channels/dingtalk");
				this.#registry.register(new DingTalkChannel(), this.#config.channels[id]);
			}
			// Future: feishu, wechat, etc.
		}

		// Connect all channels
		await this.#registry.connectAll(async msg => this.#handleInboundMessage(msg));

		this.#running = true;
		logger.debug("Gateway started");
	}

	async stop(): Promise<void> {
		if (!this.#running) return;

		logger.debug("Stopping gateway...");
		await this.#registry.disconnectAll();
		this.#store?.close();
		this.#running = false;
		logger.debug("Gateway stopped");
	}

	get isRunning(): boolean {
		return this.#running;
	}

	async getStatus(): Promise<{
		running: boolean;
		channels: Array<{ id: string; name: string; connected: boolean }>;
		sessions: number;
	}> {
		const channels = this.#registry.getAll().map(c => ({
			id: c.id,
			name: c.name,
			connected: c.isConnected(),
		}));

		const sessions = (await this.#store?.getActiveSessions()) ?? [];

		return {
			running: this.#running,
			channels,
			sessions: sessions.length,
		};
	}

	// ═══════════════════════════════════════════════════════════════════
	// Message Handling
	// ═══════════════════════════════════════════════════════════════════

	async #handleInboundMessage(msg: InboundMessage): Promise<void> {
		logger.debug("Received message", {
			channel: msg.channelId,
			user: msg.userId,
			group: msg.isGroup ? msg.conversationTitle : "DM",
			content: msg.content.type === "text" ? msg.content.text.slice(0, 100) : msg.content.type,
		});

		try {
			// Find or create session
			let session = await this.#store?.getSession(msg.channelId, msg.conversationId);
			const now = Date.now();
			if (!session && this.#store) {
				const sessionPath = this.#buildSessionPath(msg.channelId, msg.conversationId);
				session = await this.#store.createSession({
					channelId: msg.channelId,
					userId: msg.userId,
					conversationId: msg.conversationId,
					createdAt: now,
					updatedAt: now,
					ompSessionPath: sessionPath,
					status: "active",
				});
			} else if (session && !session.ompSessionPath && this.#store) {
				const sessionPath = this.#buildSessionPath(msg.channelId, msg.conversationId);
				await this.#store.updateSession(session.id, { ompSessionPath: sessionPath, updatedAt: now });
				session = { ...session, ompSessionPath: sessionPath };
			}

			if (!session) {
				logger.error("Failed to create session", { channelId: msg.channelId, conversationId: msg.conversationId });
				return;
			}

			// Send "processing" placeholder first
			const placeholder: OutboundMessage = {
				channelId: msg.channelId,
				conversationId: msg.conversationId,
				content: { type: "markdown", markdown: "💭 思考中..." },
			};
			await this.#registry.sendMessage(placeholder);

			// Forward to agent bridge
			const response = await this.#forwardToAgent(msg, session);

			// Send final response
			if (response) {
				const outbound: OutboundMessage = {
					channelId: msg.channelId,
					conversationId: msg.conversationId,
					content: { type: "text", text: response },
				};
				await this.#registry.sendMessage(outbound);
			}

			// Update session timestamp
			if (this.#store && session) {
				await this.#store.updateSession(session.id, { updatedAt: Date.now() });
			}
		} catch (err) {
			logger.error("Failed to handle message", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	async #forwardToAgent(msg: InboundMessage, session: SessionRecord): Promise<string | null> {
		return this.#bridge.forward(msg, session);
	}

	#buildSessionPath(channelId: string, conversationId: string): string {
		const dataDir = this.#config.dataDir ?? `${process.env.HOME}/.pi/gateway-data`;
		// Sanitize conversationId for filesystem safety
		const safeId = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
		return `${dataDir}/sessions/${channelId}/${safeId}.jsonl`;
	}
}
