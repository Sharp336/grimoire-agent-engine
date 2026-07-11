import { homedir } from "node:os";
import { join } from "node:path";
import { type Env, envBool, envInt, envString } from "../util/env";

export const DEFAULT_ZVEC_DIR = join(homedir(), ".hermes", "zvec");
export const DEFAULT_ZVEC_CODE_INDEX = join(DEFAULT_ZVEC_DIR, "code-index");

export function zvecCodeIndexPath(env: Env = process.env): string {
	return envString("OMP_ZVEC_CODE_INDEX", DEFAULT_ZVEC_CODE_INDEX, env);
}

export function zvecChunkSize(env: Env = process.env): number {
	return envInt("OMP_ZVEC_CHUNK_SIZE", 100, env);
}

export function zvecChunkOverlap(env: Env = process.env): number {
	return envInt("OMP_ZVEC_CHUNK_OVERLAP", 10, env);
}

export function zvecTopK(env: Env = process.env): number {
	return envInt("OMP_ZVEC_TOP_K", 20, env);
}

export function zvecEnabled(env: Env = process.env): boolean {
	return envBool("OMP_ZVEC_ENABLED", true, env);
}
