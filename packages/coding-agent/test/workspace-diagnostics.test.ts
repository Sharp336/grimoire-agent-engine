import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { describe, expect, test } from "bun:test";
import { detectProjectType, interpretEmptyDiagnosticsResult } from "../src/lsp/workspace-diagnostics";

const command = ["npx", "tsc", "--noEmit"];

describe("interpretEmptyDiagnosticsResult", () => {
	test("reports a silent non-zero exit as an unverified workspace", () => {
		expect(interpretEmptyDiagnosticsResult(17, null, command)).toBe(
			"Failed to run npx tsc --noEmit: the checker exited with code 17 without reporting anything, so the workspace was not verified",
		);
	});

	test("reports a signal when the checker was killed silently", () => {
		expect(interpretEmptyDiagnosticsResult(137, "SIGKILL", command)).toBe(
			"Failed to run npx tsc --noEmit: the checker was killed by SIGKILL without reporting anything, so the workspace was not verified",
		);
	});

	test("preserves the clean-workspace result for a successful silent checker", () => {
		expect(interpretEmptyDiagnosticsResult(0, null, command)).toBe("No issues found");
	});
});

describe("detectProjectType", () => {
	test("detects a Dart project from pubspec.yaml", async () => {
		const tempDir = TempDir.createSync("@omp-workspace-diagnostics-dart-");
		try {
			// Detection only tests for the marker's existence; the manifest is never parsed.
			await Bun.write(path.join(tempDir.path(), "pubspec.yaml"), "name: demo\n");

			const projectType = await detectProjectType(tempDir.path());

			expect(projectType.type).toBe("dart");
			expect(projectType.command).toEqual(["dart", "analyze"]);
		} finally {
			tempDir.removeSync();
		}
	});

	test("keeps existing markers ahead of Dart when both are present", async () => {
		// `pubspec.yaml` is checked last, so a polyglot root still resolves to the
		// established checker rather than silently switching to `dart analyze`.
		const tempDir = TempDir.createSync("@omp-workspace-diagnostics-polyglot-");
		try {
			await Bun.write(path.join(tempDir.path(), "pubspec.yaml"), "name: demo\n");
			await Bun.write(path.join(tempDir.path(), "Cargo.toml"), '[package]\nname = "demo"\nversion = "0.0.0"\n');

			expect((await detectProjectType(tempDir.path())).type).toBe("rust");
		} finally {
			tempDir.removeSync();
		}
	});

	test("reports unknown when no marker is present", async () => {
		const tempDir = TempDir.createSync("@omp-workspace-diagnostics-empty-");
		try {
			const projectType = await detectProjectType(tempDir.path());

			expect(projectType.type).toBe("unknown");
			expect(projectType.command).toBeUndefined();
		} finally {
			tempDir.removeSync();
		}
	});
});
