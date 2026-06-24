/**
 * Valut — local secret reference system for in-chat credential safety.
 *
 * When a user wraps sensitive text with ``?/`` ... ``/?`` in a chat
 * message, the enclosed value is extracted and replaced with an opaque
 * reference like ``[VLT:a1b2c3d4]``.  The agent and the LLM never see
 * the plaintext.
 *
 * On output, ``[VLT:<id>]`` references are substituted back to the
 * original value before the user sees them, so the agent can reference
 * a secret by its ID without ever knowing the actual value.
 *
 * Storage: ``~/.omp/valut.json`` (0600 on POSIX).  The file is a flat
 * JSON object mapping reference IDs to secret values.
 *
 * @module agent/valut
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── regex ────────────────────────────────────────────────────────────

/** Matches ``?/`` opener, any content (non-greedy), ``/?`` closer. */
const TRIGGER_RE = /\?\/(.+?)\/\?/g;

/** Matches ``[VLT:<id>]`` where <id> is ``vlt_`` + 8 hex chars. */
const REF_RE = /\[VLT:(vlt_[0-9a-fA-F]{8})\]/g;

// ── storage path ─────────────────────────────────────────────────────

function valutPath(): string {
	const base = process.env.OMP_HOME ?? path.join(os.homedir(), ".omp");
	const dir = fs.existsSync(base) ? base : path.join(os.homedir(), ".omp");
	return path.join(dir, "valut.json");
}

// ── storage I/O ──────────────────────────────────────────────────────

interface ValutEntries {
	[id: string]: string;
}

function loadEntries(): ValutEntries {
	try {
		const p = valutPath();
		if (!fs.existsSync(p)) return {};
		const raw = fs.readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			const clean: ValutEntries = {};
			for (const [k, v] of Object.entries(parsed)) {
				if (typeof k === "string" && typeof v === "string") clean[k] = v;
			}
			return clean;
		}
	} catch {
		/* corrupt or missing — start fresh */
	}
	return {};
}

function saveEntries(entries: ValutEntries): void {
	try {
		const p = valutPath();
		const dir = path.dirname(p);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const tmp = p + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
		try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
		fs.renameSync(tmp, p);
		try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
	} catch {
		/* disk full or permissions — silently degrade */
	}
}

// ── id generation ────────────────────────────────────────────────────

function generateId(existing: ValutEntries): string {
	let id: string;
	do {
		const bytes = crypto.getRandomValues(new Uint8Array(4));
		id = "vlt_";
		for (const b of bytes) {
			id += (b >> 4).toString(16);
			id += (b & 0x0f).toString(16);
		}
	} while (id in existing);
	return id;
}

// ── public API ───────────────────────────────────────────────────────

/**
 * Scan *text* for ``?/.../?`` patterns, vault the secrets,
 * and return cleaned text with ``[VLT:id]`` references.
 *
 * The returned text contains no plaintext secrets — only opaque
 * references that the agent and LLM can safely pass around.
 */
export function sanitizeInput(text: string): string {
	if (!text.includes("?/")) return text;

	const store = loadEntries();

	const result = text.replace(TRIGGER_RE, (fullMatch: string, secret: string): string => {
		if (!secret.trim()) return fullMatch;

		for (const [id, val] of Object.entries(store)) {
			if (val === secret) return `[VLT:${id}]`;
		}

		const id = generateId(store);
		store[id] = secret;
		return `[VLT:${id}]`;
	});

	if (result !== text) saveEntries(store);
	return result;
}

/**
 * Replace ``[VLT:<id>]`` references in *text* with their stored
 * values.  Unresolved references pass through unchanged.
 */
export function restoreOutput(text: string): string {
	if (!text.includes("[VLT:")) return text;

	const store = loadEntries();
	if (Object.keys(store).length === 0) return text;

	return text.replace(REF_RE, (fullMatch: string, id: string): string => {
		const resolved = store[id];
		return resolved !== undefined ? resolved : fullMatch;
	});
}

// ── admin ────────────────────────────────────────────────────────────

/** List all stored reference IDs. */
export function listIds(): string[] {
	return Object.keys(loadEntries()).sort();
}

/** Remove a stored secret. */
export function removeId(id: string): boolean {
	const entries = loadEntries();
	if (id in entries) {
		delete entries[id];
		saveEntries(entries);
		return true;
	}
	return false;
}
