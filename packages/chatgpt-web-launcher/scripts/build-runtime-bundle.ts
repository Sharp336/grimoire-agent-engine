import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const RUNTIME_EXTERNALS = Object.freeze([
	"playwright-core",
	"@modelcontextprotocol/sdk",
	"@oh-my-pi/pi-natives",
] as const);

export const NATIVE_TARGETS = Object.freeze({
	"darwin-arm64": Object.freeze({ platform: "darwin", arch: "arm64" }),
	"darwin-x64": Object.freeze({ platform: "darwin", arch: "x64" }),
	"linux-arm64": Object.freeze({ platform: "linux", arch: "arm64" }),
	"linux-x64": Object.freeze({ platform: "linux", arch: "x64" }),
	"win32-arm64": Object.freeze({ platform: "win32", arch: "arm64" }),
	"win32-x64": Object.freeze({ platform: "win32", arch: "x64" }),
} as const);

const REQUIRED_NATIVE_FILES = Object.freeze(["native/index.js", "native/loader-state.js", "native/embedded-addon.js"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
type NativeTarget = (typeof NATIVE_TARGETS)[keyof typeof NATIVE_TARGETS];
type JsonObject = Record<string, unknown>;

export interface BundleRoots {
	launcherRoot: string;
	ompRoot: string;
	providerRoot: string;
}

export interface BuildRuntimeOptions {
	output?: string;
	platform?: string;
	arch?: string;
	redistributeBun?: boolean;
}

export function resolveBundleRoots(scriptDirectory = import.meta.dir): BundleRoots {
	const launcherRoot = resolve(scriptDirectory, "..");
	const ompRoot = resolve(launcherRoot, "../..");
	const providerRoot = join(ompRoot, "packages", "chatgpt-web");
	return Object.freeze({ launcherRoot, ompRoot, providerRoot });
}

export function selectNativeTarget(platform: string, arch: string): { tag: string; platform: string; arch: string } {
	const tag = `${platform}-${arch}`;
	const target = NATIVE_TARGETS[tag as keyof typeof NATIVE_TARGETS] as NativeTarget | undefined;
	if (!target || target.platform !== platform || target.arch !== arch) throw new Error("unsupported_runtime_tuple");
	return Object.freeze({ tag, platform, arch });
}

export function safeRelativePath(root: string, candidate: string): string {
	const normalizedRoot = resolve(root);
	const normalizedCandidate = resolve(candidate);
	const value = relative(normalizedRoot, normalizedCandidate);
	if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value))
		throw new Error("unsafe_runtime_path");
	return value.split(sep).join("/");
}

function jsonFile(filePath: string): JsonObject {
	const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_runtime_manifest");
	return value as JsonObject;
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as JsonObject)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stableValue(child)]),
	);
}

function writeStableJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(stableValue(value), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function sha256File(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertPlainDirectory(directory: string): void {
	const info = lstatSync(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe_runtime_resource");
}

function assertPlainFile(filePath: string): void {
	const info = lstatSync(filePath);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("unsafe_runtime_resource");
}
function assertRuntimeExecutable(filePath: string): void {
	const info = lstatSync(filePath);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe_runtime_resource");
}

function ensureDirectory(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	assertPlainDirectory(directory);
}

function copyPlainFile(source: string, destination: string): void {
	assertPlainFile(source);
	ensureDirectory(dirname(destination));
	copyFileSync(source, destination);
	if (process.platform !== "win32") chmodSync(destination, 0o600);
}
function copyRuntimeExecutable(source: string, destination: string): void {
	assertRuntimeExecutable(source);
	ensureDirectory(dirname(destination));
	copyFileSync(source, destination);
	if (process.platform !== "win32") chmodSync(destination, 0o700);
}

function copyPlainTree(source: string, destination: string): void {
	assertPlainDirectory(source);
	ensureDirectory(destination);
	for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
			throw new Error("unsafe_runtime_resource");
		const from = join(source, entry.name);
		const to = join(destination, entry.name);
		if (entry.isDirectory()) copyPlainTree(from, to);
		else copyPlainFile(from, to);
	}
}

function packageDirectory(nodeModulesRoot: string, packageName: string): string {
	if (!PACKAGE_NAME_PATTERN.test(packageName)) throw new Error("invalid_runtime_dependency");
	const candidate = join(nodeModulesRoot, ...packageName.split("/"));
	assertPlainDirectory(candidate);
	if (realpathSync.native(candidate) !== candidate) throw new Error("linked_runtime_dependency");
	return candidate;
}

function runtimeDependencyNames(manifest: JsonObject): string[] {
	const names = new Set<string>();
	for (const field of ["dependencies", "optionalDependencies"] as const) {
		const dependencies = manifest[field];
		if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
			for (const name of Object.keys(dependencies as JsonObject)) names.add(name);
		}
	}
	const peers = manifest.peerDependencies;
	const metadata = manifest.peerDependenciesMeta;
	if (peers && typeof peers === "object" && !Array.isArray(peers)) {
		for (const name of Object.keys(peers as JsonObject)) {
			const item = metadata && typeof metadata === "object" ? (metadata as JsonObject)[name] : undefined;
			if (!(item && typeof item === "object" && (item as JsonObject).optional === true)) names.add(name);
		}
	}
	return [...names].sort();
}

function copyExternalClosure(nodeModulesRoot: string, appNodeModules: string, roots: readonly string[]) {
	const queued = [...roots].sort();
	const copied = new Set<string>();
	const locked: Array<{ name: string; version: string; manifestSha256: string }> = [];
	while (queued.length > 0) {
		const name = queued.shift();
		if (!name || copied.has(name) || name === "@oh-my-pi/pi-natives") continue;
		const source = packageDirectory(nodeModulesRoot, name);
		const manifestPath = join(source, "package.json");
		assertPlainFile(manifestPath);
		const manifest = jsonFile(manifestPath);
		if (manifest.name !== name || typeof manifest.version !== "string") throw new Error("invalid_runtime_dependency");
		copyPlainTree(source, join(appNodeModules, ...name.split("/")));
		copied.add(name);
		locked.push({ name, version: manifest.version, manifestSha256: sha256File(manifestPath) });
		for (const dependency of runtimeDependencyNames(manifest)) {
			if (!copied.has(dependency) && !queued.includes(dependency)) queued.push(dependency);
		}
		queued.sort();
	}
	return locked.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveNativeLeafRoot(ompRoot: string, tag: string): string {
	const candidates = [
		join(ompRoot, "packages", "natives", "npm", tag),
		join(ompRoot, "node_modules", "@oh-my-pi", `pi-natives-${tag}`),
	];
	const matches = candidates.filter(candidate => existsSync(candidate));
	if (matches.length !== 1) throw new Error("native_target_package_unavailable");
	assertPlainDirectory(matches[0]);
	if (realpathSync.native(matches[0]) !== matches[0]) throw new Error("linked_native_target_package");
	return matches[0];
}

function copyNativePackage(
	ompRoot: string,
	appNodeModules: string,
	target: { tag: string; platform: string; arch: string },
	expectedVersion: string,
): JsonObject {
	const sourceRoot = join(ompRoot, "packages", "natives");
	assertPlainDirectory(sourceRoot);
	const coreManifestPath = join(sourceRoot, "package.json");
	const coreManifest = jsonFile(coreManifestPath);
	if (coreManifest.name !== "@oh-my-pi/pi-natives" || coreManifest.version !== expectedVersion)
		throw new Error("native_package_identity_mismatch");
	const coreMetadata = coreManifest.ompNative as JsonObject | undefined;
	if (!coreMetadata || !Number.isInteger(coreMetadata.napiAbi)) throw new Error("native_package_metadata_invalid");
	const tags = coreMetadata.platformTags;
	if (!Array.isArray(tags) || !tags.includes(target.tag)) throw new Error("native_target_metadata_invalid");
	const coreDestination = join(appNodeModules, "@oh-my-pi", "pi-natives");
	copyPlainFile(coreManifestPath, join(coreDestination, "package.json"));
	for (const relativeFile of ["README.md", "CHANGELOG.md", ...REQUIRED_NATIVE_FILES]) {
		const source = join(sourceRoot, ...relativeFile.split("/"));
		if (REQUIRED_NATIVE_FILES.includes(relativeFile) && !existsSync(source))
			throw new Error("native_loader_resource_missing");
		if (existsSync(source)) copyPlainFile(source, join(coreDestination, ...relativeFile.split("/")));
	}
	for (const entry of readdirSync(join(sourceRoot, "native"), { withFileTypes: true })) {
		if (entry.isFile() && !entry.name.endsWith(".node") && !REQUIRED_NATIVE_FILES.includes(`native/${entry.name}`)) {
			copyPlainFile(join(sourceRoot, "native", entry.name), join(coreDestination, "native", entry.name));
		}
	}

	const leafSource = resolveNativeLeafRoot(ompRoot, target.tag);
	const leafManifestPath = join(leafSource, "package.json");
	const leafManifest = jsonFile(leafManifestPath);
	const leafMetadata = leafManifest.ompNative as JsonObject | undefined;
	if (
		leafManifest.name !== `@oh-my-pi/pi-natives-${target.tag}` ||
		leafManifest.version !== expectedVersion ||
		!Array.isArray(leafManifest.os) ||
		leafManifest.os.length !== 1 ||
		leafManifest.os[0] !== target.platform ||
		!Array.isArray(leafManifest.cpu) ||
		leafManifest.cpu.length !== 1 ||
		leafManifest.cpu[0] !== target.arch ||
		!leafMetadata ||
		leafMetadata.platformTag !== target.tag ||
		leafMetadata.napiAbi !== coreMetadata.napiAbi
	)
		throw new Error("native_target_identity_mismatch");
	const metadataFiles = leafMetadata.files;
	if (!metadataFiles || typeof metadataFiles !== "object" || Array.isArray(metadataFiles))
		throw new Error("native_target_metadata_invalid");
	const addonFiles = Object.keys(metadataFiles as JsonObject).sort();
	if (addonFiles.length === 0) throw new Error("native_target_addon_missing");
	const addonHashes: Record<string, string> = {};
	for (const addon of addonFiles) {
		if (basename(addon) !== addon || !addon.endsWith(".node")) throw new Error("native_target_metadata_invalid");
		const metadata = (metadataFiles as JsonObject)[addon];
		const expectedHash = metadata && typeof metadata === "object" ? (metadata as JsonObject).sha256 : undefined;
		if (typeof expectedHash !== "string" || !HASH_PATTERN.test(expectedHash))
			throw new Error("native_target_metadata_invalid");
		const addonPath = join(leafSource, addon);
		assertPlainFile(addonPath);
		const actualHash = sha256File(addonPath);
		if (actualHash !== expectedHash) throw new Error("native_target_checksum_mismatch");
		addonHashes[addon] = actualHash;
	}
	const leafDestination = join(appNodeModules, "@oh-my-pi", `pi-natives-${target.tag}`);
	copyPlainTree(leafSource, leafDestination);
	const copiedAddons = readdirSync(leafDestination)
		.filter(name => name.endsWith(".node"))
		.sort();
	if (JSON.stringify(copiedAddons) !== JSON.stringify(addonFiles)) throw new Error("native_target_layout_invalid");
	const selectedAddon = typeof leafManifest.main === "string" ? leafManifest.main.replace(/^\.\//, "") : addonFiles[0];
	if (!addonFiles.includes(selectedAddon)) throw new Error("native_target_entrypoint_invalid");
	return {
		package: "@oh-my-pi/pi-natives",
		version: expectedVersion,
		platformTag: target.tag,
		napiAbi: coreMetadata.napiAbi,
		packageRoot: "app/node_modules/@oh-my-pi/pi-natives",
		leafRoot: `app/node_modules/@oh-my-pi/pi-natives-${target.tag}`,
		addon: `app/node_modules/@oh-my-pi/pi-natives-${target.tag}/${selectedAddon}`,
		sha256: addonHashes[selectedAddon],
		manifestSha256: sha256File(coreManifestPath),
		leafManifestSha256: sha256File(leafManifestPath),
		addons: addonHashes,
	};
}

function copyNotices(providerRoot: string, output: string, redistributeBun: boolean): void {
	const licensesRoot = join(output, "LICENSES");
	ensureDirectory(licensesRoot);
	for (const name of ["NOTICE.md", "OpenCodex-MIT.txt"])
		copyPlainFile(join(providerRoot, "LICENSES", name), join(licensesRoot, name));
	const bunNotice = join(licensesRoot, "Bun-runtime.md");
	if (redistributeBun) {
		const source = join(providerRoot, "LICENSES", "Bun-runtime.md");
		if (!readFileSync(source, "utf8").includes(`Bun ${Bun.version}`)) throw new Error("bun_runtime_notice_mismatch");
		copyPlainFile(source, bunNotice);
	} else if (existsSync(bunNotice)) rmSync(bunNotice, { force: true });
}

function collectChecksums(root: string): Record<string, string> {
	const files: string[] = [];
	function visit(directory: string): void {
		assertPlainDirectory(directory);
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const value = join(directory, entry.name);
			if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
				throw new Error("unsafe_runtime_resource");
			if (entry.isDirectory()) visit(value);
			else if (safeRelativePath(root, value) !== "checksums.json") files.push(value);
		}
	}
	visit(root);
	return Object.fromEntries(
		files.map(file => [safeRelativePath(root, file), sha256File(file)]).sort(([a], [b]) => a.localeCompare(b)),
	);
}

function validateOutput(output: string, launcherRoot: string): string {
	const buildRoot = join(launcherRoot, "build");
	ensureDirectory(buildRoot);
	const normalized = resolve(output);
	safeRelativePath(buildRoot, normalized);
	if (existsSync(normalized)) {
		const info = lstatSync(normalized);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe_runtime_output");
	}
	return normalized;
}

async function bundleEntrypoint(entrypoint: string, outdir: string, naming: string): Promise<void> {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		target: "bun",
		format: "esm",
		minify: true,
		sourcemap: "none",
		splitting: false,
		packages: "bundle",
		external: [...RUNTIME_EXTERNALS],
		outdir,
		naming,
	});
	if (!result.success) throw new Error("runtime_bundle_build_failed");
}

async function bundleProviderLoader(launcherRoot: string): Promise<void> {
	const outputRoot = join(launcherRoot, "build");
	ensureDirectory(outputRoot);
	const result = await Bun.build({
		entrypoints: [join(launcherRoot, "scripts", "provider-runtime-entry.ts")],
		target: "node",
		format: "cjs",
		minify: true,
		sourcemap: "none",
		splitting: false,
		packages: "bundle",
		external: [...RUNTIME_EXTERNALS],
		outdir: outputRoot,
		naming: "provider-runtime.cjs",
	});
	if (!result.success) throw new Error("provider_runtime_loader_build_failed");
}

export async function buildRuntimeBundle(options: BuildRuntimeOptions = {}): Promise<string> {
	const { launcherRoot, ompRoot, providerRoot } = resolveBundleRoots();
	const launcherManifest = jsonFile(join(launcherRoot, "package.json"));
	const providerManifest = jsonFile(join(providerRoot, "package.json"));
	if (
		launcherManifest.name !== "@oh-my-pi/pi-chatgpt-web-launcher" ||
		launcherManifest.version !== providerManifest.version ||
		typeof launcherManifest.version !== "string"
	)
		throw new Error("runtime_package_version_mismatch");
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const target = selectNativeTarget(platform, arch);
	const redistributeBun = options.redistributeBun === true;
	if (redistributeBun && (platform !== process.platform || arch !== process.arch))
		throw new Error("cross_runtime_bundle_forbidden");
	const output = validateOutput(options.output ?? join(launcherRoot, "build", "runtime"), launcherRoot);
	rmSync(output, { recursive: true, force: true });
	const appRoot = join(output, "app");
	const appNodeModules = join(appRoot, "node_modules");
	ensureDirectory(appNodeModules);
	await bundleEntrypoint(join(providerRoot, "src", "cli.ts"), appRoot, "cli.js");
	await bundleEntrypoint(join(providerRoot, "src", "mcp", "main.ts"), appRoot, "mcp-main.js");
	await bundleProviderLoader(launcherRoot);
	const externalLock = copyExternalClosure(join(ompRoot, "node_modules"), appNodeModules, [
		"playwright-core",
		"@modelcontextprotocol/sdk",
	]);
	const native = copyNativePackage(ompRoot, appNodeModules, target, launcherManifest.version);
	if (typeof native.manifestSha256 !== "string" || typeof native.leafManifestSha256 !== "string") {
		throw new Error("native_lock_metadata_invalid");
	}
	const runtimeLock = [
		...externalLock,
		{ name: "@oh-my-pi/pi-natives", version: launcherManifest.version, manifestSha256: native.manifestSha256 },
		{
			name: `@oh-my-pi/pi-natives-${target.tag}`,
			version: launcherManifest.version,
			manifestSha256: native.leafManifestSha256,
		},
	].sort((a, b) => a.name.localeCompare(b.name));
	const externalVersions: Record<string, string> = Object.fromEntries(
		runtimeLock.map(entry => [entry.name, entry.version]),
	);
	writeStableJson(join(appRoot, "package.json"), {
		name: "@oh-my-pi/pi-chatgpt-web-runtime",
		version: launcherManifest.version,
		private: true,
		type: "module",
		dependencies: externalVersions,
	});
	writeStableJson(join(appRoot, "external-lock.json"), { schemaVersion: 1, packages: runtimeLock });
	let runtime: JsonObject = { kind: "external" };
	if (redistributeBun) {
		if (!Bun.version) throw new Error("bun_runtime_unavailable");
		const executableName = platform === "win32" ? "bun.exe" : "bun";
		const runtimeDirectory = join(output, "runtime");
		ensureDirectory(runtimeDirectory);
		const sourceExecutable = realpathSync.native(process.execPath);
		copyRuntimeExecutable(sourceExecutable, join(runtimeDirectory, executableName));
		runtime = { kind: "bun", version: Bun.version, executable: `runtime/${executableName}` };
	}
	copyNotices(providerRoot, output, redistributeBun);
	writeStableJson(join(output, "manifest.json"), {
		schemaVersion: 1,
		appVersion: launcherManifest.version,
		platform,
		arch,
		entrypoints: { cli: "app/cli.js", mcp: "app/mcp-main.js" },
		runtime,
		native,
		externals: [...RUNTIME_EXTERNALS],
	});
	writeStableJson(join(output, "checksums.json"), { algorithm: "sha256", files: collectChecksums(output) });
	return output;
}

function parseArguments(argv: readonly string[]): BuildRuntimeOptions {
	const options: BuildRuntimeOptions = {};
	for (const argument of argv) {
		if (argument === "--redistribute-bun") options.redistributeBun = true;
		else if (argument.startsWith("--output=")) options.output = argument.slice("--output=".length);
		else if (argument.startsWith("--platform=")) options.platform = argument.slice("--platform=".length);
		else if (argument.startsWith("--arch=")) options.arch = argument.slice("--arch=".length);
		else throw new Error("invalid_runtime_bundle_argument");
	}
	return options;
}

if (import.meta.main) await buildRuntimeBundle(parseArguments(process.argv.slice(2)));
