/**
 * File system operations for Task Manager.
 *
 * Replaces `proper-lockfile` with omp's `withFileLock` from `config/file-lock.ts`.
 * Keeps the `CreateLockError` pattern — wraps `withFileLock` failures into
 * the same error code `ECREATELOCK`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "../config/file-lock";
import { DEFAULT_FILES, ENTITY_EXTENSION } from "./constants";
import type { TaskConfig } from "./types";

export class CreateLockError extends Error {
	code = "ECREATELOCK" as const;
	constructor(
		message: string,
		public readonly path: string,
	) {
		super(message);
		this.name = "CreateLockError";
	}
}

export class FileSystem {
	#config: TaskConfig | null = null;
	#rootDir: string;

	constructor(rootDir: string = process.cwd()) {
		this.#rootDir = rootDir;
	}

	setConfig(config: TaskConfig): void {
		this.#config = config;
	}

	get config(): TaskConfig {
		if (!this.#config) throw new Error("Task Manager config not loaded");
		return this.#config;
	}

	get rootDir(): string {
		return this.#rootDir;
	}

	dirFor(type: "tasks" | "decisions" | "documents" | "milestones" | "archive"): string {
		return path.join(this.#rootDir, this.config.directories[type]);
	}

	filePathFor(type: "tasks" | "decisions" | "documents" | "milestones", id: string): string {
		return path.join(this.dirFor(type), `${id}${ENTITY_EXTENSION}`);
	}

	archivePathFor(type: "tasks" | "decisions" | "documents" | "milestones", id: string): string {
		return path.join(this.dirFor("archive"), type, `${id}${ENTITY_EXTENSION}`);
	}

	configPath(): string {
		return path.join(this.#rootDir, this.#config?.files.config ?? DEFAULT_FILES.config);
	}

	async ensureDirs(): Promise<void> {
		const dirs = [
			this.dirFor("tasks"),
			this.dirFor("decisions"),
			this.dirFor("documents"),
			this.dirFor("milestones"),
			this.dirFor("archive"),
			path.join(this.dirFor("archive"), "tasks"),
			path.join(this.dirFor("archive"), "decisions"),
			path.join(this.dirFor("archive"), "documents"),
			path.join(this.dirFor("archive"), "milestones"),
		];
		await Promise.all(dirs.map(d => fs.mkdir(d, { recursive: true })));
	}

	async readEntity(type: "tasks" | "decisions" | "documents" | "milestones", id: string): Promise<string> {
		const filePath = this.filePathFor(type, id);
		try {
			return await Bun.file(filePath).text();
		} catch (err) {
			if (isEnoent(err)) throw new Error(`Task not found: ${id}`);
			throw err;
		}
	}

	async writeEntity(
		type: "tasks" | "decisions" | "documents" | "milestones",
		id: string,
		content: string,
	): Promise<void> {
		const filePath = this.filePathFor(type, id);
		await this.#writeWithLock(filePath, content);
	}

	async deleteEntity(type: "tasks" | "decisions" | "documents" | "milestones", id: string): Promise<void> {
		const filePath = this.filePathFor(type, id);
		try {
			await fs.unlink(filePath);
		} catch (err) {
			if (isEnoent(err)) throw new Error(`Task not found: ${id}`);
			throw err;
		}
	}

	async archiveEntity(type: "tasks" | "decisions" | "documents" | "milestones", id: string): Promise<void> {
		const srcPath = this.filePathFor(type, id);
		const destPath = this.archivePathFor(type, id);
		try {
			const content = await Bun.file(srcPath).text();
			await this.#writeWithLock(destPath, content);
			await fs.unlink(srcPath);
		} catch (err) {
			if (isEnoent(err)) throw new Error(`Task not found: ${id}`);
			throw err;
		}
	}

	async listEntityFiles(type: "tasks" | "decisions" | "documents" | "milestones"): Promise<string[]> {
		const dir = this.dirFor(type);
		try {
			const entries = await fs.readdir(dir);
			return entries.filter(f => f.endsWith(ENTITY_EXTENSION)).map(f => f.slice(0, -ENTITY_EXTENSION.length));
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	}

	async entityExists(type: "tasks" | "decisions" | "documents" | "milestones", id: string): Promise<boolean> {
		try {
			const stat = await fs.stat(this.filePathFor(type, id));
			return stat.isFile();
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	async readConfig(): Promise<string | null> {
		try {
			return await Bun.file(this.configPath()).text();
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	async writeConfig(content: string): Promise<void> {
		await this.#writeWithLock(this.configPath(), content);
	}

	/**
	 * Write a file under a file lock, wrapping lock-acquisition failures into
	 * `CreateLockError` (code `ECREATELOCK`) to match the source contract.
	 */
	async #writeWithLock(filePath: string, content: string): Promise<void> {
		try {
			await withFileLock(filePath, async () => {
				await Bun.write(filePath, content);
			});
		} catch (err) {
			if (err instanceof CreateLockError) throw err;
			throw new CreateLockError(
				`Failed to acquire lock for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
				filePath,
			);
		}
	}
}
