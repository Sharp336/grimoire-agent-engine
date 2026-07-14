import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureSecureSocketDirectory } from "../src/ownership.ts";

describe("appserver socket directory ownership", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("does not chmod an existing caller-owned socket directory", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-appserver-existing-dir-"));
		dirs.push(directory);
		await fs.chmod(directory, 0o755);

		await expect(ensureSecureSocketDirectory(path.join(directory, "custom.sock"))).resolves.toBe(
			path.resolve(directory),
		);

		expect((await fs.stat(directory)).mode & 0o7777).toBe(0o755);
	});

	it("leaves /tmp permissions unchanged for a custom /tmp/custom.sock path", async () => {
		const before = (await fs.stat("/tmp")).mode & 0o7777;

		await expect(ensureSecureSocketDirectory("/tmp/custom.sock")).resolves.toBe("/tmp");

		expect((await fs.stat("/tmp")).mode & 0o7777).toBe(before);
	});

	it("creates missing app-private directory components with private modes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-appserver-private-dir-"));
		dirs.push(root);
		const directory = path.join(root, "nested", "run");

		await ensureSecureSocketDirectory(path.join(directory, "appserver.sock"));

		expect((await fs.stat(path.join(root, "nested"))).mode & 0o777).toBe(0o700);
		expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
	});
});
