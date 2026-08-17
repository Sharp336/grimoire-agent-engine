import { describe, expect, it } from "bun:test";
import {
	getRuntimeBuildInfo,
	parseEmbeddedSourceCommit,
	RUNTIME_BUILD_INFO_SCHEMA,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";

const SOURCE_COMMIT = "a".repeat(40);

describe("runtime build info", () => {
	it("parses a compiled source commit into the exact JSONL record", () => {
		const buildInfo = getRuntimeBuildInfo(SOURCE_COMMIT);

		expect(buildInfo).toEqual({
			schema: RUNTIME_BUILD_INFO_SCHEMA,
			name: "omp",
			version: VERSION,
			sourceCommit: SOURCE_COMMIT,
		});
		expect(`${JSON.stringify(buildInfo)}\n`).toBe(
			`{"schema":"sheltie.runtime-build-info/v1","name":"omp","version":"${VERSION}","sourceCommit":"${SOURCE_COMMIT}"}\n`,
		);
	});

	it("rejects missing and invalid source commits", () => {
		expect(parseEmbeddedSourceCommit(undefined)).toBeUndefined();
		expect(parseEmbeddedSourceCommit("A".repeat(40))).toBeUndefined();
		expect(parseEmbeddedSourceCommit("a".repeat(39))).toBeUndefined();
		expect(parseEmbeddedSourceCommit(`${SOURCE_COMMIT}\n`)).toBeUndefined();
		expect(getRuntimeBuildInfo(undefined)).toBeUndefined();
		expect(getRuntimeBuildInfo("A".repeat(40))).toBeUndefined();
	});

	it("does not let a source run claim ambient process or global state", () => {
		const globals = globalThis as Record<string, unknown>;
		const previousSourceCommit = process.env.PI_SOURCE_COMMIT;
		const previousGlobalSourceCommit = globals.PI_SOURCE_COMMIT;
		try {
			process.env.PI_SOURCE_COMMIT = SOURCE_COMMIT;
			globals.PI_SOURCE_COMMIT = SOURCE_COMMIT;
			expect(getRuntimeBuildInfo()).toBeUndefined();
		} finally {
			if (previousSourceCommit === undefined) {
				delete process.env.PI_SOURCE_COMMIT;
			} else {
				process.env.PI_SOURCE_COMMIT = previousSourceCommit;
			}
			if (previousGlobalSourceCommit === undefined) {
				delete globals.PI_SOURCE_COMMIT;
			} else {
				globals.PI_SOURCE_COMMIT = previousGlobalSourceCommit;
			}
		}
	});
});
