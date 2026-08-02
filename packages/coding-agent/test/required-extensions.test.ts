import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	loadExtensions,
	RequiredExtensionValidationError,
	validateRequiredExtensionOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { TempDir } from "@oh-my-pi/pi-utils";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const EXTENSION_SOURCE = `export default function (pi) { pi.registerCommand("required-test", { handler: async () => {} }); }`;

function writeExtension(dir: string, name: string): string {
	const extensionPath = path.join(dir, name);
	fs.writeFileSync(extensionPath, EXTENSION_SOURCE);
	return extensionPath;
}

async function digest(extensionPath: string): Promise<string> {
	return Bun.SHA256.hash(new Uint8Array(await Bun.file(extensionPath).arrayBuffer()), "hex");
}

describe("required extension CLI and loading contract", () => {
	it("parses repeatable required paths and digests and validates the receipt option", () => {
		const parsed = parseArgs([
			"--required-extension",
			"/tmp/one.ts",
			"--required-extension",
			"/tmp/two.ts",
			"--required-extension-sha256",
			DIGEST,
			"--required-extension-sha256",
			DIGEST,
			"--extension-load-receipt",
			"receipt.json",
		]);
		expect(parsed.requiredExtensions).toEqual(["/tmp/one.ts", "/tmp/two.ts"]);
		expect(parsed.requiredExtensionSha256).toEqual([DIGEST, DIGEST]);
		expect(parsed.extensionLoadReceipt).toBe("receipt.json");
	});

	it("rejects incomplete, relative, malformed, and conflicting required options", () => {
		expect(() => parseArgs(["--required-extension", "/tmp/one.ts"])).toThrow(RequiredExtensionValidationError);
		expect(() => parseArgs(["--required-extension", "relative.ts", "--required-extension-sha256", DIGEST])).toThrow(
			/absolute/,
		);
		expect(() => parseArgs(["--required-extension", "/tmp/one.ts", "--required-extension-sha256", "bad"])).toThrow(
			/64 hexadecimal/,
		);
		expect(() =>
			parseArgs([
				"--required-extension",
				"/tmp/one.ts",
				"--required-extension-sha256",
				DIGEST,
				"--extension",
				"/tmp/other.ts",
			]),
		).toThrow(/cannot be combined/);
		expect(() => validateRequiredExtensionOptions({ extensionLoadReceipt: "receipt.json" })).toThrow(/requires/);
	});

	it("fails closed on digest mismatch and does not write a receipt", async () => {
		const tempDir = TempDir.createSync("@pi-required-extension-");
		try {
			const extensionPath = writeExtension(tempDir.path(), "one.ts");
			const receiptPath = path.join(tempDir.path(), "receipt.json");
			const required = validateRequiredExtensionOptions({
				requiredExtensions: [extensionPath],
				requiredExtensionSha256: [DIGEST],
				extensionLoadReceipt: receiptPath,
			});
			if (!required) throw new Error("expected required options");

			await expect(loadExtensions([extensionPath], tempDir.path(), undefined, required)).rejects.toMatchObject({
				code: "digest-mismatch",
			});
			expect(await Bun.file(receiptPath).exists()).toBe(false);
		} finally {
			tempDir.removeSync();
		}
	});

	it("rejects an extension outside the exact required set", async () => {
		const tempDir = TempDir.createSync("@pi-required-extension-");
		try {
			const requiredPath = writeExtension(tempDir.path(), "required.ts");
			const unexpectedPath = writeExtension(tempDir.path(), "unexpected.ts");
			const required = validateRequiredExtensionOptions({
				requiredExtensions: [requiredPath],
				requiredExtensionSha256: [await digest(requiredPath)],
			});
			if (!required) throw new Error("expected required options");

			await expect(
				loadExtensions([requiredPath, unexpectedPath], tempDir.path(), undefined, required),
			).rejects.toMatchObject({
				code: "unexpected-extension",
			});
		} finally {
			tempDir.removeSync();
		}
	});

	it("writes a v1 receipt only after every required extension loads", async () => {
		const tempDir = TempDir.createSync("@pi-required-extension-");
		try {
			const extensionPath = writeExtension(tempDir.path(), "one.ts");
			const receiptPath = path.join(tempDir.path(), "nested", "receipt.json");
			const sha256 = await digest(extensionPath);
			const required = validateRequiredExtensionOptions({
				requiredExtensions: [extensionPath],
				requiredExtensionSha256: [sha256],
				extensionLoadReceipt: receiptPath,
			});
			if (!required) throw new Error("expected required options");

			const result = await loadExtensions([extensionPath], tempDir.path(), undefined, required);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			const receipt = await Bun.file(receiptPath).json();
			expect(receipt.schema).toBe("omp.required-extension-load.v1");
			expect(receipt.pid).toBe(process.pid);
			expect(receipt.loaded_at).toMatch(/Z$/);
			expect(receipt.extensions).toEqual([{ path: await fs.promises.realpath(extensionPath), sha256 }]);
		} finally {
			tempDir.removeSync();
		}
	});

	it("does not write a receipt when a later required extension fails to import", async () => {
		const tempDir = TempDir.createSync("@pi-required-extension-");
		try {
			const goodPath = writeExtension(tempDir.path(), "good.ts");
			const badPath = path.join(tempDir.path(), "bad.ts");
			fs.writeFileSync(badPath, `throw new Error("required load failure");`);
			const receiptPath = path.join(tempDir.path(), "receipt.json");
			const required = validateRequiredExtensionOptions({
				requiredExtensions: [goodPath, badPath],
				requiredExtensionSha256: [await digest(goodPath), await digest(badPath)],
				extensionLoadReceipt: receiptPath,
			});
			if (!required) throw new Error("expected required options");

			await expect(loadExtensions([goodPath, badPath], tempDir.path(), undefined, required)).rejects.toMatchObject({
				code: "load-failure",
			});
			expect(await Bun.file(receiptPath).exists()).toBe(false);
		} finally {
			tempDir.removeSync();
		}
	});
	it("reuses the verified entry and imported sibling snapshots on reload", async () => {
		const tempDir = TempDir.createSync("@pi-required-extension-snapshot-");
		try {
			const siblingPath = path.join(tempDir.path(), "sibling.ts");
			const extensionPath = path.join(tempDir.path(), "entry.ts");
			fs.writeFileSync(
				siblingPath,
				`export default function (pi) { pi.registerCommand("verified-sibling", { handler: async () => {} }); }`,
			);
			fs.writeFileSync(extensionPath, `export { default } from "./sibling.ts";`);
			const required = validateRequiredExtensionOptions({
				requiredExtensions: [extensionPath],
				requiredExtensionSha256: [await digest(extensionPath)],
			});
			if (!required) throw new Error("expected required options");

			const first = await loadExtensions([extensionPath], tempDir.path(), undefined, required);
			fs.writeFileSync(
				siblingPath,
				`export default function (pi) { pi.registerCommand("mutated", { handler: async () => {} }); }`,
			);
			fs.writeFileSync(extensionPath, `throw new Error("entry swapped");`);

			const secondOptions = first.requiredExtensionOptions;
			if (!secondOptions) throw new Error("expected effective required options");
			const second = await loadExtensions([extensionPath], tempDir.path(), undefined, secondOptions);
			expect(second.extensions[0]?.commands.has("verified-sibling")).toBe(true);
			expect(second.extensions[0]?.commands.has("mutated")).toBe(false);
		} finally {
			tempDir.removeSync();
		}
	});
	it("restores ordinary disk-backed reloads after required loading", async () => {
		const tempDir = TempDir.createSync("@pi-required-extension-mode-");
		try {
			const extensionPath = writeExtension(tempDir.path(), "mode.ts");
			const required = validateRequiredExtensionOptions({
				requiredExtensions: [extensionPath],
				requiredExtensionSha256: [await digest(extensionPath)],
			});
			if (!required) throw new Error("expected required options");
			await loadExtensions([extensionPath], tempDir.path(), undefined, required);
			fs.writeFileSync(
				extensionPath,
				`export default function (pi) { pi.registerCommand("ordinary-reload", { handler: async () => {} }); }`,
			);
			const ordinary = await loadExtensions([extensionPath], tempDir.path());
			expect(ordinary.extensions[0]?.commands.has("ordinary-reload")).toBe(true);
		} finally {
			tempDir.removeSync();
		}
	});
});
