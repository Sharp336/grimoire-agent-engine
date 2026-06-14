/**
 * OKF bundle I/O — read, write, walk, and analyse a directory of OKF concept
 * documents (the on-disk source of truth).
 *
 * A bundle is a directory tree of `.md` files. Every non-reserved `.md` file
 * is a concept; its concept ID is the file path relative to the bundle root
 * with the `.md` suffix removed. Reserved filenames (`index.md`, `log.md`) are
 * structural, not concepts.
 *
 * All filesystem access goes through `node:fs/promises` + `Bun.file`.
 */

import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureConformance, type OkfConcept, parse, RESERVED_FILENAMES } from "./document";

// ─────────────────────────────────────────────────────────────────────────────
// Local utilities (kept self-contained — no pi-utils native-addon dependency)
// ─────────────────────────────────────────────────────────────────────────────

/** Check if a filesystem error is ENOENT (file/directory not found). */
function isEnoent(error: unknown): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Minimal structured logger for OKF modules. */
const log = {
	warn(message: string, context?: Record<string, unknown>): void {
		console.warn(`[okf] WARN: ${message}`, context ?? "");
	},
	debug(message: string, context?: Record<string, unknown>): void {
		if (process.env.OKF_DEBUG) console.debug(`[okf] ${message}`, context ?? "");
	},
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Lightweight summary of a concept for listings, search indices, and graphs. */
export interface OkfConceptSummary {
	id: string;
	type: string;
	title?: string;
	description: string;
	tags: string[];
	/** Absolute filesystem path. */
	filePath: string;
	/** Last-modified time in epoch milliseconds. */
	mtime: number;
}

/** A node in the concept graph (concept → other concepts via markdown links). */
export interface OkfGraphNode {
	id: string;
	type: string;
	title?: string;
	description: string;
	tags: string[];
}

/** A directed edge in the concept graph (source concept → target concept). */
export interface OkfGraphEdge {
	from: string;
	to: string;
}

/** The concept graph — nodes are concepts, edges are resolved cross-links. */
export interface OkfGraph {
	nodes: OkfGraphNode[];
	edges: OkfGraphEdge[];
}

/** A cross-link that points to a concept that does not exist in the bundle. */
export interface OkfBrokenLink {
	from: string;
	target: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle root
// ─────────────────────────────────────────────────────────────────────────────

/** Default bundle root relative to the project cwd. */
export const DEFAULT_BUNDLE_DIRNAME = path.join(".omp", "knowledge");

/** Get the default bundle root for a project cwd. */
export function getBundleRoot(cwd: string): string {
	return path.join(cwd, DEFAULT_BUNDLE_DIRNAME);
}

// ─────────────────────────────────────────────────────────────────────────────
// Concept ID normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a relative path to a valid OKF concept ID.
 *
 * Accepts paths with or without the `.md` suffix. Rejects:
 *   - Reserved filenames (`index.md`, `log.md`) at any level.
 *   - Dotfiles (segments starting with `.`).
 *   - Path traversal (`..`).
 *   - NUL bytes.
 *
 * @returns The concept ID (path without `.md`), or `undefined` if invalid.
 */
export function normalizeConceptId(relativePath: string): string | undefined {
	const normalized = relativePath
		.replaceAll("\\", "/")
		.replace(/^\.?\//, "")
		.trim();
	if (!normalized || normalized.includes("\0")) return undefined;

	const segments = normalized.split("/");
	for (const segment of segments) {
		if (!segment || segment === ".." || segment === "." || segment.startsWith(".")) {
			return undefined;
		}
	}

	// Strip `.md` suffix if present to produce the concept ID.
	const id = normalized.replace(/\.md$/i, "");

	// Reject reserved filenames as the concept's filename (last segment).
	const lastSegment = id.split("/").pop()!;
	if (RESERVED_FILENAMES.has(`${lastSegment.toLowerCase()}.md`)) return undefined;

	return id;
}

/**
 * Convert a concept ID to its relative file path within the bundle.
 * Example: `tables/orders` → `tables/orders.md`.
 */
export function conceptIdToPath(id: string): string {
	return `${id}.md`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk a bundle directory and return all concept IDs (sorted, recursive).
 * Skips reserved filenames (`index.md`, `log.md`) and dotfiles.
 */
export async function walkBundle(root: string): Promise<string[]> {
	const ids: string[] = [];
	await collectConceptIds(root, root, ids);
	return ids.sort();
}

async function collectConceptIds(root: string, dir: string, out: string[]): Promise<void> {
	let entries: nodeFs.Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectConceptIds(root, fullPath, out);
			continue;
		}
		if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
		if (RESERVED_FILENAMES.has(entry.name.toLowerCase())) continue;
		const relativePath = path.relative(root, fullPath).replaceAll(path.sep, "/");
		const id = normalizeConceptId(relativePath);
		if (id) out.push(id);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Read / Load
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a single concept from disk, lazily normalising its frontmatter.
 *
 * @throws if the file does not exist or cannot be parsed.
 */
export async function loadConcept(root: string, id: string): Promise<OkfConcept> {
	const filePath = path.join(root, conceptIdToPath(id));
	const text = await Bun.file(filePath).text();
	const doc = parse(text, id);
	return { id, ...doc };
}

/**
 * Load all concept summaries from a bundle.
 *
 * Each file is parsed and its frontmatter is lazily normalised (written back
 * to disk only if `autoUpdate` is true). Summaries are sorted by id.
 */
export async function loadSummaries(
	root: string,
	options: { autoUpdate?: boolean } = {},
): Promise<OkfConceptSummary[]> {
	const ids = await walkBundle(root);
	const summaries: OkfConceptSummary[] = [];
	for (const id of ids) {
		const filePath = path.join(root, conceptIdToPath(id));
		try {
			const text = await Bun.file(filePath).text();
			const ensured = ensureConformance(id, text);
			if (options.autoUpdate !== false && ensured.changed) {
				await Bun.write(filePath, ensured.content);
			}
			const doc = parse(ensured.content, id);
			let mtime = 0;
			try {
				mtime = (await fs.stat(filePath)).mtimeMs;
			} catch {
				// mtime is best-effort.
			}
			summaries.push({
				id,
				type: ensured.type,
				title: typeof doc.frontmatter.title === "string" ? doc.frontmatter.title : undefined,
				description: ensured.description,
				tags: parseTags(doc.frontmatter.tags),
				filePath,
				mtime,
			});
		} catch (error) {
			log.warn("OKF: failed to load concept", {
				id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return summaries;
}

/** Coerce a frontmatter `tags` value to a `string[]`. */
function parseTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((v): v is string => typeof v === "string");
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map(t => t.trim())
			.filter(Boolean);
	}
	return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Write / Delete
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a concept to disk, ensuring OKF conformance and appending to `log.md`.
 *
 * Creates parent directories as needed. The content is normalised via
 * `ensureConformance` before writing.
 */
export async function writeConcept(
	root: string,
	id: string,
	content: string,
): Promise<{ wrote: string; type: string; description: string }> {
	const relativePath = conceptIdToPath(id);
	const fullPath = path.join(root, relativePath);
	await fs.mkdir(path.dirname(fullPath), { recursive: true });

	// Path-traversal safety: the resolved path must stay under root.
	const resolvedRoot = path.resolve(root);
	const resolvedPath = path.resolve(fullPath);
	ensureWithinRoot(resolvedPath, resolvedRoot);

	// Determine whether this is a creation or update.
	let existed = false;
	try {
		await fs.stat(fullPath);
		existed = true;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	const ensured = ensureConformance(id, content);
	await Bun.write(fullPath, ensured.content);

	// Append to the nearest log.md (OKF §7).
	await appendToLog(root, id, existed ? "Update" : "Creation");

	return { wrote: relativePath, type: ensured.type, description: ensured.description };
}

/** Delete a concept from disk. */
export async function deleteConcept(root: string, id: string): Promise<boolean> {
	const fullPath = path.join(root, conceptIdToPath(id));
	const resolvedRoot = path.resolve(root);
	ensureWithinRoot(path.resolve(fullPath), resolvedRoot);
	try {
		await fs.unlink(fullPath);
		await appendToLog(root, id, "Deprecation");
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Append a dated entry to the nearest `log.md` (OKF §7). */
async function appendToLog(root: string, conceptId: string, action: string): Promise<void> {
	const date = new Date().toISOString().slice(0, 10);
	const logPath = path.join(root, "log.md");
	const entry = `* **${action}**: ${conceptId} (${date})\n`;
	try {
		let existing = "";
		try {
			existing = await Bun.file(logPath).text();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const updated = mergeLogEntry(existing, date, entry);
		await Bun.write(logPath, updated);
	} catch (error) {
		log.debug("OKF: failed to append log entry", { conceptId, error: String(error) });
	}
}

/**
 * Merge a log entry into the existing log content, inserting under the correct
 * ISO-8601 date heading (newest first), or creating a new heading.
 */
function mergeLogEntry(existing: string, date: string, entry: string): string {
	const heading = `## ${date}`;
	const lines = existing.split("\n");
	let insertIdx = 0;
	let foundSection = false;

	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			const headingDate = lines[i].slice(3).trim();
			if (headingDate === date) {
				foundSection = true;
				// Insert after the last entry in this section.
				let j = i + 1;
				while (j < lines.length && !lines[j].startsWith("## ") && !lines[j].startsWith("# ")) {
					j++;
				}
				lines.splice(j, 0, entry.trim());
				return lines.join("\n");
			}
			if (headingDate < date) {
				insertIdx = i;
				break;
			}
			insertIdx = i + 1;
		}
	}

	if (foundSection) return lines.join("\n");

	// Insert a new date section.
	const section = `${heading}\n${entry}`;
	lines.splice(insertIdx, 0, "", section);
	if (!existing.includes("# Directory Update Log")) {
		lines.unshift("# Directory Update Log", "");
	}
	return lines.join("\n").replace(/^\n+/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Link resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Regex for markdown links: `[text](target)`. */
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Resolve a markdown link target to a concept ID (or `undefined` if broken).
 *
 * Handles two forms (spec §5):
 *   - Absolute (bundle-relative): `/tables/orders.md` → `tables/orders`
 *   - Relative: `./orders.md` or `../cat/orders.md` relative to the source concept's directory.
 *
 * Non-`.md` links (URLs, anchors, etc.) return `undefined` (not broken, just not concepts).
 */
export function resolveLinkTarget(link: string, fromConceptId: string): string | undefined {
	// Skip URLs, anchors, and non-markdown links.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(link) || link.startsWith("#") || link.startsWith("mailto:")) {
		return undefined;
	}
	if (!link.toLowerCase().endsWith(".md")) return undefined;

	let resolved: string;
	if (link.startsWith("/")) {
		// Absolute (bundle-relative).
		resolved = link.slice(1);
	} else {
		// Relative to the source concept's directory.
		const fromDir = path.dirname(fromConceptId);
		resolved = path.posix.normalize(path.posix.join(fromDir, link)).replace(/^\.\//, "");
	}

	return normalizeConceptId(resolved);
}

/**
 * Find all internal markdown links in a concept body and resolve them to concept IDs.
 * @returns Array of `{ target, resolvedId }` pairs (resolvedId may be undefined for broken links).
 */
export function findLinks(body: string, fromConceptId: string): { target: string; resolvedId: string | undefined }[] {
	const links: { target: string; resolvedId: string | undefined }[] = [];
	for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
		const target = match[2];
		const resolvedId = resolveLinkTarget(target, fromConceptId);
		if (resolvedId !== undefined) {
			links.push({ target, resolvedId });
		}
	}
	return links;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the concept graph from a bundle: nodes are concepts, edges are resolved
 * cross-links. Also collects broken links for `/okf diagnose`.
 */
export async function buildGraph(root: string): Promise<{
	graph: OkfGraph;
	brokenLinks: OkfBrokenLink[];
}> {
	const summaries = await loadSummaries(root);
	const conceptIds = new Set(summaries.map(s => s.id));
	const edges: OkfGraphEdge[] = [];
	const brokenLinks: OkfBrokenLink[] = [];

	for (const summary of summaries) {
		try {
			const concept = await loadConcept(root, summary.id);
			const links = findLinks(concept.body, concept.id);
			for (const link of links) {
				if (link.resolvedId && conceptIds.has(link.resolvedId)) {
					edges.push({ from: summary.id, to: link.resolvedId });
				} else if (link.resolvedId) {
					brokenLinks.push({ from: summary.id, target: link.resolvedId });
				}
			}
		} catch {
			// Skip concepts that can't be loaded.
		}
	}

	const nodes: OkfGraphNode[] = summaries.map(s => ({
		id: s.id,
		type: s.type,
		title: s.title,
		description: s.description,
		tags: s.tags,
	}));

	return { graph: { nodes, edges }, brokenLinks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Index rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a synthesised `index.md`-style listing for the bundle (or a category).
 *
 * If a real `index.md` exists in the target directory, its content is returned
 * instead (spec §6: producers MAY author index files).
 *
 * Concepts are grouped by `type` (or `category` if no type), each entry showing
 * its description.
 */
export async function renderIndex(root: string, options: { category?: string } = {}): Promise<string> {
	const summaries = await loadSummaries(root);
	const visible = options.category ? summaries.filter(s => s.id.startsWith(`${options.category}/`)) : summaries;

	// If a real index.md exists at the target level, defer to it.
	const indexPath = options.category ? path.join(root, options.category, "index.md") : path.join(root, "index.md");
	try {
		const content = await Bun.file(indexPath).text();
		if (content.trim()) return content;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	if (visible.length === 0) {
		return options.category
			? `# Knowledge: ${options.category}\n\nNo concept documents in this category.\n`
			: "# Knowledge\n\nNo concept documents in this bundle.\n";
	}

	// Group by type.
	const groups = new Map<string, OkfConceptSummary[]>();
	for (const summary of visible) {
		const group = groups.get(summary.type) ?? [];
		group.push(summary);
		groups.set(summary.type, group);
	}

	const lines: string[] = ["# Knowledge", ""];
	for (const [type, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		lines.push(`## ${type}`, "");
		for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
			const title = item.title ?? item.id.split("/").pop() ?? item.id;
			lines.push(`- [${title}](/${conceptIdToPath(item.id)}) — ${item.description}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 fingerprint of the bundle's content for change detection.
 *
 * The fingerprint covers concept IDs and their raw file content. Two bundles
 * with the same concepts produce the same fingerprint.
 */
export async function fingerprint(root: string): Promise<string> {
	const ids = await walkBundle(root);
	const hasher = new Bun.SHA256();
	hasher.update("okf-bundle-v1\0");
	for (const id of ids) {
		const filePath = path.join(root, conceptIdToPath(id));
		try {
			const content = await Bun.file(filePath).text();
			hasher.update(`${id.length}:${id}\0${Buffer.byteLength(content, "utf8")}:\0`);
			hasher.update(content);
			hasher.update("\0");
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}
	}
	return hasher.digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Path safety
// ─────────────────────────────────────────────────────────────────────────────

/** Throw if `targetPath` escapes `rootPath` (path-traversal guard). */
export function ensureWithinRoot(targetPath: string, rootPath: string): void {
	if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error("Path escapes the OKF bundle root");
	}
}
