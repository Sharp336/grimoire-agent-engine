import * as path from "node:path";

export type MemoryBankScoping = "global" | "per-project" | "per-project-tagged";

export interface MemoryBankScope {
	baseBank: string;
	bank: string;
	globalBank: string;
	retainBank: string;
	recallBanks: readonly string[];
}

const DEFAULT_SHARED_BANK = "default";
const MAX_BANK_NAME_LENGTH = 64;

/**
 * Resolve deterministic write and recall banks for an active project.
 *
 * `per-project-tagged` retains in a project-local bank while also recalling
 * the configured shared bank. Derivation intentionally depends only on cwd:
 * changes to an enclosing Git layout must never fragment project memories.
 */
export function computeMemoryBankScope(
	configured: string | undefined,
	cwd: string,
	scoping: MemoryBankScoping,
): MemoryBankScope {
	const project = projectBank(configured, cwd);
	const globalBank = sharedBank(configured);
	switch (scoping) {
		case "global":
			return {
				baseBank: globalBank,
				bank: globalBank,
				globalBank,
				retainBank: globalBank,
				recallBanks: [globalBank],
			};
		case "per-project":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: [project],
			};
		case "per-project-tagged":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: project === globalBank ? [project] : [project, globalBank],
			};
	}
}

function sharedBank(configured: string | undefined): string {
	return sanitizeMemoryBankName(configured) ?? DEFAULT_SHARED_BANK;
}

function projectBank(configured: string | undefined, cwd: string): string {
	const projectRoot = path.resolve(cwd || ".");
	const project = projectBankSegment(projectRoot);
	const base = sanitizeMemoryBankName(configured);
	return limitMemoryBankName(base ? `${base}-${project}` : project);
}

function projectBankSegment(projectRoot: string): string {
	const project = sanitizeMemoryBankName(path.basename(projectRoot)) ?? DEFAULT_SHARED_BANK;
	return limitMemoryBankName(`${project}-${Bun.hash(projectRoot).toString(36)}`);
}

export function sanitizeMemoryBankName(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized ? limitMemoryBankName(sanitized) : undefined;
}

export function limitMemoryBankName(name: string): string {
	if (name.length <= MAX_BANK_NAME_LENGTH) return name;
	const hash = Bun.hash(name).toString(36);
	const prefixLength = Math.max(1, MAX_BANK_NAME_LENGTH - 1 - hash.length);
	const prefix = name.slice(0, prefixLength).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}
