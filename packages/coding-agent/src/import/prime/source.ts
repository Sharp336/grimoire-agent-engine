import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	PRIME_IMPORT_SCHEMA_VERSION,
	type PrimeImportDomain,
	type PrimeImportLoss,
	type PrimeImportLossCode,
	type PrimeImportSourceDiscovery,
	type PrimeImportSourceInventory,
	type PrimeImportSourceOptions,
	type PrimeSourceDirectory,
	type PrimeSourceDrift,
	type PrimeSourceExcludedEntry,
	type PrimeSourceFile,
	type PrimeSourceRecord,
	type PrimeSourceSnapshot,
	type PrimeSourceSnapshotTreeEntry,
	type PrimeSourceSymlink,
} from "./types";

const HARD_MAX_FILE_BYTES = 16 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const HARD_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_FILE_BYTES = HARD_MAX_FILE_BYTES;
const DEFAULT_MAX_TOTAL_BYTES = HARD_MAX_TOTAL_BYTES;
const DEFAULT_MAX_ENTRIES = HARD_MAX_ENTRIES;
const LEGACY_SESSION_DIRECTORY = /^--.+--$/;
const SESSION_FILE = /\.jsonl$/;
const EXCLUDED_REASONS: Record<string, PrimeSourceExcludedEntry["reason"]> = {
	kernel: "kernel",
	kernels: "kernel",
	"kernel-state.dill": "kernel",
	"kernel-state.json": "kernel",
	harness: "harness",
	"harness-state": "harness",
	"rlm-subagents.jsonl": "rlm",
	"rlm-sessions": "rlm",
	"cron-jobs.json": "schedule",
	"schedule.json": "schedule",
	"scheduled-jobs.json": "schedule",
	"scheduled-jobs.json.lock": "schedule",
	schedules: "schedule",
	leases: "lease",
	"session-leases": "lease",
	heartbeat: "heartbeat",
	heartbeats: "heartbeat",
	runtime: "runtime",
	"runtime-state": "runtime",
};

interface BudgetState {
	readonly maxTotalBytes: number;
	readonly maxEntries: number;
	entries: number;
	totalBytes: number;
	exhausted: boolean;
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function validateBudget(name: string, value: number | undefined, fallback: number, hardLimit: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimit) {
		throw new RangeError(`${name} must be a safe positive integer no greater than ${hardLimit}`);
	}
	return value;
}

function budgetLoss(
	context: ScanContext,
	sourceRef: string,
	filePath: string,
	domain: PrimeImportDomain = context.domain,
): void {
	if (context.budget.exhausted) return;
	context.budget.exhausted = true;
	context.losses.push(loss("source-budget-exceeded", domain, sourceRef, path.resolve(filePath)));
}

function consumeEntry(context: ScanContext, sourceRef: string, filePath: string): boolean {
	if (context.budget.exhausted) return false;
	if (context.budget.entries >= context.budget.maxEntries) {
		budgetLoss(context, sourceRef, filePath);
		return false;
	}
	context.budget.entries += 1;
	return true;
}

function reserveBytes(
	context: ScanContext,
	sourceRef: string,
	filePath: string,
	size: number,
	domain: PrimeImportDomain = context.domain,
): boolean {
	if (context.budget.exhausted) return false;
	if (size > context.budget.maxTotalBytes - context.budget.totalBytes) {
		budgetLoss(context, sourceRef, filePath, domain);
		return false;
	}
	context.budget.totalBytes += size;
	return true;
}

interface FileStatIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

interface ScanContext {
	readonly domain: PrimeImportDomain;
	readonly sourcePrefix: string;
	readonly allowedRoots: readonly string[];
	readonly logicalRoot?: string;
	readonly logicalRootCanonical?: string;
	readonly maxFileBytes: number;
	readonly budget: BudgetState;
	readonly scannedDirectories: Set<string>;
	readonly chargedFiles: Set<string>;
	readonly records: PrimeSourceRecord[];
	readonly excluded: PrimeSourceExcludedEntry[];
	readonly losses: PrimeImportLoss[];
}

interface ReadFileResult {
	readonly file?: PrimeSourceFile;
	readonly losses: readonly PrimeImportLoss[];
}

function loss(
	code: PrimeImportLossCode,
	domain: PrimeImportDomain,
	sourceRef: string,
	filePath?: string,
): PrimeImportLoss {
	return filePath === undefined ? { code, domain, sourceRef } : { code, domain, sourceRef, path: filePath };
}

function modeOf(stat: { mode: number }): number {
	return stat.mode & 0o7777;
}

function sameFileIdentity(left: FileStatIdentity, right: FileStatIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function isContained(candidate: string, roots: readonly string[]): boolean {
	return roots.some(root => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

function sourceRefFor(prefix: string, relative: string): string {
	return relative ? `${prefix}/${relative.split(path.sep).join("/")}` : prefix;
}

async function readBoundedDirectory(
	root: string,
	context: ScanContext,
	sourcePrefix: string,
): Promise<string[] | undefined> {
	const allowedRoots = context.logicalRootCanonical ? [context.logicalRootCanonical] : context.allowedRoots;
	const before = await fs.lstat(root);
	if (before.isSymbolicLink()) {
		context.losses.push(loss("source-symlink", context.domain, sourcePrefix, path.resolve(root)));
		return undefined;
	}
	if (!before.isDirectory()) {
		context.losses.push(loss("source-type-changed", context.domain, sourcePrefix, path.resolve(root)));
		return undefined;
	}
	const canonicalBefore = await safeRealpath(root);
	if (canonicalBefore === undefined || !isContained(canonicalBefore, allowedRoots)) {
		context.losses.push(
			loss("source-path-escape", context.domain, sourcePrefix, canonicalBefore ?? path.resolve(root)),
		);
		return undefined;
	}
	if (context.scannedDirectories.has(canonicalBefore)) return [];
	context.scannedDirectories.add(canonicalBefore);
	const entries: string[] = [];
	let overflow = false;
	const directory = await fs.opendir(root);
	for await (const entry of directory) {
		if (context.budget.entries >= context.budget.maxEntries) {
			overflow = true;
			break;
		}
		context.budget.entries += 1;
		entries.push(entry.name);
	}
	const after = await fs.lstat(root).catch(() => undefined);
	if (!after) {
		context.losses.push(loss("source-missing", context.domain, sourcePrefix, path.resolve(root)));
		return undefined;
	}
	if (after.isSymbolicLink()) {
		context.losses.push(loss("source-type-changed", context.domain, sourcePrefix, path.resolve(root)));
		context.losses.push(loss("source-symlink", context.domain, sourcePrefix, path.resolve(root)));
		return undefined;
	}
	const canonicalAfter = await safeRealpath(root);
	if (
		!after.isDirectory() ||
		canonicalAfter === undefined ||
		canonicalAfter !== canonicalBefore ||
		!sameFileIdentity(before, after)
	) {
		context.losses.push(loss("source-changed", context.domain, sourcePrefix, canonicalAfter ?? path.resolve(root)));
		return undefined;
	}
	if (overflow) {
		budgetLoss(context, sourcePrefix, root);
		return undefined;
	}
	return entries.sort(compareStrings);
}

async function safeRealpath(filePath: string): Promise<string | undefined> {
	try {
		return await fs.realpath(filePath);
	} catch {
		return undefined;
	}
}
async function hasSymlinkComponent(root: string, candidate: string, includeFinal = true): Promise<boolean> {
	const relative = path.relative(root, candidate);
	if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
	if (!relative) return includeFinal && (await fs.lstat(root).catch(() => undefined))?.isSymbolicLink() === true;
	const segments = relative.split(path.sep).filter(Boolean);
	let current = root;
	const limit = segments.length;
	for (let index = 0; index < limit; index += 1) {
		const stat = await fs.lstat(current).catch(() => undefined);
		if (stat?.isSymbolicLink()) return true;
		current = path.join(current, segments[index]);
	}
	if (!includeFinal) return false;
	const finalStat = await fs.lstat(current).catch(() => undefined);
	return finalStat?.isSymbolicLink() ?? false;
}

async function readSymlink(
	filePath: string,
	sourceRef: string,
	stat: Stats,
	context: ScanContext,
): Promise<PrimeSourceSymlink | undefined> {
	const canonicalPath = path.resolve(filePath);
	const parentPath = path.dirname(filePath);
	const canonicalAllowedRoots = context.logicalRootCanonical ? [context.logicalRootCanonical] : context.allowedRoots;
	const lexicalAllowedRoots = context.logicalRoot ? [path.resolve(context.logicalRoot)] : [];
	const parentBefore = await fs.lstat(parentPath).catch(() => undefined);
	const parentCanonicalBefore = await safeRealpath(parentPath);
	if (
		!parentBefore?.isDirectory() ||
		parentCanonicalBefore === undefined ||
		!isContained(parentCanonicalBefore, canonicalAllowedRoots)
	) {
		context.losses.push(
			loss("source-path-escape", context.domain, sourceRef, parentCanonicalBefore ?? canonicalPath),
		);
		return undefined;
	}
	const target = await fs.readlink(filePath).catch(() => undefined);
	const finalAfter = await fs.lstat(filePath).catch(() => undefined);
	const parentAfter = await fs.lstat(parentPath).catch(() => undefined);
	const parentCanonicalAfter = await safeRealpath(parentPath);
	if (!finalAfter) {
		context.losses.push(loss("source-missing", context.domain, sourceRef, canonicalPath));
		return undefined;
	}
	if (!finalAfter.isSymbolicLink()) {
		context.losses.push(loss("source-type-changed", context.domain, sourceRef, canonicalPath));
		return undefined;
	}
	if (
		!parentAfter?.isDirectory() ||
		parentCanonicalAfter === undefined ||
		parentCanonicalAfter !== parentCanonicalBefore ||
		!sameFileIdentity(parentBefore, parentAfter) ||
		!sameFileIdentity(stat, finalAfter)
	) {
		context.losses.push(loss("source-changed", context.domain, sourceRef, canonicalPath));
		return undefined;
	}
	const targetPaths =
		target === undefined ? [] : [path.resolve(parentPath, target), path.resolve(parentCanonicalBefore, target)];
	const external =
		targetPaths.length === 0 ||
		!targetPaths.some(
			targetPath => isContained(targetPath, lexicalAllowedRoots) || isContained(targetPath, canonicalAllowedRoots),
		);
	context.losses.push(
		loss(external ? "source-external-symlink" : "source-symlink", context.domain, sourceRef, canonicalPath),
	);
	return {
		kind: "symlink",
		domain: context.domain,
		sourceRef,
		canonicalPath,
		mode: modeOf(finalAfter),
		mtimeMs: finalAfter.mtimeMs,
		target,
		external,
	};
}
async function readRegularFile(filePath: string, sourceRef: string, context: ScanContext): Promise<ReadFileResult> {
	const resolvedPath = path.resolve(filePath);
	if (context.logicalRoot && (await hasSymlinkComponent(context.logicalRoot, filePath))) {
		return { losses: [loss("source-symlink", context.domain, sourceRef, resolvedPath)] };
	}
	let initial: Stats;
	try {
		initial = await fs.lstat(filePath);
	} catch {
		return { losses: [loss("source-missing", context.domain, sourceRef, resolvedPath)] };
	}
	if (initial.isSymbolicLink()) {
		await readSymlink(filePath, sourceRef, initial, context);
		return { losses: [], file: undefined };
	}
	if (!initial.isFile()) {
		return { losses: [loss("source-unsupported", context.domain, sourceRef, resolvedPath)] };
	}
	if (initial.size > context.maxFileBytes) {
		return { losses: [loss("source-oversized", context.domain, sourceRef, resolvedPath)] };
	}
	const canonicalPath = await safeRealpath(filePath);
	if (canonicalPath === undefined) {
		return { losses: [loss("source-unreadable", context.domain, sourceRef, resolvedPath)] };
	}
	if (context.logicalRootCanonical !== undefined && !isContained(canonicalPath, [context.logicalRootCanonical])) {
		return { losses: [loss("source-path-escape", context.domain, sourceRef, canonicalPath)] };
	}
	if (context.chargedFiles.has(canonicalPath)) return { losses: [] };
	context.chargedFiles.add(canonicalPath);
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (!opened.isFile()) {
			return { losses: [loss("source-type-changed", context.domain, sourceRef, canonicalPath)] };
		}
		if (!sameFileIdentity(initial, opened)) {
			return { losses: [loss("source-changed", context.domain, sourceRef, canonicalPath)] };
		}
		if (opened.size > context.maxFileBytes) {
			return { losses: [loss("source-oversized", context.domain, sourceRef, canonicalPath)] };
		}
		if (!reserveBytes(context, sourceRef, canonicalPath, opened.size)) return { losses: [] };
		const buffer = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < buffer.length) {
			const read = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (read.bytesRead === 0) {
				return { losses: [loss("source-changed", context.domain, sourceRef, canonicalPath)] };
			}
			offset += read.bytesRead;
		}
		const after = await fs.lstat(filePath).catch(() => undefined);
		if (!after) {
			return { losses: [loss("source-missing", context.domain, sourceRef, canonicalPath)] };
		}
		if (after.isSymbolicLink()) {
			return {
				losses: [
					loss("source-type-changed", context.domain, sourceRef, canonicalPath),
					loss("source-symlink", context.domain, sourceRef, canonicalPath),
				],
			};
		}
		if (!after.isFile()) {
			return { losses: [loss("source-type-changed", context.domain, sourceRef, canonicalPath)] };
		}
		if (!sameFileIdentity(opened, after)) {
			return { losses: [loss("source-changed", context.domain, sourceRef, canonicalPath)] };
		}
		const contentBase64 = buffer.toString("base64");
		return {
			file: {
				kind: "file",
				domain: context.domain,
				canonicalPath,
				sourceRef,
				mode: modeOf(after),
				mtimeMs: after.mtimeMs,
				size: after.size,
				sha256: createHash("sha256").update(buffer).digest("hex"),
				contentBase64,
			},
			losses: [],
		};
	} catch {
		const symlinked = context.logicalRoot ? await hasSymlinkComponent(context.logicalRoot, filePath) : false;
		return {
			losses: [loss(symlinked ? "source-symlink" : "source-unreadable", context.domain, sourceRef, canonicalPath)],
		};
	} finally {
		if (handle) await handle.close().catch(() => undefined);
	}
}

async function inspectEntry(
	filePath: string,
	sourceRef: string,
	context: ScanContext,
): Promise<PrimeSourceRecord | undefined> {
	let stat: Stats;
	try {
		stat = await fs.lstat(filePath);
	} catch {
		context.losses.push(loss("source-missing", context.domain, sourceRef, path.resolve(filePath)));
		return undefined;
	}
	if (stat.isSymbolicLink()) {
		const symlink = await readSymlink(filePath, sourceRef, stat, context);
		if (symlink) context.records.push(symlink);
		return symlink;
	}
	const canonicalPath = await safeRealpath(filePath);
	if (
		canonicalPath === undefined ||
		(context.logicalRootCanonical !== undefined && !isContained(canonicalPath, [context.logicalRootCanonical]))
	) {
		context.losses.push(
			loss("source-path-escape", context.domain, sourceRef, canonicalPath ?? path.resolve(filePath)),
		);
		return undefined;
	}
	if (stat.isDirectory()) {
		const directory: PrimeSourceDirectory = {
			kind: "directory",
			domain: context.domain,
			canonicalPath,
			sourceRef,
			mode: modeOf(stat),
			mtimeMs: stat.mtimeMs,
		};
		context.records.push(directory);
		return directory;
	}
	if (!stat.isFile()) {
		context.losses.push(loss("source-unsupported", context.domain, sourceRef, canonicalPath));
		return undefined;
	}
	const result = await readRegularFile(filePath, sourceRef, context);
	context.losses.push(...result.losses);
	if (result.file) context.records.push(result.file);
	return result.file;
}

async function listDirectory(
	root: string,
	context: ScanContext,
	recurse: boolean,
	required: boolean,
	excludeRuntime = false,
): Promise<void> {
	if (context.budget.exhausted) return;
	if (context.logicalRoot && (await hasSymlinkComponent(context.logicalRoot, root, false))) {
		context.losses.push(loss("source-symlink", context.domain, context.sourcePrefix, path.resolve(root)));
		return;
	}
	let stat: Stats;
	try {
		stat = await fs.lstat(root);
	} catch {
		if (context.logicalRoot && (await hasSymlinkComponent(context.logicalRoot, root))) {
			context.losses.push(loss("source-symlink", context.domain, context.sourcePrefix, path.resolve(root)));
		} else if (required) {
			context.losses.push(loss("source-missing", context.domain, context.sourcePrefix, path.resolve(root)));
		}
		return;
	}
	if (stat.isSymbolicLink()) {
		const symlink = await readSymlink(root, context.sourcePrefix, stat, context);
		if (symlink) context.records.push(symlink);
		return;
	}
	if (context.logicalRoot && (await hasSymlinkComponent(context.logicalRoot, root))) {
		context.losses.push(loss("source-symlink", context.domain, context.sourcePrefix, path.resolve(root)));
		return;
	}
	if (!stat.isDirectory()) {
		context.losses.push(loss("source-invalid-layout", context.domain, context.sourcePrefix, path.resolve(root)));
		return;
	}
	const canonicalRoot = await safeRealpath(root);
	if (
		canonicalRoot === undefined ||
		(context.logicalRootCanonical !== undefined && !isContained(canonicalRoot, [context.logicalRootCanonical]))
	) {
		context.losses.push(
			loss("source-path-escape", context.domain, context.sourcePrefix, canonicalRoot ?? path.resolve(root)),
		);
		return;
	}
	let entries: string[] | undefined;
	try {
		entries = await readBoundedDirectory(root, context, context.sourcePrefix);
	} catch {
		context.losses.push(loss("source-unreadable", context.domain, context.sourcePrefix, canonicalRoot));
		return;
	}
	if (!entries) return;
	for (const name of entries) {
		if (context.budget.exhausted) return;
		const candidate = path.join(root, name);
		const sourceRef = sourceRefFor(context.sourcePrefix, name);
		const childStat = await fs.lstat(candidate).catch(() => undefined);
		if (!childStat) {
			context.losses.push(loss("source-missing", context.domain, sourceRef, candidate));
			continue;
		}
		if (excludeRuntime) {
			const reason = EXCLUDED_REASONS[name];
			if (reason) {
				await scanExcluded(
					candidate,
					sourceRef,
					context.logicalRootCanonical ? [context.logicalRootCanonical] : context.allowedRoots,
					context.excluded,
					context.losses,
					context,
					reason,
					true,
				);
				continue;
			}
		}
		if (childStat.isDirectory() && recurse) {
			const childContext = { ...context, sourcePrefix: sourceRef };
			const directory = await inspectEntry(candidate, sourceRef, childContext);
			if (directory) await listDirectory(candidate, childContext, true, true, excludeRuntime);
			continue;
		}
		await inspectEntry(candidate, sourceRef, context);
	}
}
function firstJsonLine(contentBase64: string): Record<string, unknown> | undefined {
	const bytes = Buffer.from(contentBase64, "base64");
	const lineEnd = bytes.indexOf(10);
	const line = new TextDecoder().decode(lineEnd < 0 ? bytes : bytes.subarray(0, lineEnd)).replace(/\r$/, "");
	if (!line.trim()) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "type"))
			return undefined;
		return value as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function isSessionHeader(contentBase64: string): boolean {
	return firstJsonLine(contentBase64)?.type === "session";
}

async function scanSessionFile(
	filePath: string,
	sourceRef: string,
	context: ScanContext,
	ignoreNonSession: boolean,
): Promise<void> {
	const stat = await fs.lstat(filePath).catch(() => undefined);
	if (!stat) {
		context.losses.push(loss("source-missing", "sessions", sourceRef, filePath));
		return;
	}
	if (stat.isSymbolicLink()) {
		const symlink = await readSymlink(filePath, sourceRef, stat, context);
		if (symlink) context.records.push(symlink);
		return;
	}
	const result = await readRegularFile(filePath, sourceRef, context);
	context.losses.push(...result.losses);
	if (!result.file) return;
	if (!isSessionHeader(result.file.contentBase64)) {
		if (!ignoreNonSession)
			context.losses.push(loss("source-invalid-layout", "sessions", sourceRef, result.file.canonicalPath));
		return;
	}
	context.records.push(result.file);
}

async function scanSessionRoot(
	root: string,
	prefix: string,
	context: ScanContext,
	ignoreNonSession = false,
): Promise<string[] | undefined> {
	if (context.budget.exhausted) return;
	let entries: string[] | undefined;
	try {
		entries = await readBoundedDirectory(root, context, prefix);
	} catch {
		context.losses.push(loss("source-missing", "sessions", prefix, path.resolve(root)));
		return;
	}
	if (!entries) return;
	for (const name of entries) {
		if (!SESSION_FILE.test(name)) continue;
		if (context.budget.exhausted) return;
		const candidate = path.join(root, name);
		const sourceRef = sourceRefFor(prefix, name);
		const stat = await fs.lstat(candidate).catch(() => undefined);
		if (!stat) {
			context.losses.push(loss("source-missing", "sessions", sourceRef, candidate));
			continue;
		}
		if (stat.isDirectory()) {
			context.losses.push(loss("source-invalid-layout", "sessions", sourceRef, candidate));
			continue;
		}
		await scanSessionFile(candidate, sourceRef, context, ignoreNonSession);
	}
	return entries;
}

async function scanNestedSessions(root: string, entries: readonly string[], context: ScanContext): Promise<void> {
	if (context.budget.exhausted) return;
	for (const name of entries) {
		if (!LEGACY_SESSION_DIRECTORY.test(name)) continue;
		if (context.budget.exhausted) return;
		const directory = path.join(root, name);
		const sourceRef = `legacy-nested/${name}`;
		const stat = await fs.lstat(directory).catch(() => undefined);
		if (!stat) {
			context.losses.push(loss("source-missing", "sessions", sourceRef, directory));
			continue;
		}
		if (stat.isSymbolicLink()) {
			const symlink = await readSymlink(directory, sourceRef, stat, context);
			if (symlink) context.records.push(symlink);
			continue;
		}
		if (!stat.isDirectory()) {
			context.losses.push(loss("source-invalid-layout", "sessions", sourceRef, directory));
			continue;
		}
		await scanSessionRoot(directory, sourceRef, context);
	}
}

async function scanExcluded(
	root: string,
	sourcePrefix: string,
	allowedRoots: readonly string[],
	excluded: PrimeSourceExcludedEntry[],
	losses: PrimeImportLoss[],
	context: ScanContext,
	inheritedReason?: PrimeSourceExcludedEntry["reason"],
	entryAlreadyCounted = false,
): Promise<void> {
	if (context.budget.exhausted) return;
	const stat = await fs.lstat(root).catch(() => undefined);
	if (!stat) {
		if (entryAlreadyCounted) losses.push(loss("source-missing", "excluded-state", sourcePrefix, path.resolve(root)));
		return;
	}
	if (!entryAlreadyCounted && !consumeEntry(context, sourcePrefix, root)) return;
	const reason = inheritedReason ?? EXCLUDED_REASONS[path.basename(root)];
	if (!reason) return;
	const canonicalPath = stat.isSymbolicLink() ? path.resolve(root) : await safeRealpath(root);
	if (canonicalPath === undefined || (!stat.isSymbolicLink() && !isContained(canonicalPath, allowedRoots))) {
		losses.push(loss("source-path-escape", "excluded-state", sourcePrefix, canonicalPath ?? path.resolve(root)));
		return;
	}
	const kind: PrimeSourceExcludedEntry["kind"] = stat.isSymbolicLink()
		? "symlink"
		: stat.isDirectory()
			? "directory"
			: "file";
	excluded.push({ domain: "excluded-state", sourceRef: sourcePrefix, canonicalPath, kind, reason });
	losses.push(loss("source-excluded", "excluded-state", sourcePrefix, canonicalPath));
	if (stat.isSymbolicLink() || !stat.isDirectory()) return;
	let entries: string[] | undefined;
	try {
		entries = await readBoundedDirectory(root, context, sourcePrefix);
	} catch {
		losses.push(loss("source-unreadable", "excluded-state", sourcePrefix, canonicalPath));
		return;
	}
	if (!entries) return;
	for (const name of entries) {
		if (context.budget.exhausted) return;
		await scanExcluded(
			path.join(root, name),
			`${sourcePrefix}/${name}`,
			allowedRoots,
			excluded,
			losses,
			context,
			reason,
			true,
		);
	}
}

function metadata(file: PrimeSourceFile): Omit<PrimeSourceFile, "contentBase64"> {
	const { contentBase64: _contentBase64, ...value } = file;
	return value;
}

function treeEntry(record: Exclude<PrimeSourceRecord, PrimeSourceFile>): PrimeSourceSnapshotTreeEntry {
	if (record.kind === "directory") {
		return {
			kind: record.kind,
			domain: record.domain,
			sourceRef: record.sourceRef,
			canonicalPath: record.canonicalPath,
			mode: record.mode,
		};
	}
	return {
		kind: record.kind,
		domain: record.domain,
		sourceRef: record.sourceRef,
		canonicalPath: record.canonicalPath,
		mode: record.mode,
		target: record.target,
		external: record.external,
	};
}

function snapshotId(
	identity: {
		readonly sourceRoot: string;
		readonly cwd: string;
		readonly sessionRoot: string;
		readonly primeCliConfigPath?: string;
	},
	files: readonly Omit<PrimeSourceFile, "contentBase64">[],
	treeEntries: readonly PrimeSourceSnapshotTreeEntry[],
): string {
	const hasher = createHash("sha256");
	hasher.update(
		JSON.stringify([identity.sourceRoot, identity.cwd, identity.sessionRoot, identity.primeCliConfigPath ?? null]),
	);
	hasher.update("\n");
	for (const file of [...files].sort((a, b) => compareStrings(a.sourceRef, b.sourceRef))) {
		hasher.update(
			JSON.stringify([file.sourceRef, file.domain, file.kind, file.size, file.mode, file.mtimeMs, file.sha256]),
		);
		hasher.update("\n");
	}
	for (const entry of [...treeEntries].sort((a, b) => compareStrings(a.sourceRef, b.sourceRef))) {
		hasher.update(
			JSON.stringify([
				entry.sourceRef,
				entry.domain,
				entry.kind,
				entry.canonicalPath,
				entry.mode,
				entry.kind === "symlink" ? (entry.target ?? null) : null,
				entry.kind === "symlink" ? entry.external : null,
			]),
		);
		hasher.update("\n");
	}
	return hasher.digest("hex");
}

function deduplicateRecords(records: readonly PrimeSourceRecord[]): PrimeSourceRecord[] {
	const seenFiles = new Map<PrimeImportDomain, Set<string>>();
	const deduplicated: PrimeSourceRecord[] = [];
	for (const record of records) {
		if (record.kind === "file") {
			let paths = seenFiles.get(record.domain);
			if (paths === undefined) {
				paths = new Set<string>();
				seenFiles.set(record.domain, paths);
			}
			if (paths.has(record.canonicalPath)) continue;
			paths.add(record.canonicalPath);
		}
		deduplicated.push(record);
	}
	return deduplicated;
}

function sortRecords(records: readonly PrimeSourceRecord[]): PrimeSourceRecord[] {
	return [...records].sort((a, b) => compareStrings(a.sourceRef, b.sourceRef));
}

function sortLosses(losses: readonly PrimeImportLoss[]): PrimeImportLoss[] {
	return [...losses].sort((left, right) => {
		const sourceRef = compareStrings(left.sourceRef, right.sourceRef);
		if (sourceRef !== 0) return sourceRef;
		const code = compareStrings(left.code, right.code);
		if (code !== 0) return code;
		const domain = compareStrings(left.domain, right.domain);
		if (domain !== 0) return domain;
		return compareStrings(left.path ?? "", right.path ?? "");
	});
}

export async function discoverPrimeSource(options: PrimeImportSourceOptions): Promise<PrimeImportSourceDiscovery> {
	const sourceRoot = path.resolve(options.sourceRoot);
	const cwd = path.resolve(options.cwd);
	const sessionRootExplicit = options.sessionRoot !== undefined;
	const maxFileBytes = validateBudget(
		"maxFileBytes",
		options.maxFileBytes,
		DEFAULT_MAX_FILE_BYTES,
		HARD_MAX_FILE_BYTES,
	);
	const maxTotalBytes = validateBudget(
		"maxTotalBytes",
		options.maxTotalBytes,
		DEFAULT_MAX_TOTAL_BYTES,
		HARD_MAX_TOTAL_BYTES,
	);
	const maxEntries = validateBudget("maxEntries", options.maxEntries, DEFAULT_MAX_ENTRIES, HARD_MAX_ENTRIES);
	const budget: BudgetState = { maxTotalBytes, maxEntries, entries: 0, totalBytes: 0, exhausted: false };
	const scannedDirectories = new Set<string>();
	const chargedFiles = new Set<string>();
	const sessionRoot = path.resolve(options.sessionRoot ?? path.join(sourceRoot, "sessions"));
	const records: PrimeSourceRecord[] = [];
	const excluded: PrimeSourceExcludedEntry[] = [];
	const losses: PrimeImportLoss[] = [];
	const sourceRootStat = await fs.lstat(sourceRoot).catch(() => undefined);
	const sessionRootStat = await fs.lstat(sessionRoot).catch(() => undefined);
	const sessionRootViaSymlink = await hasSymlinkComponent(path.dirname(sessionRoot), sessionRoot);
	const sourceRootCanonical = sourceRootStat?.isDirectory() ? await safeRealpath(sourceRoot) : undefined;
	const cwdCanonical = await safeRealpath(cwd);
	const sessionRootCanonical = sessionRootStat?.isDirectory() ? await safeRealpath(sessionRoot) : undefined;
	const sessionRootOverlapsSourceRoot =
		sessionRootExplicit &&
		sourceRootCanonical !== undefined &&
		sessionRootCanonical !== undefined &&
		isContained(sourceRootCanonical, [sessionRootCanonical]);
	const cliConfigPath = options.primeCliConfigPath ? path.resolve(options.primeCliConfigPath) : undefined;
	const cliConfigCanonical = cliConfigPath ? await safeRealpath(cliConfigPath) : undefined;
	const cliDirectoryCanonical = cliConfigPath ? await safeRealpath(path.dirname(cliConfigPath)) : undefined;
	const allowedRoots = [sourceRootCanonical, cwdCanonical, sessionRootCanonical, cliDirectoryCanonical].filter(
		(value): value is string => value !== undefined,
	);
	if (!sourceRootStat) {
		losses.push(loss("source-missing", "config", "source-root", sourceRoot));
	} else if (sourceRootStat.isSymbolicLink()) {
		losses.push(loss("source-symlink", "config", "source-root", sourceRoot));
	} else if (!sourceRootStat.isDirectory()) {
		losses.push(loss("source-invalid-layout", "config", "source-root", sourceRoot));
	}
	if (sessionRootViaSymlink) {
		losses.push(loss("source-symlink", "sessions", "sessions", sessionRoot));
	} else if (sessionRootExplicit && !sessionRootStat) {
		losses.push(loss("source-missing", "sessions", "sessions", sessionRoot));
	} else if (sessionRootStat?.isSymbolicLink()) {
		losses.push(loss("source-symlink", "sessions", "sessions", sessionRoot));
	} else if (sessionRootStat && !sessionRootStat.isDirectory()) {
		losses.push(loss("source-invalid-layout", "sessions", "sessions", sessionRoot));
	}
	const global = (
		domain: PrimeImportDomain,
		prefix: string,
		logicalRoot = sourceRoot,
		logicalRootCanonical = sourceRootCanonical,
	): ScanContext => ({
		domain,
		sourcePrefix: prefix,
		allowedRoots,
		logicalRoot,
		logicalRootCanonical,
		scannedDirectories,
		chargedFiles,
		maxFileBytes,
		budget,
		records,
		excluded,
		losses,
	});
	const directFiles: readonly [string, PrimeImportDomain, string][] = [
		[path.join(sourceRoot, "settings.json"), "settings", "global/settings.json"],
		[path.join(cwd, ".prime", "agent", "settings.json"), "settings", "project/settings.json"],
		[path.join(sourceRoot, "models.json"), "models", "global/models.json"],
		[path.join(sourceRoot, "auth.json"), "credentials", "global/auth.json"],
		[path.join(sourceRoot, "oauth.json"), "credentials", "global/oauth.json"],
	];
	for (const [filePath, domain, sourceRef] of [...directFiles].sort((left, right) =>
		compareStrings(left[2], right[2]),
	)) {
		if (budget.exhausted) break;
		const logicalRoot = sourceRef.startsWith("project/") ? cwd : sourceRoot;
		const logicalRootCanonical = sourceRef.startsWith("project/") ? cwdCanonical : sourceRootCanonical;
		const context = global(domain, sourceRef.slice(0, sourceRef.lastIndexOf("/")), logicalRoot, logicalRootCanonical);
		const stat = await fs.lstat(filePath).catch(() => undefined);
		if (!stat) {
			if (await hasSymlinkComponent(logicalRoot, filePath)) {
				if (!consumeEntry(context, sourceRef, filePath)) break;
				losses.push(loss("source-symlink", domain, sourceRef, filePath));
			}
			continue;
		}
		if (!consumeEntry(context, sourceRef, filePath)) break;
		if (!stat.isFile()) {
			if (stat.isSymbolicLink()) {
				const symlink = await readSymlink(filePath, sourceRef, stat, context);
				if (symlink) records.push(symlink);
			} else losses.push(loss("source-invalid-layout", domain, sourceRef, filePath));
			continue;
		}
		const result = await readRegularFile(filePath, sourceRef, context);
		losses.push(...result.losses);
		if (result.file) records.push(result.file);
	}
	if (cliConfigPath && !budget.exhausted) {
		const context = global("config", "cli-config", path.dirname(cliConfigPath), cliDirectoryCanonical);
		const stat = await fs.lstat(cliConfigPath).catch(() => undefined);
		if (!stat) {
			losses.push(loss("source-missing", "config", "cli-config/config", cliConfigPath));
		} else if (consumeEntry(context, "cli-config/config", cliConfigPath)) {
			if (stat.isSymbolicLink()) {
				const symlink = await readSymlink(cliConfigPath, "cli-config/config", stat, context);
				if (symlink) records.push(symlink);
			} else {
				const result = await readRegularFile(cliConfigPath, "cli-config/config", context);
				losses.push(...result.losses);
				if (result.file) records.push(result.file);
			}
		}
	}
	if (!budget.exhausted) {
		await listDirectory(
			path.join(sourceRoot, "skills"),
			global("skills", "global/skills", sourceRoot, sourceRootCanonical),
			true,
			false,
		);
		await listDirectory(
			path.join(cwd, ".prime", "agent", "skills"),
			global("skills", "project/skills", cwd, cwdCanonical),
			true,
			false,
		);
		const sessionContext = global("sessions", "sessions", sessionRoot, sessionRootCanonical);
		if (
			!sessionRootViaSymlink &&
			sessionRootStat?.isDirectory() &&
			sessionRootCanonical &&
			(sessionRootExplicit || sourceRootStat?.isDirectory())
		) {
			const currentEntries = await scanSessionRoot(sessionRoot, "sessions/current", sessionContext);
			if (currentEntries) await scanNestedSessions(sessionRoot, currentEntries, sessionContext);
		}
		if (sourceRootStat?.isDirectory() && !budget.exhausted && !sessionRootOverlapsSourceRoot) {
			await scanSessionRoot(
				sourceRoot,
				"legacy-root",
				global("sessions", "legacy-root", sourceRoot, sourceRootCanonical),
				true,
			);
		}
	}
	if (!budget.exhausted) {
		const artifactRoot = path.join(path.dirname(sessionRoot), "session-artifacts");
		const artifactRootViaSymlink = await hasSymlinkComponent(path.dirname(sessionRoot), artifactRoot);
		const artifactRootCanonical = await safeRealpath(artifactRoot);
		if (artifactRootViaSymlink) {
			losses.push(loss("source-symlink", "artifacts", "artifacts", artifactRoot));
		} else if (
			artifactRootCanonical !== undefined &&
			(sessionRootExplicit ||
				(sourceRootCanonical !== undefined && isContained(artifactRootCanonical, [sourceRootCanonical])))
		) {
			await listDirectory(
				artifactRoot,
				global("artifacts", "artifacts", artifactRoot, artifactRootCanonical),
				true,
				false,
				true,
			);
		}
	}
	const excludedRoots = [sourceRoot, path.join(cwd, ".prime", "agent")];
	for (const root of excludedRoots) {
		if (budget.exhausted) break;
		const logicalRoot = root === sourceRoot ? sourceRoot : cwd;
		const logicalRootCanonical = root === sourceRoot ? sourceRootCanonical : cwdCanonical;
		for (const name of Object.keys(EXCLUDED_REASONS).sort(compareStrings)) {
			if (budget.exhausted) break;
			const candidate = path.join(root, name);
			const sourceRef = `${root === sourceRoot ? "global" : "project"}/excluded/${name}`;
			const context = global("excluded-state", sourceRef, logicalRoot, logicalRootCanonical);
			if (await hasSymlinkComponent(logicalRoot, candidate)) {
				if (!consumeEntry(context, sourceRef, candidate)) break;
				losses.push(loss("source-symlink", "excluded-state", sourceRef, candidate));
				continue;
			}
			await scanExcluded(
				candidate,
				sourceRef,
				logicalRootCanonical ? [logicalRootCanonical] : [],
				excluded,
				losses,
				context,
			);
		}
	}
	const sortedRecords = sortRecords(deduplicateRecords(records));
	const files = sortedRecords.filter((record): record is PrimeSourceFile => record.kind === "file");
	const serializableFiles = files.map(metadata);
	const treeEntries = sortedRecords
		.filter((record): record is Exclude<PrimeSourceRecord, PrimeSourceFile> => record.kind !== "file")
		.map(treeEntry);
	const snapshotSourceRoot = sourceRootCanonical ?? sourceRoot;
	const snapshotCwd = cwdCanonical ?? cwd;
	const snapshotSessionRoot = sessionRootCanonical ?? sessionRoot;
	const snapshotCliConfigPath = cliConfigPath ? (cliConfigCanonical ?? cliConfigPath) : undefined;
	const snapshot: PrimeSourceSnapshot = {
		schemaVersion: PRIME_IMPORT_SCHEMA_VERSION,
		snapshotId: snapshotId(
			{
				sourceRoot: snapshotSourceRoot,
				cwd: snapshotCwd,
				sessionRoot: snapshotSessionRoot,
				primeCliConfigPath: snapshotCliConfigPath,
			},
			serializableFiles,
			treeEntries,
		),
		sourceRoot: snapshotSourceRoot,
		cwd: snapshotCwd,
		sessionRoot: snapshotSessionRoot,
		maxFileBytes,
		maxTotalBytes,
		maxEntries,
		files: serializableFiles,
		treeEntries,
		primeCliConfigPath: cliConfigPath,
	};
	const inventory: PrimeImportSourceInventory = {
		records: sortedRecords,
		files,
		excluded: [...excluded].sort((left, right) => compareStrings(left.sourceRef, right.sourceRef)),
	};
	return { snapshot, inventory, losses: sortLosses(losses) };
}

export async function revalidatePrimeSource(
	snapshot: PrimeSourceSnapshot,
	options: { readonly domains?: readonly PrimeImportDomain[] } = {},
): Promise<PrimeSourceDrift> {
	const rediscovered = await discoverPrimeSource({
		sourceRoot: snapshot.sourceRoot,
		cwd: snapshot.cwd,
		sessionRoot: snapshot.sessionRoot,
		primeCliConfigPath: snapshot.primeCliConfigPath,
		maxFileBytes: snapshot.maxFileBytes,
		maxTotalBytes: snapshot.maxTotalBytes,
		maxEntries: snapshot.maxEntries,
	});
	const losses: PrimeImportLoss[] = [];
	const domains = options.domains ? new Set(options.domains) : undefined;
	const included = (domain: PrimeImportDomain): boolean => domains?.has(domain) ?? true;
	const expectedByRef = new Map(
		snapshot.files.filter(file => included(file.domain)).map(file => [file.sourceRef, file]),
	);
	const expectedTreeByRef = new Map(
		snapshot.treeEntries.filter(entry => included(entry.domain)).map(entry => [entry.sourceRef, entry]),
	);
	const currentFilesByRef = new Map(
		rediscovered.snapshot.files.filter(file => included(file.domain)).map(file => [file.sourceRef, file]),
	);
	const currentTreeByRef = new Map(
		rediscovered.snapshot.treeEntries.filter(entry => included(entry.domain)).map(entry => [entry.sourceRef, entry]),
	);
	const currentRecordsByRef = new Map(
		rediscovered.inventory.records
			.filter(record => included(record.domain))
			.map(record => [record.sourceRef, record]),
	);
	const rediscoveryLossesByRef = new Map<string, PrimeImportLoss[]>();
	for (const item of rediscovered.losses) {
		if (!included(item.domain)) continue;
		const items = rediscoveryLossesByRef.get(item.sourceRef);
		if (items) items.push(item);
		else rediscoveryLossesByRef.set(item.sourceRef, [item]);
	}
	for (const current of rediscovered.snapshot.files) {
		if (!included(current.domain)) continue;
		if (!expectedByRef.has(current.sourceRef) && !expectedTreeByRef.has(current.sourceRef)) {
			losses.push(loss("source-changed", current.domain, current.sourceRef, current.canonicalPath));
		}
	}
	for (const current of rediscovered.snapshot.treeEntries) {
		if (!included(current.domain)) continue;
		if (!expectedByRef.has(current.sourceRef) && !expectedTreeByRef.has(current.sourceRef)) {
			losses.push(loss("source-changed", current.domain, current.sourceRef, current.canonicalPath));
		}
	}
	for (const expected of snapshot.files) {
		if (!included(expected.domain)) continue;
		const current = currentFilesByRef.get(expected.sourceRef);
		if (current) {
			const metadataChanged =
				current.domain !== expected.domain ||
				current.kind !== expected.kind ||
				current.canonicalPath !== expected.canonicalPath ||
				current.size !== expected.size ||
				current.mode !== expected.mode ||
				current.mtimeMs !== expected.mtimeMs;
			if (metadataChanged) {
				losses.push(loss("source-changed", expected.domain, expected.sourceRef, current.canonicalPath));
			}
			if (current.sha256 !== expected.sha256) {
				losses.push(loss("source-drift", expected.domain, expected.sourceRef, current.canonicalPath));
			}
			continue;
		}
		const currentRecord = currentRecordsByRef.get(expected.sourceRef);
		const rediscoveryLosses = rediscoveryLossesByRef.get(expected.sourceRef) ?? [];
		losses.push(...rediscoveryLosses);
		if (currentRecord?.kind === "symlink") {
			losses.push(loss("source-type-changed", expected.domain, expected.sourceRef, currentRecord.canonicalPath));
			if (
				!rediscoveryLosses.some(item => item.code === "source-symlink" || item.code === "source-external-symlink")
			) {
				losses.push(loss("source-symlink", expected.domain, expected.sourceRef, currentRecord.canonicalPath));
			}
		} else if (currentRecord) {
			losses.push(loss("source-type-changed", expected.domain, expected.sourceRef, currentRecord.canonicalPath));
		} else if (rediscoveryLosses.length === 0) {
			losses.push(loss("source-missing", expected.domain, expected.sourceRef));
		}
	}
	for (const expected of snapshot.treeEntries) {
		if (!included(expected.domain)) continue;
		const current = currentTreeByRef.get(expected.sourceRef);
		if (current) {
			const metadataChanged =
				current.domain !== expected.domain ||
				current.kind !== expected.kind ||
				current.canonicalPath !== expected.canonicalPath ||
				current.mode !== expected.mode ||
				(current.kind === "symlink" &&
					expected.kind === "symlink" &&
					(current.target !== expected.target || current.external !== expected.external));
			if (metadataChanged) {
				losses.push(loss("source-changed", expected.domain, expected.sourceRef, current.canonicalPath));
			}
			continue;
		}
		const currentFile = currentFilesByRef.get(expected.sourceRef);
		const currentRecord = currentRecordsByRef.get(expected.sourceRef);
		const rediscoveryLosses = rediscoveryLossesByRef.get(expected.sourceRef) ?? [];
		losses.push(...rediscoveryLosses);
		if (currentFile) {
			losses.push(loss("source-type-changed", expected.domain, expected.sourceRef, currentFile.canonicalPath));
		} else if (currentRecord) {
			losses.push(loss("source-type-changed", expected.domain, expected.sourceRef, currentRecord.canonicalPath));
		} else if (rediscoveryLosses.length === 0) {
			losses.push(loss("source-missing", expected.domain, expected.sourceRef));
		}
	}
	return { ok: losses.length === 0, losses: sortLosses(losses) };
}
