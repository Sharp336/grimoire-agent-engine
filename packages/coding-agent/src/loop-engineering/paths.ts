import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizeName, parseLoopSpec } from "./schema";
import type { LoopSpec } from "./types";

export async function loadLoopSpec(cwd: string, target: string | undefined): Promise<LoopSpec> {
	const specPath = await resolveLoopSpecPath(cwd, target);
	const content = await Bun.file(specPath).text();
	return parseLoopSpec(content, specPath);
}

export async function listLoopSpecs(cwd: string): Promise<LoopSpec[]> {
	const dir = await resolveInsideProject(cwd, path.join(".omp", "loops"), "loop specs directory");
	let entries: string[];
	try {
		await assertNotSymlink(dir, "loop specs directory");
		entries = await fs.readdir(dir);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const specs: LoopSpec[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".loop.yaml") && !entry.endsWith(".loop.yml")) continue;
		const specPath = await resolveInsideProject(cwd, path.join(".omp", "loops", entry), "loop spec path");
		await assertNotSymlink(specPath, "loop spec path");
		specs.push(parseLoopSpec(await Bun.file(specPath).text(), specPath));
	}
	return specs;
}

export async function resolveLoopSpecPath(cwd: string, target: string | undefined): Promise<string> {
	if (target && (target.includes(path.sep) || target.endsWith(".yaml") || target.endsWith(".yml"))) {
		const specPath = await resolveInsideProject(cwd, target, "loop spec path");
		await assertNotSymlink(specPath, "loop spec path");
		return specPath;
	}
	const name = normalizeName(target || "daily-triage");
	const yamlPath = await resolveInsideProject(cwd, path.join(".omp", "loops", `${name}.loop.yaml`), "loop spec path");
	try {
		await assertNotSymlink(yamlPath, "loop spec path");
		return yamlPath;
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
	}
	const ymlPath = await resolveInsideProject(cwd, path.join(".omp", "loops", `${name}.loop.yml`), "loop spec path");
	await assertNotSymlink(ymlPath, "loop spec path");
	return ymlPath;
}

export async function resolveInsideProject(cwd: string, relativePath: string, label: string): Promise<string> {
	const normalized = normalizeRelativeProjectPath(relativePath, label);
	const rootReal = await fs.realpath(cwd);
	const resolved = path.resolve(rootReal, normalized);
	await assertParentInsideProject(rootReal, resolved, label);
	await assertExistingTargetInsideProject(rootReal, resolved, label);
	return resolved;
}

export function normalizeRelativeProjectPath(relativePath: string, label: string): string {
	if (path.isAbsolute(relativePath)) throw new Error(`${label} must be relative to the project`);
	const normalized = path.normalize(relativePath);
	if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
		throw new Error(`${label} must stay inside the project`);
	}
	return normalized;
}

export async function assertSafeProjectWrite(cwd: string, filePath: string, label: string): Promise<void> {
	const rootReal = await fs.realpath(cwd);
	const parent = path.dirname(filePath);
	await assertParentInsideProject(rootReal, filePath, label);
	await rejectSymlinkPath(rootReal, parent, label);
	try {
		const targetStat = await fs.lstat(filePath);
		if (targetStat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
	}
}

async function assertNotSymlink(filePath: string, label: string): Promise<void> {
	const stat = await fs.lstat(filePath);
	if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
}

async function assertParentInsideProject(rootReal: string, filePath: string, label: string): Promise<void> {
	let parentReal: string;
	try {
		parentReal = await fs.realpath(path.dirname(filePath));
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
		parentReal = await nearestExistingParentReal(path.dirname(filePath));
	}
	const relative = path.relative(rootReal, parentReal);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`${label} must stay inside the project`);
	}
}

async function assertExistingTargetInsideProject(rootReal: string, filePath: string, label: string): Promise<void> {
	try {
		const targetReal = await fs.realpath(filePath);
		const relative = path.relative(rootReal, targetReal);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`${label} must stay inside the project`);
		}
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}
async function nearestExistingParentReal(dir: string): Promise<string> {
	let current = dir;
	for (;;) {
		try {
			return await fs.realpath(current);
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

async function rejectSymlinkPath(rootReal: string, targetDir: string, label: string): Promise<void> {
	const relative = path.relative(rootReal, path.resolve(targetDir));
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside the project`);
	let current = rootReal;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) throw new Error(`${label} must not pass through a symlink`);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
	}
}
