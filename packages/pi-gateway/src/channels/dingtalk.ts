/**
 * DingTalk channel — connects via Stream mode (WebSocket).
 *
 * Uses the official DingTalk Stream protocol to receive messages
 * and reply via sessionWebhook or REST API.
 *
 * No public IP required — outbound WebSocket connection to DingTalk servers.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type {
	ChannelConfig,
	DingTalkConfig,
	DingTalkRawMessage,
	InboundMessage,
	MessageContent,
	OutboundMessage,
} from "../types";
import { BaseChannel } from "./base";

// ═══════════════════════════════════════════════════════════════════════
// Stream Protocol
// ═══════════════════════════════════════════════════════════════════════

const STREAM_WS_URL = "wss://api.dingtalk.com/v1.0/gateway/connections";

interface StreamRegisterPayload {
	clientId: string;
	clientSecret: string;
	ua: string;
	subscriptions: string[];
}

interface StreamRegisterResponse {
	endpoint: string;
	ticket: string;
}

// ═══════════════════════════════════════════════════════════════════════
// DingTalk Channel
// ═══════════════════════════════════════════════════════════════════════

export class DingTalkChannel extends BaseChannel {
	readonly id = "dingtalk";
	readonly name = "DingTalk";
	readonly capabilities = {
		inbound: true,
		outbound: true,
		richContent: true,
		groups: true,
		mentions: true,
		voice: false,
	};

	#ws: WebSocket | null = null;
	#config: DingTalkConfig | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#ticket = "";
	#endpoint = "";

	protected async onConnect(config: ChannelConfig): Promise<void> {
		this.#config = config as DingTalkConfig;
		await this.#registerAndConnect();
	}

	protected async onDisconnect(): Promise<void> {
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
		this.#ws?.close();
		this.#ws = null;
	}

	async sendMessage(msg: OutboundMessage): Promise<void> {
		if (!this.#config) {
			throw new Error("DingTalk channel not configured");
		}

		const text =
			msg.content.type === "markdown"
				? msg.content.markdown
				: msg.content.type === "text"
					? msg.content.text
					: "[unsupported content type]";
		const body = {
			msgtype: "markdown" as const,
			markdown: {
				title: "消息",
				text,
			},
			at: {
				atUserIds: msg.mentions ?? [],
				isAtAll: false,
			},
		};

		// Use the sessionWebhook from the raw message if available
		// For proactive messages, use the REST API
		const url = this.#buildSendUrl(msg.conversationId);
		const headers = this.#buildAuthHeaders();

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`DingTalk send failed: ${response.status} ${error}`);
		}

		logger.debug("DingTalk message sent", { conversationId: msg.conversationId });
	}

	// ═══════════════════════════════════════════════════════════════════
	// Stream Connection
	// ═══════════════════════════════════════════════════════════════════

	async #registerAndConnect(): Promise<void> {
		if (!this.#config) return;

		try {
			// Step 1: Register with DingTalk to get endpoint and ticket
			const registerUrl = `${STREAM_WS_URL}?client_id=${this.#config.appKey}`;
			const registerPayload: StreamRegisterPayload = {
				clientId: this.#config.appKey,
				clientSecret: this.#config.appSecret,
				ua: "pi-gateway/0.1.0",
				subscriptions: ["/v1.0/im/bot/messages/get"],
			};

			const registerRes = await fetch(registerUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(registerPayload),
			});

			if (!registerRes.ok) {
				throw new Error(`Registration failed: ${registerRes.status}`);
			}

			const registerData = (await registerRes.json()) as StreamRegisterResponse;
			this.#endpoint = registerData.endpoint;
			this.#ticket = registerData.ticket;

			// Step 2: Connect WebSocket
			this.#ws = new WebSocket(this.#endpoint);

			this.#ws.onopen = () => {
				logger.debug("DingTalk Stream connected");
			};

			this.#ws.onmessage = async event => {
				const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
				await this.#handleStreamMessage(data);
			};

			this.#ws.onerror = error => {
				logger.error("DingTalk Stream error", { error });
			};

			this.#ws.onclose = () => {
				logger.warn("DingTalk Stream disconnected, reconnecting in 5s");
				this.#reconnectTimer = setTimeout(() => this.#registerAndConnect(), 5000);
			};
		} catch (err) {
			logger.error("Failed to register DingTalk Stream", {
				error: err instanceof Error ? err.message : String(err),
			});
			this.#reconnectTimer = setTimeout(() => this.#registerAndConnect(), 10000);
		}
	}

	async #handleStreamMessage(data: unknown): Promise<void> {
		// Acknowledge the message first
		const headers = (data as Record<string, unknown>).headers ?? {};
		const id = (headers as Record<string, unknown>).id;
		if (id) {
			this.#ws?.send(
				JSON.stringify({
					code: 200,
					headers: {
						id,
						contentType: "application/json",
					},
					message: "ok",
				}),
			);
		}

		// Parse the robot message
		const payload = (data as Record<string, unknown>).data;
		if (!payload) return;

		const raw = payload as DingTalkRawMessage;
		const msg = this.#parseRawMessage(raw);
		if (msg) {
			await this.handleInbound(msg);
		}
	}

	#parseRawMessage(raw: DingTalkRawMessage): InboundMessage | null {
		const content: MessageContent = raw.text
			? { type: "text", text: raw.text.content.trim() }
			: raw.content
				? { type: "text", text: raw.content.trim() }
				: { type: "text", text: "" };

		return {
			channelId: this.id,
			userId: raw.senderStaffId ?? raw.senderId,
			userName: raw.senderNick,
			conversationId: raw.conversationId,
			conversationTitle: raw.conversationTitle,
			isGroup: raw.conversationType === "2",
			content,
			timestamp: new Date(raw.createAt),
			raw,
		};
	}

	#buildSendUrl(_conversationId: string): string {
		// For proactive messaging, use the REST API
		return `https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend`;
	}

	#buildAuthHeaders(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			"x-acs-dingtalk-access-token": this.#getAccessToken(),
		};
	}

	#getAccessToken(): string {
		// In production, this should call the token API and cache the result
		// For now, return placeholder — actual implementation needs OAuth flow
		return "";
	}
}
