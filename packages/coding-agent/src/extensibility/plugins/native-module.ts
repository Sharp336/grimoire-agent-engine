/// <reference path="./native-extension-modules.d.ts" />

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isCompiledBinary } from "@oh-my-pi/pi-utils/env";

const namespace = "omp-native-extension";
const modules: Record<string, Readonly<Record<string, unknown>>> = Object.create(null);
const ownedFiles = new Set<string>();
const codePattern = /\.[cm]?[jt]sx?(?:\?load=\d+)?$/;
let installed = false;
let loadTag = 0;

function filePath(file: string): string {
	const bare = file.replace(/\?load=\d+$/, "");
	return path.normalize(bare.startsWith("file:") ? fileURLToPath(bare) : bare);
}

function sourcePath(file: string): string {
	return fs.realpathSync(filePath(file));
}

function recordDependency(specifier: string, importer: string): void {
	const resolved = Bun.resolveSync(specifier, path.dirname(sourcePath(importer)));
	if (codePattern.test(resolved)) ownedFiles.add(sourcePath(resolved));
}

async function hostModuleSource(key: string): Promise<string> {
	if (!modules[key]) {
		if (isCompiledBinary()) {
			const { BUNDLED_PI_MODULE_LOADERS } = await import("omp-native-extension-modules");
			const loader = BUNDLED_PI_MODULE_LOADERS[key];
			if (!loader) throw new Error(`Native extension host module is not exported: ${key}`);
			modules[key] = await loader();
		} else {
			modules[key] = await import(pathToFileURL(Bun.resolveSync(key, import.meta.dir)).href);
		}
	}
	const source = [`const host = globalThis.__ompNativeExtensionModules[${JSON.stringify(key)}];`];
	for (const name of Object.keys(modules[key])) {
		const binding = `value${source.length}`;
		source.push(
			`const ${binding} = host[${JSON.stringify(name)}]; export { ${binding} as ${JSON.stringify(name)} };`,
		);
	}
	return source.join("\n");
}

/** Link host imports only; ordinary ESM edges keep their original runtime file base. */
async function linkNativeFile(file: string): Promise<{ contents: string; loader: "js" }> {
	const output = await Bun.build({
		entrypoints: [file],
		target: "bun",
		format: "esm",
		plugins: [
			{
				name: namespace,
				setup(build) {
					build.onResolve({ filter: /^@oh-my-pi\// }, args => ({ path: args.path, namespace }));
					build.onLoad({ filter: /.*/, namespace }, async args => ({
						contents: await hostModuleSource(args.path),
						loader: "js",
					}));
					// Avoid matching absolute build entrypoints: broad entry hooks panic in Bun 1.4.
					build.onResolve({ filter: /^(?:\.{1,2}[\/]|node:|bun:|@|[a-zA-Z_-][^:]*$)/ }, args => {
						if (args.kind === "entry-point") return { path: args.path };
						// Synchronous require closures must be linked together, never await runtime onLoad.
						if (args.kind === "require-call" || args.kind === "require-resolve") return undefined;
						if (!args.path.startsWith("node:") && !args.path.startsWith("bun:")) {
							recordDependency(args.path, args.importer);
						}
						return { path: args.path, external: true };
					});
					build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "file" }, args => {
						if (sourcePath(args.path) === file) return undefined;
						// Only bundled require dependencies reach this callback. Preserve their file-local metadata.
						const original = sourcePath(args.path);
						const loader = /tsx$/.test(original) ? "tsx" : /jsx$/.test(original) ? "jsx" : "ts";
						const transpiler = new Bun.Transpiler({
							loader,
							define: {
								"import.meta.url": JSON.stringify(pathToFileURL(original).href),
								"import.meta.dir": JSON.stringify(path.dirname(original)),
								"import.meta.dirname": JSON.stringify(path.dirname(original)),
								"import.meta.path": JSON.stringify(original),
								"import.meta.filename": JSON.stringify(original),
							},
						});
						return { contents: transpiler.transformSync(fs.readFileSync(original, "utf8")), loader: "js" };
					});
				},
			},
		],
	});
	if (!output.success)
		throw new Error(
			`Native extension linking failed for ${file}:\n${output.logs.map(log => log.message).join("\n")}`,
		);
	return { contents: await output.outputs[0].text(), loader: "js" };
}

/** Install process hooks once; files outside the reached extension graph fall through synchronously. */
export function installNativeModuleResolver(): void {
	if (installed) return;
	installed = true;
	Reflect.set(globalThis, "__ompNativeExtensionModules", modules);
	Bun.plugin({
		name: namespace,
		setup(build) {
			build.onResolve({ filter: /^(?:\.|\/|[A-Za-z]:|file:)/, namespace: "file" }, args => {
				if (args.importer && ownedFiles.has(filePath(args.importer))) recordDependency(args.path, args.importer);
				return undefined;
			});
			build.onLoad({ filter: codePattern, namespace: "file" }, args => {
				const file = filePath(args.path);
				if (!ownedFiles.has(file)) return undefined;
				return linkNativeFile(file);
			});
		},
	});
}

/** Load in place: relative assets, late imports and native module identity retain their original base. */
export async function loadNativeModule(file: string): Promise<unknown> {
	installNativeModuleResolver();
	const absolute = sourcePath(path.resolve(file));
	ownedFiles.add(absolute);
	const specifier = process.platform === "win32" ? pathToFileURL(absolute).href : absolute;
	return import(`${specifier}?load=${++loadTag}`);
}
