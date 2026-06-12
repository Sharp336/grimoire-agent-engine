import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { FileEntry } from "./session-manager";
import { parseSessionEntries } from "./session-manager";

export interface CompleteEntryPage {
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
}

export interface CompleteEntryPageOptions {
	fromByte?: number;
	maxBytes?: number;
	maxEntries?: number;
}

/** Read only newline-terminated JSONL entries, advancing a byte cursor over complete entries. */
export async function readCompleteEntryPage(
	sessionFile: string,
	options: CompleteEntryPageOptions = {},
): Promise<CompleteEntryPage> {
	let startByte = Number.isFinite(options.fromByte) ? Math.max(0, Math.trunc(options.fromByte!)) : 0;
	const maxBytes =
		options.maxBytes === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.trunc(options.maxBytes));
	const maxEntries =
		options.maxEntries === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.trunc(options.maxEntries));
	let size: number;
	try {
		({ size } = await fs.stat(sessionFile));
	} catch (error) {
		if (!isEnoent(error)) throw error;
		return { fromByte: startByte, nextByte: startByte, reset: false, entries: [] };
	}

	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}
	if (startByte >= size) return { fromByte: startByte, nextByte: startByte, reset, entries: [] };

	// Read one extra byte so a page ending exactly on a newline can be recognized.
	const text = await Bun.file(sessionFile)
		.slice(startByte, Math.min(size, startByte + maxBytes + 1))
		.text();
	const lines = text.split("\n");
	const completeLineCount = text.endsWith("\n") ? lines.length - 1 : Math.max(0, lines.length - 1);
	const selected = lines.slice(0, Math.min(completeLineCount, maxEntries));
	const completeText = selected.length > 0 ? `${selected.join("\n")}\n` : "";
	const entries = completeText.length > 0 ? parseSessionEntries(completeText) : [];
	return {
		fromByte: startByte,
		nextByte: startByte + Buffer.byteLength(completeText, "utf8"),
		reset,
		entries,
	};
}
