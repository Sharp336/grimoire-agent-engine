/**
 * Flow trace writer — dumps the raw HTTP payload sent to the provider,
 * one file per request, JSON with indentation. Nothing else.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlowTraceEvent } from "./flow-runtime";

export class FlowTraceWriter {
	#dir: string;
	#sessionId: string;

	constructor(sessionId?: string) {
		this.#sessionId = sanitizeId(sessionId ?? "nosession");
		this.#dir = join(homedir(), ".omp", "traces");
	}

	get path(): string | null {
		return this.#dir;
	}

	startNewTrace(_userPreview: string): string {
		try {
			mkdirSync(this.#dir, { recursive: true });
		} catch {
			// ignore
		}
		return this.#dir;
	}

	write(_event: FlowTraceEvent): void {
		// no-op — only raw HTTP payloads go to disk
	}

	writePayload(payload: unknown): void {
		try {
			mkdirSync(this.#dir, { recursive: true });
		} catch {
			// ignore
		}
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const base = join(this.#dir, `${this.#sessionId}-${ts}`);
		try {
			writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2), "utf8");
		} catch {
			// ignore
		}
		try {
			writeFileSync(`${base}.md`, renderMarkdown(payload), "utf8");
		} catch {
			// ignore
		}
	}

	close(): void {
		// nothing to flush
	}
}

function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

// ──────────────────────────────────────────────────────────────────────────
// Markdown render — best-effort unwrap of common provider payload shapes.
// ──────────────────────────────────────────────────────────────────────────

function renderMarkdown(payload: unknown): string {
	const out: string[] = [];
	out.push(`# LLM request — ${new Date().toISOString()}`);
	out.push("");
	const obj = payload as Record<string, unknown>;
	const toolsField = obj.tools;
	if (Array.isArray(toolsField) && toolsField.length > 0) {
		const names = toolsField
			.map(t => {
				const tool = t as Record<string, unknown>;
				const fn = tool.function as Record<string, unknown> | undefined;
				return (tool.name as string) ?? (fn?.name as string) ?? "?";
			})
			.filter(Boolean);
		out.push(`## Tools (${names.length})`);
		out.push("");
		out.push(names.map(n => `\`${n}\``).join(", "));
		out.push("");
	}

	const convo = Array.isArray(obj.input) ? obj.input : Array.isArray(obj.messages) ? obj.messages : null;
	if (Array.isArray(convo)) {
		const callIdToName = new Map<string, string>();
		for (const item of convo) {
			const it = item as { type?: string; name?: string; call_id?: string };
			if (it.type === "function_call" && it.call_id && it.name) {
				callIdToName.set(it.call_id, it.name);
			}
		}

		out.push(`## Conversation (${convo.length})`);
		out.push("");
		convo.forEach((item, i) => {
			out.push(`### [${i}] ${describeItem(item, callIdToName)}`);
			out.push("");
			out.push(JSON.stringify(item));
			out.push("\n");
		});
	}

	return out.join("\n");
}

function describeItem(item: unknown, callIdToName?: Map<string, string>): string {
	const it = item as { role?: string; type?: string; name?: string; call_id?: string };
	if (it.type === "function_call") return `function_call \`${it.name ?? "?"}\``;
	if (it.type === "function_call_output") {
		const name = it.name ?? (it.call_id && callIdToName?.get(it.call_id)) ?? "?";
		return `function_call_output \`${name}\``;
	}
	if (it.type && !it.role) return it.type;
	return it.role ?? "?";
}
