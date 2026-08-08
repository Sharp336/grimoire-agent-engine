import { describe, expect, it } from "bun:test";
import {
	createForkManifest,
	FORK_NPM_PACKAGE,
	FORK_PACKAGE_DESCRIPTION,
	FORK_REPOSITORY,
} from "./publish-fork-package";

describe("fork npm package manifest", () => {
	it("publishes the localized CLI under its own npm identity while retaining MIT metadata", () => {
		const manifest = createForkManifest({
			name: "@oh-my-pi/pi-coding-agent",
			license: "MIT",
			bin: { omp: "dist/cli.js" },
		});

		expect(manifest.name).toBe(FORK_NPM_PACKAGE);
		expect(manifest.description).toBe(FORK_PACKAGE_DESCRIPTION);
		expect(manifest.author).toBe("yequ172672");
		expect(manifest.contributors).toEqual(["Mario Zechner", "Can Boluk"]);
		expect(manifest.license).toBe("MIT");
		expect(manifest.homepage).toBe(`https://github.com/${FORK_REPOSITORY}`);
		expect(manifest.repository).toEqual({
			type: "git",
			url: `git+https://github.com/${FORK_REPOSITORY}.git`,
			directory: "packages/coding-agent",
		});
		expect(manifest.bin).toEqual({ omp: "dist/cli.js" });
	});
});
