import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeStorageTestRoot } from "./helpers/storage-worker-fixture";

it("storage cleanup refuses a disposable working directory and its ancestors", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "artel-cleanup-cwd-"));
	const cwd = path.join(root, "checkout");
	const sentinel = path.join(cwd, "keep");
	await fs.mkdir(cwd);
	await fs.writeFile(sentinel, "keep");
	try {
		for (const target of [cwd, root]) {
			const child = Bun.spawn([process.execPath, "--eval", `
				import { removeStorageTestRoot } from ${JSON.stringify(path.join(import.meta.dir, "helpers/storage-worker-fixture.ts"))};
				try {
					await removeStorageTestRoot(${JSON.stringify(target)});
					process.exitCode = 1;
				} catch (error) {
					if (!String(error).includes("Refusing to remove")) throw error;
				}
			`], { cwd, stdout: "pipe", stderr: "pipe" });
			expect(await child.exited).toBe(0);
			expect(await fs.readFile(sentinel, "utf8")).toBe("keep");
		}
		await removeStorageTestRoot(undefined);
		await removeStorageTestRoot("");
		expect(await fs.readFile(sentinel, "utf8")).toBe("keep");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("storage cleanup removes only its created temporary tree", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "artel-cleanup-"));
	const owned = path.join(root, "engine-test-owned"), sibling = path.join(root, "keep");
	try {
		await fs.mkdir(owned);
		await fs.writeFile(path.join(owned, "data"), "remove");
		await fs.writeFile(sibling, "keep");
		await removeStorageTestRoot(owned);
		expect(await fs.readdir(root)).toEqual(["keep"]);
		expect(await fs.readFile(sibling, "utf8")).toBe("keep");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
