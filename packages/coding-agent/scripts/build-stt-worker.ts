import * as path from "node:path";

/**
 * Builds the FluidAudio Nemotron STT worker (native/stt-nemotron) with SwiftPM
 * in release mode. The resulting binary is picked up automatically in dev via
 * the workspace lookup in `src/stt/nemotron-worker-client.ts`; production
 * builds copy it next to the compiled `omp` binary.
 */
const packageDir = path.resolve(import.meta.dir, "..", "native", "stt-nemotron");

const result = Bun.spawnSync(["swift", "build", "-c", "release"], {
	cwd: packageDir,
	stdout: "inherit",
	stderr: "inherit",
});

if (result.exitCode !== 0) {
	process.exit(result.exitCode ?? 1);
}

const binary = path.join(packageDir, ".build", "release", "stt-nemotron");
console.log(`stt-nemotron worker built: ${binary}`);
