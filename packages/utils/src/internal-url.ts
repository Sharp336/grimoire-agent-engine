/**
 * Parse a persisted `skill://` read target without exposing the coding-agent's
 * generic internal-URL parser to shared packages.
 */

const RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;
const SELECTOR_PART_RE = new RegExp(`^(?:raw|conflicts|${RANGE_LIST_SRC}|-\\d+(?:[-+]\\d+)?)$`, "i");
const SKILL_SCHEME_RE = /^skill:\/\//i;
const SKILL_AUTHORITY_RE = /^skill:\/\/([^/?#]*)/i;
/** A persisted skill read target. */
export interface SkillUrlTarget {
	skill: string;
	target: string;
}

/** Parse a single, unambiguous skill URL target, retaining its original string. */
export function parseSkillUrlTarget(target: string): SkillUrlTarget | undefined {
	if (!SKILL_SCHEME_RE.test(target)) return undefined;
	let path = target;
	const schemeEnd = target.match(SKILL_SCHEME_RE)?.[0].length ?? 0;
	while (true) {
		const colon = path.lastIndexOf(":");
		if (colon < schemeEnd) break;
		const tail = path.slice(colon + 1);
		if (!SELECTOR_PART_RE.test(tail)) break;
		path = path.slice(0, colon);
	}

	const authority = path.match(SKILL_AUTHORITY_RE)?.[1];
	if (!authority) return undefined;
	let skill = authority;
	try {
		skill = decodeURIComponent(authority);
	} catch {
		// Preserve an invalidly encoded authority exactly as persisted.
	}
	return { skill, target };
}
