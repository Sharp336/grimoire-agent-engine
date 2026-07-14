import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { __internalsForTesting } from "../src/identity.ts";

describe("persistent appserver host identity", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("publishes one immutable winner when first-run creators race", async () => {
		const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "omp-appserver-host-id-"));
		dirs.push(dir);
		fs.chmodSync(dir, 0o700);
		const path = nodePath.join(dir, "host-id");
		let arrived = 0;
		const gate = Promise.withResolvers<void>();
		const beforePublish = async () => {
			arrived += 1;
			if (arrived === 2) gate.resolve();
			await gate.promise;
		};

		const [first, second] = await Promise.all([
			__internalsForTesting.loadPersistentHostIdWithPublishHook(path, beforePublish),
			__internalsForTesting.loadPersistentHostIdWithPublishHook(path, beforePublish),
		]);

		expect(first).toBe(second);
		expect(fs.readFileSync(path, "utf8").trim()).toBe(first);
		expect(fs.statSync(path).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
});
