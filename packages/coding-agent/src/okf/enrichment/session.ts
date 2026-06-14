/**
 * OKF session-extraction enrichment — an LLM pass that runs after a session to
 * extract durable knowledge into the OKF bundle.
 *
 * Reads the preceding conversation + existing concept files, then emits a
 * structured JSON response with upsert/delete operations. Secret-obfuscated.
 *
 * Inspired by the DeprecatedLuke fork's `writeSessionKnowledge()` pattern but
 * rewritten with a cleaner operation-based schema.
 */

import * as path from "node:path";
import { deleteConcept, getBundleRoot, loadSummaries, writeConcept } from "../bundle";

const MAX_EXISTING_CONCEPTS = 80;
const MAX_EXISTING_BYTES = 120_000;

export interface OkfEnrichmentOp {
	op: "upsert" | "delete";
	id: string;
	content?: string;
}

export interface OkfEnrichmentResult {
	upserted: string[];
	deleted: string[];
	skipped: number;
}

/**
 * Parse an LLM extraction response into structured operations.
 * Expects JSON: `{"operations": [{"op": "upsert", "id": "cat/topic", "content": "..."}]}`.
 */
export function parseEnrichmentResponse(text: string): OkfEnrichmentOp[] {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return [];
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as { operations?: unknown };
		if (!Array.isArray(parsed.operations)) return [];
		const ops: OkfEnrichmentOp[] = [];
		for (const item of parsed.operations) {
			if (!item || typeof item !== "object") continue;
			const candidate = item as { op?: unknown; id?: unknown; content?: unknown };
			if (candidate.op !== "upsert" && candidate.op !== "delete") continue;
			if (typeof candidate.id !== "string" || !candidate.id.trim()) continue;
			ops.push({
				op: candidate.op,
				id: candidate.id.trim(),
				content: typeof candidate.content === "string" ? candidate.content : undefined,
			});
		}
		return ops;
	} catch {
		return [];
	}
}

/**
 * Apply enrichment operations to the on-disk bundle.
 */
export async function applyEnrichmentOps(cwd: string, ops: OkfEnrichmentOp[]): Promise<OkfEnrichmentResult> {
	const root = getBundleRoot(cwd);
	const upserted: string[] = [];
	const deleted: string[] = [];
	let skipped = 0;

	for (const op of ops) {
		try {
			if (op.op === "upsert" && op.content) {
				await writeConcept(root, op.id, op.content);
				upserted.push(op.id);
			} else if (op.op === "delete") {
				const ok = await deleteConcept(root, op.id);
				if (ok) deleted.push(op.id);
				else skipped++;
			} else {
				skipped++;
			}
		} catch {
			skipped++;
		}
	}

	return { upserted, deleted, skipped };
}

/**
 * Render existing concept files as context for the enrichment prompt.
 * Caps at MAX_EXISTING_CONCEPTS files and MAX_EXISTING_BYTES total.
 */
export async function renderExistingConcepts(cwd: string): Promise<string> {
	const root = getBundleRoot(cwd);
	const summaries = await loadSummaries(root, { autoUpdate: false });
	const visible = summaries.slice(0, MAX_EXISTING_CONCEPTS);

	const parts: string[] = [];
	let remainingBytes = MAX_EXISTING_BYTES;
	for (const summary of visible) {
		if (remainingBytes <= 0) break;
		const content = await Bun.file(path.join(root, `${summary.id}.md`))
			.text()
			.catch(() => "");
		if (!content) continue;
		const truncated = content.length > remainingBytes ? content.slice(0, remainingBytes) : content;
		remainingBytes -= Buffer.byteLength(truncated, "utf8");
		parts.push(`\n${truncated}\n`);
	}
	return parts.length > 0 ? parts.join("\n\n") : "No existing concept files.";
}
