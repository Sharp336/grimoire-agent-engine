import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import {
	extractEmbeddedAddonArchive,
	initLoaderContext,
	selectEmbeddedAddonFile,
	selectNativePlatformTag,
	validateNativeAddonMetadata,
	verifyNativeAddonFile,
} from "../native/loader-state.js";

const sha256 = (content: Uint8Array | string) => crypto.createHash("sha256").update(content).digest("hex");
const armFilename = "pi_natives.win32-arm64.node";
const armHash = sha256("arm64 addon");
const armMetadata = {
	platformTag: "win32-arm64",
	napiAbi: 10,
	files: { [armFilename]: { sha256: armHash } },
};
function gzipTarEntry(filename: string, content: Buffer): Buffer {
	const header = Buffer.alloc(512);
	header.write(filename, 0, 100, "utf8");
	header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
	header[156] = "0".charCodeAt(0);
	const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
	return zlib.gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
}

describe("native target metadata", () => {
	it("selects win32-arm64 as a distinct supported host", () => {
		expect(selectNativePlatformTag("win32", "arm64")).toBe("win32-arm64");
		expect(() => selectNativePlatformTag("win32", "ia32")).toThrow("Unsupported platform: win32-ia32");
		expect(initLoaderContext({ platform: "win32", arch: "arm64", isCompiledBinary: false }).addonFilenames).toEqual([
			armFilename,
		]);
	});
	it("resolves only the matching installed arm64 leaf metadata", () => {
		const leafPackageDir = "C:\\app\\node_modules\\@oh-my-pi\\pi-natives-win32-arm64";
		const ctx = initLoaderContext({
			platform: "win32",
			arch: "arm64",
			runtimeNapiAbi: 10,
			isCompiledBinary: false,
			nativeDir: "C:\\app\\node_modules\\@oh-my-pi\\pi-natives\\native",
			leafPackageDir,
			leafPackageManifest: {
				name: "@oh-my-pi/pi-natives-win32-arm64",
				version: "17.2.4",
				os: ["win32"],
				cpu: ["arm64"],
				ompNative: armMetadata,
			},
		});
		expect(ctx.leafPackageDir).toBe(leafPackageDir);
		expect(ctx.candidates).toContain(path.join(leafPackageDir, armFilename));
		expect(ctx.candidates.join("\n")).not.toContain("win32-x64");
	});

	it("rejects wrong architecture and incompatible ABI metadata", () => {
		expect(() =>
			validateNativeAddonMetadata({ metadata: armMetadata, platformTag: "win32-x64", runtimeNapiAbi: 10 }),
		).toThrow("architecture mismatch");
		expect(() =>
			validateNativeAddonMetadata({ metadata: armMetadata, platformTag: "win32-arm64", runtimeNapiAbi: 9 }),
		).toThrow("ABI mismatch");
	});

	it("selects the arm64 embedded resource without a variant fallback", () => {
		const armFile = { variant: "default" as const, filename: armFilename, size: 1, sha256: armHash };
		expect(
			selectEmbeddedAddonFile({
				addon: { platformTag: "win32-arm64", napiAbi: 10, version: "17.2.4", files: [armFile] },
				platformTag: "win32-arm64",
				arch: "arm64",
				variant: null,
				runtimeNapiAbi: 10,
			}),
		).toBe(armFile);
	});

	it("does not select an x64 embedded resource for win32-arm64", () => {
		const x64Addon = {
			platformTag: "win32-x64",
			napiAbi: 10,
			version: "17.2.4",
			files: [
				{
					variant: "baseline" as const,
					filename: "pi_natives.win32-x64-baseline.node",
					size: 1,
					sha256: "a".repeat(64),
				},
			],
		};
		expect(() =>
			selectEmbeddedAddonFile({
				addon: x64Addon,
				platformTag: "win32-arm64",
				arch: "arm64",
				variant: null,
				runtimeNapiAbi: 10,
			}),
		).toThrow("architecture mismatch");
	});

	it("fails closed for a missing installed leaf", () => {
		expect(() =>
			initLoaderContext({
				platform: "win32",
				arch: "arm64",
				isCompiledBinary: false,
				nativeDir: "C:\\app\\node_modules\\@oh-my-pi\\pi-natives\\native",
				leafPackageDir: null,
			}),
		).toThrow("Missing native leaf package @oh-my-pi/pi-natives-win32-arm64");
	});

	it("rejects checksum drift", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-loader-hash-"));
		try {
			const filePath = path.join(root, armFilename);
			await Bun.write(filePath, "wrong addon");
			expect(() => verifyNativeAddonFile({ filePath, sha256: armHash })).toThrow("checksum mismatch");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects embedded archive checksum drift before extraction", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-loader-archive-hash-"));
		const targetDir = path.join(root, "target");
		const archivePath = path.join(root, "addons.tar.gz");
		try {
			await fs.mkdir(targetDir);
			await Bun.write(archivePath, gzipTarEntry(armFilename, Buffer.from("x")));
			expect(() =>
				extractEmbeddedAddonArchive({
					archivePath,
					archiveSha256: "a".repeat(64),
					files: [{ variant: "default", filename: armFilename, size: 1, sha256: sha256("x") }],
					targetDir,
				}),
			).toThrow("archive checksum mismatch");
			expect(await Bun.file(path.join(targetDir, armFilename)).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects archive traversal entries before writing any addon", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-loader-traversal-"));
		const targetDir = path.join(root, "target");
		const archivePath = path.join(root, "addons.tar.gz");
		try {
			await fs.mkdir(targetDir);
			await Bun.write(archivePath, gzipTarEntry("../escape.node", Buffer.from("x")));
			expect(() =>
				extractEmbeddedAddonArchive({
					archivePath,
					files: [{ variant: "default", filename: armFilename, size: 1, sha256: sha256("x") }],
					targetDir,
				}),
			).toThrow("Unsafe embedded addon archive entry");
			expect(await Bun.file(path.join(root, "escape.node")).exists()).toBe(false);
			expect(await Bun.file(path.join(targetDir, armFilename)).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlink or junction in the extraction target path", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-loader-target-link-"));
		const actualDir = path.join(root, "actual");
		const targetDir = path.join(root, "target");
		const archivePath = path.join(root, "addons.tar.gz");
		try {
			await fs.mkdir(actualDir);
			await fs.symlink(actualDir, targetDir, process.platform === "win32" ? "junction" : "dir");
			await Bun.write(archivePath, gzipTarEntry(armFilename, Buffer.from("x")));
			expect(() =>
				extractEmbeddedAddonArchive({
					archivePath,
					files: [{ variant: "default", filename: armFilename, size: 1, sha256: sha256("x") }],
					targetDir,
				}),
			).toThrow("Unsafe embedded addon target directory");
			expect(await Bun.file(path.join(actualDir, armFilename)).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
