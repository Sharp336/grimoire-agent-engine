import * as fs from "node:fs/promises";
import type { AudioContent } from "@oh-my-pi/pi-ai";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { resolveReadPath } from "../tools/path-utils";

export const MAX_AUDIO_INPUT_BYTES = 25 * 1024 * 1024;

export const SUPPORTED_INPUT_AUDIO_MIME_TYPES: Record<string, true> = {
	"audio/wav": true,
	"audio/x-wav": true,
	"audio/mpeg": true,
	"audio/aac": true,
	"audio/mp4": true,
	"audio/aiff": true,
	"audio/x-aiff": true,
	"audio/ogg": true,
	"audio/flac": true,
};

export interface LoadedAudioInput extends AudioContent {
	resolvedPath: string;
	textNote: string;
	bytes: number;
}

export class AudioInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Audio file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "AudioInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

export interface LoadAudioInputOptions {
	path: string;
	cwd: string;
	resolvedPath?: string;
	detectedMimeType?: string;
	maxBytes?: number;
}

function startsWith(bytes: Uint8Array, ascii: string, offset = 0): boolean {
	if (bytes.length < offset + ascii.length) return false;
	for (let i = 0; i < ascii.length; i++) {
		if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
	}
	return true;
}

function containsAscii(bytes: Uint8Array, needle: string, maxScan = bytes.length): boolean {
	const limit = Math.min(maxScan, bytes.length) - needle.length;
	for (let i = 0; i <= limit; i++) {
		let match = true;
		for (let j = 0; j < needle.length; j++) {
			if (bytes[i + j] !== needle.charCodeAt(j)) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}
	return false;
}

function detectSupportedAudioMimeType(bytes: Uint8Array): string | null {
	if (startsWith(bytes, "RIFF") && startsWith(bytes, "WAVE", 8)) return "audio/wav";
	if (startsWith(bytes, "ID3")) return "audio/mpeg";
	if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "audio/aac";
	if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
	if (startsWith(bytes, "FORM") && (startsWith(bytes, "AIFF", 8) || startsWith(bytes, "AIFC", 8))) {
		return "audio/aiff";
	}
	// Ogg is a generic container that also carries video (e.g. Ogg/Theora .ogv).
	// Confirm an audio codec signature before classifying as audio.
	if (startsWith(bytes, "OggS")) {
		if (containsAscii(bytes, "OpusHead")) return "audio/ogg";
		if (containsAscii(bytes, "vorbis")) return "audio/ogg";
		if (containsAscii(bytes, "Speex")) return "audio/ogg";
		if (containsAscii(bytes, "fLaC")) return "audio/flac";
		return null;
	}
	if (startsWith(bytes, "fLaC")) return "audio/flac";
	// MP4: accept only audio-specific `ftyp` brands. Generic brands like `isom`,
	// `mp42`, `mp41` are also used by video containers, so matching them would
	// misdetect video files as audio.
	if (startsWith(bytes, "ftyp", 4)) {
		const brand = String.fromCharCode(...bytes.slice(8, Math.min(bytes.length, 12))).toLowerCase();
		if (brand === "m4a " || brand === "f4a " || brand === "f4b ") return "audio/mp4";
	}
	return null;
}

export function audioFormatFromMimeType(mimeType: string): string | undefined {
	const subtype = mimeType.split("/")[1]?.toLowerCase().split(";")[0];
	if (!subtype) return undefined;
	if (subtype === "mpeg") return "mp3";
	if (subtype === "x-wav" || subtype === "wave") return "wav";
	if (subtype === "x-aiff") return "aiff";
	if (subtype === "mp4") return "m4a";
	return subtype;
}

/**
 * OpenAI-family transports only accept MP3/WAV audio *input* (the
 * `input_audio` format field). Other containers (M4A/AAC/AIFF/OGG/FLAC)
 * would be accepted by the loader then silently downgraded to a text
 * placeholder by the adapter — reject them up front for these transports.
 */
const OPENAI_AUDIO_INPUT_MIME_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"]);
const OPENAI_FAMILY_APIS = new Set(["openai-completions", "openai-responses", "openai-codex-responses", "openrouter"]);

export function audioInputSupportedByApi(mimeType: string, api: string): boolean {
	if (!OPENAI_FAMILY_APIS.has(api)) return true;
	return OPENAI_AUDIO_INPUT_MIME_TYPES.has(mimeType.toLowerCase());
}

export async function detectSupportedAudioMimeTypeFromFile(path: string): Promise<string | null> {
	const header = await Bun.file(path).slice(0, 512).bytes();
	return detectSupportedAudioMimeType(header);
}

export async function loadAudioInput(options: LoadAudioInputOptions): Promise<LoadedAudioInput | null> {
	const maxBytes = options.maxBytes ?? MAX_AUDIO_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const mimeType = options.detectedMimeType ?? (await detectSupportedAudioMimeTypeFromFile(resolvedPath));
	if (!mimeType) return null;

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new AudioInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	if (inputBuffer.byteLength > maxBytes) {
		throw new AudioInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	const data = Buffer.from(inputBuffer).toString("base64");
	const format = audioFormatFromMimeType(mimeType);

	return {
		type: "audio",
		resolvedPath,
		mimeType,
		data,
		...(format ? { format } : {}),
		textNote: `Read audio file [${mimeType}, ${formatBytes(inputBuffer.byteLength)}]`,
		bytes: inputBuffer.byteLength,
	};
}
