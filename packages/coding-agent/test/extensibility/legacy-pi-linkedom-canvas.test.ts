import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

installLegacyPiSpecifierShim();

const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function writePackage(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-linkedom-"));
	tempRoots.push(dir);
	for (const rel in files) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, files[rel]);
	}
	return dir;
}

describe("legacy-pi CommonJS default export interop (linkedom canvas)", () => {
	it("loads linkedom parseHTML through the extension graph hook", async () => {
		const dir = await writePackage({
			"package.json": JSON.stringify({ name: "linkedom-ext", version: "1.0.0", type: "module" }),
			"index.ts": [
				'import { parseHTML } from "linkedom";',
				"const { document } = parseHTML('<html><body><p>hi</p></body></html>');",
				"export const text = document.querySelector('p')?.textContent ?? '';",
				"export default function (pi) { void pi; }",
			].join("\n"),
		});

		const { $ } = await import("bun");
		await $`bun add linkedom`.cwd(dir).quiet();

		const mod = (await loadLegacyPiModule(path.join(dir, "index.ts"))) as { text: string };
		expect(mod.text).toBe("hi");
	});
});
