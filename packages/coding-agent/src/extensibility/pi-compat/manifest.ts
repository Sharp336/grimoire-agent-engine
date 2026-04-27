import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginFeature, PluginManifest } from "../plugins/types";
import type { PiCompatManifestResult } from "./types";

type PackageJsonWithPluginManifest = {
	name?: string;
	version?: string;
	omp?: Partial<PluginManifest>;
	pi?: Partial<PluginManifest>;
};

type ResourceKey = "extensions" | "skills" | "prompts" | "themes";

const RESOURCE_KEYS: ResourceKey[] = ["extensions", "skills", "prompts", "themes"];
const RECOGNIZED_PI_KEYS = new Set([
	"name",
	"version",
	"description",
	"tools",
	"hooks",
	"extensions",
	"commands",
	"features",
	"settings",
	"skills",
	"prompts",
	"themes",
]);

function cloneManifest(manifest: Partial<PluginManifest>, version: string): PluginManifest {
	const cloned = structuredClone(manifest) as PluginManifest;
	cloned.version = version;
	return cloned;
}

async function directoryExists(dir: string): Promise<boolean> {
	try {
		const stat = await fs.promises.stat(dir);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

async function findConventionalResources(packageRoot: string): Promise<Partial<Record<ResourceKey, string[]>>> {
	const result: Partial<Record<ResourceKey, string[]>> = {};
	await Promise.all(
		RESOURCE_KEYS.map(async key => {
			if (await directoryExists(path.join(packageRoot, key))) {
				result[key] = [key];
			}
		}),
	);
	return result;
}

function applyConventionalFallbacks(
	manifest: PluginManifest,
	conventional: Partial<Record<ResourceKey, string[]>>,
): string[] {
	const applied: string[] = [];
	for (const key of RESOURCE_KEYS) {
		if (!(key in manifest) && conventional[key]?.length) {
			manifest[key] = conventional[key];
			applied.push(key);
		}
	}
	return applied;
}

function normalizeFeatureResources(features: Record<string, PluginFeature> | undefined): void {
	if (!features) return;
	for (const feature of Object.values(features)) {
		for (const key of RESOURCE_KEYS) {
			const value = feature[key];
			if (typeof value === "string") {
				feature[key] = [value];
			}
		}
	}
}

export async function normalizePiCompatibleManifest(
	pkg: PackageJsonWithPluginManifest,
	packageRoot: string,
): Promise<PiCompatManifestResult> {
	const version = pkg.version ?? "0.0.0";
	const conventional = await findConventionalResources(packageRoot);
	const conventionalKeys = Object.keys(conventional);

	if (pkg.omp && typeof pkg.omp === "object") {
		const manifest = cloneManifest(pkg.omp, version);
		normalizeFeatureResources(manifest.features);
		applyConventionalFallbacks(manifest, conventional);
		return {
			manifest,
			source: "omp",
			conventionalResources: conventionalKeys,
			ignoredPiKeys: [],
		};
	}

	if (pkg.pi && typeof pkg.pi === "object") {
		const manifest = cloneManifest(pkg.pi, version);
		normalizeFeatureResources(manifest.features);
		applyConventionalFallbacks(manifest, conventional);
		const ignoredPiKeys = Object.keys(pkg.pi as Record<string, unknown>).filter(key => !RECOGNIZED_PI_KEYS.has(key));
		return {
			manifest,
			source: "pi",
			conventionalResources: conventionalKeys,
			ignoredPiKeys,
		};
	}

	if (conventionalKeys.length > 0) {
		const manifest: PluginManifest = { version };
		applyConventionalFallbacks(manifest, conventional);
		return {
			manifest,
			source: "conventional",
			conventionalResources: conventionalKeys,
			ignoredPiKeys: [],
		};
	}

	return {
		manifest: undefined,
		source: "none",
		conventionalResources: [],
		ignoredPiKeys: [],
	};
}

export function getPiManifestResourceKeys(): readonly ResourceKey[] {
	return RESOURCE_KEYS;
}
