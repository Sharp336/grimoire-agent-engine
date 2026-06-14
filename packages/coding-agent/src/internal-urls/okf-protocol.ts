/**
 * `okf://` internal-URL protocol handler for OKF concept bundles.
 *
 * URL forms (spec §5–6):
 *   - `okf://` — List all concepts (progressive-disclosure index).
 *   - `okf://<category>` — List concepts in one category.
 *   - `okf://<category>/<topic>.md` — Read or write a single concept.
 *
 * Resolves against the calling session's cwd (the project root). The bundle
 * root is `<cwd>/.omp/knowledge` by default.
 *
 * Path-traversal safety: resolved filesystem paths are verified to stay under
 * the bundle root via `realpath` + `ensureWithinRoot`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import {
	conceptIdToPath,
	ensureWithinRoot,
	normalizeConceptId,
	renderIndex,
	resolveBundleRoot,
	writeConcept,
} from "../okf/bundle";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, WriteContext } from "./types";

/** Handler for `okf://` URLs. */
export class OkfProtocolHandler implements ProtocolHandler {
	readonly scheme = "okf";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const { root, parsed } = resolveOkfUrl(url, context);

		// `okf://` or `okf://<category>` — render the listing.
		if (!parsed.relativePath) {
			const content = await renderIndex(root, { category: parsed.category });
			const sourcePath = parsed.category ? path.join(root, parsed.category) : root;
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf-8"),
				sourcePath,
				notes: ["Use okf://<category>/<topic>.md to read or write a concept."],
			};
		}

		// `okf://<category>/<topic>.md` — read one concept.
		return readConcept(url, root, parsed.relativePath);
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const { root, parsed } = resolveOkfUrl(url, context);
		if (!parsed.relativePath) {
			throw new Error("okf:// write requires a concept path: okf://<category>/<topic>.md");
		}
		const id = normalizeConceptId(parsed.relativePath);
		if (!id) {
			throw new Error(`Invalid OKF concept path: ${parsed.relativePath}`);
		}
		await writeConcept(root, id, content);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// URL parsing
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedOkfUrl {
	category?: string;
	relativePath?: string;
}

function resolveOkfUrl(
	url: InternalUrl,
	context?: ResolveContext | WriteContext,
): { root: string; parsed: ParsedOkfUrl } {
	const cwd = context?.cwd;
	if (!cwd) throw new Error("okf:// requires a session cwd");
	// Honor okf.bundleDir when available in the context settings.
	const settings = (context as ResolveContext & { settings?: Settings })?.settings;
	const bundleDir = settings ? (settings.get("okf.bundleDir") as string | undefined) : undefined;
	const root = resolveBundleRoot(cwd, bundleDir);
	const parsed = parseOkfUrlPath(url);
	// Path-traversal safety: validate the category segment.
	if (parsed.category && (parsed.category.includes("..") || parsed.category.includes("\0"))) {
		throw new Error(`okf:// category must not contain path traversal: ${url.href}`);
	}
	return { root, parsed };
}

function parseOkfUrlPath(url: InternalUrl): ParsedOkfUrl {
	const rawCategory = url.rawHost || url.hostname;
	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/" && rawPathname !== "";

	// `okf://` — no category, no path.
	if (!rawCategory) {
		if (!hasPath) return {};
		const relativePath = decodeURIComponent(rawPathname!.slice(1));
		const id = normalizeConceptId(relativePath);
		if (!id) throw new Error(`Invalid OKF concept path: ${relativePath}`);
		return { category: id.split("/")[0], relativePath: `${id}.md` };
	}

	const category = decodeURIComponent(rawCategory);

	// `okf://<category>` — no path.
	if (!hasPath) return { category };

	// `okf://<category>/<topic>.md`
	const topicPath = decodeURIComponent(rawPathname!.slice(1));
	const relativePath = `${category}/${topicPath}`;
	const id = normalizeConceptId(relativePath);
	if (!id) throw new Error(`Invalid OKF concept path: ${relativePath}`);
	return { category, relativePath: `${id}.md` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

async function readConcept(url: InternalUrl, root: string, relativePath: string): Promise<InternalResource> {
	const id = normalizeConceptId(relativePath);
	if (!id) throw new Error(`Invalid OKF concept path: ${relativePath}`);

	const filePath = path.resolve(root, conceptIdToPath(id));

	// Path-traversal safety: verify via realpath.
	let realRoot: string;
	try {
		realRoot = await fs.realpath(root);
	} catch {
		throw new Error(`OKF bundle not found: ${url.href}`);
	}

	const resolvedPath = path.resolve(filePath);
	ensureWithinRoot(resolvedPath, realRoot);

	try {
		const realTarget = await fs.realpath(resolvedPath);
		ensureWithinRoot(realTarget, realRoot);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			throw new Error(`OKF concept not found: ${url.href}`);
		}
		throw error;
	}

	const stat = await fs.stat(resolvedPath);
	if (!stat.isFile()) throw new Error(`okf:// URL must resolve to a file: ${url.href}`);

	const content = await Bun.file(resolvedPath).text();
	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: resolvedPath,
		notes: ["Use write okf://<category>/<topic>.md to update this concept."],
	};
}

/** Minimal error-code check (avoids importing pi-utils native addon). */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
