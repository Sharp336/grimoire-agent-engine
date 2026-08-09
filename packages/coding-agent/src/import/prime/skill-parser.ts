import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { validateAgentSkillFrontmatter } from "../../discovery/agent-plugin-format";
import type {
	PrimeImportLoss,
	PrimeImportSourceDiscovery,
	PrimeJsonValue,
	PrimeSkillCandidate,
	PrimeSkillParserResult,
	PrimeSkillPayloadEntry,
	PrimeSkillScope,
	PrimeSourceFile,
	PrimeSourceRecord,
} from "./types";

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function skillLoss(code: PrimeImportLoss["code"], sourceRef: string, pathValue?: string): PrimeImportLoss {
	return pathValue === undefined
		? { code, domain: "skills", sourceRef }
		: { code, domain: "skills", sourceRef, path: pathValue };
}

function isJsonValue(value: unknown): value is PrimeJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(item => isJsonValue(item));
	if (typeof value !== "object") return false;
	return Object.values(value).every(item => isJsonValue(item));
}

function toJsonValue(value: unknown): PrimeJsonValue | undefined {
	if (isJsonValue(value)) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result: Record<string, PrimeJsonValue> = {};
	for (const [key, nested] of Object.entries(value)) {
		const normalized = toJsonValue(nested);
		if (normalized !== undefined) result[key] = normalized;
	}
	return result;
}

function relativePath(directorySourceRef: string, sourceRef: string): string {
	return sourceRef.slice(directorySourceRef.length + 1);
}

function skillScope(sourceRef: string): PrimeSkillScope | undefined {
	const match = /^(global|project)\/skills(?:\/|$)/.exec(sourceRef);
	return match?.[1] as PrimeSkillScope | undefined;
}

function skillRootForFile(sourceRef: string): string | undefined {
	if (!sourceRef.endsWith("/SKILL.md")) return undefined;
	const scope = skillScope(sourceRef);
	if (!scope) return undefined;
	return sourceRef.slice(0, -"/SKILL.md".length);
}

function skillBase(scope: PrimeSkillScope): string {
	return `${scope}/skills`;
}

function globPatternMatches(pattern: string, value: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

function ignorePatternMatches(pattern: string, target: string, directory: boolean): boolean {
	let value = pattern.trim();
	if (!value || (value.startsWith("#") && !value.startsWith("\\#"))) return false;
	if (value.startsWith("\\#") || value.startsWith("\\!")) value = value.slice(1);
	if (value.startsWith("/")) value = value.slice(1);
	const directoryPattern = value.endsWith("/");
	if (directoryPattern) value = value.slice(0, -1);
	if (directoryPattern && !directory) {
		const targetParent = target.split("/").slice(0, -1).join("/");
		if (targetParent !== value && !targetParent.startsWith(`${value}/`)) return false;
	}
	if (!value.includes("/")) return target.split("/").some(part => globPatternMatches(value, part));
	return globPatternMatches(value, target);
}

function isIgnoredSkillPath(
	records: readonly PrimeSourceRecord[],
	scope: PrimeSkillScope,
	target: string,
	directory: boolean,
): boolean {
	const base = skillBase(scope);
	const relativeTarget = target.slice(base.length + 1);
	const directories = relativeTarget.split("/");
	if (!directory) directories.pop();
	let ignored = false;
	for (let index = 0; index <= directories.length; index += 1) {
		const directorySourceRef = [base, ...directories.slice(0, index)].join("/");
		for (const name of [".gitignore", ".ignore", ".fdignore"]) {
			const ignoreFile = records.find(
				(record): record is PrimeSourceFile =>
					record.kind === "file" && record.sourceRef === `${directorySourceRef}/${name}`,
			);
			if (!ignoreFile) continue;
			const content = Buffer.from(ignoreFile.contentBase64, "base64").toString("utf8");
			for (const rawPattern of content.split(/\r?\n/)) {
				const trimmed = rawPattern.trim();
				if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) continue;
				const leading = rawPattern.trimStart();
				const negated = leading.startsWith("!");
				const pattern = negated ? leading.slice(1) : leading;
				const prefix = directorySourceRef === base ? "" : `${directorySourceRef.slice(base.length + 1)}/`;
				const scopedPattern = pattern.includes("/") ? `${prefix}${pattern}` : pattern;
				if (ignorePatternMatches(scopedPattern, relativeTarget, directory)) ignored = !negated;
			}
		}
	}
	return ignored;
}

function isSafeRelativeSymlink(relativePathValue: string, target: string): boolean {
	if (!target || path.posix.isAbsolute(target)) return false;
	const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePathValue), target));
	return resolved !== ".." && !resolved.startsWith("../") && !resolved.includes("\u0000");
}

function payloadEntry(record: PrimeSourceRecord, directorySourceRef: string): PrimeSkillPayloadEntry | undefined {
	const relative = relativePath(directorySourceRef, record.sourceRef);
	if (!relative) return undefined;
	if (record.kind === "file") {
		return {
			kind: "file",
			relativePath: relative,
			sourceRef: record.sourceRef,
			mode: record.mode,
			size: record.size,
			sha256: record.sha256,
			contentBase64: record.contentBase64,
		};
	}
	if (record.kind === "directory") {
		return { kind: "directory", relativePath: relative, sourceRef: record.sourceRef, mode: record.mode };
	}
	if (record.external || record.target === undefined || !isSafeRelativeSymlink(relative, record.target))
		return undefined;
	return {
		kind: "symlink",
		relativePath: relative,
		sourceRef: record.sourceRef,
		mode: record.mode,
		target: record.target,
	};
}

function sortLosses(losses: readonly PrimeImportLoss[]): PrimeImportLoss[] {
	return [...losses].sort((left, right) => {
		const source = compareStrings(left.sourceRef, right.sourceRef);
		if (source !== 0) return source;
		const line = (left.line ?? 0) - (right.line ?? 0);
		if (line !== 0) return line;
		const code = compareStrings(left.code, right.code);
		return code !== 0 ? code : compareStrings(left.path ?? "", right.path ?? "");
	});
}

export function parsePrimeSkills(discovery: PrimeImportSourceDiscovery): PrimeSkillParserResult {
	const losses: PrimeImportLoss[] = [...discovery.losses];
	const sourceRecords = discovery.inventory.records;
	const skillFiles = sourceRecords
		.filter(
			(record): record is PrimeSourceFile =>
				record.kind === "file" && skillRootForFile(record.sourceRef) !== undefined,
		)
		.sort((left, right) => compareStrings(left.sourceRef, right.sourceRef));
	const roots: Array<{ scope: PrimeSkillScope; directorySourceRef: string; skillFile: PrimeSourceFile }> = [];
	for (const skillFile of skillFiles) {
		const directorySourceRef = skillRootForFile(skillFile.sourceRef);
		const scope = skillScope(skillFile.sourceRef);
		if (!directorySourceRef || !scope) continue;
		const relativeRoot = directorySourceRef.slice(skillBase(scope).length + 1);
		if (relativeRoot.split("/").some(part => part.startsWith(".") || part === "node_modules")) {
			losses.push(skillLoss("skills-ignored", directorySourceRef));
			continue;
		}
		if (isIgnoredSkillPath(sourceRecords, scope, directorySourceRef, true)) {
			losses.push(skillLoss("skills-ignored", directorySourceRef));
			continue;
		}
		if (
			roots.some(
				root =>
					directorySourceRef === root.directorySourceRef ||
					directorySourceRef.startsWith(`${root.directorySourceRef}/`),
			)
		)
			continue;
		roots.push({ scope, directorySourceRef, skillFile });
	}

	const candidates: PrimeSkillCandidate[] = [];
	for (const { scope, directorySourceRef, skillFile } of roots.sort((left, right) => {
		const scopeOrder = (scope: PrimeSkillScope): number => (scope === "project" ? 0 : 1);
		const byScope = scopeOrder(left.scope) - scopeOrder(right.scope);
		return byScope !== 0 ? byScope : compareStrings(left.directorySourceRef, right.directorySourceRef);
	})) {
		const records = sourceRecords.filter(
			record => record.sourceRef === directorySourceRef || record.sourceRef.startsWith(`${directorySourceRef}/`),
		);
		if (
			discovery.losses.some(
				loss =>
					loss.domain === "skills" &&
					loss.code === "source-unsupported" &&
					(loss.sourceRef === directorySourceRef || loss.sourceRef.startsWith(`${directorySourceRef}/`)),
			)
		) {
			losses.push(skillLoss("skills-special-file", directorySourceRef));
			continue;
		}
		let rawFrontmatter: Record<string, unknown>;
		try {
			rawFrontmatter = parseFrontmatter(Buffer.from(skillFile.contentBase64, "base64").toString("utf8"), {
				source: skillFile.sourceRef,
				repair: false,
				rawKeys: true,
				level: "fatal",
			}).frontmatter;
		} catch {
			losses.push(skillLoss("skills-invalid-frontmatter", skillFile.sourceRef));
			continue;
		}
		const dirName = directorySourceRef.slice(directorySourceRef.lastIndexOf("/") + 1);
		if (validateAgentSkillFrontmatter(rawFrontmatter, dirName) !== null) {
			losses.push(skillLoss("skills-invalid-frontmatter", skillFile.sourceRef));
			continue;
		}
		const frontmatter: Record<string, PrimeJsonValue> = {};
		for (const [key, value] of Object.entries(rawFrontmatter)) {
			const normalized = toJsonValue(value);
			if (normalized !== undefined) frontmatter[key] = normalized;
		}
		const payload: PrimeSkillPayloadEntry[] = [];
		for (const record of records) {
			if (record.kind === "symlink" && record.external) {
				losses.push(skillLoss("skills-external-symlink", record.sourceRef, record.canonicalPath));
				continue;
			}
			const entry = payloadEntry(record, directorySourceRef);
			if (entry) payload.push(entry);
			else if (record.kind === "symlink") {
				losses.push(skillLoss("skills-external-symlink", record.sourceRef, record.canonicalPath));
			}
		}
		candidates.push({
			kind: "skill",
			scope,
			name: dirName,
			directorySourceRef,
			frontmatter,
			files: payload.sort((left, right) => compareStrings(left.relativePath, right.relativePath)),
		});
	}

	const selected = new Map<string, PrimeSkillCandidate>();
	for (const candidate of candidates) {
		const previous = selected.get(candidate.name);
		if (!previous) {
			selected.set(candidate.name, candidate);
		} else {
			losses.push(skillLoss("skills-duplicate", candidate.directorySourceRef));
		}
	}
	return {
		candidates: [...selected.values()].sort((left, right) => {
			const lower = compareStrings(left.name.toLowerCase(), right.name.toLowerCase());
			return lower !== 0 ? lower : compareStrings(left.directorySourceRef, right.directorySourceRef);
		}),
		losses: sortLosses(losses),
	};
}
