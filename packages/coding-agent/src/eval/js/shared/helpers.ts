import * as fsConstants from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ToolError } from "../../../tools/tool-errors";
import type { JsStatusEvent } from "./types";

export interface HelperOptions {
	limit?: number;
	offset?: number;
}

/**
 * Inputs the helper factory needs from its host runtime. `cwd` is a getter so the runtime
 * can update it between cells (e.g. when the agent's session cwd changes) without
 * recreating helpers.
 */
export interface HelperContext {
	cwd(): string;
	env: Map<string, string>;
	/**
	 * On-disk roots for internal-URL schemes the helpers accept (e.g.
	 * `{ local: "/…/artifacts/local" }`). A path like `local://x.md` is rewritten
	 * to `<root>/x.md` before any filesystem op; unknown schemes are rejected.
	 */
	localRoots(): Record<string, string>;
	emitStatus(event: JsStatusEvent): void;
}

/**
 * The set of functions exposed to user code via `globalThis.__omp_helpers__`. The JS
 * prelude reads from this bag and attaches short aliases (`read`, `write`, `env`, ...)
 * onto the global scope.
 */
export interface HelperBundle {
	read(rawPath: string, options?: HelperOptions): Promise<string>;
	writeFile(rawPath: string, data: unknown): Promise<string>;
	env(key?: string, value?: string): string | Record<string, string> | undefined;
}

const utf8Encoder = new TextEncoder();

export function createHelpers(ctx: HelperContext): HelperBundle {
	return {
		read: async (rawPath, options = {}) => {
			const { filePath, text: rawText, size } = await readHelperFile(ctx, rawPath);
			let text = rawText;
			const offset = typeof options.offset === "number" ? options.offset : 1;
			const limit = typeof options.limit === "number" ? options.limit : undefined;
			if (offset > 1 || limit !== undefined) {
				const lines = text.split(/\r?\n/);
				const start = Math.max(0, offset - 1);
				const end = limit !== undefined ? start + limit : lines.length;
				text = lines.slice(start, end).join("\n");
			}
			ctx.emitStatus({ op: "read", path: filePath, bytes: size, chars: text.length });
			return text;
		},
		writeFile: async (rawPath, data) => {
			if (!isWriteData(data)) {
				throw new ToolError("write() expects string, Blob, ArrayBuffer, or TypedArray data");
			}
			const target = resolveHelperTarget(ctx, rawPath, "write");
			const filePath = target.root
				? await writeProtocolFile(target, data)
				: await writePlainFile(target.filePath, data);
			ctx.emitStatus({ op: "write", path: filePath, bytes: getDataSize(data) });
			return filePath;
		},
		env: (key, value) => {
			if (!key) {
				const merged = Object.fromEntries(Object.entries(getMergedEnv(ctx)).sort(([a], [b]) => a.localeCompare(b)));
				ctx.emitStatus({ op: "env", count: Object.keys(merged).length, keys: Object.keys(merged).slice(0, 20) });
				return merged;
			}
			if (value !== undefined) {
				ctx.env.set(key, value);
				ctx.emitStatus({ op: "env", key, value, action: "set" });
				return value;
			}
			const result = ctx.env.get(key) ?? Bun.env[key];
			ctx.emitStatus({ op: "env", key, value: result, action: "get" });
			return result;
		},
	};
}

function getMergedEnv(ctx: HelperContext): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (typeof value === "string") merged[key] = value;
	}
	for (const [key, value] of ctx.env) merged[key] = value;
	return merged;
}

const INTERNAL_URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

function resolvePath(ctx: HelperContext, value: string): string {
	if (path.isAbsolute(value)) return path.normalize(value);
	return path.resolve(ctx.cwd(), value);
}

interface ResolvedHelperPath {
	filePath: string;
	scheme?: string;
	root?: string;
}

/**
 * Map a raw helper path to an absolute filesystem path. Plain paths resolve
 * against the cwd; an internal-URL whose scheme has an injected root (e.g.
 * `local://`) is rewritten under that root; any other `scheme://` is rejected
 * so we never silently create a literal `scheme:/` directory.
 */
function resolveHelperTarget(ctx: HelperContext, rawPath: string, op: "read" | "write"): ResolvedHelperPath {
	const match = INTERNAL_URL_RE.exec(rawPath);
	if (!match) return { filePath: resolvePath(ctx, rawPath) };
	const scheme = match[1].toLowerCase();
	const root = ctx.localRoots()[scheme];
	if (!root) {
		throw new ToolError(`Protocol paths are not supported by ${op}(): ${rawPath}`);
	}
	return { filePath: resolveUnderRoot(scheme, root, match[2], rawPath), scheme, root };
}

/** Resolve an internal-URL relative path under its root, mirroring the host
 *  local-protocol handler: decode, reject absolute/traversal, confine to root. */
function resolveUnderRoot(scheme: string, root: string, rawRelative: string, rawPath: string): string {
	let relative: string;
	try {
		relative = decodeURIComponent(rawRelative.replaceAll("\\", "/"));
	} catch {
		throw new ToolError(`Invalid URL encoding in ${scheme}:// path: ${rawPath}`);
	}
	const rootPath = path.resolve(root);
	if (relative === "") return rootPath;
	if (path.isAbsolute(relative)) {
		throw new ToolError(`Absolute paths are not allowed in ${scheme}:// URLs: ${rawPath}`);
	}
	const normalized = path.posix.normalize(relative);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new ToolError(`Path traversal (..) is not allowed in ${scheme}:// URLs: ${rawPath}`);
	}
	const resolved = path.resolve(rootPath, normalized);
	if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
		throw new ToolError(`${scheme}:// path escapes its root: ${rawPath}`);
	}
	return resolved;
}

async function readHelperFile(
	ctx: HelperContext,
	rawPath: string,
): Promise<{ filePath: string; text: string; size: number }> {
	const target = resolveHelperTarget(ctx, rawPath, "read");
	if (target.root) return readProtocolFile(target);
	const file = Bun.file(target.filePath);
	const stat = await file.stat();
	if (stat.isDirectory()) {
		throw new ToolError(`Directory paths are not supported by read(): ${target.filePath}`);
	}
	return { filePath: target.filePath, text: await file.text(), size: stat.size };
}

async function readProtocolFile(target: ResolvedHelperPath): Promise<{ filePath: string; text: string; size: number }> {
	if (!target.root) throw new ToolError(`Protocol root unavailable for read(): ${target.filePath}`);
	const filePath = await ensureSafeTarget(target.root, target.filePath, target.scheme ?? "local", false);
	await rejectProtocolLeafEscape(filePath, target.scheme ?? "local", "read");
	const flags = fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW ?? 0);
	const handle = await fs.open(filePath, flags);
	try {
		const stat = await handle.stat();
		if (stat.isDirectory()) {
			throw new ToolError(`Directory paths are not supported by read(): ${filePath}`);
		}
		return { filePath, text: await handle.readFile("utf8"), size: stat.size };
	} finally {
		await handle.close();
	}
}

async function writePlainFile(filePath: string, data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<string> {
	if (typeof data === "string" || data instanceof Blob || data instanceof ArrayBuffer) {
		await Bun.write(filePath, data);
	} else {
		await Bun.write(filePath, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	}
	return filePath;
}

async function writeProtocolFile(
	target: ResolvedHelperPath,
	data: string | Blob | ArrayBuffer | ArrayBufferView,
): Promise<string> {
	if (!target.root) throw new ToolError(`Protocol root unavailable for write(): ${target.filePath}`);
	const filePath = await ensureSafeTarget(target.root, target.filePath, target.scheme ?? "local", true);
	await rejectProtocolLeafEscape(filePath, target.scheme ?? "local", "write");
	const flags =
		fsConstants.constants.O_WRONLY |
		fsConstants.constants.O_CREAT |
		fsConstants.constants.O_TRUNC |
		(fsConstants.constants.O_NOFOLLOW ?? 0);
	const handle = await fs.open(filePath, flags, 0o666);
	try {
		await handle.writeFile(await toFsWriteData(data));
	} finally {
		await handle.close();
	}
	return filePath;
}

async function ensureSafeTarget(
	root: string,
	targetPath: string,
	scheme: string,
	createParents: boolean,
): Promise<string> {
	const rootPath = path.resolve(root);
	const rootStat = await fs.lstat(rootPath);
	if (rootStat.isSymbolicLink()) {
		throw new ToolError(`${scheme}:// root cannot be a symlink`);
	}
	if (!rootStat.isDirectory()) {
		throw new ToolError(`${scheme}:// root must be a directory`);
	}

	const realRoot = await fs.realpath(rootPath);
	const absoluteTarget = path.resolve(targetPath);
	const relativeTarget = path.relative(rootPath, absoluteTarget);
	if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
		throw new ToolError(`${scheme}:// path escapes its root: ${targetPath}`);
	}

	const parentRelative = path.dirname(relativeTarget);
	let current = realRoot;
	if (parentRelative !== ".") {
		for (const part of parentRelative.split(path.sep)) {
			if (!part || part === ".") continue;
			const nextPath = path.join(current, part);
			await ensureSafeDirectory(nextPath, realRoot, scheme, createParents);
			current = await fs.realpath(nextPath);
		}
	}
	return path.join(current, path.basename(relativeTarget));
}

async function ensureSafeDirectory(
	pathName: string,
	realRoot: string,
	scheme: string,
	createMissing: boolean,
): Promise<void> {
	let stat: fsConstants.Stats;
	try {
		stat = await fs.lstat(pathName);
	} catch (error) {
		if (!isNodeError(error, "ENOENT") || !createMissing) throw error;
		try {
			await fs.mkdir(pathName);
		} catch (mkdirError) {
			if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
		}
		stat = await fs.lstat(pathName);
	}

	if (!stat.isDirectory() && !stat.isSymbolicLink()) {
		throw new ToolError(`${scheme}:// parent must be a directory`);
	}
	const realPath = await fs.realpath(pathName);
	assertWithinRoot(realPath, realRoot, scheme);
	const realStat = await fs.stat(realPath);
	if (!realStat.isDirectory()) {
		throw new ToolError(`${scheme}:// parent must be a directory`);
	}
}

async function rejectProtocolLeafEscape(filePath: string, scheme: string, op: "read" | "write"): Promise<void> {
	try {
		const stat = await fs.lstat(filePath);
		if (stat.isSymbolicLink()) {
			throw new ToolError(`${scheme}:// ${op} target cannot be a symlink`);
		}
		if (!stat.isFile()) {
			throw new ToolError(`${scheme}:// ${op} target must be a file`);
		}
	} catch (error) {
		if (op === "write" && isNodeError(error, "ENOENT")) return;
		throw error;
	}
}

function assertWithinRoot(targetPath: string, realRoot: string, scheme: string): void {
	const relative = path.relative(realRoot, targetPath);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
	throw new ToolError(`${scheme}:// path escapes its root: ${targetPath}`);
}

async function toFsWriteData(data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<string | Uint8Array> {
	if (typeof data === "string") return data;
	if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}

function getDataSize(data: string | Blob | ArrayBuffer | ArrayBufferView): number {
	if (typeof data === "string") return utf8Encoder.encode(data).byteLength;
	if (data instanceof Blob) return data.size;
	if (data instanceof ArrayBuffer) return data.byteLength;
	return data.byteLength;
}

function isWriteData(value: unknown): value is string | Blob | ArrayBuffer | ArrayBufferView {
	return (
		typeof value === "string" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
	);
}
