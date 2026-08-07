import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { LiveClientMessage, LiveServerEvent } from "./protocol";

export type LiveProvider = "auto" | "openai-codex" | "xai-grok";
export type ResolvedLiveProvider = Exclude<LiveProvider, "auto">;

/** Callbacks emitted by a live transport implementation. */
export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	onOutputLevel(level: number): void;
}

/** Configuration required to establish a live call. */
export interface LiveTransportOptions {
	authStorage: AuthStorage;
	sessionId: string;
	instructions: string;
	voice: string;
	codexVoice?: string;
	grokVoice?: string;
	provider?: LiveProvider;
	grokModel?: string;
	callbacks: LiveTransportCallbacks;
	signal?: AbortSignal;
}

/** Unified real-time transport interface powering `/live` mode. */
export interface ILiveTransport {
	readonly provider: ResolvedLiveProvider;
	readonly model: string;

	/** Connect to the realtime backend. */
	connect(): Promise<void>;

	/** Send a control or context message to the realtime session. */
	send(message: LiveClientMessage): Promise<void>;

	/** Push Float32 PCM audio samples (16 kHz mono) from microphone. */
	pushAudio(samples: Float32Array): void;

	/** Set muted state. */
	setMuted(muted: boolean): Promise<void>;

	/** Gracefully stop and close the transport. */
	close(): Promise<void>;
}
