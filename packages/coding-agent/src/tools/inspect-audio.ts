import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { type } from "arktype";
import { extractTextContent } from "../commit/utils";
import { expandRoleAlias, getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import {
	AudioInputTooLargeError,
	type LoadedAudioInput,
	loadAudioInput,
	MAX_AUDIO_INPUT_BYTES,
} from "../utils/audio-input";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const inspectAudioSchema = type({
	path: type("string").describe("audio file path"),
	question: type("string").describe("question about the audio"),
	"+": "reject",
});

export type InspectAudioParams = typeof inspectAudioSchema.infer;

export interface InspectAudioToolDetails {
	model: string;
	audioPath: string;
	mimeType: string;
}

export class InspectAudioTool implements AgentTool<typeof inspectAudioSchema, InspectAudioToolDetails> {
	readonly name = "inspect_audio";
	readonly approval = "read" as const;
	readonly label = "InspectAudio";
	readonly loadMode = "discoverable";
	readonly summary = "Describe or analyze an audio file";
	readonly description = "Inspects an audio file with an audio-capable model and returns compact text analysis.";
	readonly parameters = inspectAudioSchema;
	readonly strict = false;

	constructor(
		private readonly session: ToolSession,
		private readonly completeAudioRequest: typeof completeSimple = completeSimple,
	) {}

	async execute(
		_toolCallId: string,
		params: InspectAudioParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<InspectAudioToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<InspectAudioToolDetails>> {
		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for inspect_audio.");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("No models available for inspect_audio.");
		}

		const matchPreferences = getModelMatchPreferences(this.session.settings);
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			const expanded = expandRoleAlias(pattern, this.session.settings);
			const resolved = resolveModelFromString(expanded, availableModels, matchPreferences, modelRegistry);
			return resolved?.input.includes("audio") ? resolved : undefined;
		};

		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();
		const model =
			resolvePattern("pi/audio") ??
			resolvePattern(activeModelPattern) ??
			availableModels.find(candidate => candidate.input.includes("audio"));
		if (!model) {
			throw new ToolError("No audio-capable model is available. Configure one via modelRoles.audio or --model.");
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
				"inspect_audio only supports WAV, MP3, AAC, AIFF, OGG, FLAC, and M4A files detected by content.",
			);
		}

		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const response = await instrumentedCompleteSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{
								type: "audio",
								data: audioInput.data,
								mimeType: audioInput.mimeType,
								...(audioInput.format ? { format: audioInput.format } : {}),
							},
							{ type: "text", text: params.question },
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: modelRegistry.resolver(model, this.session.getSessionId?.() ?? undefined),
				signal,
			},
			{ telemetry, oneshotKind: "inspect_audio", completeImpl: this.completeAudioRequest },
		);

		if (response.stopReason === "error") {
			throw new ToolError(response.errorMessage ?? "inspect_audio request failed.");
		}
		if (response.stopReason === "aborted") {
			throw new ToolError("inspect_audio request aborted.");
		}

		const text = extractTextContent(response);
		if (!text) {
			throw new ToolError("inspect_audio model returned no text output.");
		}

		return {
			content: [{ type: "text", text }],
			details: {
				model: `${model.provider}/${model.id}`,
				audioPath: audioInput.resolvedPath,
				mimeType: audioInput.mimeType,
			},
		};
	}
}
