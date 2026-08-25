import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ValidationModule {
	module: unknown;
	cleanup(): Promise<void>;
}

/** Runtime-selected module loading boundary for user and plugin modules. */
export async function loadRuntimeModule(modulePath: string, cacheBust = ""): Promise<unknown> {
	if (!cacheBust) return import(modulePath);
	const loaded = await loadValidationModule(modulePath, cacheBust);
	return loaded.module;
}

export async function loadValidationModule(modulePath: string, cacheBust: string): Promise<ValidationModule> {
	const root = await findPackageRoot(modulePath);
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-module-validation-"));
	await fs.cp(root, tempRoot, { recursive: true, verbatimSymlinks: true });
	const nodeModules = await findNodeModules(root);
	if (nodeModules) await fs.symlink(nodeModules, path.join(tempRoot, "node_modules"), "dir");
	const copiedPath = path.join(tempRoot, path.relative(root, modulePath));
	const module = await import(`${copiedPath}?${cacheBust}`);
	return { module, cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }) };
}

async function findPackageRoot(modulePath: string): Promise<string> {
	let directory = path.dirname(modulePath);
	while (true) {
		try {
			await fs.access(path.join(directory, "package.json"));
			return directory;
		} catch {
			const parent = path.dirname(directory);
			if (parent === directory) return path.dirname(modulePath);
			directory = parent;
		}
	}
}

async function findNodeModules(root: string): Promise<string | undefined> {
	let directory = root;
	while (true) {
		const candidate = path.join(directory, "node_modules");
		try {
			await fs.access(candidate);
			return candidate;
		} catch {
			const parent = path.dirname(directory);
			if (parent === directory) return undefined;
			directory = parent;
		}
	}
}
