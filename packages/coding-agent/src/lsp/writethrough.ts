import * as fs from "node:fs";
import { isEnoent, logger, once, untilAborted } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import { isPermissionDeniedError, writeFileWithFallback } from "../tools/file-write-fallback";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "./client";
import { getServersForFile } from "./config";
import {
	captureDiagnosticVersions,
	captureOpenFileVersions,
	DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	type FileDiagnosticsResult,
	FileFormatResult,
	type FormatContentResult,
	formatContent,
	getDiagnosticsForFile,
	INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	limitDiagnosticMessages,
	type ServerVersionMap,
} from "./diagnostics";
import {
	canonicalRoot,
	getConfig,
	notifyFileSaved,
	type ResolvedFileServer,
	resolveFileLspServers,
	splitServers,
	syncFileContent,
} from "./servers";
import type { ServerConfig } from "./types";
import { summarizeDiagnosticMessages } from "./utils";
import { resolveLspCeiling } from "./workspace";

/** Options for creating the LSP writethrough callback */
export interface WritethroughOptions {
	/** Whether to format the file using LSP after writing */
	enableFormat?: boolean;
	/** Whether to get LSP diagnostics after writing */
	enableDiagnostics?: boolean;
	/** Called when diagnostics arrive after the main timeout. */
	onDeferredDiagnostics?: (diagnostics: FileDiagnosticsResult) => void;
	/** Signal to cancel a pending deferred diagnostics fetch. */
	deferredSignal?: AbortSignal;
	/** Transform diagnostics before surfacing them after a successful fetch. */
	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
}

/** Internal resolved form of {@link WritethroughOptions} that the writethrough machinery operates on. */
type ResolvedWritethroughOptions = {
	enableFormat: boolean;
	enableDiagnostics: boolean;
	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
};

/** Per-file deferred LSP diagnostics wiring for {@link WritethroughCallback}. */
export type WritethroughDeferredHandle = {
	onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
	signal: AbortSignal;
	finalize: (diagnostics: FileDiagnosticsResult | undefined) => void;
};

/** Callback type for the LSP writethrough */
export type WritethroughCallback = (
	dst: string,
	content: string,
	signal?: AbortSignal,
	file?: BunFile,
	batch?: LspWritethroughBatchRequest,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>;

/** No-op writethrough callback */
export async function writethroughNoop(
	dst: string,
	content: string,
	_signal?: AbortSignal,
	file?: BunFile,
	_batch?: LspWritethroughBatchRequest,
	_getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	await writeFileWithFallback(dst, content, file);
	return undefined;
}

interface PendingWritethrough {
	dst: string;
	file?: BunFile;
	changeType: FileChangeType;
	/**
	 * The bytes this entry committed. The flush prefers a fresh read of `dst` so
	 * post-processing sees whatever else in the batch touched the file, and falls
	 * back to these when that read is denied.
	 */
	content: string;
}

interface RunLspWritethroughOptions {
	contentAlreadyWritten?: boolean;
}

interface LspWritethroughBatchRequest {
	id: string;
	flush: boolean;
}

interface LspWritethroughBatchState {
	entries: Map<string, PendingWritethrough>;
	options: ResolvedWritethroughOptions;
}

const writethroughBatches = new Map<string, LspWritethroughBatchState>();

function getOrCreateWritethroughBatch(id: string, options: ResolvedWritethroughOptions): LspWritethroughBatchState {
	const existing = writethroughBatches.get(id);
	if (existing) {
		existing.options.enableFormat ||= options.enableFormat;
		existing.options.enableDiagnostics ||= options.enableDiagnostics;
		existing.options.transformDiagnostics ??= options.transformDiagnostics;
		return existing;
	}
	const batch: LspWritethroughBatchState = {
		entries: new Map<string, PendingWritethrough>(),
		options: { ...options },
	};
	writethroughBatches.set(id, batch);
	return batch;
}

export async function flushLspWritethroughBatch(
	id: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<FileDiagnosticsResult | undefined> {
	const state = writethroughBatches.get(id);
	if (!state) {
		return undefined;
	}
	writethroughBatches.delete(id);
	return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal);
}

function mergeDiagnostics(
	results: Array<FileDiagnosticsResult | undefined>,
	options: ResolvedWritethroughOptions,
): FileDiagnosticsResult | undefined {
	const messages: string[] = [];
	const servers = new Set<string>();
	let hasResults = false;
	let hasFormatter = false;
	let formatted = false;
	let hasFailed = false;
	let hasUnsupported = false;

	for (const result of results) {
		if (!result) continue;
		hasResults = true;
		if (result.server) {
			for (const server of result.server.split(",")) {
				const trimmed = server.trim();
				if (trimmed) {
					servers.add(trimmed);
				}
			}
		}
		if (result.messages.length > 0) {
			messages.push(...result.messages);
		}
		if (result.formatter !== undefined) {
			hasFormatter = true;
			if (result.formatter === FileFormatResult.FORMATTED) {
				formatted = true;
			} else if (result.formatter === FileFormatResult.FAILED) {
				hasFailed = true;
			} else if (result.formatter === FileFormatResult.UNSUPPORTED) {
				hasUnsupported = true;
			}
		}
	}

	if (!hasResults && !hasFormatter) {
		return undefined;
	}

	let summary = options.enableDiagnostics ? "no issues" : "OK";
	let errored = false;
	let limitedMessages = messages;
	if (messages.length > 0) {
		const summaryInfo = summarizeDiagnosticMessages(messages);
		summary = summaryInfo.summary;
		errored = summaryInfo.errored;
		limitedMessages = limitDiagnosticMessages(messages);
	}
	// Priority: FAILED > FORMATTED > UNCHANGED > UNSUPPORTED
	const formatter = hasFormatter
		? hasFailed
			? FileFormatResult.FAILED
			: formatted
				? FileFormatResult.FORMATTED
				: hasUnsupported && !formatted
					? FileFormatResult.UNSUPPORTED
					: FileFormatResult.UNCHANGED
		: undefined;

	return {
		server: servers.size > 0 ? Array.from(servers).join(", ") : undefined,
		messages: limitedMessages,
		summary,
		errored,
		formatter,
	};
}

async function runLspWritethrough(
	dst: string,
	content: string,
	cwd: string,
	options: ResolvedWritethroughOptions,
	changeType: FileChangeType,
	signal?: AbortSignal,
	file?: BunFile,
	deferred?: {
		onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
		signal: AbortSignal;
	},
	runOptions?: RunLspWritethroughOptions,
): Promise<FileDiagnosticsResult | undefined> {
	const { enableFormat, enableDiagnostics } = options;
	const contentAlreadyWritten = runOptions?.contentAlreadyWritten ?? false;

	let finalContent = content;
	const writeContent = async (value: string) => writeFileWithFallback(dst, value, file);
	const getWritePromise = once(() =>
		contentAlreadyWritten && finalContent === content ? Promise.resolve() : writeContent(finalContent),
	);
	let writeNotified = false;
	// Watched-file announcements go to every canonical workspace root the
	// write touches (clone partitions), never the session cwd: clients are
	// keyed by their workspace root, so a session-cwd announce would never
	// reach the clone servers that just formatted and saved.
	let notifyRoots: string[] = [cwd];
	const notifyWriteCommitted = async (notifySignal: AbortSignal | undefined = signal) => {
		if (writeNotified) return;
		writeNotified = true;
		try {
			await Promise.all(
				notifyRoots.map(root =>
					notifyWorkspaceWatchedFiles(root, [{ filePath: dst, type: changeType }], notifySignal),
				),
			);
		} catch (error) {
			if (notifySignal?.aborted && !signal?.aborted) {
				// The operation budget died mid-notify while the caller is still
				// live: allow the post-write retry below to re-announce with the
				// caller's signal (didChangeWatchedFiles is idempotent).
				writeNotified = false;
				return;
			}
			throw error;
		}
	};
	if (!enableFormat && !enableDiagnostics) {
		await getWritePromise();
		await notifyWriteCommitted();
		return undefined;
	}

	// File-driven clone-local resolution: a clone file's servers attach to
	// their own canonical workspace roots (realpath), never the session cwd,
	// and a missing clone-local binary is skipped — never a $PATH/founder
	// fallback, never a client spawned at the session root. Session-owned and
	// stray (non-git) files keep the original session-config selection and
	// identity, so lazy/custom formatter/freshness behavior is unchanged —
	// including exactly one getServersForFile call per file.
	const ceiling = resolveLspCeiling(dst, cwd);
	if (ceiling.escaped) {
		notifyRoots = [];
		await getWritePromise();
		await notifyWriteCommitted();
		return undefined;
	}
	let resolvable: ResolvedFileServer[];
	if (ceiling.kind !== "git") {
		const config = getConfig(cwd);
		const sessionServers = getServersForFile(config, dst);
		if (sessionServers.length === 0) {
			await getWritePromise();
			await notifyWriteCommitted();
			return undefined;
		}
		resolvable = sessionServers.map(([name, serverConfig]) => ({
			name,
			config: serverConfig,
			workspaceRoot: cwd,
			workspaceRootReal: canonicalRoot(cwd),
			ceiling: ceiling.path,
			ceilingKind: ceiling.kind,
			missingBinary: false,
		}));
	} else {
		const fileResolution = resolveFileLspServers(dst, cwd);
		resolvable = fileResolution.servers.filter(entry => !entry.missingBinary);
		// A clone write always announces on the clone work tree — never the
		// unrelated session root — even when nothing is resolvable.
		notifyRoots = [canonicalRoot(fileResolution.ceiling.path)];
		if (fileResolution.ceiling.escaped || resolvable.length === 0) {
			await getWritePromise();
			await notifyWriteCommitted();
			return undefined;
		}
	}
	notifyRoots = Array.from(new Set(resolvable.map(entry => entry.workspaceRootReal)));

	// Partition resolvable servers by their canonical workspace root so every
	// client attaches to its own project. Version maps below are keyed by
	// server name, so partitions merge cleanly.
	const partitions = new Map<string, ResolvedFileServer[]>();
	for (const entry of resolvable) {
		const list = partitions.get(entry.workspaceRootReal);
		if (list) {
			list.push(entry);
		} else {
			partitions.set(entry.workspaceRootReal, [entry]);
		}
	}
	const roots = Array.from(partitions.keys());
	const rootServers = (root: string): Array<[string, ServerConfig]> =>
		(partitions.get(root) ?? []).map(entry => [entry.name, entry.config]);
	const rootLspServers = (root: string): Array<[string, ServerConfig]> =>
		(partitions.get(root) ?? []).filter(entry => !entry.config.createClient).map(entry => [entry.name, entry.config]);
	const rootCustomServers = (root: string): Array<[string, ServerConfig]> =>
		(partitions.get(root) ?? [])
			.filter(entry => Boolean(entry.config.createClient))
			.map(entry => [entry.name, entry.config]);
	const servers = resolvable.map(entry => [entry.name, entry.config] as [string, ServerConfig]);
	const { customLinterServers } = splitServers(servers);
	const useCustomFormatter = enableFormat && customLinterServers.length > 0;

	// Run one LSP step per workspace partition, so each server's client is
	// created at its own canonical root. Sync/notify/version capture use the
	// non-custom subset (mirroring the original lspServers); formatting uses
	// the branch's subset so custom formatting never cold-starts an LSP server.
	const syncFileContentPerRoots = async (
		dstPath: string,
		fileContent: string,
		opSignal: AbortSignal,
		createMissing: boolean,
	): Promise<void> => {
		await Promise.all(
			roots.map(root => syncFileContent(dstPath, fileContent, root, rootLspServers(root), opSignal, createMissing)),
		);
	};
	const notifyFileSavedPerRoots = async (
		dstPath: string,
		opSignal: AbortSignal,
		createMissing: boolean,
	): Promise<void> => {
		await Promise.all(
			roots.map(root => notifyFileSaved(dstPath, root, rootLspServers(root), opSignal, createMissing)),
		);
	};
	const formatContentPerRoots = async (
		contentToFormat: string,
		opSignal: AbortSignal,
		serversForRoot: (root: string) => Array<[string, ServerConfig]>,
	): Promise<FormatContentResult> => {
		let hadFailure = false;
		for (const root of roots) {
			const formatted = await formatContent(dst, contentToFormat, root, serversForRoot(root), opSignal);
			if (!formatted.failed && !formatted.unsupported) return formatted;
			hadFailure ||= formatted.failed;
		}
		return { content: contentToFormat, failed: hadFailure, unsupported: !hadFailure };
	};

	// Fetch post-write diagnostics per workspace partition without making the
	// edit/write block on a slow language server. Blocks inline only briefly
	// for a fresh result; slow servers deliver late via the deferred channel
	// as ONE merged result.
	const fetchDiagnosticsPerRoots = async (args: {
		minVersions: ServerVersionMap | undefined;
		expectedDocumentVersions: ServerVersionMap | undefined;
		transformDiagnostics?: ResolvedWritethroughOptions["transformDiagnostics"];
		deferred?: { onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void; signal: AbortSignal };
		signal?: AbortSignal;
	}): Promise<FileDiagnosticsResult | undefined> => {
		const { minVersions, expectedDocumentVersions, transformDiagnostics, deferred, signal } = args;
		const apply = (d: FileDiagnosticsResult | undefined) =>
			d && transformDiagnostics ? transformDiagnostics(dst, d) : d;
		// A single partition returns its raw result (freshness contract: the
		// summary stays "OK"); only multiple partitions are merged.
		const mergeResults = (results: Array<FileDiagnosticsResult | undefined>): FileDiagnosticsResult | undefined =>
			roots.length === 1 ? results[0] : mergeDiagnostics(results, options);

		if (!deferred) {
			// No late-injection channel: block for the standard budget and return inline.
			const results = await Promise.all(
				roots.map(root =>
					getDiagnosticsForFile(dst, root, rootServers(root), {
						signal,
						minVersions,
						expectedDocumentVersions,
					}),
				),
			);
			return apply(mergeResults(results));
		}

		// One background fetch per partition with a generous inner budget;
		// await them only briefly inline.
		const fetchPromises = roots.map(root =>
			getDiagnosticsForFile(dst, root, rootServers(root), {
				signal: deferred.signal,
				minVersions,
				expectedDocumentVersions,
				timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
			}),
		);
		const INLINE_TIMEOUT = Symbol("inline-diagnostics-timeout");
		const raced = await Promise.race([
			Promise.all(fetchPromises).then(results => mergeResults(results)),
			Bun.sleep(INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS).then(() => INLINE_TIMEOUT),
		]);
		if (raced !== INLINE_TIMEOUT) {
			return apply(raced as FileDiagnosticsResult | undefined);
		}
		// Slow servers: deliver late via the deferred channel; nothing inline.
		void Promise.all(fetchPromises)
			.then(results => {
				const merged = mergeResults(results);
				if (merged && !deferred.signal.aborted) deferred.onDeferredDiagnostics(merged);
			})
			.catch(() => {});
		return undefined;
	};

	// Capture diagnostic versions BEFORE syncing to detect stale diagnostics
	// Bound client creation by the writethrough budget: a hung/broken server
	// must not add its full init wait (30s default) to every edit.
	const minVersionsPromise = enableDiagnostics
		? Promise.all(roots.map(root => captureDiagnosticVersions(root, rootServers(root), 5_000, signal))).then(
				maps => new Map(maps.flatMap(map => Array.from(map.entries()))),
			)
		: undefined;
	let minVersions = useCustomFormatter ? undefined : await minVersionsPromise;
	let expectedDocumentVersions: ServerVersionMap | undefined;

	let formatter: FileFormatResult | undefined;
	let diagnostics: FileDiagnosticsResult | undefined;
	let timedOut = false;
	let synced = false;
	// The writethrough LSP budget is 5s, bounded by the caller's signal when
	// one is supplied. Concrete by construction — every per-partition step
	// below takes it as a required AbortSignal, never an optional.
	const timeoutSignal = AbortSignal.timeout(5_000);
	timeoutSignal.addEventListener(
		"abort",
		() => {
			timedOut = true;
		},
		{ once: true },
	);
	const operationSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		await untilAborted(operationSignal, async () => {
			if (useCustomFormatter) {
				// Custom linters operate on on-disk input; the shared pre-write also
				// supports implementations that inspect the file before formatting.
				if (!contentAlreadyWritten) await writeContent(content);
				const [formattedContent, capturedVersions] = await Promise.all([
					formatContentPerRoots(content, operationSignal, rootCustomServers),
					minVersionsPromise,
				]);
				finalContent = formattedContent.content;
				minVersions = capturedVersions;
				if (formattedContent.failed) {
					formatter = FileFormatResult.FAILED;
				} else if (formattedContent.unsupported) {
					formatter = FileFormatResult.UNSUPPORTED;
				} else {
					formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				}
				if (!contentAlreadyWritten || finalContent !== content) await writeContent(finalContent);
				await notifyWriteCommitted(operationSignal);
				await syncFileContentPerRoots(dst, finalContent, operationSignal, enableDiagnostics);
			} else {
				// 1. Sync original content to LSP servers
				await syncFileContentPerRoots(dst, content, operationSignal, true);

				// 2. Format in-memory via LSP
				if (enableFormat) {
					const formatted = await formatContentPerRoots(content, operationSignal, rootLspServers);
					finalContent = formatted.content;
					if (formatted.failed) {
						formatter = FileFormatResult.FAILED;
					} else if (formatted.unsupported) {
						formatter = FileFormatResult.UNSUPPORTED;
					} else {
						formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
					}
				}

				// 3. If formatted, sync formatted content to LSP servers
				if (finalContent !== content) {
					await syncFileContentPerRoots(dst, finalContent, operationSignal, true);
				}

				// 4. Write to disk
				await getWritePromise();
				await notifyWriteCommitted(operationSignal);
			}

			if (enableDiagnostics) {
				expectedDocumentVersions = new Map(
					(
						await Promise.all(
							roots.map(root => captureOpenFileVersions(dst, root, rootLspServers(root), operationSignal)),
						)
					).flatMap(map => Array.from(map.entries())),
				);
			}

			// 5. Notify saved to LSP servers
			await notifyFileSavedPerRoots(dst, operationSignal, !useCustomFormatter || enableDiagnostics);
		});
		synced = true;
	} catch {
		if (timedOut) {
			formatter = undefined;
			diagnostics = undefined;
			// Schedule background diagnostic fetch if caller wants deferred results:
			// one bounded fetch per partition; whenever every partition settles,
			// exactly one merged result is delivered (no lost or duplicated
			// callbacks when a partition fetch yields nothing).
			if (deferred && !deferred.signal.aborted && enableDiagnostics) {
				void (async () => {
					const results = await Promise.all(
						roots.map(root =>
							getDiagnosticsForFile(dst, root, rootServers(root), {
								signal: AbortSignal.any([deferred.signal, AbortSignal.timeout(25_000)]),
								minVersions,
								expectedDocumentVersions,
								timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
							}).catch(() => undefined),
						),
					);
					const merged = mergeDiagnostics(results, options);
					if (merged && !deferred.signal.aborted) deferred.onDeferredDiagnostics(merged);
				})();
			}
		}
		await getWritePromise();
		// The write above committed even though the operation budget elapsed:
		// announce it on the caller's signal — the dead `operationSignal` would
		// abort the notify before it ever reaches the server.
		await notifyWriteCommitted();
	}

	if (synced && enableDiagnostics) {
		diagnostics = await fetchDiagnosticsPerRoots({
			minVersions,
			expectedDocumentVersions,
			transformDiagnostics: options.transformDiagnostics,
			deferred,
			signal,
		});
	}

	if (formatter !== undefined) {
		diagnostics ??= {
			server: servers.map(([name]) => name).join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
		diagnostics.formatter = formatter;
	}

	return diagnostics;
}

async function flushWritethroughBatch(
	batch: PendingWritethrough[],
	cwd: string,
	options: ResolvedWritethroughOptions,
	signal?: AbortSignal,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (batch.length === 0) {
		return undefined;
	}
	const results: Array<FileDiagnosticsResult | undefined> = [];
	for (const entry of batch) {
		const bundle = getDeferred?.(entry.dst);
		let content: string;
		try {
			content = await fs.promises.readFile(entry.dst, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				bundle?.finalize(undefined);
				continue;
			}
			// A brokered write lands bytes this process may not be able to read
			// back: a sandbox that denies the write commonly denies the read too.
			// Failing here would fail a flush whose every write succeeded, so the
			// content this entry committed stands in for the unreadable file.
			if (!isPermissionDeniedError(error)) throw error;
			content = entry.content;
		}
		const deferredInner =
			bundle &&
			({
				onDeferredDiagnostics: bundle.onDeferredDiagnostics,
				signal: bundle.signal,
			} as const);
		const diag = await runLspWritethrough(
			entry.dst,
			content,
			cwd,
			options,
			entry.changeType,
			signal,
			entry.file,
			deferredInner,
			{ contentAlreadyWritten: true },
		);
		bundle?.finalize(diag);
		results.push(diag);
	}
	return mergeDiagnostics(results, options);
}

/** Create a writethrough callback for LSP aware write operations */
export function createLspWritethrough(cwd: string, options?: WritethroughOptions): WritethroughCallback {
	const resolvedOptions: ResolvedWritethroughOptions = {
		enableFormat: options?.enableFormat ?? false,
		enableDiagnostics: options?.enableDiagnostics ?? false,
		transformDiagnostics: options?.transformDiagnostics,
	};
	return async (
		dst: string,
		content: string,
		signal?: AbortSignal,
		file?: BunFile,
		batch?: LspWritethroughBatchRequest,
		getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
	) => {
		const changeType = (await Bun.file(dst).exists()) ? FileChangeType.Changed : FileChangeType.Created;
		if (!batch) {
			const bundle = getDeferred?.(dst);
			const deferredInner =
				bundle &&
				({
					onDeferredDiagnostics: bundle.onDeferredDiagnostics,
					signal: bundle.signal,
				} as const);
			const diagnostics = await runLspWritethrough(
				dst,
				content,
				cwd,
				resolvedOptions,
				changeType,
				signal,
				file,
				deferredInner,
			);
			bundle?.finalize(diagnostics);
			return diagnostics;
		}

		// File commits are never deferred: the batch owns only LSP post-processing,
		// so a later flush cannot replay an obsolete whole-file snapshot.
		try {
			await writethroughNoop(dst, content, signal, file);
		} catch (error) {
			if (batch.flush) {
				const pending = writethroughBatches.get(batch.id);
				if (pending) {
					writethroughBatches.delete(batch.id);
					try {
						await flushWritethroughBatch(
							Array.from(pending.entries.values()),
							cwd,
							pending.options,
							signal,
							getDeferred,
						);
					} catch (flushError) {
						logger.warn("Failed to flush pending LSP batch after final write failure", {
							batchId: batch.id,
							error: flushError instanceof Error ? flushError.message : String(flushError),
						});
					}
				}
			}
			throw error;
		}

		const state = getOrCreateWritethroughBatch(batch.id, resolvedOptions);
		state.entries.set(dst, { dst, file, changeType, content });
		if (!batch.flush) return undefined;

		writethroughBatches.delete(batch.id);
		return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal, getDeferred);
	};
}
