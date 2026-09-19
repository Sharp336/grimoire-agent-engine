import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __renderNativeExtensionVirtualModule, collectBundledPiEntries } from "../../scripts/native-extension-module";

test("native modules retain host identity, sibling imports and relative assets from source and a compiled host", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "artel-native-module-"));
	try {
		const extension = path.join(root, "extension.ts");
		await fs.mkdir(path.join(root, "nested"));
		await fs.writeFile(
			path.join(root, "nested/helper.ts"),
			'export { Type } from "@oh-my-pi/omptype/typebox"; export const asset = await Bun.file(new URL("./asset.txt", import.meta.url)).text(); export const url = import.meta.url; export async function later() { const target = "./late.ts"; return import(target); }',
		);
		await fs.writeFile(
			path.join(root, "nested/late.ts"),
			'export { Type } from "@oh-my-pi/omptype/typebox"; export const url = import.meta.url;',
		);
		await fs.writeFile(path.join(root, "nested/asset.txt"), "relative asset");
		await fs.writeFile(
			extension,
			'import { Type } from "./nested/helper.ts"; export * from "./nested/helper.ts"; export default api => { if (api.typebox.Type !== Type) throw new Error("API schema identity failed"); api.registerTool({name:"native", parameters:Type.Object({value:Type.String()})}); };',
		);
		const probe = path.resolve(import.meta.dir, "../fixtures/native-module-probe.ts");
		async function run(executable: string, args: string[]): Promise<void> {
			const child = Bun.spawn([executable, ...args, extension], {
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
				signal: AbortSignal.timeout(15_000),
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code, stderr).toBe(0);
			expect(stdout.trim()).toBe("native-module-ok");
		}
		await run(process.execPath, [probe]);
		const entries = (await collectBundledPiEntries()).filter(entry => entry.key === "@oh-my-pi/omptype/typebox");
		expect(entries).toHaveLength(1);
		const source = __renderNativeExtensionVirtualModule(entries);
		const binary = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
		const output = await Bun.build({
			entrypoints: [probe],
			target: "bun",
			compile: { outfile: binary },
			plugins: [
				{
					name: "native-module-fixture",
					setup(build) {
						build.onResolve({ filter: /^omp-native-extension-modules$/ }, () => ({
							path: "registry",
							namespace: "fixture",
						}));
						build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
							contents: source,
							loader: "ts",
							resolveDir: path.resolve(import.meta.dir, "../.."),
						}));
					},
				},
			],
		});
		expect(output.success, output.logs.map(log => log.message).join("\n")).toBe(true);
		await run(binary, []);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);
