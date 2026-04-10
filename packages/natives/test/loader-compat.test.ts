import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { REQUIRED_EXPORTS, patchNativeLoader } from "../scripts/patch-loader";

const require_ = createRequire(import.meta.url);
const loaderSourcePath = path.join(import.meta.dir, "../native/index.js");
const packageVersion = "99.99.99";
const tabWidthExports = new Set(["setDefaultTabWidth", "getDefaultTabWidth", "getIndentation"]);
const classExports = new Set([
	"ChunkState",
	"MacAppearanceObserver",
	"PhotonImage",
	"PtySession",
	"SearchDb",
	"Shell",
]);

interface LoaderFixture {
	rootDir: string;
	loaderPath: string;
	nativeDir: string;
	platformTag: string;
	canonicalFilename: string;
	xdgDataHome: string;
	versionedDir: string;
}

async function createLoaderFixture(): Promise<LoaderFixture> {
	const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-loader-"));
	const nativeDir = path.join(rootDir, "native");
	const loaderPath = path.join(nativeDir, "index.js");
	const xdgDataHome = path.join(rootDir, "xdg");
	const versionedDir = path.join(xdgDataHome, "omp", "natives", packageVersion);
	const platformTag = `${process.platform}-${process.arch}`;
	const canonicalFilename =
		process.arch === "x64"
			? `pi_natives.${platformTag}-baseline.node`
			: `pi_natives.${platformTag}.node`;

	await fs.mkdir(nativeDir, { recursive: true });
	await fs.mkdir(path.join(xdgDataHome, "omp"), { recursive: true });
	await Bun.write(path.join(rootDir, "package.json"), JSON.stringify({ version: packageVersion }, null, 2));
	await Bun.write(loaderPath, await Bun.file(loaderSourcePath).text());
	await patchNativeLoader(loaderPath);

	return { rootDir, loaderPath, nativeDir, platformTag, canonicalFilename, xdgDataHome, versionedDir };
}

function buildAddonModule(includeTabWidthExports: boolean): string {
	const lines = ["let tabWidth = 3;", "module.exports = {"];

	for (const name of REQUIRED_EXPORTS) {
		if (!includeTabWidthExports && tabWidthExports.has(name)) {
			continue;
		}
		if (name === "setDefaultTabWidth") {
			lines.push(`\t${name}(value) { tabWidth = value; },`);
			continue;
		}
		if (name === "getDefaultTabWidth" || name === "getIndentation") {
			lines.push(`\t${name}() { return tabWidth; },`);
			continue;
		}
		if (classExports.has(name)) {
			lines.push(`\t${name}: class ${name} {},`);
			continue;
		}
		lines.push(`\t${name}() {},`);
	}

	lines.push("};", "");
	return lines.join("\n");
}

function installFakeNodeExtension(): () => void {
	const extensions = require_.extensions as NodeJS.RequireExtensions;
	const original = extensions[".node"];
	const jsLoader = extensions[".js"];
	if (!jsLoader) {
		throw new Error("Missing .js loader");
	}
	extensions[".node"] = jsLoader;
	return () => {
		if (original) {
			extensions[".node"] = original;
		} else {
			delete extensions[".node"];
		}
	};
}

function purgeRequireCache(rootDir: string): void {
	for (const key of Object.keys(require_.cache)) {
		if (key.startsWith(rootDir)) {
			delete require_.cache[key];
		}
	}
}

function restoreEnv(key: string, previous: string | undefined): void {
	if (previous === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = previous;
}

describe("native loader compatibility", () => {
	it("prefers the bundled embedded addon when a cached compiled addon is stale", async () => {
		const fixture = await createLoaderFixture();
		const restoreNodeExtension = installFakeNodeExtension();
		const previousCompiled = process.env.PI_COMPILED;
		const previousVariant = process.env.PI_NATIVE_VARIANT;
		const previousXdg = process.env.XDG_DATA_HOME;

		try {
			process.env.PI_COMPILED = "1";
			if (process.arch === "x64") {
				process.env.PI_NATIVE_VARIANT = "baseline";
			}
			process.env.XDG_DATA_HOME = fixture.xdgDataHome;

			const bundledPath = path.join(fixture.rootDir, "bundled-addon.node");
			await Bun.write(bundledPath, buildAddonModule(true));
			await Bun.write(
				path.join(fixture.nativeDir, "embedded-addon.js"),
				[
					"module.exports = {",
					`\tembeddedAddon: {`,
					`\t\tplatformTag: ${JSON.stringify(fixture.platformTag)},`,
					`\t\tversion: ${JSON.stringify(packageVersion)},`,
					`\t\tfiles: [{ variant: ${JSON.stringify(process.arch === "x64" ? "baseline" : "default")}, filename: ${JSON.stringify(fixture.canonicalFilename)}, filePath: ${JSON.stringify(bundledPath)} }],`,
					"\t}",
					"};",
					"",
				].join("\n"),
			);
			await fs.mkdir(fixture.versionedDir, { recursive: true });
			await Bun.write(path.join(fixture.versionedDir, fixture.canonicalFilename), buildAddonModule(false));

			purgeRequireCache(fixture.rootDir);
			const native = require_(fixture.loaderPath) as {
				setDefaultTabWidth(width: number): void;
				getDefaultTabWidth(): number;
				getIndentation(): number;
			};
			native.setDefaultTabWidth(5);
			expect(native.getDefaultTabWidth()).toBe(5);
			expect(native.getIndentation()).toBe(5);
		} finally {
			purgeRequireCache(fixture.rootDir);
			restoreNodeExtension();
			restoreEnv("PI_COMPILED", previousCompiled);
			restoreEnv("PI_NATIVE_VARIANT", previousVariant);
			restoreEnv("XDG_DATA_HOME", previousXdg);
			await fs.rm(fixture.rootDir, { recursive: true, force: true });
		}
	});

	it("fails fast with explicit missing export names when only a stale addon is available", async () => {
		const fixture = await createLoaderFixture();
		const restoreNodeExtension = installFakeNodeExtension();
		const previousCompiled = process.env.PI_COMPILED;
		const previousVariant = process.env.PI_NATIVE_VARIANT;
		const previousXdg = process.env.XDG_DATA_HOME;

		try {
			delete process.env.PI_COMPILED;
			if (process.arch === "x64") {
				process.env.PI_NATIVE_VARIANT = "baseline";
			}
			delete process.env.XDG_DATA_HOME;
			await Bun.write(path.join(fixture.nativeDir, fixture.canonicalFilename), buildAddonModule(false));

			purgeRequireCache(fixture.rootDir);
			expect(() => require_(fixture.loaderPath)).toThrow(
				/Native addon missing required exports: .*setDefaultTabWidth.*getDefaultTabWidth.*getIndentation/,
			);
		} finally {
			purgeRequireCache(fixture.rootDir);
			restoreNodeExtension();
			restoreEnv("PI_COMPILED", previousCompiled);
			restoreEnv("PI_NATIVE_VARIANT", previousVariant);
			restoreEnv("XDG_DATA_HOME", previousXdg);
			await fs.rm(fixture.rootDir, { recursive: true, force: true });
		}
	});
});
