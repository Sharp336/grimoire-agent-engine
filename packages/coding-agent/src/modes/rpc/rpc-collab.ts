import {
	CollabHost,
	type CollabHostEventBus,
	type CollabHostSession,
	type CollabHostSessionManager,
} from "../../collab/host";
import type { RpcCollabLifecycleFrame, RpcCollabRoomState } from "./rpc-types";

export interface RpcCollabHostControllerContext {
	session: CollabHostSession;
	sessionManager: CollabHostSessionManager;
	eventBus?: CollabHostEventBus;
	defaultRelayUrl?: string;
	defaultWebUrl?: string;
	displayName?: string;
	output(frame: RpcCollabLifecycleFrame): void;
}

export interface RpcCollabStartOptions {
	relayUrl?: string;
	webUrl?: string;
	displayName?: string;
}

/** Owns the single native collaboration room associated with one RPC process. */
export class RpcCollabHostController {
	readonly #context: RpcCollabHostControllerContext;
	#host: CollabHost | undefined;
	#stopping = false;

	constructor(context: RpcCollabHostControllerContext) {
		this.#context = context;
	}

	status(): RpcCollabRoomState {
		const host = this.#host;
		if (!host) return { active: false, participants: [] };
		return {
			active: true,
			joinUrl: host.link,
			viewUrl: host.viewLink,
			...(host.webLink ? { webUrl: host.webLink } : {}),
			...(host.webViewLink ? { webViewUrl: host.webViewLink } : {}),
			participants: host.participants,
		};
	}

	async start(options: RpcCollabStartOptions): Promise<RpcCollabRoomState> {
		if (this.#host) return this.status();
		const relayInput = options.relayUrl?.trim() || this.#context.defaultRelayUrl?.trim();
		if (!relayInput) throw new Error("No collaboration relay configured");
		const relayUrl = relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
		const webUrl = options.webUrl?.trim() || this.#context.defaultWebUrl?.trim() || "";
		const host = new CollabHost({
			session: this.#context.session,
			sessionManager: this.#context.sessionManager,
			eventBus: this.#context.eventBus,
			displayName: options.displayName?.trim() || this.#context.displayName?.trim(),
			onRelayReconnecting: reason => {
				this.#context.output({ type: "collab_state", state: "reconnecting", reason, room: this.status() });
			},
			onStopped: reason => {
				if (this.#host !== host) return;
				const state = this.#stopping ? "stopped" : "failed";
				this.#host = undefined;
				this.#stopping = false;
				this.#context.output({ type: "collab_state", state, reason, room: this.status() });
			},
		});
		this.#host = host;
		try {
			await host.start(relayUrl, webUrl);
		} catch (error) {
			if (this.#host === host) {
				this.#host = undefined;
				const reason = error instanceof Error ? error.message : String(error);
				this.#context.output({ type: "collab_state", state: "failed", reason, room: this.status() });
			}
			throw error;
		}
		if (this.#host !== host) throw new Error("Collaboration room ended while starting");
		const room = this.status();
		this.#context.output({ type: "collab_state", state: "started", room });
		return room;
	}

	async stop(reason: string): Promise<RpcCollabRoomState> {
		const host = this.#host;
		if (!host) return this.status();
		this.#stopping = true;
		await host.stop(reason);
		return this.status();
	}

	async shutdown(): Promise<void> {
		await this.stop("RPC shutdown");
	}
}
