import {
	IrcBus,
	type IrcMessage,
	type IrcPeerTransport,
	type IrcSendOptions,
	type IrcTransportPeer,
	MAIN_AGENT_ID,
} from "@oh-my-pi/pi-coding-agent";
import type { ActiveInvocation, AnimaExecutorController } from "./executor";
import {
	type AnimaControl,
	ControlProtocolError,
	type MailMessage,
	type MailReceiveResult,
	type ProtocolHello,
} from "./protocol";

const RECEIVE_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 250;
const ACK_TIMEOUT_MS = 5_000;

export interface PeerBus {
	registerPeerTransport(transport: IrcPeerTransport): () => void;
	deliverInbound(message: IrcMessage): Promise<{ outcome: string; error?: string }>;
}

export interface AnimaPeerBridgeConfig {
	client: AnimaControl;
	controller: AnimaExecutorController;
	bus?: PeerBus;
	onError?: (error: Error) => void;
}

export class AnimaPeerBridge implements IrcPeerTransport {
	readonly id = "anima";
	readonly #client: AnimaControl;
	readonly #controller: AnimaExecutorController;
	readonly #bus: PeerBus;
	readonly #onError: (error: Error) => void;
	readonly #abort = new AbortController();
	readonly #deliveredPendingAck = new Set<string>();
	#mailbox = "";
	#requestSequence = 0;
	#disposeTransport?: () => void;
	#receiveLoop?: Promise<void>;

	constructor(config: AnimaPeerBridgeConfig) {
		this.#client = config.client;
		this.#controller = config.controller;
		this.#bus = config.bus ?? IrcBus.global();
		this.#onError = config.onError ?? (error => console.error(`[anima-omp] ${error.message}`));
	}

	async start(): Promise<ProtocolHello> {
		if (this.#receiveLoop) throw new Error("Anima peer bridge is already started");
		const hello = await this.#client.hello();
		if (!hello.capabilities.threaded_mail || !hello.capabilities.external_mailbox) {
			throw new ControlProtocolError(
				"missing_capability",
				"Anima control must advertise threaded_mail and external_mailbox",
			);
		}
		if (this.#abort.signal.aborted) {
			throw new ControlProtocolError("transport_closed", "Anima peer bridge was stopped during startup", true);
		}
		this.#mailbox = hello.mailbox;
		this.#disposeTransport = this.#bus.registerPeerTransport(this);
		this.#receiveLoop = this.#runReceiveLoop();
		void this.#receiveLoop.catch(error => {
			if (!this.#abort.signal.aborted) this.#onError(error instanceof Error ? error : new Error(String(error)));
		});
		return hello;
	}

	async stop(): Promise<void> {
		this.#abort.abort(new Error("Anima peer bridge stopped"));
		this.#disposeTransport?.();
		this.#disposeTransport = undefined;
		await this.#client.close();
		try {
			await this.#receiveLoop;
		} catch (error) {
			if (!this.#abort.signal.aborted) throw error;
		}
	}

	claims(peerId: string): boolean {
		return this.#controller.findByPeerId(peerId) !== undefined;
	}

	listPeers(): IrcTransportPeer[] {
		return this.#controller
			.list()
			.filter((invocation): invocation is ActiveInvocation & { sessionName: string } =>
				Boolean(invocation.sessionName),
			)
			.map(invocation => ({
				id: invocation.sessionName,
				displayName: invocation.agentName,
				status: this.#controller.peerStatus(invocation),
				activity: invocation.detail,
			}));
	}

	async send(message: IrcMessage, options?: Readonly<IrcSendOptions>): Promise<void> {
		await this.#controller.sendPeer(message, options);
	}

	async #runReceiveLoop(): Promise<void> {
		while (!this.#abort.signal.aborted) {
			let result: MailReceiveResult;
			try {
				result = await this.#client.request<MailReceiveResult>(
					"mail.receive",
					{
						mailbox: this.#mailbox,
						timeout_ms: RECEIVE_TIMEOUT_MS,
					},
					{
						id: `mail-receive:${++this.#requestSequence}`,
						timeoutMs: RECEIVE_TIMEOUT_MS + 5_000,
					},
				);
			} catch (error) {
				if (this.#abort.signal.aborted) return;
				if (!(error instanceof ControlProtocolError) || !error.retryable) throw error;
				await Bun.sleep(RETRY_DELAY_MS);
				continue;
			}

			for (const message of result.messages) {
				if (this.#abort.signal.aborted) return;
				if (!this.#deliveredPendingAck.has(message.id)) {
					let inbound: IrcMessage | undefined;
					try {
						inbound = this.#toInboundMessage(message);
					} catch (error) {
						if (!message.id) throw error;
						this.#onError(error instanceof Error ? error : new Error(String(error)));
					}
					if (inbound) {
						let receipt: { outcome: string; error?: string };
						try {
							receipt = await this.#bus.deliverInbound(inbound);
						} catch (error) {
							this.#onError(error instanceof Error ? error : new Error(String(error)));
							await Bun.sleep(RETRY_DELAY_MS);
							break;
						}
						if (receipt.outcome === "failed") {
							await Bun.sleep(RETRY_DELAY_MS);
							break;
						}
					}
					this.#deliveredPendingAck.add(message.id);
				}
				try {
					await this.#client.request(
						"mail.ack",
						{ mailbox: this.#mailbox, message_id: message.id },
						{ id: `mail-ack:${message.id}`, timeoutMs: ACK_TIMEOUT_MS },
					);
				} catch (error) {
					if (!(error instanceof ControlProtocolError) || !error.retryable) throw error;
					await Bun.sleep(RETRY_DELAY_MS);
					break;
				}
				this.#deliveredPendingAck.delete(message.id);
			}
		}
	}

	#toInboundMessage(message: MailMessage): IrcMessage {
		const sentAt = Date.parse(message.sent_at);
		const rawBody = message.body || message.subject;
		if (!message.id || !message.from || message.to !== this.#mailbox || !rawBody || !Number.isFinite(sentAt)) {
			throw new ControlProtocolError("invalid_response", "Anima mail.receive returned an invalid message");
		}
		const correlation = {
			...(message.thread_id ? { threadId: message.thread_id } : {}),
			...(message.reply_to ? { replyTo: message.reply_to } : {}),
		};
		const route = this.#controller.resolvePeerMessage(message.from, correlation);
		if (!route) {
			throw new ControlProtocolError(
				"unauthenticated_sender",
				`Anima mail sender ${JSON.stringify(message.from)} is not authorized for this message thread`,
			);
		}
		const body = rawBody.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
		return {
			id: message.id,
			from: message.from,
			to: route.recipient ?? MAIN_AGENT_ID,
			body,
			ts: sentAt,
			...correlation,
		};
	}
}
