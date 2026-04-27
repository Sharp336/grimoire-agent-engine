import * as fs from "node:fs";
import * as path from "node:path";
import { buildPiCompatEnv, ensurePiCompatHome, getPiCompatBinDir } from "./path-bridge";
import type { PiCompatEnvOptions } from "./types";

export interface PiCliShimResult {
	binDir: string;
	shimPath: string;
	cmdShimPath: string;
}

function posixShimContent(): string {
	return [
		"#!/usr/bin/env sh",
		"set -eu",
		'if [ "${' + "OMP_PI_COMPAT_BRIDGE:-}" + '" = "child-home" ] && [ -n "${' + "OMP_PI_COMPAT_HOME:-}" + '" ]; then',
		'  export HOME="$OMP_PI_COMPAT_HOME"',
		"fi",
		'if [ -n "${' + "OMP_PI_COMPAT_OMP:-}" + '" ]; then',
		'  exec "$OMP_PI_COMPAT_OMP" "$@"',
		"fi",
		'exec omp "$@"',
		"",
	].join("\n");
}

function windowsShimContent(): string {
	return [
		"@echo off",
		'if "%OMP_PI_COMPAT_BRIDGE%"=="child-home" if not "%OMP_PI_COMPAT_HOME%"=="" set "USERPROFILE=%OMP_PI_COMPAT_HOME%"',
		'if not "%OMP_PI_COMPAT_OMP%"=="" (',
		'  "%OMP_PI_COMPAT_OMP%" %*',
		"  exit /b %ERRORLEVEL%",
		")",
		"omp %*",
		"exit /b %ERRORLEVEL%",
		"",
	].join("\r\n");
}

export async function ensurePiCliShim(): Promise<PiCliShimResult> {
	const binDir = getPiCompatBinDir();
	const shimPath = path.join(binDir, process.platform === "win32" ? "pi.cmd" : "pi");
	const posixPath = path.join(binDir, "pi");
	const cmdShimPath = path.join(binDir, "pi.cmd");

	await fs.promises.mkdir(binDir, { recursive: true });
	await Bun.write(posixPath, posixShimContent());
	await fs.promises.chmod(posixPath, 0o755);
	await Bun.write(cmdShimPath, windowsShimContent());

	return { binDir, shimPath, cmdShimPath };
}

export async function activatePiCompatEnvironment(options: PiCompatEnvOptions = {}): Promise<Record<string, string>> {
	await ensurePiCliShim();
	await ensurePiCompatHome();
	const env = buildPiCompatEnv(options);
	for (const [key, value] of Object.entries(env)) {
		process.env[key] = value;
	}
	return env;
}
