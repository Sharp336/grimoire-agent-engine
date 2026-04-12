/**
 * Flow store — project-local persistence for the live flow definition.
 *
 * The live flow lives at `<cwd>/.omp/flow.json`. On first use, if the
 * file does not exist, the store writes a copy of the bundled base flow
 * and returns it. Users can hand-edit the file between runs; the model
 * edits it at runtime via `flow_edit`.
 *
 * The seed is imported statically from `./flows/base-flow.json` (NOT
 * read via fs) so the compiled `bun build --compile` binary inlines it
 * at build time.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import baseFlow from "./flows/base-flow.json" with { type: "json" };
import type { Flow as FlowV2 } from "./flow-types";

export const BUNDLED_BASE_FLOW: FlowV2 = baseFlow as FlowV2;

export class FlowStore {
	#path: string;
	#fallback: FlowV2;

	constructor(options?: { path?: string; fallback?: FlowV2; cwd?: string }) {
		const cwd = options?.cwd ?? process.cwd();
		this.#path = options?.path ?? join(cwd, ".omp", "flow.json");
		this.#fallback = options?.fallback ?? cloneFlow(BUNDLED_BASE_FLOW);
	}

	get path(): string {
		return this.#path;
	}

	load(): FlowV2 {
		let raw: string;
		try {
			raw = readFileSync(this.#path, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			this.save(this.#fallback);
			return this.#fallback;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			throw new Error(
				`FlowStore: failed to parse ${this.#path} as JSON — ${(e as Error).message}. Fix or delete the file to reseed from the bundled base flow.`,
			);
		}
		if (
			parsed &&
			typeof parsed === "object" &&
			(parsed as FlowV2).version === 1 &&
			(parsed as FlowV2).nodes &&
			typeof (parsed as FlowV2).nodes === "object"
		) {
			const flow = parsed as FlowV2;
			if (!Array.isArray(flow.edges)) flow.edges = [];
			return flow;
		}
		throw new Error(
			`FlowStore: ${this.#path} is not a valid flow (expected { version: 1, nodes: {...} }). Delete the file to reseed.`,
		);
	}

	save(flow: FlowV2): void {
		try {
			mkdirSync(join(this.#path, ".."), { recursive: true });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		writeFileSync(this.#path, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
	}
}

function cloneFlow(flow: FlowV2): FlowV2 {
	return JSON.parse(JSON.stringify(flow)) as FlowV2;
}
