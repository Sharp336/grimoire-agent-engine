const SEMVER_PATTERN =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export interface ForkReleaseManifest {
	schemaVersion: 1;
	forkVersion: string;
	upstreamVersion: string;
	nativeVersion: string;
	upstreamCommit: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isValidReleaseVersion(value: unknown): value is string {
	return typeof value === "string" && SEMVER_PATTERN.test(value);
}

function requireSemver(value: unknown, field: string): string {
	if (!isValidReleaseVersion(value)) {
		throw new Error(`Invalid fork release metadata: ${field} must be a valid SemVer version`);
	}
	return value;
}

/** Parse the one strict schema shared by runtime, packaging, updates, and release tooling. */
export function parseForkReleaseManifest(value: unknown): ForkReleaseManifest {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		throw new Error("Invalid fork release metadata: schemaVersion must be 1");
	}
	const forkVersion = requireSemver(value.forkVersion, "forkVersion");
	const upstreamVersion = requireSemver(value.upstreamVersion, "upstreamVersion");
	const nativeVersion = requireSemver(value.nativeVersion, "nativeVersion");
	if (typeof value.upstreamCommit !== "string" || !GIT_COMMIT_PATTERN.test(value.upstreamCommit)) {
		throw new Error("Invalid fork release metadata: upstreamCommit must be a 40-character lowercase Git SHA");
	}
	return {
		schemaVersion: 1,
		forkVersion,
		upstreamVersion,
		nativeVersion,
		upstreamCommit: value.upstreamCommit,
	};
}
