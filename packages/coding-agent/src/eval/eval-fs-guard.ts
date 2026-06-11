import type * as FsType from "node:fs";
import type * as FsPromisesType from "node:fs/promises";
import { ToolError } from "../tools/tool-errors";
import { createBlockedBunSpawn, guardChildProcessModule, isChildProcessModuleId } from "./eval-subprocess-guard";
import {
	EVAL_SOURCE_WRITE_BLOCKED_MESSAGE,
	isEvalArtifactWritePath,
	isEvalLocalRootFilesystemPath,
} from "./eval-write-guard";

export type EvalFsPathGuard = (rawPath: unknown) => void;

/** Options for dynamic `import()` in eval (matches runtime `__omp_import__`; global from Bun types). */
export type EvalDynamicImportOptions = ImportCallOptions;

function pathArgFromUnknown(arg: unknown): string | URL | undefined {
	if (typeof arg === "string" || arg instanceof URL) return arg;
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(arg)) {
		return arg.toString("utf8");
	}
	if (arg && typeof arg === "object" && "path" in arg) {
		const nested = (arg as { path?: unknown }).path;
		if (typeof nested === "string" || nested instanceof URL) return nested;
		if (typeof Buffer !== "undefined" && Buffer.isBuffer(nested)) {
			return nested.toString("utf8");
		}
	}
	return undefined;
}

function firstPathArg(args: unknown[]): unknown {
	for (const arg of args) {
		const path = pathArgFromUnknown(arg);
		if (path !== undefined) return path;
	}
	return undefined;
}

const guardedWriteFdPaths = new Map<number, string>();

function isNodeFsWriteOpenMode(mode: unknown): boolean {
	if (mode === undefined || mode === null) return false;
	if (typeof mode === "number") {
		// Node O_* flags: O_WRONLY (1), O_RDWR (2), O_CREAT (64), O_TRUNC (512), O_APPEND (1024)
		return (mode & 0x41) !== 0 || (mode & 0x402) !== 0 || (mode & 0x200) !== 0;
	}
	const m = String(mode);
	if (!m || m === "r") return false;
	if (m.includes("+")) return true;
	return /[wax+]/i.test(m);
}

function registerGuardedFd(fd: unknown, rawPath: unknown): void {
	if (typeof fd !== "number" || rawPath === undefined || rawPath === null) return;
	guardedWriteFdPaths.set(fd, rawPath instanceof URL ? rawPath.pathname : String(rawPath));
}

function pathFromFd(fd: number): string | undefined {
	return guardedWriteFdPaths.get(fd);
}

function unregisterGuardedFd(fd: unknown): void {
	if (typeof fd === "number") guardedWriteFdPaths.delete(fd);
}

/** Stdio fds are not project paths; allow writes without fd-map lookup. */
const STDIO_FD_MAX = 2;

function pathFromWriteFdArg(args: unknown[]): unknown {
	const fd = args[0];
	if (typeof fd !== "number") return firstPathArg(args);
	if (fd >= 0 && fd <= STDIO_FD_MAX) return undefined;
	const mapped = pathFromFd(fd);
	if (mapped === undefined) {
		throw new ToolError(EVAL_SOURCE_WRITE_BLOCKED_MESSAGE);
	}
	return mapped;
}

function pathFromWriteTargetArg(args: unknown[]): unknown {
	const first = args[0];
	if (typeof first === "number") {
		if (first >= 0 && first <= STDIO_FD_MAX) return undefined;
		const mapped = pathFromFd(first);
		if (mapped === undefined) {
			throw new ToolError(EVAL_SOURCE_WRITE_BLOCKED_MESSAGE);
		}
		return mapped;
	}
	return firstPathArg(args);
}

export function createEvalFsPathGuard(block: boolean, localRoots: Record<string, string>): EvalFsPathGuard | undefined {
	if (!block) return undefined;
	return (rawPath: unknown) => {
		if (rawPath === undefined || rawPath === null) return;
		const text = rawPath instanceof URL ? rawPath.pathname : String(rawPath);
		if (isEvalArtifactWritePath(text, localRoots)) return;
		if (isEvalLocalRootFilesystemPath(text, localRoots)) return;
		throw new ToolError(EVAL_SOURCE_WRITE_BLOCKED_MESSAGE);
	};
}

function guardFileHandleWrites(handle: unknown, _guard: EvalFsPathGuard): unknown {
	// Open path is guarded in fs.promises.open / openSync; handle methods take data, not paths.
	return handle;
}

function renamePaths(args: unknown[]): unknown[] {
	const paths: unknown[] = [];
	for (const index of [0, 1]) {
		const raw = pathArgFromUnknown(args[index]);
		if (raw !== undefined) paths.push(raw);
	}
	return paths;
}

function linkPaths(args: unknown[]): unknown[] {
	const paths: unknown[] = [];
	for (const index of [0, 1]) {
		const raw = pathArgFromUnknown(args[index]);
		if (raw !== undefined) paths.push(raw);
	}
	return paths;
}

function wrapCallback(
	fn: (...args: unknown[]) => unknown,
	guard: EvalFsPathGuard | undefined,
	getPath: (args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
	if (!guard) return fn;
	return (...args: unknown[]) => {
		applyPathGuard(guard, getPath(args));
		return fn(...args);
	};
}

function applyPathGuard(guard: EvalFsPathGuard, raw: unknown): void {
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (entry !== undefined) guard(entry);
		}
		return;
	}
	if (raw !== undefined) guard(raw);
}

function wrapSync(
	fn: (...args: unknown[]) => unknown,
	guard: EvalFsPathGuard | undefined,
	getPath: (args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
	if (!guard) return fn;
	return (...args: unknown[]) => {
		applyPathGuard(guard, getPath(args));
		return fn(...args);
	};
}

const WRITE_SYNC_METHODS: Array<{
	key: string;
	getPath: (args: unknown[]) => unknown;
}> = [
	{ key: "writeFileSync", getPath: pathFromWriteTargetArg },
	{ key: "openSync", getPath: firstPathArg },
	{ key: "appendFileSync", getPath: pathFromWriteTargetArg },
	{ key: "writeSync", getPath: pathFromWriteFdArg },
	{ key: "truncateSync", getPath: firstPathArg },
	{ key: "renameSync", getPath: renamePaths },
	{ key: "copyFileSync", getPath: args => args[1] },
	{ key: "cpSync", getPath: args => args[1] },
	{ key: "mkdirSync", getPath: firstPathArg },
	{ key: "rmSync", getPath: firstPathArg },
	{ key: "rmdirSync", getPath: firstPathArg },
	{ key: "unlinkSync", getPath: firstPathArg },
	{ key: "symlinkSync", getPath: linkPaths },
	{ key: "linkSync", getPath: linkPaths },
];

const WRITE_CALLBACK_METHODS: Array<{
	key: string;
	getPath: (args: unknown[]) => unknown;
}> = [
	{ key: "writeFile", getPath: pathFromWriteTargetArg },
	{ key: "appendFile", getPath: pathFromWriteTargetArg },
	{ key: "truncate", getPath: firstPathArg },
	{ key: "rename", getPath: renamePaths },
	{ key: "copyFile", getPath: args => args[1] },
	{ key: "cp", getPath: args => args[1] },
	{ key: "mkdir", getPath: firstPathArg },
	{ key: "rm", getPath: firstPathArg },
	{ key: "rmdir", getPath: firstPathArg },
	{ key: "unlink", getPath: firstPathArg },
	{ key: "symlink", getPath: linkPaths },
	{ key: "link", getPath: linkPaths },
];

const WRITE_PROMISE_METHODS: Array<{
	key: keyof typeof FsPromisesType;
	getPath: (args: unknown[]) => unknown;
}> = [
	{ key: "writeFile", getPath: pathFromWriteTargetArg },
	{ key: "appendFile", getPath: pathFromWriteTargetArg },
	{ key: "truncate", getPath: firstPathArg },
	{ key: "rename", getPath: renamePaths },
	{ key: "copyFile", getPath: args => args[1] },
	{ key: "cp", getPath: args => args[1] },
	{ key: "mkdir", getPath: firstPathArg },
	{ key: "rm", getPath: firstPathArg },
	{ key: "rmdir", getPath: firstPathArg },
	{ key: "unlink", getPath: firstPathArg },
	{ key: "symlink", getPath: linkPaths },
	{ key: "link", getPath: linkPaths },
];

export function createGuardedFsModule(fs: typeof FsType, guard: EvalFsPathGuard | undefined): typeof FsType {
	if (!guard) return fs;
	const out = { ...fs } as typeof FsType;
	for (const { key, getPath } of WRITE_SYNC_METHODS) {
		const fn = (fs as Record<string, unknown>)[key];
		if (typeof fn === "function") {
			if (key === "openSync") {
				(out as Record<string, unknown>).openSync = ((...args: unknown[]) => {
					const raw = getPath(args);
					const mode = args[1];
					if (isNodeFsWriteOpenMode(mode)) guard!(raw);
					const fd = (fn as (...a: unknown[]) => number)(...args);
					if (isNodeFsWriteOpenMode(mode)) registerGuardedFd(fd, raw);
					return fd;
				}) as typeof fs.openSync;
				const realClose = fs.closeSync;
				if (typeof realClose === "function") {
					(out as Record<string, unknown>).closeSync = ((fd: number) => {
						unregisterGuardedFd(fd);
						return realClose(fd);
					}) as typeof fs.closeSync;
				}
				continue;
			}
			(out as Record<string, unknown>)[key as string] = wrapSync(
				fn as (...args: unknown[]) => unknown,
				guard,
				getPath,
			);
		}
	}

	const realOpen = fs.open;
	if (typeof realOpen === "function") {
		(out as Record<string, unknown>).open = ((...args: unknown[]) => {
			const raw = firstPathArg(args);
			let cbIndex = -1;
			for (let i = args.length - 1; i >= 0; i--) {
				if (typeof args[i] === "function") {
					cbIndex = i;
					break;
				}
			}
			let mode: unknown = "r";
			if (cbIndex === 2) mode = args[1];
			else if (cbIndex === 3) mode = args[2];
			else if (cbIndex < 0 && args.length >= 2) mode = args[1];
			if (isNodeFsWriteOpenMode(mode)) guard!(raw);
			if (cbIndex < 0) {
				return (realOpen as (...a: unknown[]) => unknown).apply(fs, args);
			}
			const userCb = args[cbIndex] as (err: NodeJS.ErrnoException | null, fd?: number) => void;
			const next = [...args];
			next[cbIndex] = (err: NodeJS.ErrnoException | null, fd?: number) => {
				if (!err && fd !== undefined && isNodeFsWriteOpenMode(mode)) {
					registerGuardedFd(fd, raw);
				}
				userCb(err, fd);
			};
			return (realOpen as (...a: unknown[]) => unknown).apply(fs, next);
		}) as typeof fs.open;
	}
	const realClose = fs.close;
	if (typeof realClose === "function") {
		(out as Record<string, unknown>).close = ((...args: unknown[]) => {
			const fd = args[0];
			let cbIndex = -1;
			for (let i = args.length - 1; i >= 0; i--) {
				if (typeof args[i] === "function") {
					cbIndex = i;
					break;
				}
			}
			if (cbIndex < 0) {
				unregisterGuardedFd(fd);
				return (realClose as (...a: unknown[]) => unknown).apply(fs, args);
			}
			const userCb = args[cbIndex] as (err: NodeJS.ErrnoException | null) => void;
			const next = [...args];
			next[cbIndex] = (err: NodeJS.ErrnoException | null) => {
				if (!err) unregisterGuardedFd(fd);
				userCb(err);
			};
			return (realClose as (...a: unknown[]) => unknown).apply(fs, next);
		}) as typeof fs.close;
	}
	for (const { key, getPath } of WRITE_CALLBACK_METHODS) {
		const fn = (fs as Record<string, unknown>)[key];
		if (typeof fn === "function") {
			(out as Record<string, unknown>)[key] = wrapCallback(fn as (...args: unknown[]) => unknown, guard, getPath);
		}
	}
	const promises = { ...fs.promises };
	for (const { key, getPath } of WRITE_PROMISE_METHODS) {
		const fn = fs.promises[key];
		if (typeof fn === "function") {
			(promises as Record<string, unknown>)[key as string] = wrapSync(
				fn as (...args: unknown[]) => unknown,
				guard,
				getPath,
			);
		}
	}

	const realPromisesOpen = fs.promises.open;
	if (typeof realPromisesOpen === "function") {
		(promises as Record<string, unknown>).open = (async (...args: unknown[]) => {
			const raw = firstPathArg(args);
			const mode = args[1];
			if (isNodeFsWriteOpenMode(mode)) guard!(raw);
			const fh = await (realPromisesOpen as (...a: unknown[]) => Promise<unknown>).apply(fs.promises, args);
			if (isNodeFsWriteOpenMode(mode)) return guardFileHandleWrites(fh, guard!);
			return fh;
		}) as typeof fs.promises.open;
	}
	(promises as Record<string, unknown>).default = promises;

	const realCreateWriteStream = fs.createWriteStream;
	if (typeof realCreateWriteStream === "function") {
		(out as Record<string, unknown>).createWriteStream = ((...args: unknown[]) => {
			guard!(firstPathArg(args));
			return realCreateWriteStream.apply(fs, args as never);
		}) as typeof fs.createWriteStream;
	}
	out.promises = promises;
	(out as Record<string, unknown>).default = out;
	return out;
}

export function wrapBuiltinModuleForGuard(
	specifier: string,
	mod: unknown,
	guard: EvalFsPathGuard | undefined,
	fsModule: typeof FsType,
): unknown {
	if (!guard) return mod;
	const id = specifier.replace(/^node:/, "");
	if (id === "fs") {
		return createGuardedFsModule(fsModule, guard);
	}
	if (id === "fs/promises") {
		return createGuardedFsModule(fsModule, guard).promises;
	}
	if (id === "child_process") {
		return guardChildProcessModule(mod as object, true);
	}
	return mod;
}

export function createGuardedRequire(
	baseRequire: NodeJS.Require,
	guard: EvalFsPathGuard | undefined,
	fsModule: typeof FsType,
): NodeJS.Require {
	if (!guard) return baseRequire;
	const guardedFs = createGuardedFsModule(fsModule, guard);
	const guardedRequire = ((id: string) => {
		if (id === "fs" || id === "node:fs") {
			return guardedFs;
		}
		if (id === "node:fs/promises" || id === "fs/promises") {
			return guardedFs.promises;
		}
		if (isChildProcessModuleId(id)) {
			return guardChildProcessModule(baseRequire(id) as object, true);
		}
		return baseRequire(id);
	}) as NodeJS.Require;
	Object.defineProperties(guardedRequire, {
		resolve: { value: baseRequire.resolve.bind(baseRequire), configurable: true },
		cache: { get: () => baseRequire.cache, configurable: true },
		extensions: { get: () => baseRequire.extensions, configurable: true },
		main: { get: () => baseRequire.main, configurable: true },
	});
	return guardedRequire;
}

function isFsModuleSpecifier(specifier: string): boolean {
	return (
		specifier === "fs" || specifier === "node:fs" || specifier === "fs/promises" || specifier === "node:fs/promises"
	);
}

function isNodeModuleSpecifier(specifier: string): boolean {
	return specifier === "module" || specifier === "node:module";
}

function wrapImportedModuleNamespace(
	specifier: string,
	mod: Record<string, unknown>,
	guard: EvalFsPathGuard,
	fsModule: typeof FsType,
): Record<string, unknown> {
	if (!isNodeModuleSpecifier(specifier)) {
		return mod;
	}
	const createRequireFn = mod.createRequire;
	if (typeof createRequireFn !== "function") {
		return mod;
	}
	const guardedCreateRequire = createGuardedCreateRequire(
		createRequireFn as typeof import("node:module").createRequire,
		guard,
		fsModule,
	);
	const out: Record<string, unknown> = { ...mod, createRequire: guardedCreateRequire };
	if (mod.default && typeof mod.default === "object") {
		out.default = { ...(mod.default as Record<string, unknown>), createRequire: guardedCreateRequire };
	}
	return out;
}

export async function guardedImportModuleNamespace(
	specifier: string,
	guard: EvalFsPathGuard | undefined,
	fsModule: typeof FsType,
	importFn: (target: string, options?: EvalDynamicImportOptions) => Promise<unknown>,
	options?: EvalDynamicImportOptions,
): Promise<unknown> {
	const target = specifier;
	const mod = (await (options !== undefined ? importFn(target, options) : importFn(target))) as Record<
		string,
		unknown
	>;
	if (!guard) return mod;
	if (isChildProcessModuleId(target)) {
		return guardChildProcessModule(mod as object, true);
	}
	if (isNodeModuleSpecifier(target)) {
		return wrapImportedModuleNamespace(target, mod, guard, fsModule);
	}
	if (!isFsModuleSpecifier(target)) return mod;
	if (target === "node:fs/promises" || target === "fs/promises") {
		const guarded = createGuardedFsModule(fsModule, guard);
		const promises = guarded.promises as typeof guarded.promises & { default?: typeof guarded.promises };
		(promises as Record<string, unknown>).default ??= promises;
		return promises;
	}
	return createGuardedFsModule(fsModule, guard);
}

export function createGuardedCreateRequire(
	baseCreateRequire: typeof import("node:module").createRequire,
	guard: EvalFsPathGuard | undefined,
	fsModule: typeof FsType,
): typeof import("node:module").createRequire {
	if (!guard) return baseCreateRequire;
	return ((filenameOrUrl: string | URL) => {
		const base = baseCreateRequire(filenameOrUrl);
		return createGuardedRequire(base, guard, fsModule);
	}) as typeof import("node:module").createRequire;
}

export function createGuardedBunNamespace(guard: EvalFsPathGuard | undefined): unknown | undefined {
	if (!guard || typeof globalThis.Bun === "undefined") return undefined;
	const bun = globalThis.Bun as { write?: (destination: unknown, ...rest: unknown[]) => Promise<unknown> };
	if (typeof bun.write !== "function") return globalThis.Bun;
	const realWrite = bun.write.bind(bun);
	const blockSpawn = createBlockedBunSpawn();
	return new Proxy(bun, {
		get(target, prop, receiver) {
			if (prop === "write") {
				return async (destination: unknown, ...rest: unknown[]) => {
					guard(destination);
					return realWrite(destination, ...rest);
				};
			}
			if (prop === "file") {
				const realFile = Reflect.get(target, prop, receiver);
				if (typeof realFile !== "function") {
					return realFile;
				}
				return (path: unknown, ...rest: unknown[]) => {
					const handle = realFile.call(target, path, ...rest) as {
						writer?: (...args: unknown[]) => unknown;
						writerSync?: (...args: unknown[]) => unknown;
					};
					const wrapWriter =
						(fn: (...args: unknown[]) => unknown) =>
						(...wArgs: unknown[]) => {
							guard(path);
							return fn.apply(handle, wArgs);
						};
					if (typeof handle.writer === "function") {
						handle.writer = wrapWriter(handle.writer.bind(handle));
					}
					if (typeof handle.writerSync === "function") {
						handle.writerSync = wrapWriter(handle.writerSync.bind(handle));
					}
					return handle;
				};
			}
			if (prop === "spawn" || prop === "spawnSync") {
				return blockSpawn;
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}
