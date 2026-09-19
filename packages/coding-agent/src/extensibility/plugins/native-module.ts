/// <reference path="./native-extension-modules.d.ts" />

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isCompiledBinary } from "@oh-my-pi/pi-utils";

const namespace = "omp-native-extension";
const modules: Record<string, Readonly<Record<string, unknown>>> = {};
let installed = false;
let loadTag = 0;

/** Resolve current host packages without legacy package aliases or source rewriting. */
export function installNativeModuleResolver(): void {
	if (installed) return;
	installed = true;
	Reflect.set(globalThis, "__ompNativeExtensionModules", modules);
	Bun.plugin({
		name: namespace,
		setup(build) {
			build.onResolve({ filter: /^@oh-my-pi\// }, args => {
				if (isCompiledBinary()) return { path: args.path, namespace };
				return { path: Bun.resolveSync(args.path, import.meta.dir) };
			});
			build.onLoad({ filter: /.*/, namespace }, async args => {
				const { BUNDLED_PI_MODULE_LOADERS } = await import("omp-native-extension-modules");
				const loader = BUNDLED_PI_MODULE_LOADERS[args.path];
				if (!loader) throw new Error(`Native extension host module is not exported: ${args.path}`);
				const module = (modules[args.path] ??= await loader());
				const source = [`const host = globalThis.__ompNativeExtensionModules[${JSON.stringify(args.path)}];`];
				for (const name of Object.keys(module)) {
					source.push(
						name === "default"
							? "export default host.default;"
							: `export const ${name} = host[${JSON.stringify(name)}];`,
					);
				}
				return { contents: source.join("\n"), loader: "js" };
			});
		},
	});
}

/** Import in place so extension-relative assets and ordinary dependency resolution remain native. */
export async function loadNativeModule(file: string): Promise<unknown> {
	installNativeModuleResolver();
	const absolute = path.resolve(file);
	const specifier = process.platform === "win32" ? pathToFileURL(absolute).href : absolute;
	return import(`${specifier}?load=${++loadTag}`);
}
