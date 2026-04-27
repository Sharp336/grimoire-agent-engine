import * as os from "node:os";
import * as path from "node:path";
import type { PiCompatInstallSource } from "./types";

const SHELL_METACHARS = /[;&|`$(){}[\]<>\\]/;

function isWindowsDrivePath(spec: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(spec);
}

function assertSafeSpecifier(spec: string): void {
	if (!spec || spec.includes("\0")) {
		throw new Error("Package source must be a non-empty string");
	}
	const valueToCheck = isWindowsDrivePath(spec) ? spec.replace(/\\/g, "/") : spec;
	if (SHELL_METACHARS.test(valueToCheck)) {
		throw new Error(`Invalid characters in package source: ${spec}`);
	}
}

function splitRef(input: string): { base: string; ref?: string } {
	const hashIndex = input.lastIndexOf("#");
	if (hashIndex > -1) {
		const ref = input.slice(hashIndex + 1);
		return { base: input.slice(0, hashIndex), ref: ref || undefined };
	}

	const atIndex = input.lastIndexOf("@");
	const slashIndex = input.lastIndexOf("/");
	if (atIndex > slashIndex) {
		const ref = input.slice(atIndex + 1);
		return { base: input.slice(0, atIndex), ref: ref || undefined };
	}

	return { base: input };
}

function packageHintFromRepo(repo: string): string | undefined {
	const normalized = repo.replace(/\.git$/, "");
	const parts = normalized.split("/").filter(Boolean);
	return parts.at(-1);
}

function packageNameFromNpmSpec(spec: string): string {
	if (spec.startsWith("@")) {
		const slashIndex = spec.indexOf("/");
		if (slashIndex === -1) return spec;
		const versionIndex = spec.indexOf("@", slashIndex + 1);
		return versionIndex === -1 ? spec : spec.slice(0, versionIndex);
	}
	const versionIndex = spec.indexOf("@");
	return versionIndex === -1 ? spec : spec.slice(0, versionIndex);
}

function normalizeGithubSource(value: string): { installSpec: string; packageNameHint?: string; ref?: string } | null {
	const { base, ref } = splitRef(value);
	let ownerRepo: string | undefined;

	if (base.startsWith("github:")) {
		ownerRepo = base.slice("github:".length);
	} else if (base.startsWith("github.com/")) {
		ownerRepo = base.slice("github.com/".length);
	} else if (base.startsWith("https://github.com/") || base.startsWith("git+https://github.com/")) {
		const urlText = base.startsWith("git+") ? base.slice(4) : base;
		const url = new URL(urlText);
		ownerRepo = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
	}

	if (!ownerRepo) return null;
	const normalized = ownerRepo.replace(/\.git$/, "");
	const installSpec = ref ? `github:${normalized}#${ref}` : `github:${normalized}`;
	return { installSpec, packageNameHint: packageHintFromRepo(normalized), ref };
}

function isLocalSource(spec: string): boolean {
	return (
		spec.startsWith("./") ||
		spec.startsWith("../") ||
		spec.startsWith("/") ||
		spec.startsWith("~/") ||
		isWindowsDrivePath(spec) ||
		spec === "." ||
		spec === ".." ||
		spec.startsWith("file:")
	);
}

export function resolvePiCompatLocalPath(spec: string, cwd: string): string {
	const raw = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
	const expanded = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
	if (isWindowsDrivePath(expanded)) return path.normalize(expanded);
	return path.resolve(cwd, expanded);
}

export function parsePiInstallSource(spec: string, cwd: string = process.cwd()): PiCompatInstallSource {
	assertSafeSpecifier(spec);

	if (spec.startsWith("npm:")) {
		const packageSpec = spec.slice("npm:".length);
		assertSafeSpecifier(packageSpec);
		if (!packageSpec) throw new Error(`Invalid npm package source: ${spec}`);
		return {
			kind: "npm",
			original: spec,
			installSpec: packageSpec,
			packageNameHint: packageNameFromNpmSpec(packageSpec),
		};
	}

	if (isLocalSource(spec)) {
		const localPath = resolvePiCompatLocalPath(spec, cwd);
		return {
			kind: "local",
			original: spec,
			installSpec: `file:${localPath}`,
			localPath,
			packageNameHint: path.basename(localPath),
		};
	}

	if (spec.startsWith("git:")) {
		const body = spec.slice("git:".length);
		assertSafeSpecifier(body);
		const github = normalizeGithubSource(body);
		if (github) {
			return { kind: "git", original: spec, ...github };
		}
		const { base, ref } = splitRef(body);
		return {
			kind: "git",
			original: spec,
			installSpec: ref ? `${base}#${ref}` : base,
			packageNameHint: packageHintFromRepo(base),
			ref,
		};
	}

	if (spec.startsWith("https://") || spec.startsWith("git+https://")) {
		const github = normalizeGithubSource(spec);
		if (github) {
			return { kind: "git", original: spec, ...github };
		}
		const { base, ref } = splitRef(spec);
		return {
			kind: "git",
			original: spec,
			installSpec: ref ? `${base}#${ref}` : base,
			packageNameHint: packageHintFromRepo(base),
			ref,
		};
	}

	return {
		kind: "npm",
		original: spec,
		installSpec: spec,
		packageNameHint: packageNameFromNpmSpec(spec),
	};
}
