import * as fs from "node:fs";
import * as path from "node:path";
import { getPluginsNodeModules, isEnoent } from "@oh-my-pi/pi-utils";
import { extractPackageName } from "../plugins/parser";
import { normalizePiCompatibleManifest } from "./manifest";
import { findPiCompatProfile } from "./profiles";
import { parsePiInstallSource } from "./source";
import type { PiCompatDoctorReport, PiCompatFinding, PiCompatTier } from "./types";

type PackageJson = {
	name?: string;
	version?: string;
	scripts?: Record<string, string>;
	omp?: Record<string, unknown>;
	pi?: Record<string, unknown>;
};

interface ScanResult {
	imports: string[];
	piExecutableCalls: string[];
	piHomePaths: string[];
	envNames: string[];
}

const TEXT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".md",
	".yml",
	".yaml",
	".sh",
	".bash",
]);
const MAX_SCAN_BYTES = 1024 * 1024;
const INSTALL_SCRIPT_NAMES = new Set(["preinstall", "install", "postinstall", "prepare"]);

function tierLabel(tier: PiCompatTier): string {
	switch (tier) {
		case 1:
			return "Tier 1 - manifest/API compatible";
		case 2:
			return "Tier 2 - process compatible";
		case 3:
			return "Tier 3 - legacy path compatible";
		case 4:
			return "Tier 4 - patch/profile required";
	}
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function addFinding(findings: PiCompatFinding[], finding: PiCompatFinding): void {
	findings.push(finding);
}

function shouldScanFile(filePath: string): boolean {
	return TEXT_EXTENSIONS.has(path.extname(filePath));
}

async function collectFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	async function visit(dir: string): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath);
				continue;
			}
			if (entry.isFile() && shouldScanFile(entryPath)) {
				result.push(entryPath);
			}
		}
	}
	await visit(root);
	return result;
}

function scanContent(content: string, filePath: string, result: ScanResult): void {
	const importPattern =
		/(?:from\s+["']|import\s*\(\s*["']|require\s*\(\s*["'])(@mariozechner\/[^"']+|typebox(?:\/[^"']+)?|@sinclair\/typebox\/compile)["']/g;
	for (const match of content.matchAll(importPattern)) {
		result.imports.push(match[1]);
	}

	if (/\bspawn(?:Sync)?\s*\(\s*["']pi["']/.test(content) || /\bexecFile(?:Sync)?\s*\(\s*["']pi["']/.test(content)) {
		result.piExecutableCalls.push(filePath);
	}

	if (/~\/\.pi|\.pi\/|["']\.pi["']|homedir\s*\(\s*\)\s*,\s*["']\.pi["']/.test(content)) {
		result.piHomePaths.push(filePath);
	}

	for (const match of content.matchAll(/\bPI_[A-Z0-9_]+\b/g)) {
		result.envNames.push(match[0]);
	}
}

async function scanPackage(packagePath: string): Promise<ScanResult> {
	const result: ScanResult = { imports: [], piExecutableCalls: [], piHomePaths: [], envNames: [] };
	const files = await collectFiles(packagePath);
	await Promise.all(
		files.map(async filePath => {
			try {
				const stat = await fs.promises.stat(filePath);
				if (stat.size > MAX_SCAN_BYTES) return;
				const content = await Bun.file(filePath).text();
				scanContent(content, filePath, result);
			} catch {
				// Ignore unreadable files; package code may contain generated artifacts with odd permissions.
			}
		}),
	);
	result.imports = unique(result.imports);
	result.piExecutableCalls = unique(result.piExecutableCalls);
	result.piHomePaths = unique(result.piHomePaths);
	result.envNames = unique(result.envNames);
	return result;
}

async function readPackageJson(packagePath: string): Promise<PackageJson | undefined> {
	try {
		return (await Bun.file(path.join(packagePath, "package.json")).json()) as PackageJson;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

function installedPackagePathForSpec(spec: string, cwd: string): { packagePath?: string; packageName?: string } {
	const source = parsePiInstallSource(spec, cwd);
	if (source.kind === "local" && source.localPath) {
		return { packagePath: source.localPath, packageName: source.packageNameHint };
	}
	const packageName = source.packageNameHint ? extractPackageName(source.packageNameHint) : undefined;
	if (!packageName) return {};
	const packagePath = path.join(getPluginsNodeModules(), packageName);
	if (fs.existsSync(path.join(packagePath, "package.json"))) {
		return { packagePath, packageName };
	}
	return { packageName };
}

function installScriptNames(pkg: PackageJson | undefined): string[] {
	if (!pkg?.scripts) return [];
	return Object.keys(pkg.scripts).filter(name => INSTALL_SCRIPT_NAMES.has(name));
}

export async function doctorPiCompatTarget(spec: string, cwd: string = process.cwd()): Promise<PiCompatDoctorReport> {
	const { packagePath, packageName: packageNameHint } = installedPackagePathForSpec(spec, cwd);
	const pkg = packagePath ? await readPackageJson(packagePath) : undefined;
	const packageName = pkg?.name ?? packageNameHint;
	const profile = findPiCompatProfile(packageName);
	const manifestResult = packagePath && pkg ? await normalizePiCompatibleManifest(pkg, packagePath) : undefined;
	const manifest = manifestResult?.manifest;
	const findings: PiCompatFinding[] = [];
	let tier: PiCompatTier = profile?.expectedTier ?? 1;

	if (packagePath && pkg) {
		if (manifest) {
			addFinding(findings, {
				status: "ok",
				code: "manifest",
				message: `${manifestResult?.source ?? "none"} manifest found`,
			});
		} else {
			addFinding(findings, {
				status: "warning",
				code: "manifest_missing",
				message: "No package.json omp/pi manifest or conventional Pi resource directories found",
			});
		}
		if (manifestResult?.ignoredPiKeys.length) {
			addFinding(findings, {
				status: "warning",
				code: "unsupported_pi_keys",
				message: `Unsupported Pi manifest keys: ${manifestResult.ignoredPiKeys.join(", ")}`,
			});
		}
	} else {
		addFinding(findings, {
			status: "info",
			code: "not_installed",
			message:
				"Package source was not installed or linked locally; doctor used source parsing and known profiles only",
		});
	}

	if (profile) {
		addFinding(findings, {
			status: "info",
			code: "profile",
			message: `Known Pi compatibility profile: ${profile.packageNames[0]}`,
		});
	}

	const scan = packagePath
		? await scanPackage(packagePath)
		: { imports: [], piExecutableCalls: [], piHomePaths: [], envNames: [] };
	if (scan.imports.length > 0) {
		addFinding(findings, {
			status: "warning",
			code: "pi_import_aliases",
			message: `Imports require Pi alias shims: ${scan.imports.join(", ")}`,
		});
	}
	if (scan.piExecutableCalls.length > 0 || profile?.requiresCliShim) {
		tier = tier < 2 ? 2 : tier;
		addFinding(findings, {
			status: "warning",
			code: "pi_cli_shim",
			message: "Package calls the pi executable; enable the scoped OMP pi CLI shim for child processes",
			paths: scan.piExecutableCalls,
		});
	}
	if (scan.piHomePaths.length > 0 || profile?.warnsHardcodedPiHome) {
		tier = tier < 3 ? 3 : tier;
		addFinding(findings, {
			status: "warning",
			code: "legacy_pi_paths",
			message:
				"Package references .pi or ~/.pi paths; use env/profile/child-home bridge first, symlink mode only with explicit consent",
			paths: scan.piHomePaths,
		});
	}

	const scripts = installScriptNames(pkg);
	if (scripts.length > 0) {
		tier = tier < 4 ? 4 : tier;
		addFinding(findings, {
			status: "warning",
			code: "install_scripts",
			message: `Package defines install-time scripts (${scripts.join(", ")}); inspect before running arbitrary code`,
		});
	}

	if (scan.envNames.length > 0) {
		addFinding(findings, {
			status: "info",
			code: "env_overrides",
			message: `Pi-related env vars referenced: ${scan.envNames.join(", ")}`,
		});
	}

	const resources = {
		extensions: manifest?.extensions ?? [],
		skills: manifest?.skills ?? [],
		prompts: manifest?.prompts ?? [],
		themes: manifest?.themes ?? [],
	};
	const resourceCount = Object.values(resources).reduce((sum, entries) => sum + entries.length, 0);
	addFinding(findings, {
		status: resourceCount > 0 ? "ok" : "info",
		code: "resources",
		message: resourceCount > 0 ? `Resolved ${resourceCount} Pi resource path(s)` : "No Pi package resources resolved",
	});

	return {
		spec,
		packageName,
		packagePath,
		manifestSource: manifestResult?.source ?? "none",
		tier,
		tierLabel: tierLabel(tier),
		recommendedBridgeMode: profile?.recommendedBridgeMode ?? (tier >= 3 ? "child-home" : tier >= 2 ? "env" : "none"),
		profile,
		findings,
		resources,
	};
}
