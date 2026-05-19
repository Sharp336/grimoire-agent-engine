import { ToolError } from "./tool-errors";
import { inflateZipEntry } from "./zip-inflate";

export type ArchiveFormat = "zip" | "tar" | "tar.gz";

export interface ArchivePathCandidate {
	archivePath: string;
	subPath: string;
}

export interface ArchiveNode {
	path: string;
	isDirectory: boolean;
	size: number;
	mtimeMs?: number;
}

export interface ArchiveDirectoryEntry extends ArchiveNode {
	name: string;
}

export interface ExtractedArchiveFile extends ArchiveNode {
	bytes: Uint8Array;
}

export interface ArchiveReaderOptions {
	zipFilenameEncoding?: string;
}

interface TarStorage {
	type: "tar";
	file: File;
}

interface ZipStorage {
	type: "zip";
	archiveBytes: Uint8Array;
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	crc32: number;
}

type EntryStorage = TarStorage | ZipStorage;

interface ArchiveIndexEntry extends ArchiveNode {
	storage?: EntryStorage;
}

interface ZipExtraField {
	id: number;
	data: Uint8Array;
}

interface ZipCentralDirectoryRecord {
	rawName: Uint8Array;
	extraFields: ZipExtraField[];
	generalPurposeBitFlag: number;
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	crc32: number;
}

interface ZipEndOfCentralDirectory {
	entryCount: number;
	centralDirectorySize: number;
	centralDirectoryOffset: number;
}

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FILENAME_FLAG = 0x0800;
const ZIP_UNICODE_PATH_EXTRA_FIELD_ID = 0x7075;
const ZIP64_16_BIT_SENTINEL = 0xffff;
const ZIP64_32_BIT_SENTINEL = 0xffffffff;
const ZIP_EOCD_MIN_LENGTH = 22;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const CP437_HIGH_CODE_POINTS = [
	0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec,
	0x00c4, 0x00c5, 0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x00ff, 0x00d6, 0x00dc, 0x00a2,
	0x00a3, 0x00a5, 0x20a7, 0x0192, 0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba, 0x00bf, 0x2310,
	0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb, 0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
	0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510, 0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c,
	0x255e, 0x255f, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567, 0x2568, 0x2564, 0x2565, 0x2559,
	0x2558, 0x2552, 0x2553, 0x256b, 0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580, 0x03b1, 0x00df,
	0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4, 0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
	0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248, 0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2,
	0x25a0, 0x00a0,
] as const;

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) {
			value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
	}
	return (value ^ 0xffffffff) >>> 0;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 2 > bytes.length) throw new ToolError("Invalid ZIP archive: unexpected EOF");
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > bytes.length) throw new ToolError("Invalid ZIP archive: unexpected EOF");
	return (
		(bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! * 0x1000000)) >>> 0
	);
}

function assertZipRange(bytes: Uint8Array, offset: number, length: number): void {
	if (offset < 0 || length < 0 || offset + length > bytes.length) {
		throw new ToolError("Invalid ZIP archive: entry extends beyond archive bounds");
	}
}

function normalizeArchiveLookupPath(rawPath?: string): string | undefined {
	if (!rawPath) return "";

	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	return normalizedParts.join("/");
}

function normalizeArchiveEntryPath(rawPath: string): string | undefined {
	const parts = rawPath.replace(/\\/g, "/").split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) return undefined;
	return normalizedParts.join("/");
}

function isArchiveDirectoryName(rawPath: string): boolean {
	return rawPath.endsWith("/") || rawPath.endsWith("\\");
}

function upsertArchiveEntry(map: Map<string, ArchiveIndexEntry>, entry: ArchiveIndexEntry): void {
	const existing = map.get(entry.path);
	if (!existing) {
		map.set(entry.path, entry);
		return;
	}

	if (existing.isDirectory && !entry.isDirectory) {
		map.set(entry.path, entry);
		return;
	}

	if (!existing.isDirectory && entry.isDirectory) {
		return;
	}

	map.set(entry.path, {
		...existing,
		size: existing.size || entry.size,
		mtimeMs: existing.mtimeMs ?? entry.mtimeMs,
		storage: existing.storage ?? entry.storage,
	});
}

function ensureParentDirectories(map: Map<string, ArchiveIndexEntry>): void {
	for (const entry of [...map.values()]) {
		const parts = entry.path.split("/");
		const stop = parts.length - 1;
		for (let index = 1; index <= stop; index++) {
			const dirPath = parts.slice(0, index).join("/");
			if (!dirPath || map.has(dirPath)) continue;
			map.set(dirPath, {
				path: dirPath,
				isDirectory: true,
				size: 0,
			});
		}
	}
}

function getArchiveFormatFromPath(filePath: string): ArchiveFormat | undefined {
	const normalized = filePath.toLowerCase();
	if (normalized.endsWith(".tar.gz") || normalized.endsWith(".tgz")) return "tar.gz";
	if (normalized.endsWith(".tar")) return "tar";
	if (normalized.endsWith(".zip")) return "zip";
	return undefined;
}

async function readTarEntries(bytes: Uint8Array): Promise<ArchiveIndexEntry[]> {
	let archive: Bun.Archive;
	try {
		archive = new Bun.Archive(bytes);
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}

	let files: Map<string, File>;
	try {
		files = await archive.files();
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}

	const entries: ArchiveIndexEntry[] = [];
	for (const [rawPath, file] of files) {
		const normalizedPath = normalizeArchiveEntryPath(rawPath);
		if (!normalizedPath) continue;
		const mtimeMs = file.lastModified > 0 ? file.lastModified : undefined;
		entries.push({
			path: normalizedPath,
			isDirectory: false,
			size: file.size,
			mtimeMs,
			storage: { type: "tar", file },
		});
	}

	return entries;
}

function findEndOfCentralDirectory(bytes: Uint8Array): ZipEndOfCentralDirectory {
	if (bytes.length < ZIP_EOCD_MIN_LENGTH) throw new ToolError("Invalid ZIP archive: missing end of central directory");

	const minimumOffset = Math.max(0, bytes.length - ZIP_EOCD_MIN_LENGTH - ZIP_MAX_COMMENT_LENGTH);
	for (let offset = bytes.length - ZIP_EOCD_MIN_LENGTH; offset >= minimumOffset; offset--) {
		if (readUint32LE(bytes, offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;

		const commentLength = readUint16LE(bytes, offset + 20);
		if (offset + ZIP_EOCD_MIN_LENGTH + commentLength !== bytes.length) continue;

		const diskNumber = readUint16LE(bytes, offset + 4);
		const centralDirectoryDisk = readUint16LE(bytes, offset + 6);
		const diskEntryCount = readUint16LE(bytes, offset + 8);
		const entryCount = readUint16LE(bytes, offset + 10);
		const centralDirectorySize = readUint32LE(bytes, offset + 12);
		const centralDirectoryOffset = readUint32LE(bytes, offset + 16);

		if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== entryCount) {
			throw new ToolError("Multi-disk ZIP archives are not supported by the read tool");
		}
		if (
			entryCount === ZIP64_16_BIT_SENTINEL ||
			centralDirectorySize === ZIP64_32_BIT_SENTINEL ||
			centralDirectoryOffset === ZIP64_32_BIT_SENTINEL
		) {
			throw new ToolError("ZIP64 archives are not supported by the read tool yet");
		}
		assertZipRange(bytes, centralDirectoryOffset, centralDirectorySize);

		return { entryCount, centralDirectorySize, centralDirectoryOffset };
	}

	throw new ToolError("Invalid ZIP archive: missing end of central directory");
}

function parseZipExtraFields(bytes: Uint8Array): ZipExtraField[] {
	const fields: ZipExtraField[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		if (offset + 4 > bytes.length) throw new ToolError("Invalid ZIP archive: truncated extra field");
		const id = readUint16LE(bytes, offset);
		const size = readUint16LE(bytes, offset + 2);
		const dataOffset = offset + 4;
		assertZipRange(bytes, dataOffset, size);
		fields.push({ id, data: bytes.subarray(dataOffset, dataOffset + size) });
		offset = dataOffset + size;
	}
	return fields;
}

function parseZipCentralDirectory(bytes: Uint8Array): ZipCentralDirectoryRecord[] {
	const eocd = findEndOfCentralDirectory(bytes);
	const records: ZipCentralDirectoryRecord[] = [];
	let offset = eocd.centralDirectoryOffset;
	const end = eocd.centralDirectoryOffset + eocd.centralDirectorySize;

	for (let index = 0; index < eocd.entryCount; index++) {
		if (offset + 46 > end) throw new ToolError("Invalid ZIP archive: truncated central directory entry");
		if (readUint32LE(bytes, offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
			throw new ToolError("Invalid ZIP archive: bad central directory signature");
		}

		const generalPurposeBitFlag = readUint16LE(bytes, offset + 8);
		const compressionMethod = readUint16LE(bytes, offset + 10);
		const compressedSize = readUint32LE(bytes, offset + 20);
		const uncompressedSize = readUint32LE(bytes, offset + 24);
		const fileNameLength = readUint16LE(bytes, offset + 28);
		const extraFieldLength = readUint16LE(bytes, offset + 30);
		const fileCommentLength = readUint16LE(bytes, offset + 32);
		const localHeaderOffset = readUint32LE(bytes, offset + 42);
		const expectedCrc32 = readUint32LE(bytes, offset + 16);

		if (
			compressedSize === ZIP64_32_BIT_SENTINEL ||
			uncompressedSize === ZIP64_32_BIT_SENTINEL ||
			localHeaderOffset === ZIP64_32_BIT_SENTINEL
		) {
			throw new ToolError("ZIP64 archives are not supported by the read tool yet");
		}

		const rawNameOffset = offset + 46;
		const extraFieldOffset = rawNameOffset + fileNameLength;
		const fileCommentOffset = extraFieldOffset + extraFieldLength;
		const nextOffset = fileCommentOffset + fileCommentLength;
		if (nextOffset > end)
			throw new ToolError("Invalid ZIP archive: central directory entry exceeds directory bounds");

		records.push({
			rawName: bytes.subarray(rawNameOffset, extraFieldOffset),
			extraFields: parseZipExtraFields(bytes.subarray(extraFieldOffset, fileCommentOffset)),
			generalPurposeBitFlag,
			compressionMethod,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
			crc32: expectedCrc32,
		});
		offset = nextOffset;
	}

	return records;
}

function decodeUtf8(bytes: Uint8Array): string {
	return UTF8_DECODER.decode(bytes);
}

function readUnicodePathExtraField(fields: ZipExtraField[], rawName: Uint8Array): string | undefined {
	for (const field of fields) {
		if (field.id !== ZIP_UNICODE_PATH_EXTRA_FIELD_ID) continue;
		if (field.data.length < 5) continue;
		if (field.data[0] !== 1) continue;

		const expectedNameCrc = readUint32LE(field.data, 1);
		if (expectedNameCrc !== crc32(rawName)) continue;

		try {
			return decodeUtf8(field.data.subarray(5));
		} catch {}
	}
	return undefined;
}

function decodeCp437(bytes: Uint8Array): string {
	let result = "";
	for (const byte of bytes) {
		result += String.fromCodePoint(byte < 0x80 ? byte : CP437_HIGH_CODE_POINTS[byte - 0x80]!);
	}
	return result;
}

function decodeZipEntryPath(record: ZipCentralDirectoryRecord, fallbackEncoding?: string): string | undefined {
	if ((record.generalPurposeBitFlag & ZIP_UTF8_FILENAME_FLAG) !== 0) {
		try {
			return decodeUtf8(record.rawName);
		} catch {
			throw new ToolError("ZIP entry name is marked as UTF-8 but contains invalid UTF-8");
		}
	}

	const unicodePath = readUnicodePathExtraField(record.extraFields, record.rawName);
	if (unicodePath !== undefined) return unicodePath;

	if (fallbackEncoding && fallbackEncoding !== "none") {
		try {
			return new TextDecoder(fallbackEncoding as "utf-8", { fatal: true }).decode(record.rawName);
		} catch (error) {
			throw new ToolError(
				error instanceof Error
					? `Failed to decode ZIP entry name with '${fallbackEncoding}': ${error.message}`
					: `Failed to decode ZIP entry name with '${fallbackEncoding}': ${String(error)}`,
			);
		}
	}

	return decodeCp437(record.rawName);
}

async function readZipEntryBytes(storage: ZipStorage): Promise<Uint8Array> {
	const { archiveBytes, localHeaderOffset } = storage;
	assertZipRange(archiveBytes, localHeaderOffset, 30);
	if (readUint32LE(archiveBytes, localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
		throw new ToolError("Invalid ZIP archive: bad local file header signature");
	}

	const fileNameLength = readUint16LE(archiveBytes, localHeaderOffset + 26);
	const extraFieldLength = readUint16LE(archiveBytes, localHeaderOffset + 28);
	const compressedOffset = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
	assertZipRange(archiveBytes, compressedOffset, storage.compressedSize);
	const compressed = archiveBytes.subarray(compressedOffset, compressedOffset + storage.compressedSize);

	let bytes: Uint8Array;
	if (storage.compressionMethod === 0) {
		bytes = compressed;
	} else if (storage.compressionMethod === 8) {
		try {
			bytes = inflateZipEntry(compressed, storage.uncompressedSize);
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
	} else {
		throw new ToolError(`Unsupported ZIP compression method: ${storage.compressionMethod}`);
	}

	if (crc32(bytes) !== storage.crc32) {
		throw new ToolError("ZIP entry CRC mismatch");
	}
	return bytes;
}

async function readZipEntries(bytes: Uint8Array, options: ArchiveReaderOptions = {}): Promise<ArchiveIndexEntry[]> {
	const records = parseZipCentralDirectory(bytes);
	const entries: ArchiveIndexEntry[] = [];
	for (const record of records) {
		const decodedPath = decodeZipEntryPath(record, options.zipFilenameEncoding);
		if (!decodedPath) continue;
		const normalizedPath = normalizeArchiveEntryPath(decodedPath);
		if (!normalizedPath) continue;

		const isDirectory = isArchiveDirectoryName(decodedPath);
		entries.push({
			path: normalizedPath,
			isDirectory,
			size: isDirectory ? 0 : record.uncompressedSize,
			storage: isDirectory
				? undefined
				: {
						type: "zip",
						archiveBytes: bytes,
						compressionMethod: record.compressionMethod,
						compressedSize: record.compressedSize,
						uncompressedSize: record.uncompressedSize,
						localHeaderOffset: record.localHeaderOffset,
						crc32: record.crc32,
					},
		});
	}
	return entries;
}

export function parseArchivePathCandidates(filePath: string): ArchivePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const pattern = /\.(?:tar\.gz|tgz|zip|tar)(?=(?::|$))/gi;
	const seen = new Set<string>();
	const candidates: ArchivePathCandidate[] = [];

	let match: RegExpExecArray | null;
	while (true) {
		match = pattern.exec(normalized);
		if (match === null) {
			break;
		}
		const end = match.index + match[0].length;
		const archivePath = filePath.slice(0, end);
		const subPath = normalized.slice(end).replace(/^:+/, "");
		const key = `${archivePath}\0${subPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ archivePath, subPath });
	}

	return candidates.sort((left, right) => right.archivePath.length - left.archivePath.length);
}

export class ArchiveReader {
	readonly format: ArchiveFormat;
	#entries = new Map<string, ArchiveIndexEntry>();

	constructor(format: ArchiveFormat, entries: ArchiveIndexEntry[]) {
		this.format = format;
		for (const entry of entries) {
			upsertArchiveEntry(this.#entries, entry);
		}
		ensureParentDirectories(this.#entries);
	}

	getNode(subPath?: string): ArchiveNode | undefined {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) return undefined;
		if (normalizedPath === "") {
			return { path: "", isDirectory: true, size: 0 };
		}

		const entry = this.#entries.get(normalizedPath);
		if (!entry) return undefined;
		return {
			path: entry.path,
			isDirectory: entry.isDirectory,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
		};
	}

	listDirectory(subPath?: string): ArchiveDirectoryEntry[] {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) {
			throw new ToolError("Archive path cannot contain '..'");
		}

		if (normalizedPath) {
			const entry = this.#entries.get(normalizedPath);
			if (!entry) {
				throw new ToolError(`Archive path '${normalizedPath}' not found`);
			}
			if (!entry.isDirectory) {
				throw new ToolError(`Archive path '${normalizedPath}' is not a directory`);
			}
		}

		const prefix = normalizedPath ? `${normalizedPath}/` : "";
		const children = new Map<string, ArchiveDirectoryEntry>();

		for (const entry of this.#entries.values()) {
			if (normalizedPath) {
				if (!entry.path.startsWith(prefix) || entry.path === normalizedPath) continue;
			}

			const relativePath = normalizedPath ? entry.path.slice(prefix.length) : entry.path;
			const nextSegment = relativePath.split("/")[0];
			if (!nextSegment) continue;

			const childPath = normalizedPath ? `${normalizedPath}/${nextSegment}` : nextSegment;
			if (children.has(childPath)) continue;

			const childEntry = this.#entries.get(childPath);
			const isDirectory = childEntry?.isDirectory ?? relativePath.includes("/");
			children.set(childPath, {
				name: nextSegment,
				path: childPath,
				isDirectory,
				size: isDirectory ? 0 : (childEntry?.size ?? entry.size),
				mtimeMs: childEntry?.mtimeMs ?? entry.mtimeMs,
			});
		}

		return [...children.values()].sort((left, right) =>
			left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
		);
	}

	async readFile(subPath: string): Promise<ExtractedArchiveFile> {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (!normalizedPath) {
			throw new ToolError("Archive file path is required");
		}

		const entry = this.#entries.get(normalizedPath);
		if (!entry) {
			throw new ToolError(`Archive file '${normalizedPath}' not found`);
		}
		if (entry.isDirectory) {
			throw new ToolError(`Archive path '${normalizedPath}' is a directory`);
		}
		if (!entry.storage) {
			throw new ToolError(`Archive file '${normalizedPath}' has no readable storage`);
		}

		const bytes =
			entry.storage.type === "tar" ? await entry.storage.file.bytes() : await readZipEntryBytes(entry.storage);

		return {
			path: entry.path,
			isDirectory: false,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			bytes,
		};
	}
}

export async function openArchive(filePath: string, options: ArchiveReaderOptions = {}): Promise<ArchiveReader> {
	const format = getArchiveFormatFromPath(filePath);
	if (!format) {
		throw new ToolError(`Unsupported archive format: ${filePath}`);
	}

	const bytes = await Bun.file(filePath).bytes();
	const entries = format === "zip" ? await readZipEntries(bytes, options) : await readTarEntries(bytes);
	return new ArchiveReader(format, entries);
}
