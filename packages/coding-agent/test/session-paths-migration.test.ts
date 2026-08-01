import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import type { SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

function makeStorage(): SessionStorage {
	return {
		ensureDirSync(dir: string): void {
			fs.mkdirSync(dir, { recursive: true });
		},
	} as SessionStorage;
}

function encodeLegacyName(dir: string): string {
	return `--${dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

describe("session dir migration scopes to the current cwd (#7183)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	it("migrates only the old dir for the current cwd and leaves other cwds' dirs alone", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-migrate-"));
		tempDirs.push(root);

		const home = os.homedir();
		const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
		const cwdA = path.join(home, "pi-migrate-a");

		// Old-format dirs: `--<homeEncoded>-<rel>--`. Both dirs exist, and the
		// one for cwdA carries a session file (simulating a legacy session).
		const oldA = path.join(root, `--${homeEncoded}-pi-migrate-a--`);
		const oldB = path.join(root, `--${homeEncoded}-pi-migrate-b--`);
		fs.mkdirSync(oldA, { recursive: true });
		fs.mkdirSync(oldB, { recursive: true });
		fs.writeFileSync(path.join(oldA, "1699999999000_sess1.jsonl"), "{}");

		// Opening a session for cwdA must migrate ONLY oldA -> -pi-migrate-a.
		const sessionDir = computeDefaultSessionDir(cwdA, makeStorage(), root);
		expect(sessionDir).toBe(path.join(root, "-pi-migrate-a"));
		expect(fs.existsSync(path.join(root, "-pi-migrate-a", "1699999999000_sess1.jsonl"))).toBe(true);
		expect(fs.existsSync(oldA)).toBe(false);

		// The other cwd's old dir is untouched: another process (pi, or a
		// concurrent omp) may still be writing it.
		expect(fs.existsSync(oldB)).toBe(true);
		expect(fs.existsSync(path.join(root, "-pi-migrate-b"))).toBe(false);
	});

	it("later migrates a second cwd's old dir when that cwd is opened", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-migrate-"));
		tempDirs.push(root);

		const home = os.homedir();
		const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
		const cwdB = path.join(home, "pi-migrate-b2");
		const oldB = path.join(root, `--${homeEncoded}-pi-migrate-b2--`);
		fs.mkdirSync(oldB, { recursive: true });
		fs.writeFileSync(path.join(oldB, "1700000000000_sess2.jsonl"), "{}");

		// First access for cwdB migrates it.
		const sessionDir = computeDefaultSessionDir(cwdB, makeStorage(), root);
		expect(sessionDir).toBe(path.join(root, "-pi-migrate-b2"));
		expect(fs.existsSync(path.join(root, "-pi-migrate-b2", "1700000000000_sess2.jsonl"))).toBe(true);
		expect(fs.existsSync(oldB)).toBe(false);
	});

	it("keeps the legacy absolute-form migration for non-home cwds", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sess-migrate-"));
		tempDirs.push(root);

		const outsideHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-outside-home-"));
		tempDirs.push(outsideHome);
		const cwd = path.join(outsideHome, "proj");
		fs.mkdirSync(cwd, { recursive: true });

		// Non-home cwd: legacy absolute form `--<abs>--`.
		const legacyDir = path.join(root, encodeLegacyName(cwd));
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(path.join(legacyDir, "1700000000000_sess3.jsonl"), "{}");

		const sessionDir = computeDefaultSessionDir(cwd, makeStorage(), root);
		expect(fs.existsSync(path.join(sessionDir, "1700000000000_sess3.jsonl"))).toBe(true);
		expect(fs.existsSync(legacyDir)).toBe(false);
	});
});
