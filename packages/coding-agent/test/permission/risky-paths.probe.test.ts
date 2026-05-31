import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyRiskyPath } from "../../src/tools/permission/risky-paths";

// Regression guard for the root-canonicalization change (Fix 6): the sensitive
// denylist and escape blocking must survive alongside the symlinked-root allow.

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe("classifyRiskyPath denylist regression guard", () => {
	test("blocks an absolute outside system path (/etc/passwd)", () => {
		const root = mkTmp("probe-etc-");
		expect(classifyRiskyPath("/etc/passwd", root)).not.toBeNull();
	});

	test("blocks a relative escape (../escape.txt)", () => {
		const root = mkTmp("probe-rel-");
		expect(classifyRiskyPath("../escape.txt", root)).not.toBeNull();
	});

	test("blocks a sensitive home SSH path (~/.ssh/id_rsa)", () => {
		const root = mkTmp("probe-ssh-");
		expect(classifyRiskyPath("~/.ssh/id_rsa", root)).not.toBeNull();
	});

	test("blocks a home dotfile (~/.bashrc)", () => {
		const root = mkTmp("probe-bashrc-");
		expect(classifyRiskyPath("~/.bashrc", root)).not.toBeNull();
	});

	test("allows an in-workspace file (src/foo.ts)", () => {
		const root = mkTmp("probe-ws-");
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		expect(classifyRiskyPath("src/foo.ts", root)).toBeNull();
	});

	test("allows a real-path target under a symlinked workspace root", () => {
		const tmp = mkTmp("probe-symroot-");
		const realRoot = path.join(tmp, "real-ws");
		fs.mkdirSync(realRoot);
		const symRoot = path.join(tmp, "sym-ws");
		fs.symlinkSync(realRoot, symRoot);
		const realTarget = path.join(realRoot, "src", "file.ts");
		expect(classifyRiskyPath(realTarget, symRoot)).toBeNull();
	});

	test("blocks an in-workspace symlink escaping outward (W/link -> /etc)", () => {
		const root = mkTmp("probe-symesc-");
		const link = path.join(root, "link");
		fs.symlinkSync("/etc", link);
		expect(classifyRiskyPath(path.join(link, "x"), root)).not.toBeNull();
	});
});

const _ = [afterAll, describe, expect, test];
