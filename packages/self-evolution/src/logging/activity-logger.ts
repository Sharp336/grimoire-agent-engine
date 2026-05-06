/**
 * Structured activity logger (JSONL) for audit and debugging.
 *
 * Uses per-path reference counting so multiple sessions sharing the same
 * global store do not interfere with each other's flush timers.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { LogEntry } from "../types";

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 3;

interface LoggerEntry {
	logger: ActivityLogger;
	refCount: number;
}

const loggerCache = new Map<string, LoggerEntry>();

function resolveLogPath(cwd: string, globalStore?: boolean): string {
	const baseDir = globalStore
		? path.join(os.homedir(), ".omp", "self-evolution")
		: path.join(cwd, ".omp", "self-evolution");
	return path.join(baseDir, "activity.log");
}

export function getActivityLogger(cwd: string, globalStore?: boolean): ActivityLogger {
	const logPath = resolveLogPath(cwd, globalStore);

	const existing = loggerCache.get(logPath);
	if (existing) {
		existing.refCount++;
		return existing.logger;
	}

	const instance = new ActivityLogger(logPath);
	loggerCache.set(logPath, { logger: instance, refCount: 1 });
	return instance;
}

export function closeActivityLogger(cwd?: string, globalStore?: boolean): void {
	const logPath = resolveLogPath(cwd ?? "", globalStore);

	const entry = loggerCache.get(logPath);
	if (!entry) return;

	entry.refCount--;
	if (entry.refCount <= 0) {
		entry.logger.close();
		loggerCache.delete(logPath);
	}
}

export class ActivityLogger {
	#logPath: string;
	#pending: LogEntry[] = [];
	#flushTimer: NodeJS.Timeout | undefined;

	constructor(logPath: string) {
		this.#logPath = logPath;
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
