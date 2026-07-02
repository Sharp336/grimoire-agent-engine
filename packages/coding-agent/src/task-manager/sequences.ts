/**
 * Sequence counter for Task Manager entity IDs.
 *
 * Each entity type has its own monotonic counter persisted to
 * `.omp/tasks/sequences.json`. IDs are `${prefix}-${n}` (e.g. `task-1`).
 */

import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "../config/file-lock";
import type { TaskConfig } from "./types";

interface SequenceMap {
	task: number;
	decision: number;
	document: number;
	milestone: number;
}

const EMPTY: SequenceMap = { task: 0, decision: 0, document: 0, milestone: 0 };

export class Sequences {
	#config: TaskConfig;
	#rootDir: string;
	#cache: SequenceMap | null = null;

	constructor(config: TaskConfig, rootDir: string = process.cwd()) {
		this.#config = config;
		this.#rootDir = rootDir;
	}

	get filePath(): string {
		return path.join(this.#rootDir, this.#config.files.sequences);
	}

	async next(entity: keyof SequenceMap): Promise<string> {
		return withFileLock(this.filePath, async () => {
			const seq = await this.#load();
			seq[entity] += 1;
			await this.#save(seq);
			const prefix = this.#config.prefixes[entity];
			return `${prefix}-${seq[entity]}`;
		});
	}

	async peek(entity: keyof SequenceMap): Promise<number> {
		const seq = await this.#load();
		return seq[entity];
	}

	async #load(): Promise<SequenceMap> {
		// Always re-read from disk — the cache is only a write buffer,
		// never a read short-circuit. A separate process may have
		// advanced the counter between our lock and our read.
		try {
			const text = await Bun.file(this.filePath).text();
			const parsed = JSON.parse(text) as Partial<SequenceMap>;
			this.#cache = { ...EMPTY, ...parsed };
		} catch (err) {
			if (isEnoent(err)) {
				this.#cache = { ...EMPTY };
			} else {
				throw err;
			}
		}
		return { ...this.#cache };
	}

	async #save(seq: SequenceMap): Promise<void> {
		this.#cache = { ...seq };
		await Bun.write(this.filePath, JSON.stringify(seq, null, 2));
	}
}
