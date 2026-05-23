import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import * as Diff from "diff";
import { generateDiffString } from "../edit/diff";
import type { FileReadCache } from "../edit/file-read-cache";
import { getFileReadCache } from "../edit/file-read-cache";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../edit/normalize";
import { readEditFileText, serializeEditFileText } from "../edit/read-file";
import type { EditToolDetails } from "../edit/renderer";
import type { ToolSession } from "../tools";
import { assertEditableFileContent } from "../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../tools/fs-cache-invalidation";
import { outputMeta } from "../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../tools/plan-mode-guard";
import { HashlineMismatchError } from "./anchors";
import { applyHashlineEdits, type HashlineApplyResult } from "./apply";
import { buildCompactHashlineDiffPreview } from "./diff-preview";
import { computeLineHash, HL_HASH_CAPTURE_RE_RAW, HL_OP_CHARS } from "./hash";
import { type HashlineInputSection, splitHashlineInputs } from "./input";
import { parseHashlineWithWarnings } from "./parser";
import type {
	ExecuteHashlineSingleOptions,
	HashlineApplyOptions,
	HashlineEdit,
	hashlineEditParamsSchema,
} from "./types";

const ANCHOR_RE = new RegExp(HL_HASH_CAPTURE_RE_RAW, "g");
interface ReadHashlineFileResult {
	exists: boolean;
	rawContent: string;
}

async function readHashlineFile(absolutePath: string, pathText: string): Promise<ReadHashlineFileResult> {
	try {
		return { exists: true, rawContent: await readEditFileText(absolutePath, pathText) };
	} catch (error) {
		if (isEnoent(error)) return { exists: false, rawContent: "" };
		if (error instanceof Error && error.message === `File not found: ${pathText}`)
			return { exists: false, rawContent: "" };
		throw error;
	}
}

function hasAnchorScopedEdit(edits: HashlineEdit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function formatNoChangeDiagnostic(pathText: string): string {
	return `Edits to ${pathText} resulted in no changes being made.`;
}

function getHashlineApplyOptions(session: ToolSession): HashlineApplyOptions {
	return {
		autoDropPureInsertDuplicates: session.settings.get("edit.hashlineAutoDropPureInsertDuplicates"),
	};
}

function getTextContent(result: AgentToolResult<EditToolDetails>): string {
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

function getEditDetails(result: AgentToolResult<EditToolDetails>): EditToolDetails {
	return result.details ?? { diff: "" };
}

/**
 * Given the remaps from a `HashlineMismatchError` and the original input string
 * that was parsed, produce a corrected edit string with every stale anchor
 * replaced by its corrected hash. Only op lines (`+`, `<`, `-`, `=`) are
 * modified; `~TEXT` payload lines and `@PATH` headers are left untouched.
 */
export function buildCorrectedEdit(remaps: ReadonlyMap<string, string>, originalInput: string): string {
	// Build a bare-anchor lookup from remaps so bare line numbers (e.g. "5"
	// without a hash) can be corrected too. For each "42ab"→"42cd" remap,
	// add "42"→"42cd" so bare anchors resolve to corrected full anchors.
	const bareRemaps = new Map<string, string>();
	for (const [key, corrected] of remaps) {
		const m = key.match(/^(\d+)/);
		if (m) {
			const lineNum = m[1];
			if (!bareRemaps.has(lineNum)) bareRemaps.set(lineNum, corrected);
		}
	}

	return originalInput
		.split("\n")
		.map(line => {
			// Op lines start with «, », ≔ — process anchor corrections
			const first = line[0];
			if (first !== undefined && HL_OP_CHARS.includes(first)) {
				// First pass: replace every matching full anchor (LINE+HASH)
				const withFull = line.replace(ANCHOR_RE, (match, lineNum, hash) => {
					const key = `${lineNum}${hash}`;
					const corrected = remaps.get(key);
					return corrected ?? match;
				});
				// Second pass: replace bare line numbers on op lines with corrected anchors
				return withFull.replace(/\b([1-9]\d*)\b/g, (match, num) => bareRemaps.get(num) ?? match);
			}
			// Section headers, payload lines, blank lines — untouched
			return line;
		})
		.join("\n");
}

/**
 * Compute a line-shift map from `previousText` to `currentText` using a
 * structured diff. Returns a Map of `(originalLineNum → newLineNum)`.
 * Line numbers are 1-indexed. Lines whose content was modified in-place are
 * mapped to `undefined` (can't be shifted).
 */
export function computeLineShiftMap(previousText: string, currentText: string): Map<number, number | undefined> {
	const prev = previousText.split("\n");
	const patch = Diff.structuredPatch("prev", "cur", previousText, currentText, "", "", { context: 0 });
	const shiftMap = new Map<number, number | undefined>();

	let prevLine = 1;
	let curLine = 1;
	let prevIdx = 0;

	for (const hunk of patch.hunks) {
		while (prevIdx < prev.length && prevIdx < hunk.oldStart - 1) {
			shiftMap.set(prevLine, curLine);
			prevLine++;
			curLine++;
			prevIdx++;
		}

		for (const change of hunk.lines) {
			if (change.startsWith("\\")) continue;
			if (change.startsWith(" ")) {
				shiftMap.set(prevLine, curLine);
				prevLine++;
				curLine++;
				prevIdx++;
			} else if (change.startsWith("-")) {
				shiftMap.set(prevLine, undefined);
				prevLine++;
				prevIdx++;
			} else if (change.startsWith("+")) {
				curLine++;
			}
		}
	}

	while (prevIdx < prev.length) {
		shiftMap.set(prevLine, curLine);
		prevLine++;
		curLine++;
		prevIdx++;
	}

	return shiftMap;
}

/**
 * Attempt to shift stale anchors using a cached snapshot. When the file
 * changed structurally (lines inserted/deleted above the anchor), we can
 * shift the anchor's line number and re-validate strictly.
 */
export function tryShiftAnchors(
	edits: HashlineEdit[],
	cachedText: string,
	currentText: string,
): {
	shifted: HashlineEdit[];
	shiftCount: number;
} {
	const shiftMap = computeLineShiftMap(cachedText, currentText);
	const currentLines = currentText.split("\n");
	let shiftCount = 0;

	const shifted: HashlineEdit[] = [];
	for (const edit of edits) {
		if (edit.kind === "delete") {
			const newLine = shiftMap.get(edit.anchor.line);
			if (newLine === undefined) {
				// Can't shift — keep original anchor; will fail validation naturally
				shifted.push(edit);
			} else if (newLine !== edit.anchor.line) {
				// Recompute hash: non-significant lines (e.g. "}", "") include the
				// line number as seed in computeLineHash, so a shifted anchor keeps
				// its old hash which no longer matches the new position.
				const newHash = computeLineHash(newLine, currentLines[newLine - 1] ?? "");
				shifted.push({ ...edit, anchor: { line: newLine, hash: newHash } });
				shiftCount++;
			} else {
				shifted.push(edit);
			}
		} else if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") {
			const anchorLine = edit.cursor.anchor.line;
			const newLine = shiftMap.get(anchorLine);
			if (newLine === undefined) {
				// Can't shift — keep original anchor; will fail validation naturally
				shifted.push(edit);
			} else if (newLine !== anchorLine) {
				const newHash = computeLineHash(newLine, currentLines[newLine - 1] ?? "");
				shifted.push({
					...edit,
					cursor: { ...edit.cursor, anchor: { line: newLine, hash: newHash } },
				});
				shiftCount++;
			} else {
				shifted.push(edit);
			}
		} else {
			shifted.push(edit);
		}
	}

	return { shifted, shiftCount };
}

/**
 * Resolve bare line-number anchors (empty hash sentinel) using the read
 * cache snapshot. When the model writes `+ 5` instead of `+ 5xx`, the
 * hash is computed from the cached content for that line so that stale-
 * anchor detection and pre-shift recovery still work.
 *
 * If the cache has no entry for a referenced line, throws a clear error
 * telling the model to re-read the file.
 */
function resolveBareAnchors(edits: HashlineEdit[], cache: FileReadCache, absolutePath: string): HashlineEdit[] {
	const snapshot = cache.get(absolutePath);
	let needsResolution = false;
	for (const edit of edits) {
		if (edit.kind === "delete" && edit.anchor.hash === "") {
			needsResolution = true;
			break;
		}
		if (
			edit.kind !== "delete" &&
			(edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") &&
			edit.cursor.anchor.hash === ""
		) {
			needsResolution = true;
			break;
		}
	}
	if (!needsResolution) return edits;

	return edits.map((edit): HashlineEdit => {
		if (edit.kind === "delete") {
			if (edit.anchor.hash === "") {
				const line = edit.anchor.line;
				const cachedContent = snapshot?.lines.get(line);
				if (cachedContent === undefined) {
					throw new Error(
						`Line ${line}: bare line number with no cached snapshot. Re-read the file to get valid anchors.`,
					);
				}
				return { ...edit, anchor: { ...edit.anchor, hash: computeLineHash(line, cachedContent) } };
			}
			return edit;
		}
		// Insert edit — check cursor anchor
		if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") {
			if (edit.cursor.anchor.hash === "") {
				const line = edit.cursor.anchor.line;
				const cachedContent = snapshot?.lines.get(line);
				if (cachedContent === undefined) {
					throw new Error(
						`Line ${line}: bare line number with no cached snapshot. Re-read the file to get valid anchors.`,
					);
				}
				return {
					...edit,
					cursor: {
						...edit.cursor,
						anchor: { ...edit.cursor.anchor, hash: computeLineHash(line, cachedContent) },
					},
				};
			}
		}
		return edit;
	});
}

/**
 * Apply hashline edits with stale-anchor recovery:
 *
 * 1. **Anchor pre-shift**: if the file changed structurally since the last
 *    snapshot, shift anchor line numbers and re-validate strictly.
 *
 * If neither works, the original `HashlineMismatchError` is re-thrown.
 */
function applyHashlineEditsWithRecovery(
	session: ToolSession,
	absolutePath: string,
	text: string,
	edits: HashlineEdit[],
	options: HashlineApplyOptions,
): HashlineApplyResult {
	// Resolve bare line-number anchors from the read cache before any validation.
	const resolved = resolveBareAnchors(edits, getFileReadCache(session), absolutePath);

	// Tier 1: try direct application first (fast path — anchors match)
	try {
		return applyHashlineEdits(text, resolved, options);
	} catch (err) {
		if (!(err instanceof HashlineMismatchError)) throw err;
		const mismatchErr = err;

		const cache = getFileReadCache(session);
		const snapshot = cache.get(absolutePath);

		// Tier 2: pre-shift — file changed structurally, shift anchors
		let shiftedErr: HashlineMismatchError | undefined;
		if (snapshot?.fullContent && snapshot.fullContent !== text && !snapshot.isPartial) {
			const { shifted, shiftCount } = tryShiftAnchors(resolved, snapshot.fullContent, text);
			if (shiftCount > 0) {
				const warnings = [`Auto-shifted ${shiftCount} anchor(s) because the file changed since the last read.`];
				try {
					const result = applyHashlineEdits(text, shifted, options);
					return {
						...result,
						warnings: [...(result.warnings ?? []), ...warnings],
					};
				} catch (e) {
					if (!(e instanceof HashlineMismatchError)) throw e;
					shiftedErr = e;
				}
			}
		}

		// All recovery tiers exhausted — throw the best available error.
		const finalErr = shiftedErr ?? mismatchErr;

		// Build custom remaps mapping original anchor inputs to their current actual counterparts
		const customRemaps = new Map<string, string>();
		const currentLines = text.split("\n");
		const shiftMap = snapshot?.fullContent ? computeLineShiftMap(snapshot.fullContent, text) : undefined;

		for (const edit of resolved) {
			let origLine: number | undefined;
			let origHash: string | undefined;
			if (edit.kind === "delete") {
				origLine = edit.anchor.line;
				origHash = edit.anchor.hash;
			} else if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor") {
				origLine = edit.cursor.anchor.line;
				origHash = edit.cursor.anchor.hash;
			}
			if (origLine !== undefined && origHash !== undefined) {
				const newLine = shiftMap ? shiftMap.get(origLine) : origLine;
				if (newLine !== undefined) {
					const actualHash = computeLineHash(newLine, currentLines[newLine - 1] ?? "");
					customRemaps.set(`${origLine}${origHash}`, `${newLine}${actualHash}`);
				} else if (
					shiftMap &&
					(origLine > currentLines.length ||
						Array.from(shiftMap.entries()).some(([k, v]) => v === origLine && k !== origLine))
				) {
					// Line was truly deleted (file shrank or another line shifted into this position).
					// Leave anchor unmapped so retries fail and force a re-read.
				} else {
					// Line was modified in-place — remap to same line with current content hash.
					const actualHash = computeLineHash(origLine, currentLines[origLine - 1] ?? "");
					customRemaps.set(`${origLine}${origHash}`, `${origLine}${actualHash}`);
				}
			}
		}

		Object.defineProperty(finalErr, "remaps", {
			value: customRemaps,
			writable: true,
			enumerable: true,
			configurable: true,
		});

		throw finalErr;
	}
}

/**
 * Run all the front-end checks (notebook guard, parse, plan-mode check, file
 * load, edit application) without writing. Used to fail fast before applying
 * any changes in a multi-section batch.
 */
async function preflightHashlineSection(options: ExecuteHashlineSingleOptions & HashlineInputSection): Promise<void> {
	const { session, path: sectionPath, diff } = options;

	const absolutePath = resolvePlanPath(session, sectionPath);
	const { edits } = parseHashlineWithWarnings(diff);
	enforcePlanModeWrite(session, sectionPath, { op: "update" });

	const source = await readHashlineFile(absolutePath, sectionPath);
	if (!source.exists && hasAnchorScopedEdit(edits)) throw new Error(`File not found: ${sectionPath}`);
	if (source.exists) assertEditableFileContent(source.rawContent, sectionPath);

	const { text } = stripBom(source.rawContent);
	const normalized = normalizeToLF(text);
	const result = applyHashlineEditsWithRecovery(
		session,
		absolutePath,
		normalized,
		edits,
		getHashlineApplyOptions(session),
	);
	if (normalized === result.lines) throw new Error(formatNoChangeDiagnostic(sectionPath));
}

async function executeHashlineSection(
	options: ExecuteHashlineSingleOptions & HashlineInputSection & { throwOnMismatch?: boolean },
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const {
		session,
		path: sourcePath,
		diff,
		signal,
		batchRequest,
		writethrough,
		beginDeferredDiagnosticsForPath,
		throwOnMismatch,
	} = options;

	const absolutePath = resolvePlanPath(session, sourcePath);
	const { edits, warnings: parseWarnings } = parseHashlineWithWarnings(diff);
	enforcePlanModeWrite(session, sourcePath, { op: "update" });

	const source = await readHashlineFile(absolutePath, sourcePath);
	if (!source.exists && hasAnchorScopedEdit(edits)) throw new Error(`File not found: ${sourcePath}`);
	if (source.exists) assertEditableFileContent(source.rawContent, sourcePath);
	const { bom, text } = stripBom(source.rawContent);
	const originalEnding = detectLineEnding(text);
	const originalNormalized = normalizeToLF(text);

	let result: HashlineApplyResult;
	try {
		result = applyHashlineEditsWithRecovery(
			session,
			absolutePath,
			originalNormalized,
			edits,
			getHashlineApplyOptions(session),
		);
	} catch (err) {
		if (err instanceof HashlineMismatchError) {
			if (throwOnMismatch) {
				throw err;
			}
			const correctedInput = `§${sourcePath}\n${buildCorrectedEdit(err.remaps, diff)}`;
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: `${err.message}\n\nCorrected edit block:\n${correctedInput}\n\nUse this corrected edit or re-read the file for fresh anchors.`,
					},
				],
				details: {
					diff: "",
					correctedInput,
					path: sourcePath,
					op: "update",
					meta: outputMeta().get(),
					errorText: err.message,
					displayErrorText: err.displayMessage,
				},
			};
		}
		throw err;
	}

	if (originalNormalized === result.lines) {
		return {
			content: [{ type: "text", text: formatNoChangeDiagnostic(sourcePath) }],
			details: { diff: "", path: sourcePath, op: "update", meta: outputMeta().get() },
		};
	}

	const finalContent = await serializeEditFileText(
		absolutePath,
		sourcePath,
		bom + restoreLineEndings(result.lines, originalEnding),
	);
	const diagnostics = await writethrough(
		absolutePath,
		finalContent,
		signal,
		Bun.file(absolutePath),
		batchRequest,
		dst => (dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined),
	);
	invalidateFsScanAfterWrite(absolutePath);
	// The post-edit content is the freshest, most authoritative "model view"
	// of the file: the model just received it back as the diff/preview. Cache
	// it so a follow-up edit anchored against this state can still recover
	// if the file is touched out-of-band before the next edit lands.
	getFileReadCache(session).recordFullFile(absolutePath, result.lines);

	const diffResult = generateDiffString(originalNormalized, result.lines);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();
	const preview = buildCompactHashlineDiffPreview(diffResult.diff);

	const warnings = [...parseWarnings, ...(result.warnings ?? [])];
	const warningsBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n${preview.preview}` : "";
	const headline = preview.preview
		? `${sourcePath}:`
		: source.exists
			? `Updated ${sourcePath}`
			: `Created ${sourcePath}`;

	return {
		content: [{ type: "text", text: `${headline}${previewBlock}${warningsBlock}` }],
		details: {
			diff: diffResult.diff,
			path: sourcePath,
			firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine,
			diagnostics,
			op: source.exists ? "update" : "create",
			meta,
		},
	};
}
export async function executeHashlineSingle(
	options: ExecuteHashlineSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const sections = mergeSamePathSections(
		splitHashlineInputs(options.input, { cwd: options.session.cwd, path: options.path }),
	);

	// Fast path: a single section needs no preflight pass.
	if (sections.length === 1) return executeHashlineSection({ ...options, ...sections[0] });

	// Multi-section: validate everything up front so we don't apply a partial batch.
	// We run preflight for every section. If any section throws a HashlineMismatchError,
	// we halt further processing and compile an aggregate corrected input response.
	let hasMismatch = false;
	const preflightResults: Array<{
		path: string;
		error?: HashlineMismatchError;
		correctedInput?: string;
	}> = [];

	for (const section of sections) {
		try {
			await preflightHashlineSection({ ...options, ...section });
			preflightResults.push({ path: section.path });
		} catch (err) {
			if (err instanceof HashlineMismatchError) {
				hasMismatch = true;
				const correctedInput = `§${section.path}\n${buildCorrectedEdit(err.remaps, section.diff)}`;
				preflightResults.push({ path: section.path, error: err, correctedInput });
			} else {
				throw err;
			}
		}
	}

	if (hasMismatch) {
		const correctedSections = sections.map((section, idx) => {
			const res = preflightResults[idx];
			const body = res.error ? buildCorrectedEdit(res.error.remaps, section.diff) : section.diff;
			return `§${section.path}\n${body}`;
		});
		const combinedCorrectedInput = correctedSections.join("\n\n");
		const mismatchErrors = preflightResults.filter(
			(r): r is typeof r & { error: HashlineMismatchError } => !!r.error,
		);
		const combinedErrorText = mismatchErrors.map(r => r.error.message).join("\n\n");
		const text = `${combinedErrorText}\n\nCorrected edit block:\n${combinedCorrectedInput}\n\nUse this corrected edit or re-read the files for fresh anchors.`;

		return {
			isError: true,
			content: [{ type: "text", text }],
			details: {
				diff: "",
				correctedInput: combinedCorrectedInput,
				perFileResults: sections.map((section, idx) => {
					const res = preflightResults[idx];
					return {
						path: section.path,
						diff: "",
						op: "update",
						isError: true,
						errorText: res.error ? res.error.message : undefined,
						displayErrorText: res.error
							? res.error.displayMessage
							: "Skipped: preflight aborted due to a mismatch in another section",
						correctedInput: res.error && res.correctedInput ? res.correctedInput : undefined,
					};
				}),
			},
		};
	}

	const results = [];
	let activePath = "";
	try {
		for (const section of sections) {
			activePath = section.path;
			results.push({
				path: section.path,
				result: await executeHashlineSection({ ...options, ...section, throwOnMismatch: true }),
			});
		}
	} catch (err) {
		if (err instanceof HashlineMismatchError) {
			const correctedSections = sections.map(section => {
				const body = section.path === activePath ? buildCorrectedEdit(err.remaps, section.diff) : section.diff;
				return `§${section.path}\n${body}`;
			});
			const combinedCorrectedInput = correctedSections.join("\n\n");
			const text = `${err.message}\n\nCorrected edit block:\n${combinedCorrectedInput}\n\nUse this corrected edit or re-read the files for fresh anchors.`;
			return {
				isError: true,
				content: [{ type: "text", text }],
				details: {
					diff: "",
					correctedInput: combinedCorrectedInput,
					perFileResults: sections.map(section => {
						const isFailed = section.path === activePath;
						return {
							path: section.path,
							diff: "",
							op: "update",
							isError: true,
							errorText: isFailed ? err.message : undefined,
							displayErrorText: isFailed
								? err.displayMessage
								: "Skipped: batch aborted due to a mismatch in a preceding section",
							correctedInput: isFailed
								? `§${section.path}\n${buildCorrectedEdit(err.remaps, section.diff)}`
								: undefined,
						};
					}),
				},
			};
		}
		throw err;
	}

	const hasError = results.some(({ result }) => result.isError);

	return {
		...(hasError ? { isError: true } : {}),
		content: [{ type: "text", text: results.map(({ result }) => getTextContent(result)).join("\n\n") }],
		details: {
			diff: results.map(({ result }) => getEditDetails(result).diff).join("\n"),
			perFileResults: results.map(({ path: resultPath, result }) => {
				const details = getEditDetails(result);
				return {
					path: resultPath,
					diff: details.diff,
					firstChangedLine: details.firstChangedLine,
					diagnostics: details.diagnostics,
					op: details.op,
					move: details.move,
					meta: details.meta,
					correctedInput: details.correctedInput,
					isError: result.isError,
					errorText: details.errorText,
					displayErrorText: details.displayErrorText,
				};
			}),
		},
	};
}

/**
 * Collapse consecutive or interleaved sections targeting the same path into a
 * single section with concatenated diffs. Anchors authored against the same
 * file snapshot must be applied as one batch; otherwise the first sub-edit
 * shifts line numbers out from under the second's anchors and validation fails.
 * Path order is preserved by first occurrence.
 */
function mergeSamePathSections(sections: HashlineInputSection[]): HashlineInputSection[] {
	const byPath = new Map<string, string[]>();
	for (const section of sections) {
		const existing = byPath.get(section.path);
		if (existing) existing.push(section.diff);
		else byPath.set(section.path, [section.diff]);
	}
	return Array.from(byPath, ([path, diffs]) => ({ path, diff: diffs.join("\n") }));
}
