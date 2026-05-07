/**
 * Base class for IM platform channels.
 *
 * Provides common functionality: user allowlist validation,
 * message logging, and connection state tracking.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { Channel, ChannelCapabilities, ChannelConfig, InboundMessage, OutboundMessage } from "../types";

export abstract class BaseChannel implements Channel {
	abstract readonly id: string;
	abstract readonly name: string;
	abstract readonly capabilities: ChannelCapabilities;

	#connected = false;
	#messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
	#config: ChannelConfig | null = null;
	isConnected(): boolean {
		return this.#connected;
	}

	async connect(config: ChannelConfig): Promise<void> {
		this.#config = config;
		this.#connected = true;
		await this.onConnect(config);
	}

	async disconnect(): Promise<void> {
		this.#connected = false;
		await this.onDisconnect();
	}

	onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
		this.#messageHandler = handler;
	}

	abstract sendMessage(msg: OutboundMessage): Promise<void>;

	/** Override to implement channel-specific connection logic. */
	protected abstract onConnect(config: ChannelConfig): Promise<void>;

	/** Override to implement channel-specific cleanup. */
	protected abstract onDisconnect(): Promise<void>;

	/** Call this when a message is received from the platform. */
	protected async handleInbound(msg: InboundMessage): Promise<void> {
		if (!this.#config) {
			logger.warn(`Message received before ${this.name} connected, dropping`);
			return;
		}

		// Allowlist check
		if (this.#config.allowedUsers && this.#config.allowedUsers.length > 0) {
			if (!this.#config.allowedUsers.includes(msg.userId)) {
				logger.debug(`Blocked message from unauthorized user ${msg.userId} on ${this.name}`);
				return;
			}
		}

		// Group allowlist check
		if (msg.isGroup && this.#config.allowedGroups && this.#config.allowedGroups.length > 0) {
			if (!this.#config.allowedGroups.includes(msg.conversationId)) {
				logger.debug(`Blocked message from unauthorized group ${msg.conversationId} on ${this.name}`);
				return;
			}
		}

		if (!this.#messageHandler) {
			logger.warn(`No message handler registered for ${this.name}, dropping message`);
			return;
		}

		await this.#messageHandler(msg);
	}
}
