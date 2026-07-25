import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	__getPrebuiltExtensionSourceRetainCountForTests,
	__hasGraphPreparedExtensionSourceForTests,
	__hasRetainedPrebuiltExtensionSourceForTests,
	__resetLegacyPiResolutionCache,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";

function writeValidSidecar(entryPath: string, source: string): void {
	const imports = new Bun.Transpiler({ loader: "js" }).scanImports(source).map(found => {
		const token = JSON.stringify(found.path);
		const start = source.indexOf(token);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(source.indexOf(token, start + token.length)).toBe(-1);
		return { kind: found.kind, specifier: found.path, start, end: start + token.length };
	});
	const sha256 = new Bun.CryptoHasher("sha256").update(source).digest("hex");
	fs.writeFileSync(`${entryPath}.omp-imports.json`, JSON.stringify({ version: 1, sha256, imports }), "utf8");
}

describe("legacy-pi-compat prebuilt sidecar lifetime", () => {
	let tempDir: TempDir;
	let reads: Map<string, number>;
	let fileSpy: Mock<typeof Bun.file>;

	beforeEach(() => {
		__resetLegacyPiResolutionCache();
		tempDir = TempDir.createSync("@pi-prebuilt-lifetime-");
		reads = new Map<string, number>();
		const realBunFile = Bun.file.bind(Bun);
		const spyImpl = (filePath: string | URL, options?: BlobPropertyBag): BunFile => {
			const handle = realBunFile(filePath, options);
			if (typeof filePath === "string") {
				const key = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
				const bump = () => {
					reads.set(key, (reads.get(key) ?? 0) + 1);
				};
				return new Proxy(handle, {
					get(target: BunFile, prop: string | symbol, recv: unknown): unknown {
						if (prop === "text" || prop === "arrayBuffer" || prop === "bytes" || prop === "json") {
							const original = Reflect.get(target, prop, recv) as ((...a: unknown[]) => unknown) | undefined;
							if (typeof original === "function") {
								return (...methodArgs: unknown[]): unknown => {
									bump();
									return original.apply(target, methodArgs);
								};
							}
						}
						return Reflect.get(target, prop, recv);
					},
				});
			}
			return handle;
		};
		fileSpy = spyOn(Bun, "file").mockImplementation(spyImpl as typeof Bun.file);
	});

	afterEach(() => {
		fileSpy?.mockRestore();
		__resetLegacyPiResolutionCache();
		tempDir?.removeSync();
		delete (globalThis as { __ompPrebuiltTestGate?: Promise<void> }).__ompPrebuiltTestGate;
	});

	it("releases the retained prebuilt source after a successful import completes", async () => {
		const entryPath = path.join(tempDir.absolute(), "ok.js");
		const source = `export const marker = "ok";\n`;
		fs.writeFileSync(entryPath, source, "utf8");
		writeValidSidecar(entryPath, source);
		const entryRealPath = fs.realpathSync(entryPath);

		const loaded = (await loadLegacyPiModule(entryPath)) as { marker: string };
		expect(loaded.marker).toBe("ok");
		expect(__hasRetainedPrebuiltExtensionSourceForTests(entryRealPath)).toBe(false);
		expect(__getPrebuiltExtensionSourceRetainCountForTests(entryRealPath)).toBe(0);
		expect(__hasGraphPreparedExtensionSourceForTests(entryRealPath)).toBe(false);
	});

	it("releases the retained prebuilt source after an import error", async () => {
		const entryPath = path.join(tempDir.absolute(), "boom.js");
		const source = `throw new Error("prebuilt-boom");\n`;
		fs.writeFileSync(entryPath, source, "utf8");
		writeValidSidecar(entryPath, source);
		const entryRealPath = fs.realpathSync(entryPath);

		await expect(loadLegacyPiModule(entryPath)).rejects.toThrow(/prebuilt-boom/);
		expect(__hasRetainedPrebuiltExtensionSourceForTests(entryRealPath)).toBe(false);
		expect(__getPrebuiltExtensionSourceRetainCountForTests(entryRealPath)).toBe(0);
	});

	it("keeps the prebuilt source for overlapping loads and releases only after the last finishes", async () => {
		const entryPath = path.join(tempDir.absolute(), "overlap.js");
		const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();
		(globalThis as { __ompPrebuiltTestGate?: Promise<void> }).__ompPrebuiltTestGate = gate;
		const source = `await globalThis.__ompPrebuiltTestGate;\nexport const marker = "overlap";\n`;
		fs.writeFileSync(entryPath, source, "utf8");
		writeValidSidecar(entryPath, source);
		const entryRealPath = fs.realpathSync(entryPath);

		const loadA = loadLegacyPiModule(entryPath);
		const loadB = loadLegacyPiModule(entryPath);

		// Both imports are blocked on the shared gate inside module evaluation, so both
		// retains must still be held (neither finally has run yet).
		for (let i = 0; i < 50 && __getPrebuiltExtensionSourceRetainCountForTests(entryRealPath) < 2; i++) {
			await Bun.sleep(5);
		}
		expect(__getPrebuiltExtensionSourceRetainCountForTests(entryRealPath)).toBe(2);
		expect(__hasRetainedPrebuiltExtensionSourceForTests(entryRealPath)).toBe(true);
		releaseGate();

		const [a, b] = (await Promise.all([loadA, loadB])) as [{ marker: string }, { marker: string }];
		expect(a.marker).toBe("overlap");
		expect(b.marker).toBe("overlap");
		expect(__hasRetainedPrebuiltExtensionSourceForTests(entryRealPath)).toBe(false);
		expect(__getPrebuiltExtensionSourceRetainCountForTests(entryRealPath)).toBe(0);
	});

	it("reuses the graph-prepared entry on a stale-sidecar reload instead of a third disk read", async () => {
		const entryPath = path.join(tempDir.absolute(), "rebuilt.js");
		const writeSidecar = (body: string, sha256?: string) => {
			fs.writeFileSync(
				`${entryPath}.omp-imports.json`,
				JSON.stringify({
					version: 1,
					sha256: sha256 ?? new Bun.CryptoHasher("sha256").update(body).digest("hex"),
					imports: [],
				}),
				"utf8",
			);
		};

		const first = `export const marker = "v1";\n`;
		fs.writeFileSync(entryPath, first, "utf8");
		writeSidecar(first);
		const initial = (await loadLegacyPiModule(entryPath)) as { marker: string };
		expect(initial.marker).toBe("v1");
		expect(__hasRetainedPrebuiltExtensionSourceForTests(fs.realpathSync(entryPath))).toBe(false);

		reads.clear();
		const second = `export const marker = "v2";\n`;
		fs.writeFileSync(entryPath, second, "utf8");
		writeSidecar(second, "stale");
		const reloaded = (await loadLegacyPiModule(entryPath)) as { marker: string };
		expect(reloaded.marker).toBe("v2");

		const entryReads = reads.get(fs.realpathSync(entryPath)) ?? 0;
		// preparePrebuiltExtensionEntry reads once to reject the hash; ensureExtensionGraphHook
		// reads once while collecting. The permanent prebuilt onLoad must reuse that graph
		// snapshot rather than opening the entry a third time.
		expect(entryReads).toBe(2);
		expect(__hasGraphPreparedExtensionSourceForTests(fs.realpathSync(entryPath))).toBe(false);
	});
});
