/**
 * Structured activity logger (JSONL) for audit and debugging.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { LogEntry } from "../types";

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 3;

export class ActivityLogger {
	#logPath: string;
	#pending: LogEntry[] = [];
	#flushTimer: NodeJS.Timeout | undefined;

	constructor(cwd: string) {
		this.#logPath = path.join(cwd, ".omp", "self-evolution", "activity.log");
		this.#startFlushTimer();
	}

	async log(event: string, details: Record<string, unknown>): Promise<void> {
		const entry: LogEntry = {
			timestamp: Date.now(),
			event,
			details,
		};
		this.#pending.push(entry);
		if (this.#pending.length >= 50) {
			await this.#flush();
		}
	}

	async query(options: { event?: string; since?: number; limit?: number } = {}): Promise<LogEntry[]> {
		await this.#flush();
		const { event, since, limit = 100 } = options;
		const result: LogEntry[] = [];

		try {
			const text = await Bun.file(this.#logPath).text();
			const lines = text.split("\n").filter(Boolean);
			for (let i = lines.length - 1; i >= 0 && result.length < limit; i--) {
				try {
					const entry = JSON.parse(lines[i]!) as LogEntry;
					if (event && entry.event !== event) continue;
					if (since && entry.timestamp < since) continue;
					result.unshift(entry);
				} catch {
					// skip corrupt line
				}
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT") {
				logger.warn("Activity log read failed", { error: String(err) });
			}
		}
		return result;
	}

	async close(): Promise<void> {
		if (this.#flushTimer) {
			clearInterval(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		await this.#flush();
	}

	#startFlushTimer(): void {
		this.#flushTimer = setInterval(() => {
			this.#flush().catch(err => {
				logger.error("Activity log flush failed", { error: String(err) });
			});
		}, 5000);
	}

	async #flush(): Promise<void> {
		if (this.#pending.length === 0) return;
		const entries = this.#pending.splice(0, this.#pending.length);
		const lines = `${entries.map(e => JSON.stringify(e)).join("\n")}\n`;

		try {
			await this.#rotateIfNeeded();
			await fs.appendFile(this.#logPath, lines);
		} catch (err) {
			logger.error("Activity log write failed", { error: String(err) });
		}
	}

	async #rotateIfNeeded(): Promise<void> {
		try {
			const file = Bun.file(this.#logPath);
			const size = file.size;
			if (size < MAX_LOG_SIZE) return;

			for (let i = MAX_LOG_FILES - 2; i >= 0; i--) {
				const src = i === 0 ? this.#logPath : `${this.#logPath}.${i}`;
				const dst = `${this.#logPath}.${i + 1}`;
				try {
					await fs.rename(src, dst);
				} catch {
					// ignore rotation errors for missing files
				}
			}
		} catch {
			// ignore
		}
	}
}
