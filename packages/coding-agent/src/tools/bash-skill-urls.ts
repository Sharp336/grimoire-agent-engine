import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { Skill } from "../extensibility/skills";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import type { InternalResource } from "../internal-urls/types";
import { normalizeLocalScheme } from "./path-utils";
import { ToolError } from "./tool-errors";

/** Regex to find skill:// tokens in command text. */
const SKILL_URL_PATTERN = /'skill:\/\/[^'\s")`\\]+'|"skill:\/\/[^"\s')`\\]+"|skill:\/\/[^\s'")`\\]+/g;

const INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL =
	/'(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^'\s")`\\]+'|"(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^"\s')`\\]+"|(?:skill|agent|artifact|plan|memory|rule|local):\/\/[^\s'")`\\]+|'local:\/[^'\s")`\\]+'|"local:\/[^"\s')`\\]+"|(?<![./\\\\\w-])local:\/[^\s'")`\\]+/g;

const SUPPORTED_INTERNAL_SCHEMES = ["skill", "agent", "artifact", "plan", "memory", "rule", "local"] as const;

type SupportedInternalScheme = (typeof SUPPORTED_INTERNAL_SCHEMES)[number];

interface InternalUrlResolver {
	canHandle(input: string): boolean;
	resolve(input: string): Promise<InternalResource>;
}

export interface InternalUrlExpansionOptions {
	skills: readonly Skill[];
	noEscape?: boolean;
	internalRouter?: InternalUrlResolver;
	localOptions?: LocalProtocolOptions;
	ensureLocalParentDirs?: boolean;
}

/**
 * Resolve a single skill:// URL to its absolute filesystem path.
 * Calls fs.realpath to block symlink escape for plugin skills; returns the
 * lexical path for non-existent files (caller is responsible for existence checks).
 */
export async function resolveSkillUrlToPath(url: string, skills: readonly Skill[]): Promise<string> {
	const parsed = /^skill:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/.exec(url);
	if (!parsed) {
		throw new ToolError(`Invalid skill:// URL: ${url}`);
	}

	let rawSkillSegment = parsed[1];
	if (!rawSkillSegment) {
		throw new ToolError(`skill:// URL requires a skill name: ${url}`);
	}
	// Decode percent-encoded colons (%3A) used for namespaced skill names
	try {
		rawSkillSegment = decodeURIComponent(rawSkillSegment);
	} catch {
		// Leave as-is if decoding fails
	}

	// Resolve skill name by longest-prefix match against registered skills.
	// This handles namespaced skills ("plugin:skill") where the URI may also
	// carry a colon-delimited suffix (e.g., ":1-5" line range).
	const { skill, suffix } = matchSkillName(rawSkillSegment, skills);
	if (!skill) {
		const available = skills.map(s => s.name);
		const availableStr = available.length > 0 ? available.join(", ") : "none";
		throw new ToolError(`Unknown skill: ${rawSkillSegment}. Available: ${availableStr}`);
	}

	// Combine any colon suffix (line range like ":1-5") with the path segment
	const rawPath = (parsed[2] ?? "") + (suffix ? `/${suffix}` : "");
	const hasRelativePath = rawPath !== "" && rawPath !== "/";

	if (!hasRelativePath) {
		return path.resolve(skill.filePath);
	}

	let relativePath: string;
	try {
		relativePath = decodeURIComponent(rawPath.slice(1));
	} catch {
		throw new ToolError(`Invalid skill:// URL path encoding: ${url}`);
	}
	if (path.isAbsolute(relativePath)) {
		throw new ToolError("Absolute paths are not allowed in skill:// URLs");
	}

	// For skills without a pluginRoot, .. is not allowed — no safe boundary above the skill dir.
	if (!skill.pluginRoot) {
		const normalized = path.normalize(relativePath);
		if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
			throw new ToolError("Path traversal (..) is not allowed in skill:// URLs");
		}
	}

	const targetPath = path.join(skill.baseDir, relativePath);
	const resolvedPath = path.resolve(targetPath);
	const securityRoot = path.resolve(skill.pluginRoot ?? skill.baseDir);
	if (!resolvedPath.startsWith(securityRoot + path.sep) && resolvedPath !== securityRoot) {
		throw new ToolError("Path traversal is not allowed in skill:// URLs");
	}

	// Realpath containment check — prevents symlink escape within pluginRoot.
	// Only the lexical check guards non-plugin skills (no .. allowed there at all).
	let realSecurityRoot: string;
	try {
		realSecurityRoot = await fs.realpath(securityRoot);
	} catch {
		realSecurityRoot = securityRoot;
	}
	try {
		const realTargetPath = await fs.realpath(targetPath);
		if (!realTargetPath.startsWith(realSecurityRoot + path.sep) && realTargetPath !== realSecurityRoot) {
			throw new ToolError("Path traversal is not allowed in skill:// URLs");
		}
		return realTargetPath;
	} catch (err) {
		if (err instanceof ToolError) throw err;
		if (!isEnoent(err)) throw err;
		// Target absent. Check the parent directory to block symlink-ancestor escape:
		// a plugin could ship PLUGIN_ROOT/evil/ -> /outside; the lexical path
		// PLUGIN_ROOT/evil/new-file passes containment but the parent reveals the escape.
		const parentDir = path.dirname(targetPath);
		try {
			const realParent = await fs.realpath(parentDir);
			if (!realParent.startsWith(realSecurityRoot + path.sep) && realParent !== realSecurityRoot) {
				throw new ToolError("Path traversal is not allowed in skill:// URLs");
			}
		} catch (parentErr) {
			if (parentErr instanceof ToolError) throw parentErr;
			if (!isEnoent(parentErr)) throw parentErr;
			// Parent also absent — lexical check already confirmed containment.
		}
	}

	return resolvedPath;
}

/**
 * Match a raw skill segment against registered skills using longest-prefix match.
 * Handles colons in both skill names (namespacing) and suffixes (line ranges).
 *
 * For "superpowers:brainstorming:1-5" with skill "superpowers:brainstorming":
 *   -> skill = superpowers:brainstorming, suffix = "1-5"
 * For "brainstorming" with skill "brainstorming":
 *   -> skill = brainstorming, suffix = undefined
 */
function matchSkillName(
	rawSegment: string,
	skills: readonly Skill[],
): { skill: Skill | undefined; suffix: string | undefined } {
	// Exact match first (most common case)
	const exact = skills.find(s => s.name === rawSegment);
	if (exact) return { skill: exact, suffix: undefined };

	// Try stripping colon-delimited suffixes from the right
	let candidate = rawSegment;
	while (true) {
		const lastColon = candidate.lastIndexOf(":");
		if (lastColon <= 0) break;
		candidate = candidate.slice(0, lastColon);
		const match = skills.find(s => s.name === candidate);
		if (match) {
			const suffix = rawSegment.slice(lastColon + 1);
			return { skill: match, suffix };
		}
	}

	return { skill: undefined, suffix: undefined };
}

function extractScheme(url: string): SupportedInternalScheme | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (!match) return undefined;
	const scheme = match[1].toLowerCase();
	if (!SUPPORTED_INTERNAL_SCHEMES.includes(scheme as SupportedInternalScheme)) return undefined;
	return scheme as SupportedInternalScheme;
}

function unquoteToken(token: string): string {
	if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
		return token.slice(1, -1);
	}
	return token;
}

/** Shell-escape a path using single quotes. */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, "'\\''")}'`;
}

async function resolveInternalUrlToPath(
	rawUrl: string,
	skills: readonly Skill[],
	internalRouter?: InternalUrlResolver,
	localOptions?: LocalProtocolOptions,
	ensureLocalParentDirs?: boolean,
): Promise<string> {
	const url = normalizeLocalScheme(rawUrl);
	const scheme = extractScheme(url);
	if (!scheme) {
		throw new ToolError(`Unsupported internal URL in bash command: ${url}`);
	}

	if (scheme === "skill") {
		return await resolveSkillUrlToPath(url, skills);
	}

	if (scheme === "local") {
		if (!localOptions) {
			throw new ToolError(
				"Cannot resolve local:// URL in bash command: local protocol options are unavailable for this session.",
			);
		}
		const resolvedLocalPath = resolveLocalUrlToPath(url, localOptions);
		if (ensureLocalParentDirs) {
			await fs.mkdir(path.dirname(resolvedLocalPath), { recursive: true });
		}
		return resolvedLocalPath;
	}

	if (!internalRouter?.canHandle(url)) {
		throw new ToolError(
			`Cannot resolve ${scheme}:// URL in bash command: ${url}\n` +
				"Internal URL router is unavailable for this protocol in the current session.",
		);
	}

	let resource: InternalResource;
	try {
		resource = await internalRouter.resolve(url);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Failed to resolve ${scheme}:// URL in bash command: ${url}\n${message}`);
	}

	if (!resource.sourcePath) {
		throw new ToolError(`${scheme}:// URL resolved without a filesystem path and cannot be used in bash: ${url}`);
	}

	return path.resolve(resource.sourcePath);
}

/**
 * Expand all skill:// URIs in a bash command string.
 * Returns the command with URIs replaced by shell-escaped absolute paths.
 * Throws ToolError if any URI cannot be resolved.
 */
export async function expandSkillUrls(command: string, skills: readonly Skill[]): Promise<string> {
	if (skills.length === 0 || !command.includes("skill://")) {
		return command;
	}

	const matches = Array.from(command.matchAll(SKILL_URL_PATTERN));
	if (matches.length === 0) return command;

	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		const url = unquoteToken(token);
		const resolvedPath = await resolveSkillUrlToPath(url, skills);
		expanded = `${expanded.slice(0, index)}${shellEscape(resolvedPath)}${expanded.slice(index + token.length)}`;
	}
	return expanded;
}

/**
 * Expand supported internal URLs in a bash command string to shell-escaped absolute paths.
 * Supported schemes: skill://, agent://, artifact://, memory://, rule://, local://
 */
export async function expandInternalUrls(command: string, options: InternalUrlExpansionOptions): Promise<string> {
	if (!command.includes("://") && !command.includes("local:/")) return command;

	const matches = Array.from(command.matchAll(INTERNAL_URL_PATTERN_INCLUDING_NORMALIZED_LOCAL));
	if (matches.length === 0) return command;

	let expanded = command;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const token = match[0];
		const index = match.index;
		if (index === undefined) continue;

		const rawUrl = unquoteToken(token);
		const url = normalizeLocalScheme(rawUrl);
		const resolvedPath = await resolveInternalUrlToPath(
			url,
			options.skills,
			options.internalRouter,
			options.localOptions,
			options.ensureLocalParentDirs,
		);
		const replacement = options.noEscape ? resolvedPath : shellEscape(resolvedPath);
		expanded = `${expanded.slice(0, index)}${replacement}${expanded.slice(index + token.length)}`;
	}

	return expanded;
}
