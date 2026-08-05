import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

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

describe("legacy session directory coexistence", () => {
	test("recognizes a hashed bucket created before the legacy-name rollback", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const hashedDir = hashedSessionDir(sessionsRoot, cwd);
		fs.mkdirSync(hashedDir, { recursive: true });
		fs.writeFileSync(path.join(hashedDir, "existing.jsonl"), "hashed session\n");

		expect(computeDefaultSessionDir(cwd, storage, sessionsRoot)).toBe(hashedDir);
		expect(fs.readFileSync(path.join(hashedDir, "existing.jsonl"), "utf8")).toBe("hashed session\n");
		expect(fs.existsSync(relativeLegacySessionDir(sessionsRoot, cwd))).toBe(false);
	});

	test("does not claim an absent lossy legacy name for one project", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const parent = makeTempDir("omp-session-collision-");
		const firstCwd = path.join(parent, "project", "hail-mary");
		const secondCwd = path.join(parent, "project-hail", "mary");
		fs.mkdirSync(firstCwd, { recursive: true });
		fs.mkdirSync(secondCwd, { recursive: true });
		const storage = new FileSessionStorage();
		const sharedLegacyDir = relativeLegacySessionDir(sessionsRoot, firstCwd);
		expect(sharedLegacyDir).toBe(relativeLegacySessionDir(sessionsRoot, secondCwd));

		const firstCanonicalDir = computeDefaultSessionDir(firstCwd, storage, sessionsRoot);
		expect(fs.existsSync(sharedLegacyDir)).toBe(false);

		const oldClientFile = path.join(sharedLegacyDir, "second.jsonl");
		fs.mkdirSync(sharedLegacyDir, { recursive: true });
		fs.writeFileSync(oldClientFile, sessionHeader(secondCwd, "second"));
		expect(fs.existsSync(path.join(firstCanonicalDir, "second.jsonl"))).toBe(false);
		expect(fs.readFileSync(oldClientFile, "utf8")).toBe(sessionHeader(secondCwd, "second"));
	});

	test("keeps an existing legacy bucket in place beside hashed storage", () => {
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
		const rename = vi.spyOn(fs, "renameSync");

		expect(computeDefaultSessionDir(cwd, storage, sessionsRoot)).toBe(hashedDir);
		fs.writeSync(descriptor, "after startup\n");
		fs.closeSync(descriptor);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(`${contents}after startup\n`);
		expect(fs.readFileSync(artifactFile, "utf8")).toBe("artifact bytes");
		expect(fs.existsSync(path.join(hashedDir, "existing.jsonl"))).toBe(false);
		expect(fs.lstatSync(legacyDir).isDirectory()).toBe(true);
		expect(rename).not.toHaveBeenCalled();
		expect(computeDefaultSessionDir(cwd, storage, sessionsRoot)).toBe(hashedDir);
	});

	test("keeps a colliding live legacy session reachable through its path", () => {
		const sessionsRoot = makeTempDir("omp-session-root-");
		const cwd = makeTempDir("omp-session-cwd-");
		const storage = new FileSessionStorage();
		const canonicalDir = computeDefaultSessionDir(cwd, storage, sessionsRoot);
		const legacyDir = legacySessionDir(sessionsRoot, cwd);
		const source = path.join(legacyDir, "active.jsonl");
		const destination = path.join(canonicalDir, "active.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		const sourceContents = sessionHeader(cwd, "live");
		const destinationContents = sessionHeader(cwd, "stale");
		fs.writeFileSync(source, sourceContents);
		fs.writeFileSync(destination, destinationContents);
		const descriptor = fs.openSync(source, "a");

		computeDefaultSessionDir(cwd, storage, sessionsRoot);
		fs.writeSync(descriptor, "live-after\n");
		fs.closeSync(descriptor);

		expect(fs.readFileSync(source, "utf8")).toBe(`${sourceContents}live-after\n`);
		expect(fs.readFileSync(destination, "utf8")).toBe(destinationContents);
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

		fs.mkdirSync(legacyDir, { recursive: true });
		const recreated = path.join(legacyDir, "active.jsonl");
		const recreatedContents = sessionHeader(cwd, "recreated");
		fs.writeFileSync(recreated, recreatedContents);
		computeDefaultSessionDir(cwd, storage, sessionsRoot);

		expect(fs.readFileSync(recreated, "utf8")).toBe(recreatedContents);
		expect(fs.readFileSync(destination, "utf8")).toBe(canonicalContents);
	});
});
