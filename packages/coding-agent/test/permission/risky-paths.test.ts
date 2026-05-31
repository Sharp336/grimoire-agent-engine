import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyRiskyPath } from "../../src/tools/permission/risky-paths";

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

describe("classifyRiskyPath symlink containment", () => {
	test("flags a path that resolves outside the workspace via symlink", () => {
		const tmp = mkTmp("risky-real-");
		const root = path.join(tmp, "ws");
		fs.mkdirSync(root);
		const outside = path.join(tmp, "outside");
		fs.mkdirSync(outside);
		const link = path.join(root, "link");
		fs.symlinkSync(outside, link);
		const target = path.join(link, "file.txt");
		const result = classifyRiskyPath(target, root);
		expect(result).not.toBeNull();
	});

	test("allows a normal in-workspace path", () => {
		const tmp = mkTmp("risky-ok-");
		const root = path.join(tmp, "ws");
		fs.mkdirSync(root);
		const target = path.join(root, "src", "file.txt");
		const result = classifyRiskyPath(target, root);
		expect(result).toBeNull();
	});

	test("allows an in-workspace target addressed via the real path when the root is a symlink", () => {
		// Create a real workspace dir, then a symlink to it. Use the SYMLINK as the
		// workspace root and address a target by its REAL path. A non-canonical
		// containment check would wrongly flag this as outside the workspace.
		const tmp = mkTmp("risky-symroot-");
		const realRoot = path.join(tmp, "real-ws");
		fs.mkdirSync(realRoot);
		const symRoot = path.join(tmp, "sym-ws");
		fs.symlinkSync(realRoot, symRoot);
		const realTarget = path.join(realRoot, "src", "file.ts");
		const result = classifyRiskyPath(realTarget, symRoot);
		expect(result).toBeNull();
	});

	test("still blocks a genuine escape to a system path under a symlinked root", () => {
		const tmp = mkTmp("risky-escape-");
		const realRoot = path.join(tmp, "real-ws");
		fs.mkdirSync(realRoot);
		const symRoot = path.join(tmp, "sym-ws");
		fs.symlinkSync(realRoot, symRoot);
		const result = classifyRiskyPath("/etc/passwd", symRoot);
		expect(result).not.toBeNull();
	});
});

const _ = [afterAll, describe, expect, test];
