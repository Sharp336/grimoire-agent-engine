/**
 * Channel registry — manages platform connections.
 *
 * Channels are discovered and registered at gateway startup.
 * Each channel is responsible for its own connection lifecycle.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { Channel, ChannelConfig, InboundMessage, OutboundMessage } from "../types";

export class ChannelRegistry {
	#channels = new Map<string, { channel: Channel; config: ChannelConfig }>();

	register(channel: Channel, config: ChannelConfig): void {
		this.#channels.set(channel.id, { channel, config });
	}

	get(id: string): Channel | undefined {
		return this.#channels.get(id)?.channel;
	}

	getAll(): Channel[] {
		return Array.from(this.#channels.values()).map(c => c.channel);
	}

	getEnabled(): Array<{ channel: Channel; config: ChannelConfig }> {
		return Array.from(this.#channels.values()).filter(c => c.config.enabled);
	}

	async connectAll(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
		const enabled = this.getEnabled();
		const results = await Promise.allSettled(
			enabled.map(async ({ channel, config }) => {
				logger.debug(`Connecting channel: ${channel.name} (${channel.id})`);
				channel.onMessage(onMessage);
				await channel.connect(config);
				logger.debug(`Channel connected: ${channel.name}`);
			}),
		);

		for (const result of results) {
			if (result.status === "rejected") {
				logger.error("Failed to connect channel", { error: result.reason });
			}
		}
	}

	async disconnectAll(): Promise<void> {
		const results = await Promise.allSettled(
			Array.from(this.#channels.values()).map(async ({ channel }) => {
				await channel.disconnect();
			}),
		);

		for (const result of results) {
			if (result.status === "rejected") {
				logger.error("Failed to disconnect channel", { error: result.reason });
			}
		}
	}

	async sendMessage(msg: OutboundMessage): Promise<void> {
		const channel = this.get(msg.channelId);
		if (!channel) {
			throw new Error(`Unknown channel: ${msg.channelId}`);
		}
		await channel.sendMessage(msg);
	}
}
