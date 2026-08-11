import type { Api, AuthStorage } from "@oh-my-pi/pi-ai";
import type { LiveClientMessage, LiveServerEvent } from "./protocol";
import type { VoiceProviderId } from "./provider";

/** Callbacks emitted by a live transport implementation. */
export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	onOutputLevel(level: number): void;
}

/** Shared configuration passed from the live-session controller to a provider. */
export interface LiveTransportBaseOptions {
	authStorage: AuthStorage;
	sessionId: string;
	instructions: string;
	callbacks: LiveTransportCallbacks;
	signal?: AbortSignal;
}

/** Provider-resolved configuration required to establish a live transport. */
export interface LiveTransportOptions extends LiveTransportBaseOptions {
	voice: string;
	model?: string;
}

/** Message identity attached to transcripts emitted by a live transport. */
export interface LiveTransportIdentity {
	voiceProvider: VoiceProviderId;
	api: Api;
	provider: string;
	model: string;
}

/** Unified real-time transport interface powering `/live` mode. */
export interface ILiveTransport {
	readonly identity: LiveTransportIdentity;

	/** Connect to the realtime backend. */
	connect(): Promise<void>;

	/** Send a control or context message to the realtime session. */
	send(message: LiveClientMessage): Promise<void>;

	/** Decide whether the current microphone frame should reach this provider. */
	shouldStreamAudio(inputLevel: number, outputLevel: number): boolean;

	/** Push Float32 PCM audio samples (16 kHz mono) from microphone. */
	pushAudio(samples: Float32Array): void;

	/** Set muted state. */
	setMuted(muted: boolean): Promise<void>;

	/** Gracefully stop and close the transport. */
	close(): Promise<void>;
}
