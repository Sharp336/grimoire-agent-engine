import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Runtime-selected module loading boundary for user and plugin modules. */
export async function loadRuntimeModule(modulePath: string, cacheBust = ""): Promise<unknown> {
	if (!cacheBust) return import(modulePath);
	const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-module-validation-"));
	try {
		const result = await Bun.build({
			entrypoints: [modulePath],
			outdir,
			target: "bun",
			naming: "index.js",
			sourcemap: "none",
		});
		if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
		const module = await import(`${path.join(outdir, "index.js")}?${cacheBust}`);
		return module;
	} finally {
		await fs.rm(outdir, { recursive: true, force: true });
	}
}
