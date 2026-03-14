import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir } from "@oh-my-pi/pi-utils";
import { env } from "bun";

interface MigrationItem {
	source: string;
	target: string;
	type: "file" | "directory";
	category: "data" | "state" | "cache";
}

interface MigrationOptions {
	dryRun?: boolean;
	force?: boolean;
}

interface MigrationResult {
	success: boolean;
	migratedItems: number;
	errors: string[];
}

const APP_NAME = "omp";

function getXdgDataHome(): string {
	return env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
}

function getXdgStateHome(): string {
	return env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state");
}

function getXdgCacheHome(): string {
	return env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
}

async function buildMigrationPlan(): Promise<MigrationItem[]> {
	const agentDir = getAgentDir();
	const xdgDataHome = getXdgDataHome();
	const xdgStateHome = getXdgStateHome();
	const xdgCacheHome = getXdgCacheHome();

	const items: MigrationItem[] = [
		{
			source: path.join(agentDir, "agent.db"),
			target: path.join(xdgDataHome, APP_NAME, "agent.db"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(agentDir, "agent.db-shm"),
			target: path.join(xdgDataHome, APP_NAME, "agent.db-shm"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(agentDir, "agent.db-wal"),
			target: path.join(xdgDataHome, APP_NAME, "agent.db-wal"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(agentDir, "history.db"),
			target: path.join(xdgDataHome, APP_NAME, "history.db"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(agentDir, "history.db-shm"),
			target: path.join(xdgDataHome, APP_NAME, "history.db-shm"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(agentDir, "history.db-wal"),
			target: path.join(xdgDataHome, APP_NAME, "history.db-wal"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(agentDir, "models.db"),
			target: path.join(xdgDataHome, APP_NAME, "models.db"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(agentDir, "models.db-shm"),
			target: path.join(xdgDataHome, APP_NAME, "models.db-shm"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(agentDir, "models.db-wal"),
			target: path.join(xdgDataHome, APP_NAME, "models.db-wal"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(agentDir, "sessions"),
			target: path.join(xdgDataHome, APP_NAME, "sessions"),
			type: "directory",
			category: "data",
		},
		{
			source: path.join(agentDir, "blobs"),
			target: path.join(xdgDataHome, APP_NAME, "blobs"),
			type: "directory",
			category: "data",
		},
		{
			source: path.join(agentDir, "memories"),
			target: path.join(xdgStateHome, APP_NAME, "memories"),
			type: "directory",
			category: "state",
		},
		{
			source: path.join(agentDir, "terminal-sessions"),
			target: path.join(xdgStateHome, APP_NAME, "terminal-sessions"),
			type: "directory",
			category: "state",
		},
		{
			source: path.join(getConfigRootDir(), "stats.db"),
			target: path.join(xdgDataHome, APP_NAME, "stats.db"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(getConfigRootDir(), "stats.db-shm"),
			target: path.join(xdgDataHome, APP_NAME, "stats.db-shm"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(getConfigRootDir(), "stats.db-wal"),
			target: path.join(xdgDataHome, APP_NAME, "stats.db-wal"),
			type: "file",
			category: "data",
		},
		{
			source: path.join(getConfigRootDir(), "logs"),
			target: path.join(xdgStateHome, APP_NAME, "logs"),
			type: "directory",
			category: "state",
		},
		{
			source: path.join(getConfigRootDir(), "reports"),
			target: path.join(xdgStateHome, APP_NAME, "reports"),
			type: "directory",
			category: "state",
		},
		{
			source: path.join(getConfigRootDir(), "plugins"),
			target: path.join(xdgDataHome, APP_NAME, "plugins"),
			type: "directory",
			category: "data",
		},
		{
			source: path.join(getConfigRootDir(), "remote"),
			target: path.join(xdgDataHome, APP_NAME, "remote"),
			type: "directory",
			category: "data",
		},
		{
			source: path.join(getConfigRootDir(), "ssh-control"),
			target: path.join(xdgStateHome, APP_NAME, "ssh-control"),
			type: "directory",
			category: "state",
		},
		{
			source: path.join(getConfigRootDir(), "remote-host"),
			target: path.join(xdgDataHome, APP_NAME, "remote-host"),
			type: "directory",
			category: "data",
		},
		{
			source: path.join(getConfigRootDir(), "python-env"),
			target: path.join(xdgDataHome, APP_NAME, "python-env"),
			type: "directory",
			category: "data",
		},
		{
			source: path.join(getConfigRootDir(), "puppeteer"),
			target: path.join(xdgCacheHome, APP_NAME, "puppeteer"),
			type: "directory",
			category: "cache",
		},
		{
			source: path.join(getConfigRootDir(), "wt"),
			target: path.join(xdgDataHome, APP_NAME, "wt"),
			type: "directory",
			category: "data",
		},
		{
			source: path.join(getConfigRootDir(), "gpu_cache.json"),
			target: path.join(xdgCacheHome, APP_NAME, "gpu_cache.json"),
			type: "file",
			category: "cache",
		},
		{
			source: path.join(getConfigRootDir(), "natives"),
			target: path.join(xdgCacheHome, APP_NAME, "natives"),
			type: "directory",
			category: "cache",
		},
		{
			source: path.join(agentDir, "omp-crash.log"),
			target: path.join(xdgStateHome, APP_NAME, "omp-crash.log"),
			type: "file",
			category: "state",
		},
		{
			source: path.join(agentDir, "omp-debug.log"),
			target: path.join(xdgStateHome, APP_NAME, "omp-debug.log"),
			type: "file",
			category: "state",
		},
	];

	const existingItems: MigrationItem[] = [];
	for (const item of items) {
		try {
			await fs.access(item.source);
			existingItems.push(item);
		} catch {}
	}

	return existingItems;
}

async function getSize(itemPath: string, type: "file" | "directory"): Promise<number> {
	if (type === "file") {
		const stat = await fs.stat(itemPath);
		return stat.size;
	}

	let totalSize = 0;
	const entries = await fs.readdir(itemPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(itemPath, entry.name);
		if (entry.isDirectory()) {
			totalSize += await getSize(fullPath, "directory");
		} else {
			const stat = await fs.stat(fullPath);
			totalSize += stat.size;
		}
	}
	return totalSize;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

async function previewMigration(items: MigrationItem[]): Promise<void> {
	console.log("Preview: Migration plan");
	console.log("━".repeat(80));
	console.log(`${"Source".padEnd(40)} → ${"Target".padEnd(40)} ${"Size".padStart(8)}`);
	console.log("━".repeat(80));

	let totalSize = 0;
	for (const item of items) {
		const size = await getSize(item.source, item.type);
		totalSize += size;
		const home = os.homedir();
		const sourcePath = item.source.replace(home, "~");
		const targetPath = item.target.replace(home, "~");
		console.log(`${sourcePath.padEnd(40)} → ${targetPath.padEnd(40)} ${formatSize(size).padStart(8)}`);
	}

	console.log("━".repeat(80));
	console.log(`Total: ${items.length} items, ~${formatSize(totalSize)}`);
	console.log("\nRun without --dry-run to execute migration.");
}

async function calculateChecksum(filePath: string): Promise<string> {
	const content = await fs.readFile(filePath);
	return crypto.createHash("sha256").update(content).digest("hex");
}

async function copyDirectory(source: string, target: string, force: boolean): Promise<string[]> {
	await fs.mkdir(target, { recursive: true });
	const entries = await fs.readdir(source, { withFileTypes: true });
	const skipped: string[] = [];

	for (const entry of entries) {
		const sourcePath = path.join(source, entry.name);
		const targetPath = path.join(target, entry.name);

		if (entry.isDirectory()) {
			const childSkipped = await copyDirectory(sourcePath, targetPath, force);
			skipped.push(...childSkipped);
		} else {
			const exists = await fs.access(targetPath).then(
				() => true,
				() => false,
			);
			if (!exists || force) {
				await fs.copyFile(sourcePath, targetPath);
			} else {
				skipped.push(sourcePath);
			}
		}
	}
	return skipped;
}

async function verifyIntegrity(
	source: string,
	target: string,
	type: "file" | "directory",
	force: boolean,
): Promise<boolean> {
	if (type === "file") {
		const sourceStat = await fs.stat(source);
		const targetStat = await fs.stat(target);

		if (sourceStat.size !== targetStat.size) {
			return false;
		}

		const sourceChecksum = await calculateChecksum(source);
		const targetChecksum = await calculateChecksum(target);
		return sourceChecksum === targetChecksum;
	}

	// Only verify that every entry from source landed in target.
	// Target may contain pre-existing entries from a partial prior migration.
	const sourceEntries = await fs.readdir(source, { withFileTypes: true });

	for (const entry of sourceEntries) {
		const sourcePath = path.join(source, entry.name);
		const targetPath = path.join(target, entry.name);

		try {
			await fs.access(targetPath);
		} catch {
			return false;
		}

		if (entry.isDirectory()) {
			const dirValid = await verifyIntegrity(sourcePath, targetPath, "directory", force);
			if (!dirValid) return false;
		} else {
			const fileValid = await verifyIntegrity(sourcePath, targetPath, "file", force);
			if (!fileValid) return false;
		}
	}

	return true;
}

async function checkPrerequisites(
	items: MigrationItem[],
	force: boolean,
): Promise<{ valid: boolean; errors: string[] }> {
	const errors: string[] = [];

	for (const item of items) {
		if (item.type !== "file") {
			// Directory conflicts are handled per-entry by copyDirectory (skipping existing
			// files in non-force mode). Migration is resumable — no hard error here.
			continue;
		}
		// File: block only if the target already exists and force is not set.
		const exists = await fs.access(item.target).then(
			() => true,
			() => false,
		);
		if (exists && !force) {
			errors.push(`Target already exists: ${item.target}\nUse --force to overwrite existing files.`);
		}
	}

	return { valid: errors.length === 0, errors };
}

async function executeMigration(items: MigrationItem[], force: boolean): Promise<MigrationResult> {
	const errors: string[] = [];
	let migratedItems = 0;

	const prereqCheck = await checkPrerequisites(items, force);
	if (!prereqCheck.valid) {
		return { success: false, migratedItems: 0, errors: prereqCheck.errors };
	}

	console.log("Migrating to XDG Base Directory locations...\n");

	for (const item of items) {
		try {
			const size = await getSize(item.source, item.type);
			const targetDir = path.dirname(item.target);
			await fs.mkdir(targetDir, { recursive: true });

			let skippedPaths: string[] = [];
			if (item.type === "file") {
				await fs.copyFile(item.source, item.target);
			} else {
				skippedPaths = await copyDirectory(item.source, item.target, force);
			}

			const valid = await verifyIntegrity(item.source, item.target, item.type, force);
			if (!valid) {
				// Move the target aside rather than deleting it: the target may
				// contain pre-existing user data that was never written by this
				// run. Renaming to .bak keeps it recoverable while preventing
				// getXdgDataPath from treating the partial tree as authoritative.
				const bak = `${item.target}.bak`;
				await fs.rename(item.target, bak).catch(() => {});
				errors.push(`Integrity verification failed for ${item.source}; partial target moved to ${bak}`);
				continue;
			}

			if (item.type === "file") {
				await fs.rm(item.source, { recursive: true, force: true });
			} else {
				// Remove only entries that were fully copied; leave skipped source files in place
				const skippedSet = new Set(skippedPaths);
				const entries = await fs.readdir(item.source, { withFileTypes: true });
				for (const entry of entries) {
					const entryPath = path.join(item.source, entry.name);
					if (!skippedSet.has(entryPath)) {
						await fs.rm(entryPath, { recursive: true, force: true });
					}
				}
				// Remove source dir if now empty
				await fs.rmdir(item.source).catch(() => {});
			}

			const home = os.homedir();
			const _sourcePath = item.source.replace(home, "~");
			const targetPath = item.target.replace(home, "~");
			console.log(`✓ ${path.basename(item.source).padEnd(20)} ${formatSize(size).padStart(6)} → ${targetPath}`);
			migratedItems++;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`Failed to migrate ${item.source}: ${message}`);
		}
	}

	if (errors.length === 0) {
		const home = os.homedir();
		const agentDir = getAgentDir();
		const configRoot = getConfigRootDir();
		console.log("\nMigration completed successfully!");
		console.log(`Old locations cleaned up: ${agentDir.replace(home, "~")} and ${configRoot.replace(home, "~")}`);
	}

	return { success: errors.length === 0, migratedItems, errors };
}

export async function migrateToXdg(options: MigrationOptions): Promise<void> {
	try {
		const activeAgentDir = getAgentDir();
		const defaultAgentDir = path.join(getConfigRootDir(), "agent");
		if (activeAgentDir !== defaultAgentDir) {
			throw new Error(
				`omp config migrate only operates on the default profile.\n` +
					`Active agent directory: ${activeAgentDir}\n` +
					`Unset PI_CODING_AGENT_DIR before running migration.`,
			);
		}
		const items = await buildMigrationPlan();

		if (items.length === 0) {
			console.log("No data to migrate. All files are already in the correct location or don't exist.");
			return;
		}

		if (options.dryRun) {
			await previewMigration(items);
			return;
		}

		const result = await executeMigration(items, options.force ?? false);

		if (!result.success) {
			console.error("\nMigration failed with errors:");
			for (const error of result.errors) {
				console.error(`  ${error}`);
			}
			process.exit(1);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Migration error: ${message}`);
		process.exit(1);
	}
}
