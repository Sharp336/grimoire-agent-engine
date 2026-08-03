export interface EmbeddedAddonFile {
	variant: "modern" | "baseline" | "default";
	filename: string;
	size: number;
	sha256: string;
	filePath?: string;
}

export interface EmbeddedAddonArchive {
	format: "tar.gz";
	filename: string;
	sha256: string;
	filePath: string;
}

export interface EmbeddedAddon {
	platformTag: string;
	napiAbi: number;
	version: string;
	files: EmbeddedAddonFile[];
	archive?: EmbeddedAddonArchive;
}

export interface DetectCompiledBinaryInput {
	embeddedAddon: EmbeddedAddon | null | undefined;
	env: Record<string, string | undefined>;
	importMetaUrl: string | null | undefined;
}

export function detectCompiledBinary(input: DetectCompiledBinaryInput): boolean;
export function selectNativePlatformTag(platform: string, arch: string): string;

export interface NativeAddonMetadata {
	platformTag: string;
	napiAbi: number;
	files: Record<string, { sha256: string }>;
}

export function validateNativeAddonMetadata(input: {
	metadata: unknown;
	platformTag: string;
	runtimeNapiAbi?: string | number;
	packageNapiAbi?: number;
}): NativeAddonMetadata;

export function verifyNativeAddonFile(input: { filePath: string; sha256: string }): void;

export function selectEmbeddedAddonFile(input: {
	addon: EmbeddedAddon;
	platformTag: string;
	arch: string;
	variant: "modern" | "baseline" | null;
	runtimeNapiAbi?: string | number;
}): EmbeddedAddonFile | null;


export interface GetAddonFilenamesInput {
	tag: string;
	arch: string;
	variant: "modern" | "baseline" | null | undefined;
}

export function getAddonFilenames(input: GetAddonFilenamesInput): string[];

export interface ShouldStageNodeModulesAddonInput {
	platform: NodeJS.Platform | string;
	isCompiledBinary: boolean;
	nativeDir: string;
}

export function shouldStageNodeModulesAddon(input: ShouldStageNodeModulesAddonInput): boolean;

export interface ResolveLoaderCandidatesInput {
	addonFilenames: string[];
	isCompiledBinary: boolean;
	stageFromNodeModules?: boolean;
	nativeDir: string;
	leafPackageDir?: string | null;
	execDir: string;
	versionedDir: string;
	userDataDir: string;
}

export function resolveLoaderCandidates(input: ResolveLoaderCandidatesInput): string[];

export interface InitLoaderContextOverrides {
	nativeDir?: string;
	platform?: NodeJS.Platform | string;
	arch?: string;
	runtimeNapiAbi?: string | number;
	isCompiledBinary?: boolean;
	leafPackageDir?: string | null;
	leafPackageManifest?: Record<string, unknown> | null;
}

export interface NativeLoaderContext {
	platformTag: string;
	platform: string;
	arch: string;
	runtimeNapiAbi: string | number;
	packageVersion: string;
	nativeDir: string;
	leafPackageDir: string | null;
	versionedDir: string;
	isCompiledBinary: boolean;
	stageFromNodeModules: boolean;
	selectedVariant: "modern" | "baseline" | null;
	addonFilenames: string[];
	addonLabel: string;
	candidates: string[];
	fileMetadata: Record<string, { sha256: string }> | null;
	requireCandidateMetadata: boolean;
	versionSentinelExport: string;
	isWorkspaceLoad: boolean;
	nativesDir: string;
}

export function initLoaderContext(overrides?: InitLoaderContextOverrides): NativeLoaderContext;

export interface CleanupStaleNativeVersionsInput {
	nativesDir: string;
	currentVersion: string;
}

export function cleanupStaleNativeVersions(input: CleanupStaleNativeVersionsInput): string[];

export interface ExtractEmbeddedAddonArchiveInput {
	archivePath: string;
	archiveSha256?: string;
	files: EmbeddedAddonFile[];
	targetDir: string;
}

export function extractEmbeddedAddonArchive(input: ExtractEmbeddedAddonArchiveInput): string[];

export interface SelectCpuVariantInput {
	arch: string;
	override: "modern" | "baseline" | null | undefined;
	env: Record<string, string | undefined>;
	detectAvx2: () => boolean;
}

export interface SelectCpuVariantResult {
	variant: "modern" | "baseline" | null;
	source: "non-x64" | "override" | "cache" | "detect";
	cacheEnvKey?: string;
	cacheEnvValue?: string;
}

export function selectCpuVariant(input: SelectCpuVariantInput): SelectCpuVariantResult;

export interface ValidateLoadedBindingsContext {
	isWorkspaceLoad: boolean;
	packageVersion: string;
	versionSentinelExport: string;
}

export function validateLoadedBindings(
	ctx: ValidateLoadedBindingsContext,
	bindings: Record<string, unknown>,
	candidate: string,
): void;

export function loadNative(): Record<string, unknown>;
