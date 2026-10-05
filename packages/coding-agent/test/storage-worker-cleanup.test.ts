import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeStorageTestRoot } from "./helpers/storage-worker-fixture";

it("storage cleanup preserves cwd and temp root after setup failure", async () => {
	const sentinel = path.join(process.cwd(), `storage-cleanup-${crypto.randomUUID()}`);
	await fs.writeFile(sentinel, "keep");
	try {
		await removeStorageTestRoot(undefined);
		await removeStorageTestRoot("");
		await expect(removeStorageTestRoot(process.cwd())).rejects.toThrow("Refusing to remove");
		await expect(removeStorageTestRoot(os.tmpdir())).rejects.toThrow("Refusing to remove");
		expect(await fs.readFile(sentinel, "utf8")).toBe("keep");
	} finally {
		await fs.rm(sentinel);
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
