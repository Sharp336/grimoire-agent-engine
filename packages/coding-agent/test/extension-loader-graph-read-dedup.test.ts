import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";

describe("Extension Loader Graph Read Dedup", () => {
	let tempDir: TempDir;
	let reads: Map<string, number>;
	let fileSpy: Mock<typeof Bun.file>;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-ext-dedup-");
		reads = new Map<string, number>();

		const realBunFile = Bun.file.bind(Bun);

		const spyImpl = (path: string | URL, options?: BlobPropertyBag): BunFile => {
			const handle = realBunFile(path, options);
			if (typeof path === "string") {
				const key = fs.existsSync(path) ? fs.realpathSync(path) : path;
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
		if (fileSpy) {
			fileSpy.mockRestore();
		}
		if (tempDir) {
			tempDir.removeSync();
		}
	});

	it("should read each extension module from disk exactly once", async () => {
		const cwd = tempDir.absolute();
		const extDir = path.join(cwd, "ext");
		fs.mkdirSync(extDir, { recursive: true });

		const numModules = 120;
		for (let i = 0; i < numModules; i++) {
			const modPath = path.join(extDir, `mod-${i}.ts`);
			let content = `export const v${i} = ${i};\n`;
			if (i < numModules - 1) {
				content += `import "./mod-${i + 1}.ts";\n`;
			}
			fs.writeFileSync(modPath, content, "utf-8");
		}

		const entryPath = path.join(extDir, "index.ts");
		const entryContent = `import "./mod-0.ts";
export default function(pi) {
    const { Type } = pi.typebox;
    pi.registerTool({
        name: "dedup-tool",
        label: "dedup-tool",
        description: "Test tool",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
}
`;
		fs.writeFileSync(entryPath, entryContent, "utf-8");

		const result = await loadExtensions([entryPath], cwd);

		expect(result.errors).toHaveLength(0);
		expect(result.extensions[0].tools.has("dedup-tool")).toBe(true);

		const checkReadCount = (filePath: string) => {
			const real = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
			expect(reads.get(real) ?? 0).toBe(1);
		};

		checkReadCount(entryPath);
		for (let i = 0; i < numModules; i++) {
			checkReadCount(path.join(extDir, `mod-${i}.ts`));
		}
	});

	it("should read graph modules skipped by the initial import from disk at import time", async () => {
		const cwd = tempDir.absolute();
		const extDir = path.join(cwd, "ext");
		fs.mkdirSync(extDir, { recursive: true });

		const lazyPath = path.join(extDir, "lazy.ts");
		fs.writeFileSync(lazyPath, `export const value = "before";\n`, "utf-8");

		// The fixture's dynamic import is the loading boundary under test: the
		// graph scan collects `./lazy.ts` at load time, but nothing imports it
		// until `readLazy()` runs.
		const entryPath = path.join(extDir, "index.ts");
		const entryContent = `export async function readLazy(): Promise<string> {
	const mod = await import("./lazy.ts");
	return mod.value;
}
`;
		fs.writeFileSync(entryPath, entryContent, "utf-8");

		const ns = (await loadLegacyPiModule(entryPath)) as { readLazy(): Promise<string> };

		// Edit the module after load but before its first import: the loader
		// must serve the on-disk content, not a stale load-time snapshot.
		fs.writeFileSync(lazyPath, `export const value = "after";\n`, "utf-8");

		expect(await ns.readLazy()).toBe("after");
	});

	it("loads a verified prebuilt entry without duplicating host modules", async () => {
		const cwd = tempDir.absolute();
		const entryPath = path.join(cwd, "prebuilt.js");
		const source = `import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
export { ToolAbortError };
`;
		fs.writeFileSync(entryPath, source, "utf8");
		const imports = new Bun.Transpiler({ loader: "js" }).scanImports(source).map(found => {
			const token = JSON.stringify(found.path);
			const start = source.indexOf(token);
			expect(start).toBeGreaterThanOrEqual(0);
			expect(source.indexOf(token, start + token.length)).toBe(-1);
			return { kind: found.kind, specifier: found.path, start, end: start + token.length };
		});
		const sha256 = new Bun.CryptoHasher("sha256").update(source).digest("hex");
		fs.writeFileSync(`${entryPath}.omp-imports.json`, JSON.stringify({ version: 1, sha256, imports }), "utf8");

		const loaded = (await loadLegacyPiModule(entryPath)) as { ToolAbortError: typeof ToolAbortError };
		expect(loaded.ToolAbortError).toBe(ToolAbortError);
	});

	it("uses the prebuilt fast path exactly once for a valid sidecar", async () => {
		const cwd = tempDir.absolute();
		const entryPath = path.join(cwd, "fastpath.js");
		const source = `export const marker = "fast";\n`;
		fs.writeFileSync(entryPath, source, "utf8");
		const imports = new Bun.Transpiler({ loader: "js" }).scanImports(source).map(found => {
			const token = JSON.stringify(found.path);
			const start = source.indexOf(token);
			return { kind: found.kind, specifier: found.path, start, end: start + token.length };
		});
		const sha256 = new Bun.CryptoHasher("sha256").update(source).digest("hex");
		fs.writeFileSync(`${entryPath}.omp-imports.json`, JSON.stringify({ version: 1, sha256, imports }), "utf8");

		const loaded = (await loadLegacyPiModule(entryPath)) as { marker: string };
		expect(loaded.marker).toBe("fast");
		// Both reads pin the fast path: the sidecar count fails if the sidecar is never
		// consulted (fast path removed), and the entry count fails if a valid sidecar is
		// rejected, because the graph fallback reads the entry again in collectExtensionModules.
		expect(reads.get(fs.realpathSync(`${entryPath}.omp-imports.json`)) ?? 0).toBe(1);
		expect(reads.get(fs.realpathSync(entryPath)) ?? 0).toBe(1);
	});
	it("reads a sidecar-less JS entry from disk only once", async () => {
		const cwd = tempDir.absolute();
		const entryPath = path.join(cwd, "plain.js");
		fs.writeFileSync(entryPath, `export const marker = "plain";\n`, "utf8");

		const loaded = (await loadLegacyPiModule(entryPath)) as { marker: string };
		expect(loaded.marker).toBe("plain");
		// Backward-compatible path: with no sidecar the fast path must bail before opening
		// the entry, leaving the graph loader as its only reader.
		expect(reads.get(fs.realpathSync(entryPath)) ?? 0).toBe(1);
	});
	it("falls back to graph loading when a prebuilt sidecar is stale", async () => {
		const cwd = tempDir.absolute();
		const dependencyPath = path.join(cwd, "dependency.ts");
		const entryPath = path.join(cwd, "stale.js");
		fs.writeFileSync(dependencyPath, `export const value = "fallback";\n`, "utf8");
		fs.writeFileSync(entryPath, `export { value } from "./dependency.ts";\n`, "utf8");
		fs.writeFileSync(
			`${entryPath}.omp-imports.json`,
			JSON.stringify({ version: 1, sha256: "stale", imports: [] }),
			"utf8",
		);

		const loaded = (await loadLegacyPiModule(entryPath)) as { value: string };
		expect(loaded.value).toBe("fallback");
	});
	it("still loads a fast-path entry on a later load once its sidecar goes stale", async () => {
		const cwd = tempDir.absolute();
		const entryPath = path.join(cwd, "rebuilt.js");
		const writeSidecar = (source: string, sha256?: string) => {
			fs.writeFileSync(
				`${entryPath}.omp-imports.json`,
				JSON.stringify({
					version: 1,
					sha256: sha256 ?? new Bun.CryptoHasher("sha256").update(source).digest("hex"),
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

		// The first load registers a permanent prebuilt hook. Rebuilding the entry without
		// refreshing its sidecar evicts the retained source, so that hook must still serve
		// the rebuilt entry instead of failing the load.
		const second = `export const marker = "v2";\n`;
		fs.writeFileSync(entryPath, second, "utf8");
		writeSidecar(second, "stale");
		const reloaded = (await loadLegacyPiModule(entryPath)) as { marker: string };
		expect(reloaded.marker).toBe("v2");
	});
	it("rejects a hash-valid sidecar range that does not point at the import", async () => {
		const cwd = tempDir.absolute();
		const entryPath = path.join(cwd, "misdirected.js");
		const specifier = "@mariozechner/pi-coding-agent/tools/tool-errors";
		const token = JSON.stringify(specifier);
		const source = `const bait = ${token};
import { ToolAbortError } from ${token};
export { ToolAbortError };
`;
		fs.writeFileSync(entryPath, source, "utf8");
		const start = source.indexOf(token);
		const sha256 = new Bun.CryptoHasher("sha256").update(source).digest("hex");
		fs.writeFileSync(
			`${entryPath}.omp-imports.json`,
			JSON.stringify({
				version: 1,
				sha256,
				imports: [{ kind: "import-statement", specifier, start, end: start + token.length }],
			}),
			"utf8",
		);

		const loaded = (await loadLegacyPiModule(entryPath)) as { ToolAbortError: typeof ToolAbortError };
		expect(loaded.ToolAbortError).toBe(ToolAbortError);
	});
});
