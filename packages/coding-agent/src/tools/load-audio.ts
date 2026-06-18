import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import { expandRoleAlias, getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import {
	AudioInputTooLargeError,
	audioInputSupportedByApi,
	type LoadedAudioInput,
	loadAudioInput,
	MAX_AUDIO_INPUT_BYTES,
} from "../utils/audio-input";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const loadAudioSchema = type({
	path: type("string").describe("audio file path"),
	"+": "reject",
});

export type LoadAudioParams = typeof loadAudioSchema.infer;

export class LoadAudioTool implements AgentTool<typeof loadAudioSchema, Record<string, never>> {
	readonly name = "load_audio";
	readonly approval = "read" as const;
	readonly label = "LoadAudio";
	readonly loadMode = "discoverable";
	readonly summary = "Attach an audio file to the conversation";
	readonly description =
		"Loads an audio file (WAV, MP3, AAC, AIFF, OGG, FLAC, or M4A) into the conversation context for audio-capable models.";
	readonly parameters = loadAudioSchema;
	readonly strict = false;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: LoadAudioParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<Record<string, never>>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<Record<string, never>>> {
		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for load_audio.");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("No models available for load_audio.");
		}

		const matchPreferences = getModelMatchPreferences(this.session.settings);
		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();
		const activeModel = activeModelPattern
			? resolveModelFromString(
					expandRoleAlias(activeModelPattern, this.session.settings),
					availableModels,
					matchPreferences,
					modelRegistry,
				)
			: undefined;

		// load_audio attaches audio to the conversation, which the ACTIVE model
		// processes. If it lacks audio input the adapter drops the clip, so fail
		// loudly instead of silently attaching unusable audio. To analyze a clip
		// through modelRoles.audio without switching models, use inspect_audio.
		if (!activeModel?.input.includes("audio")) {
			throw new ToolError(
				"The active model does not support audio input. Switch to an audio-capable model with --model, or use the inspect_audio tool to analyze the clip through modelRoles.audio.",
			);
		}

		let audioInput: LoadedAudioInput | null;
		try {
			audioInput = await loadAudioInput({
				path: params.path,
				cwd: this.session.cwd,
				maxBytes: MAX_AUDIO_INPUT_BYTES,
			});
		} catch (error) {
			if (error instanceof AudioInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		if (!audioInput) {
			throw new ToolError(
				"load_audio only supports WAV, MP3, AAC, AIFF, OGG, FLAC, and M4A files detected by content.",
			);
		}

		if (!audioInputSupportedByApi(audioInput.mimeType, activeModel.api)) {
			throw new ToolError(
				`${activeModel.provider}/${activeModel.id} only accepts MP3/WAV audio input, but the file is ${audioInput.mimeType}. Convert the clip to MP3 or WAV, or use an audio-capable model that accepts this format.`,
			);
		}

		return {
			content: [
				{ type: "text", text: audioInput.textNote },
				{
					type: "audio",
					data: audioInput.data,
					mimeType: audioInput.mimeType,
					...(audioInput.format ? { format: audioInput.format } : {}),
				},
			],
			details: {},
		};
	}
}
