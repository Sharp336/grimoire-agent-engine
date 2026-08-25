import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Runtime-selected module loading boundary for user and plugin modules. */
export async function loadRuntimeModule(modulePath: string, cacheBust = ""): Promise<unknown> {
	if (!cacheBust) return import(modulePath);
	const root = await findPackageRoot(modulePath);
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-module-validation-"));
	try {
		await fs.cp(root, tempRoot, { recursive: true, verbatimSymlinks: true });
		const copiedPath = path.join(tempRoot, path.relative(root, modulePath));
		return await import(`${copiedPath}?${cacheBust}`);
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
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
