import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import type { FileEntry, SessionEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { holdFileOpen } from "../helpers/open-file-holder";

const PARENT_ID = "019f6d5f-4aee-7000-a3ab-3b62adc9b302";
const FORK_ID = "01a0017c-4aee-7000-a3ab-3b62adc9b303";
const MISSING_ID = "01dead00-4aee-7000-a3ab-3b62adc9b304";
const OLD_DATE = new Date("2026-01-01T00:00:00.000Z");
const TIMESTAMP = "2026-07-16T23-59-49-486Z";

let root: string;
let stdoutSpy: { mockRestore(): void } | undefined;
let stdout = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-forks-"));
	stdout = "";
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		stdout += String(chunk);
		return true;
	});
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	await fs.rm(root, { recursive: true, force: true });
});

function header(id: string, cwd: string, parentSession?: string): SessionHeader {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-07-16T23:59:49.486Z",
		cwd,
		parentSession,
	};
}

function entry(id: string, parentId: string | null, branch: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: "2026-07-17T00:00:00.000Z",
		customType: "fork-merge-test",
		data: { branch },
	};
}

async function writeSession(
	directory: string,
	filename: string,
	fileHeader: SessionHeader,
	entries: SessionEntry[],
): Promise<string> {
	await fs.mkdir(directory, { recursive: true });
	const file = path.join(directory, filename);
	const titleSlot = serializeTitleSlot({
		title: `Title for ${fileHeader.id}`,
		source: "user",
		updatedAt: "2026-07-17T00:00:00.000Z",
	});
	await Bun.write(file, `${titleSlot}${[fileHeader, ...entries].map(value => JSON.stringify(value)).join("\n")}\n`);
	await fs.utimes(file, OLD_DATE, OLD_DATE);
	return file;
}

function logicalEntries(entries: FileEntry[]): SessionEntry[] {
	return entries.filter((value): value is SessionEntry => value.type !== "session");
}

async function createForkPair(
	agentDir: string,
	parentReference?: (parent: string, sessionsRoot: string) => string,
): Promise<{
	parent: string;
	fork: string;
	forkArtifact: string;
	parentBefore: FileEntry[];
}> {
	const sessionsRoot = getSessionsDir(agentDir);
	const projectDir = path.join(sessionsRoot, "-project");
	const cwd = path.join(root, "project");
	const sharedRoot = entry("shared-root", null, "shared-root");
	const attachment = entry("attachment", "shared-root", "attachment");
	const parent = await writeSession(projectDir, `${TIMESTAMP}_${PARENT_ID}.jsonl`, header(PARENT_ID, cwd), [
		sharedRoot,
		attachment,
		entry("parent-branch", "attachment", "parent"),
	]);
	const fork = await writeSession(
		projectDir,
		`${TIMESTAMP}_${FORK_ID}.jsonl`,
		header(FORK_ID, cwd, parentReference?.(parent, sessionsRoot) ?? PARENT_ID),
		[
			sharedRoot,
			attachment,
			entry("fork-branch", "attachment", "fork"),
			entry("fork-descendant", "fork-branch", "fork-child"),
		],
	);
	const forkArtifact = path.join(fork.slice(0, -".jsonl".length), "attachments", "fork.txt");
	await fs.mkdir(path.dirname(forkArtifact), { recursive: true });
	await Bun.write(forkArtifact, "fork artifact");
	return {
		parent,
		fork,
		forkArtifact,
		parentBefore: await loadEntriesFromFile(parent, new FileSessionStorage()),
	};
}

async function backupFiles(parent: string): Promise<string[]> {
	const glob = new Bun.Glob(`${path.basename(parent)}.*.bak`);
	return Array.fromAsync(glob.scan(path.dirname(parent)), name => path.join(path.dirname(parent), name));
}

describe("omp gc fork-session merge", () => {
	test("dry-run reports a divergent fork without changing it or its parent", async () => {
		const agentDir = path.join(root, "agent");
		const pair = await createForkPair(agentDir);
		const parentBefore = await Bun.file(pair.parent).text();
		const forkBefore = await Bun.file(pair.fork).text();

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(1);
		expect(result.mergeForks?.wouldMerge).toBe(1);
		expect(result.mergeForks?.addedEntries).toBe(2);
		expect(result.mergeForks?.candidates).toEqual([
			{
				parent: pair.parent,
				fork: pair.fork,
				sharedEntries: 2,
				forkOnlyEntries: 2,
				attachmentPoints: 1,
			},
		]);
		expect(await Bun.file(pair.parent).text()).toBe(parentBefore);
		expect(await Bun.file(pair.fork).text()).toBe(forkBefore);
		expect(await Bun.file(pair.forkArtifact).text()).toBe("fork artifact");
		expect(await backupFiles(pair.parent)).toEqual([]);
		expect(stdout).toContain("forks: would graft 2 entries at 1 attachment point from 1 fork into their parents");
	});

	test("discovers and applies an absolute parentSession path", async () => {
		const agentDir = path.join(root, "agent");
		const pair = await createForkPair(agentDir, parent => parent);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true, apply: true } });

		expect(result.mergeForks?.pairs).toBe(1);
		expect(result.mergeForks?.merged).toBe(1);
		expect(result.mergeForks?.candidates[0]?.parent).toBe(pair.parent);
		expect(await Bun.file(pair.fork).exists()).toBe(false);
		expect(
			logicalEntries(await loadEntriesFromFile(pair.parent, new FileSessionStorage())).map(value => value.id),
		).toContain("fork-branch");
		expect(result.mergeForks?.skipped.map(value => value.reason).join("\n")).not.toContain("not found on disk");
	});

	test("discovers and applies a parentSession path relative to the sessions root", async () => {
		const agentDir = path.join(root, "agent");
		const pair = await createForkPair(agentDir, (parent, sessionsRoot) => path.relative(sessionsRoot, parent));

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true, apply: true } });

		expect(result.mergeForks?.pairs).toBe(1);
		expect(result.mergeForks?.merged).toBe(1);
		expect(result.mergeForks?.candidates[0]?.parent).toBe(pair.parent);
		expect(await Bun.file(pair.fork).exists()).toBe(false);
	});

	test("reports a nonexistent parentSession path as not found on disk", async () => {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(getSessionsDir(agentDir), "-project");
		const missingParent = path.join(projectDir, `${TIMESTAMP}_${MISSING_ID}.jsonl`);
		const fork = await writeSession(
			projectDir,
			`${TIMESTAMP}_${FORK_ID}.jsonl`,
			header(FORK_ID, root, missingParent),
			[entry("fork-only", null, "fork")],
		);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(0);
		expect(result.mergeForks?.skipped).toContainEqual({
			path: fork,
			reason: `parent session file ${missingParent} not found on disk`,
		});
	});

	test("reports an existing parentSession file with an invalid lineage header as unreadable", async () => {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(getSessionsDir(agentDir), "-project");
		const invalidParent = path.join(projectDir, `${TIMESTAMP}_${PARENT_ID}.jsonl`);
		await fs.mkdir(projectDir, { recursive: true });
		await Bun.write(invalidParent, "not a session header\n");
		await fs.utimes(invalidParent, OLD_DATE, OLD_DATE);
		const fork = await writeSession(
			projectDir,
			`${TIMESTAMP}_${FORK_ID}.jsonl`,
			header(FORK_ID, root, invalidParent),
			[entry("fork-only", null, "fork")],
		);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(0);
		expect(result.mergeForks?.skipped).toContainEqual({
			path: fork,
			reason: `parent session file ${invalidParent} is unreadable`,
		});
	});

	test("reports an empty parentSession reference as unresolved", async () => {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(getSessionsDir(agentDir), "-project");
		const fork = await writeSession(projectDir, `${TIMESTAMP}_${FORK_ID}.jsonl`, header(FORK_ID, root, ""), [
			entry("fork-only", null, "fork"),
		]);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(0);
		expect(result.mergeForks?.skipped).toContainEqual({
			path: fork,
			reason: 'parent session reference "" could not be resolved',
		});
	});
	test("treats a parentSession path pointing at the fork as a self-reference", async () => {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(getSessionsDir(agentDir), "-project");
		const filename = `${TIMESTAMP}_${FORK_ID}.jsonl`;
		const forkPath = path.join(projectDir, filename);
		const fork = await writeSession(projectDir, filename, header(FORK_ID, root, forkPath), [
			entry("fork-only", null, "fork"),
		]);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(0);
		expect(result.mergeForks?.skipped).toContainEqual({ path: fork, reason: "parentSession self-reference" });
	});

	test("rejects a parentSession path outside the sessions root", async () => {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(getSessionsDir(agentDir), "-project");
		const outside = path.join(root, `${TIMESTAMP}_${PARENT_ID}.jsonl`);
		await writeSession(root, path.basename(outside), header(PARENT_ID, root), [entry("shared", null, "shared")]);
		const fork = await writeSession(projectDir, `${TIMESTAMP}_${FORK_ID}.jsonl`, header(FORK_ID, root, outside), [
			entry("fork-only", null, "fork"),
		]);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(0);
		expect(result.mergeForks?.skipped).toContainEqual({
			path: fork,
			reason: `parent session path ${outside} is outside the sessions root`,
		});
	});

	test("apply grafts at the real attachment, backs up the parent, and archives the fork with artifacts", async () => {
		const agentDir = path.join(root, "agent");
		const pair = await createForkPair(agentDir);
		const forkBefore = await Bun.file(pair.fork).text();
		const forkEntryCount = (await loadEntriesFromFile(pair.fork, new FileSessionStorage())).length;

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true, apply: true } });

		expect(result.mergeForks?.merged).toBe(1);
		expect(result.mergeForks?.archivedForks).toBe(1);
		expect(await Bun.file(pair.fork).exists()).toBe(false);
		expect(await Bun.file(pair.forkArtifact).exists()).toBe(false);
		const archiveRoot = path.join(agentDir, "archive", "sessions");
		const archivedFork = path.join(archiveRoot, path.relative(getSessionsDir(agentDir), pair.fork));
		const archivedArtifact = path.join(archivedFork.slice(0, -".jsonl".length), "attachments", "fork.txt");
		expect(await Bun.file(archivedFork).text()).toBe(forkBefore);
		expect(await loadEntriesFromFile(archivedFork, new FileSessionStorage())).toHaveLength(forkEntryCount);
		expect(await Bun.file(archivedArtifact).text()).toBe("fork artifact");

		const backups = await backupFiles(pair.parent);
		expect(backups).toHaveLength(1);
		expect(await loadEntriesFromFile(backups[0]!, new FileSessionStorage())).toEqual(pair.parentBefore);
		const merged = logicalEntries(await loadEntriesFromFile(pair.parent, new FileSessionStorage()));
		expect(merged.map(value => value.id)).toEqual([
			"shared-root",
			"attachment",
			"fork-branch",
			"fork-descendant",
			"parent-branch",
		]);
		expect(merged.filter(value => value.parentId === "attachment").map(value => value.id)).toEqual([
			"fork-branch",
			"parent-branch",
		]);
		expect(stdout).toContain(
			`forks: grafted 2 entries at 1 attachment point from 1/1 fork into their parents; archived 1 to ${archiveRoot}`,
		);
	});

	test("a second apply finds no candidate after the fork was archived", async () => {
		const agentDir = path.join(root, "agent");
		await createForkPair(agentDir);
		await runGcCommand({ flags: { agentDir, mergeForks: true, apply: true } });

		const second = await runGcCommand({ flags: { agentDir, mergeForks: true, apply: true } });

		expect(second.mergeForks?.pairs).toBe(0);
		expect(second.mergeForks?.wouldMerge).toBe(0);
		expect(second.mergeForks?.candidates).toEqual([]);
		expect(second.mergeForks?.merged).toBe(0);
	});

	test("does not nominate a fork whose entries are all shared", async () => {
		const agentDir = path.join(root, "agent");
		const sessionsRoot = getSessionsDir(agentDir);
		const projectDir = path.join(sessionsRoot, "-project");
		const cwd = path.join(root, "project");
		const shared = entry("shared", null, "shared");
		await writeSession(projectDir, `${TIMESTAMP}_${PARENT_ID}.jsonl`, header(PARENT_ID, cwd), [shared]);
		const fork = await writeSession(projectDir, `${TIMESTAMP}_${FORK_ID}.jsonl`, header(FORK_ID, cwd, PARENT_ID), [
			shared,
		]);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(0);
		expect(result.mergeForks?.candidates).toEqual([]);
		expect(result.mergeForks?.skipped).toContainEqual({ path: fork, reason: "fork contributes no unique entries" });
	});

	test("skips a fork under a backup directory with a reason", async () => {
		const agentDir = path.join(root, "agent");
		const sessionsRoot = getSessionsDir(agentDir);
		const cwd = path.join(root, "project");
		const backupDir = path.join(sessionsRoot, "-project", `${TIMESTAMP}_${PARENT_ID}.jsonl.backup-test`);
		const fork = await writeSession(backupDir, "nested-fork.jsonl", header(FORK_ID, cwd, PARENT_ID), [
			entry("fork-only", null, "fork"),
		]);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(0);
		expect(result.mergeForks?.skipped).toContainEqual({
			path: fork,
			reason: "path is under a session backup directory",
		});
	});

	test("skips a self-referencing parentSession", async () => {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(getSessionsDir(agentDir), "-project");
		const fork = await writeSession(projectDir, `${TIMESTAMP}_${FORK_ID}.jsonl`, header(FORK_ID, root, FORK_ID), [
			entry("fork-only", null, "fork"),
		]);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(0);
		expect(result.mergeForks?.skipped).toContainEqual({ path: fork, reason: "parentSession self-reference" });
	});

	test("skips a fork whose parent file is absent", async () => {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(getSessionsDir(agentDir), "-project");
		const fork = await writeSession(projectDir, `${TIMESTAMP}_${FORK_ID}.jsonl`, header(FORK_ID, root, MISSING_ID), [
			entry("fork-only", null, "fork"),
		]);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true } });

		expect(result.mergeForks?.pairs).toBe(0);
		expect(result.mergeForks?.skipped).toContainEqual({
			path: fork,
			reason: `parent session id ${MISSING_ID} not found among scanned sessions`,
		});
	});

	test("merges a fresh fork when no process holds either file", async () => {
		const agentDir = path.join(root, "agent");
		const pair = await createForkPair(agentDir);
		const now = new Date();
		await fs.utimes(pair.parent, OLD_DATE, OLD_DATE);
		await fs.utimes(pair.fork, now, now);

		const result = await runGcCommand({ flags: { agentDir, mergeForks: true, apply: true } });

		expect(result.mergeForks?.merged).toBe(1);
		expect(result.mergeForks?.skippedActive).toBe(0);
	});

	test("skips and names a fork held open by another process", async () => {
		const agentDir = path.join(root, "agent");
		const pair = await createForkPair(agentDir);
		const holder = await holdFileOpen(pair.fork);
		try {
			const result = await runGcCommand({ flags: { agentDir, mergeForks: true, apply: true } });

			expect(result.mergeForks?.pairs).toBe(0);
			expect(result.mergeForks?.skippedActive).toBe(1);
			const skipped = result.mergeForks?.skipped.find(value => value.path === pair.fork);
			expect(skipped?.reason).toBe("held by a live process");
			expect(skipped?.signals).toContain("open-handle");
			expect(skipped?.holders?.some(value => value.pid === holder.pid)).toBe(true);
			expect(await Bun.file(pair.fork).exists()).toBe(true);
			expect(stdout).toContain(`forks skipped: ${pair.fork} held open by pid ${holder.pid} (`);
		} finally {
			await holder.close();
		}
	});
});
