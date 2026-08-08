import releaseManifest from "../fork-release.json" with { type: "json" };
import { type ForkReleaseManifest, parseForkReleaseManifest } from "./distribution-schema";

export * from "./distribution-schema";

export const FORK_PACKAGE = "omp-cn";
export const FORK_REPOSITORY = "yequ172672/oh-my-pi-cn";
export const FORK_NPM_REGISTRY = "https://registry.npmjs.org/";
export const FORK_NPM_PACKAGE_URL = `${FORK_NPM_REGISTRY}${FORK_PACKAGE}`;

export interface ForkDistribution extends ForkReleaseManifest {
	packageName: typeof FORK_PACKAGE;
	repository: typeof FORK_REPOSITORY;
	releaseTag: string;
}

/** Validate the persisted or registry-published fork release contract. */
export function resolveForkDistribution(value: unknown): ForkDistribution {
	const metadata = parseForkReleaseManifest(value);

	return {
		...metadata,
		packageName: FORK_PACKAGE,
		repository: FORK_REPOSITORY,
		releaseTag: `${FORK_PACKAGE}-v${metadata.forkVersion}`,
	};
}

/** Single runtime source of truth for this fork's independently versioned distribution. */
export const FORK_DISTRIBUTION: ForkDistribution = resolveForkDistribution(releaseManifest);

/** User-visible application version. Workspace packages retain their upstream version. */
export const VERSION = FORK_DISTRIBUTION.forkVersion;
