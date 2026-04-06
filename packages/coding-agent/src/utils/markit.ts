import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolAbortError } from "../tools/tool-errors";

declare const PI_COMPILED: boolean;

export interface MarkitConversionResult {
	content: string;
	ok: boolean;
	error?: string;
}

interface MarkitStreamInfo {
	extension: string;
	filename: string;
}

interface MarkitResultPayload {
	markdown?: string;
}

interface MarkitClient {
	convertFile(filePath: string): Promise<MarkitResultPayload>;
	convert(buffer: Buffer, streamInfo: MarkitStreamInfo): Promise<MarkitResultPayload>;
}

interface MarkitModule {
	Markit: new () => MarkitClient;
}

const MARKIT_MODULE_NAME = "markit-ai";
const COMPILED_MARKIT_ERROR = "markit unavailable in compiled builds";

let markitPromise: Promise<MarkitClient> | undefined;

function isCompiledBuild(): boolean {
	return (typeof PI_COMPILED !== "undefined" && PI_COMPILED) || process.env.PI_COMPILED === "true";
}

async function loadMarkitModule(): Promise<MarkitModule> {
	return (await import(MARKIT_MODULE_NAME)) as MarkitModule;
}

async function getMarkit(): Promise<MarkitClient> {
	if (isCompiledBuild()) throw new Error(COMPILED_MARKIT_ERROR);
	markitPromise ??= loadMarkitModule().then(module => new module.Markit());
	return await markitPromise;
}

function normalizeExtension(extension: string): string {
	const trimmed = extension.trim().toLowerCase();
	if (!trimmed) return ".bin";
	return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message.trim();
	}
	return "Conversion failed";
}

async function runMarkitConversion<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	try {
		return signal ? await untilAborted(signal, task) : await task();
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			throw new ToolAbortError();
		}
		throw error;
	}
}

function finalizeConversion(markdown?: string): MarkitConversionResult {
	if (typeof markdown === "string" && markdown.length > 0) {
		return { content: markdown, ok: true };
	}

	return { content: "", ok: false, error: "Conversion produced no output" };
}

export async function convertFileWithMarkit(filePath: string, signal?: AbortSignal): Promise<MarkitConversionResult> {
	try {
		const markit = await getMarkit();
		const result = await runMarkitConversion(() => markit.convertFile(filePath), signal);
		return finalizeConversion(result.markdown);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		return { content: "", ok: false, error: normalizeError(error) };
	}
}

export async function convertBufferWithMarkit(
	buffer: Uint8Array,
	extension: string,
	signal?: AbortSignal,
): Promise<MarkitConversionResult> {
	const normalizedExtension = normalizeExtension(extension);
	const streamInfo: MarkitStreamInfo = {
		extension: normalizedExtension,
		filename: `input${normalizedExtension}`,
	};

	try {
		const markit = await getMarkit();
		const result = await runMarkitConversion(() => markit.convert(Buffer.from(buffer), streamInfo), signal);
		return finalizeConversion(result.markdown);
	} catch (error) {
		if (error instanceof ToolAbortError) {
			throw error;
		}
		return { content: "", ok: false, error: normalizeError(error) };
	}
}