import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger } from "@oh-my-pi/pi-utils";

const cleanup: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanup.push(dir);
	return dir;
}

function legacySessionDir(sessionsRoot: string, cwd: string): string {
	const name = `--${path
		.resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
	return path.join(sessionsRoot, name);
}

function hashedSessionDir(sessionsRoot: string, cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	const digest = Bun.SHA256.hash(resolvedCwd.replaceAll("\\", "/"), "hex");
	return path.join(sessionsRoot, `tmp-${path.basename(resolvedCwd)}-${digest}`);
}

function relativeLegacySessionDir(sessionsRoot: string, cwd: string): string {
	const relative = path.relative(os.tmpdir(), path.resolve(cwd)).replace(/[/\\:]/g, "-");
	return path.join(sessionsRoot, `-tmp-${relative}`);
}

function sessionHeader(cwd: string, id: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("legacy session directory migration", () => {
	test("recognizes a hashed bucket created before the legacy-name rollback", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const hashedDir = hashedSessionDir(sessionsRoot, cwd);
		fs.mkdirSync(hashedDir, { recursive: true });
		fs.writeFileSync(path.join(hashedDir, "existing.jsonl"), "hashed session\n");

		expect(computeDefaultSessionDir(cwd, storage, sessionsRoot)).toBe(hashedDir);
		expect(fs.readFileSync(path.join(hashedDir, "existing.jsonl"), "utf8")).toBe("hashed session\n");
		expect(fs.realpathSync(relativeLegacySessionDir(sessionsRoot, cwd))).toBe(fs.realpathSync(hashedDir));
	});

	test("moves an unambiguous legacy bucket to hashed storage and leaves a compatible alias", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const hashedDir = hashedSessionDir(sessionsRoot, cwd);
		const legacyDir = relativeLegacySessionDir(sessionsRoot, cwd);
		fs.mkdirSync(legacyDir, { recursive: true });
		const contents = sessionHeader(cwd, "existing");
		const sessionFile = path.join(legacyDir, "existing.jsonl");
		const artifactFile = path.join(legacyDir, "existing", "blobs", "payload");
		fs.writeFileSync(sessionFile, contents);
		fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
		fs.writeFileSync(artifactFile, "artifact bytes");
		const descriptor = fs.openSync(sessionFile, "a");

		expect(computeDefaultSessionDir(cwd, storage, sessionsRoot)).toBe(hashedDir);
		fs.writeSync(descriptor, "after migration\n");
		fs.closeSync(descriptor);
		expect(fs.readFileSync(path.join(hashedDir, "existing.jsonl"), "utf8")).toBe(`${contents}after migration\n`);
		expect(fs.readFileSync(path.join(hashedDir, "existing", "blobs", "payload"), "utf8")).toBe("artifact bytes");
		expect(fs.realpathSync(legacyDir)).toBe(fs.realpathSync(hashedDir));
		expect(computeDefaultSessionDir(cwd, storage, sessionsRoot)).toBe(hashedDir);
		expect(fs.realpathSync(legacyDir)).toBe(fs.realpathSync(hashedDir));
	});

	test("keeps a colliding live legacy session reachable through its path", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const source = path.join(legacyDir, "active.jsonl");
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.rmSync(legacyDir);
		fs.mkdirSync(legacyDir, { recursive: true });
		const sourceContents = sessionHeader(cwd, "live");
		const destinationContents = sessionHeader(cwd, "stale");
		fs.writeFileSync(source, sourceContents);
		fs.writeFileSync(destination, destinationContents);
		const fd = fs.openSync(source, "a");

		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		computeDefaultSessionDir(cwd, storage, sessionsRoot);
		fs.writeSync(fd, "live-after\n");
		fs.closeSync(fd);

		expect(fs.readFileSync(source, "utf8")).toBe(`${sourceContents}live-after\n`);
		expect(fs.readFileSync(destination, "utf8")).toBe(destinationContents);
		expect(warning).toHaveBeenCalledWith("Session directory migration collision; preserving legacy entry", {
			source,
			target: destination,
		});
	});

	test("preserves writes when an older process recreates its cached legacy directory", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const destination = path.join(canonicalDir, "active.jsonl");
		const canonicalContents = sessionHeader(cwd, "canonical");
		fs.writeFileSync(destination, canonicalContents);

		fs.rmSync(legacyDir);
		fs.mkdirSync(legacyDir, { recursive: true });
		const recreated = path.join(legacyDir, "active.jsonl");
		const recreatedContents = sessionHeader(cwd, "recreated");
		fs.writeFileSync(recreated, recreatedContents);
		computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(fs.readFileSync(recreated, "utf8")).toBe(recreatedContents);
		expect(fs.readFileSync(destination, "utf8")).toBe(canonicalContents);
	});

	test("logs migration failures and leaves the legacy directory reachable", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = hashedSessionDir(sessionsRoot, cwd);
		const legacyDir = relativeLegacySessionDir(sessionsRoot, cwd);
		const legacyFile = path.join(legacyDir, "active.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		const contents = sessionHeader(cwd, "legacy");
		fs.writeFileSync(legacyFile, contents);
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw new Error("blocked");
		});

		expect(computeDefaultSessionDir(cwd, storage, sessionsRoot)).toBe(canonicalDir);
		expect(fs.readFileSync(legacyFile, "utf8")).toBe(contents);
		expect(warning).toHaveBeenCalledWith("Failed to migrate legacy session directory", {
			legacyDir,
			canonicalDir,
			error: "Error: blocked",
		});
	});
});
