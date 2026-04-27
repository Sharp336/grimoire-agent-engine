import type { PluginManifest } from "../plugins/types";

export type PiCompatTier = 1 | 2 | 3 | 4;

export type PiCompatPathBridgeMode = "none" | "env" | "child-home" | "symlink" | "profile";

export type PiCompatSourceKind = "npm" | "git" | "local";

export interface PiCompatInstallSource {
	kind: PiCompatSourceKind;
	original: string;
	installSpec: string;
	packageNameHint?: string;
	localPath?: string;
	ref?: string;
}

export interface PiCompatProfile {
	packageNames: string[];
	expectedTier: PiCompatTier;
	requiresCliShim?: boolean;
	warnsHardcodedPiHome?: boolean;
	recommendedBridgeMode?: PiCompatPathBridgeMode;
	env?: Record<string, string>;
	notes?: string[];
}

export interface PiCompatManifestResult {
	manifest: PluginManifest | undefined;
	source: "omp" | "pi" | "conventional" | "none";
	conventionalResources: string[];
	ignoredPiKeys: string[];
}

export type PiCompatFindingStatus = "ok" | "info" | "warning" | "error";

export interface PiCompatFinding {
	status: PiCompatFindingStatus;
	code: string;
	message: string;
	paths?: string[];
}

export interface PiCompatDoctorReport {
	spec: string;
	packageName?: string;
	packagePath?: string;
	manifestSource: PiCompatManifestResult["source"];
	tier: PiCompatTier;
	tierLabel: string;
	recommendedBridgeMode: PiCompatPathBridgeMode;
	profile?: PiCompatProfile;
	findings: PiCompatFinding[];
	resources: {
		extensions: string[];
		skills: string[];
		prompts: string[];
		themes: string[];
	};
}

export interface PiCompatEnvOptions {
	packageName?: string;
	bridgeMode?: PiCompatPathBridgeMode;
	baseEnv?: NodeJS.ProcessEnv;
}

export interface PiCompatSymlinkPlan {
	mode: "create" | "exists-compatible" | "refuse-existing";
	linkPath: string;
	targetPath: string;
	message: string;
}
