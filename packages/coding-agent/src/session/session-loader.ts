import * as fs from "node:fs";
import * as readline from "node:readline";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBlobsDir, isEnoent, parseJsonlLenient } from "@oh-my-pi/pi-utils";
import { BlobStore, isBlobRef, resolveImageData, resolveImageDataUrl } from "./blob-store";
import { buildSessionContext } from "./session-context";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-entries";
import { migrateToCurrentVersion } from "./session-migrations";
import { isImageBlock, isImageDataPayload } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";

const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const ELIDED_COMPACTION_SUMMARY = "[Superseded compaction summary elided during session load]";

/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseJsonlLenient<FileEntry>(content);
}

function elideCompactionSummary(entry: FileEntry | undefined): void {
	if (entry?.type !== "compaction") return;
	entry.summary = ELIDED_COMPACTION_SUMMARY;
	entry.shortSummary ??= "Superseded compaction elided";
	entry.preserveData = undefined;
}

async function loadEntriesFromFileStream(filePath: string): Promise<FileEntry[]> {
	const entries: FileEntry[] = [];
	let latestCompactionIndex: number | undefined;
	const input = fs.createReadStream(filePath, { encoding: "utf8" });
	const lines = readline.createInterface({ input, crlfDelay: Infinity });

	try {
		for await (const line of lines) {
			if (!line) continue;
			let entry: FileEntry;
			try {
				entry = JSON.parse(line) as FileEntry;
			} catch {
				continue;
			}
			if (entry.type === "compaction") {
				elideCompactionSummary(latestCompactionIndex === undefined ? undefined : entries[latestCompactionIndex]);
				latestCompactionIndex = entries.length;
			}
			entries.push(entry);
		}
	} catch (err) {
		input.destroy();
		if (isEnoent(err)) return [];
		throw err;
	}

	return entries;
}

/** Exported for testing */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<FileEntry[]> {
	let entries: FileEntry[];
	try {
		const stat = storage.statSync(filePath);
		entries =
			storage instanceof FileSessionStorage && stat.size >= STREAM_LOAD_THRESHOLD_BYTES
				? await loadEntriesFromFileStream(filePath)
				: parseSessionEntries(await storage.readText(filePath));
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	// Validate session header
	if (entries.length === 0) return entries;
	const header = entries[0] as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string") {
		return [];
	}

	return entries;
}

/**
 * Resolve blob references in loaded entries, restoring both session image blocks and persisted
 * provider image URLs back to the inline data expected by downstream transports. Mutates entries in place.
 */
function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

function shouldResolveImagePayload(value: unknown, key: string | undefined): value is { data: string } {
	if (!isImageDataPayload(value) || !isBlobRef(value.data)) return false;
	return (key === "content" && isImageBlock(value)) || key === "images";
}

async function resolvePersistedBlobRefs(value: unknown, blobStore: BlobStore, key?: string): Promise<void> {
	if (shouldResolveImagePayload(value, key)) {
		value.data = await resolveImageData(blobStore, value.data);
		return;
	}

	if (Array.isArray(value)) {
		await Promise.all(value.map(item => resolvePersistedBlobRefs(item, blobStore, key)));
		return;
	}

	if (typeof value !== "object" || value === null) return;

	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		value.image_url = await resolveImageDataUrl(blobStore, value.image_url);
	}

	await Promise.all(
		Object.entries(value).map(([childKey, item]) => resolvePersistedBlobRefs(item, blobStore, childKey)),
	);
}

export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	await Promise.all(
		entries.filter(entry => entry.type !== "session").map(entry => resolvePersistedBlobRefs(entry, blobStore)),
	);
}

/**
 * Read-only message view of a session file: load entries, migrate to the
 * current version, resolve blob refs, and build the context along the
 * persisted leaf path (last entry). Does NOT create a writer or take the
 * session lock — safe to call against a file another session is writing.
 */
export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()));
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	return buildSessionContext(sessionEntries).messages;
}
