import { describe, expect, it } from "bun:test";
import {
	FORK_DISTRIBUTION,
	FORK_NPM_PACKAGE_URL,
	FORK_PACKAGE,
	FORK_REPOSITORY,
	resolveForkDistribution,
	VERSION,
} from "@oh-my-pi/pi-coding-agent/distribution";

const VALID_RELEASE = {
	schemaVersion: 1,
	forkVersion: "17.2.12",
	upstreamVersion: "17.2.11",
	nativeVersion: "17.2.11",
	upstreamCommit: "08819b279cf02ae2545e69dad7111ab48d91d35e",
} as const;

describe("fork distribution metadata", () => {
	it("keeps the fork, upstream, native, repository, and tag identities independently observable", () => {
		expect(resolveForkDistribution(VALID_RELEASE)).toEqual({
			...VALID_RELEASE,
			packageName: "omp-cn",
			repository: "yequ172672/oh-my-pi-cn",
			releaseTag: "omp-cn-v17.2.12",
		});
	});

	it("rejects malformed release metadata before it can select packages or tags", () => {
		expect(() => resolveForkDistribution({ ...VALID_RELEASE, schemaVersion: 2 })).toThrow("schemaVersion must be 1");
		expect(() => resolveForkDistribution({ ...VALID_RELEASE, nativeVersion: "latest" })).toThrow(
			"nativeVersion must be a valid SemVer version",
		);
		expect(() => resolveForkDistribution({ ...VALID_RELEASE, upstreamCommit: "08819b2" })).toThrow(
			"upstreamCommit must be a 40-character lowercase Git SHA",
		);
	});

	it("exports the checked-in manifest through the same validated interface", () => {
		expect(VERSION).toBe(FORK_DISTRIBUTION.forkVersion);
		expect(FORK_DISTRIBUTION.packageName).toBe(FORK_PACKAGE);
		expect(FORK_DISTRIBUTION.repository).toBe(FORK_REPOSITORY);
		expect(FORK_NPM_PACKAGE_URL).toBe("https://registry.npmjs.org/omp-cn");
	});
});
