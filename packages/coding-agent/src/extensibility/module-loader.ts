import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ValidationModule {
	module: unknown;
	cleanup(): Promise<void>;
}
export interface ValidationGraph {
	load(modulePath: string): Promise<unknown>;
	cleanup(): Promise<void>;
}

export async function loadRuntimeModule(modulePath: string, cacheBust = ""): Promise<unknown> {
	if (!cacheBust) return import(modulePath);
	const graph = await createValidationGraph(await findPackageRoot(modulePath), cacheBust);
	return graph.load(modulePath);
}
export async function loadValidationModule(modulePath: string, cacheBust: string): Promise<ValidationModule> {
	const graph = await createValidationGraph(await findPackageRoot(modulePath), cacheBust);
	return { module: await graph.load(modulePath), cleanup: graph.cleanup };
}
export async function createValidationGraph(root: string, cacheBust: string): Promise<ValidationGraph> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-module-validation-"));
	try {
		await fs.cp(root, tempRoot, { recursive: true, verbatimSymlinks: true });
		const hoisted = await findNodeModules(path.dirname(root));
		if (hoisted) await copyAbsentPackages(hoisted, path.join(tempRoot, "node_modules"));
		return {
			load: modulePath => import(`${path.join(tempRoot, path.relative(root, modulePath))}?${cacheBust}`),
			cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
		};
	} catch (error) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		throw error;
	}
}
async function copyAbsentPackages(source: string, target: string): Promise<void> {
	await fs.mkdir(target, { recursive: true });
	for (const entry of await fs.readdir(source)) {
		if (entry === ".bin") continue;
		const s = path.join(source, entry);
		const t = path.join(target, entry);
		if (entry.startsWith("@") && (await directoryExists(s))) {
			await copyAbsentPackages(s, t);
			continue;
		}
		if (!(await pathExists(t))) await fs.cp(s, t, { recursive: true, verbatimSymlinks: true });
	}
}
async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
}
async function directoryExists(directory: string): Promise<boolean> {
	try {
		return (await fs.stat(directory)).isDirectory();
	} catch {
		return false;
	}
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
async function findNodeModules(start: string): Promise<string | undefined> {
	let directory = start;
	while (true) {
		const candidate = path.join(directory, "node_modules");
		if (await directoryExists(candidate)) return candidate;
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}
