import { expect, test } from "bun:test";
import { __renderNativeExtensionVirtualModule, collectBundledPiEntries } from "../../scripts/native-extension-module";

test("the complete native registry parses and retains the catalog JSON import", async () => {
	const entries = await collectBundledPiEntries();
	const source = __renderNativeExtensionVirtualModule(entries);
	const scanned = new Bun.Transpiler({ loader: "ts" }).scan(source);

	expect(scanned.exports).toContain("BUNDLED_PI_MODULE_LOADERS");
	expect(scanned.imports.map(entry => entry.path)).toContain("@oh-my-pi/pi-catalog/models.json");
	expect(scanned.imports).toHaveLength(entries.length);
});
