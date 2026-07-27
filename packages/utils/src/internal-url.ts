/**
 * Internal URL parser and selector splitter shared by the coding agent and
 * Stats. Namespaced authorities such as `skill://plugin:name` are not valid
 * WHATWG hosts, so parsing preserves their raw authority separately.
 */

const SCHEME_HOST_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const PATHNAME_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i;
const RANGE_CHUNK_SRC = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST_SRC = `${RANGE_CHUNK_SRC}(?:,${RANGE_CHUNK_SRC})*`;
const INTERNAL_URL_SELECTOR_PART_SRC = String.raw`(?:raw|conflicts|${RANGE_LIST_SRC}|-\d+(?:[-+]\d+)?)`;
const INTERNAL_URL_SELECTOR_PART_RE = new RegExp(`^${INTERNAL_URL_SELECTOR_PART_SRC}$`, "i");
const INTERNAL_URL_SELECTOR_CHAIN_RE = new RegExp(
	`^${INTERNAL_URL_SELECTOR_PART_SRC}(?::${INTERNAL_URL_SELECTOR_PART_SRC})*$`,
	"i",
);
const INTERNAL_SCHEMES_WITH_SELECTORS: Record<string, true> = {
	agent: true,
	artifact: true,
	history: true,
	issue: true,
	local: true,
	memory: true,
	omp: true,
	pr: true,
	rule: true,
	skill: true,
	ssh: true,
	security: true,
	vault: true,
};
const OPAQUE_RESOURCE_SCHEMES: Record<string, true> = { mcp: true };
const INTERNAL_URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const OPAQUE_URI_RE = /^([a-z][a-z0-9+.-]*):(.+)$/is;

/** Parsed internal URL with preserved raw authority and pathname. */
export interface InternalUrl extends URL {
	rawHost: string;
	rawPathname?: string;
	rawHref?: string;
}

/** A skill URL read target, retaining the original persisted target string. */
export interface SkillUrlTarget {
	skill: string;
	target: string;
}

/**
 * Extract the lowercased scheme from a URI-shaped input, or `undefined` when
 * the input is a filesystem path.
 */
export function extractUriScheme(input: string): string | undefined {
	const hierarchical = input.match(SCHEME_HOST_RE);
	if (hierarchical) return hierarchical[1].toLowerCase();
	const opaque = input.match(OPAQUE_URI_RE);
	if (!opaque) return undefined;
	const [, scheme, rest] = opaque;
	if (scheme.length === 1 || scheme.includes(".") || INTERNAL_URL_SELECTOR_CHAIN_RE.test(rest)) {
		return undefined;
	}
	return scheme.toLowerCase();
}

/**
 * Parse an internal URL while preserving authorities that are invalid WHATWG
 * hosts, such as namespaced skills.
 */
export function parseInternalUrl(input: string): InternalUrl {
	const hostMatch = input.match(SCHEME_HOST_RE);
	const pathMatch = input.match(PATHNAME_RE);

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		if (!hostMatch) {
			throw new Error(`Invalid URL: ${input}`);
		}
		const hashIdx = input.indexOf("#");
		const hash = hashIdx !== -1 ? input.slice(hashIdx) : "";
		const withoutHash = hashIdx !== -1 ? input.slice(0, hashIdx) : input;
		const queryIdx = withoutHash.indexOf("?");
		const search = queryIdx !== -1 ? withoutHash.slice(queryIdx) : "";
		const queryString = search.slice(1);

		let rawPathname = pathMatch?.[1] ?? "";
		if (queryIdx !== -1 && rawPathname.includes("?")) {
			rawPathname = rawPathname.slice(0, rawPathname.indexOf("?"));
		}

		parsed = {
			protocol: `${hostMatch[1]}:`,
			hostname: hostMatch[2] ?? "",
			host: hostMatch[2] ?? "",
			pathname: rawPathname,
			href: input,
			search,
			hash,
			searchParams: new URLSearchParams(queryString),
		} as unknown as URL;
	}

	let rawHost = hostMatch ? hostMatch[2] : parsed.hostname;
	try {
		rawHost = decodeURIComponent(rawHost);
	} catch {
		// Keep an invalidly encoded host unchanged.
	}

	const result = parsed as InternalUrl;
	result.rawHost = rawHost;
	result.rawPathname = pathMatch?.[1] ?? parsed.pathname;
	result.rawHref = input;
	return result;
}

/**
 * Split a selector from an internal URL. Selector-aware schemes peel repeated
 * selector chunks; opaque resource schemes such as mcp:// remain unchanged.
 */
export function splitInternalUrlSel(rawPath: string): { path: string; sel?: string } {
	const schemeMatch = rawPath.match(INTERNAL_URL_SCHEME_RE);
	if (!schemeMatch) return { path: rawPath };
	const scheme = schemeMatch[1].toLowerCase();
	if (OPAQUE_RESOURCE_SCHEMES[scheme]) return { path: rawPath };
	if (!INTERNAL_SCHEMES_WITH_SELECTORS[scheme]) return { path: rawPath };

	const schemeEnd = schemeMatch[0].length;
	if (scheme === "ssh" && rawPath.indexOf("/", schemeEnd) === -1) {
		return { path: rawPath };
	}
	let path = rawPath;
	const chunks: string[] = [];
	while (true) {
		const colon = path.lastIndexOf(":");
		if (colon < schemeEnd) break;
		const tail = path.slice(colon + 1);
		if (!INTERNAL_URL_SELECTOR_PART_RE.test(tail)) break;
		chunks.unshift(tail);
		path = path.slice(0, colon);
	}
	if (chunks.length === 0) return { path: rawPath };
	return { path, sel: chunks.join(":") };
}

/** Parse a skill URL target exactly as the read tool does. */
export function parseSkillUrlTarget(target: string): SkillUrlTarget | undefined {
	const { path } = splitInternalUrlSel(target);
	let parsed: InternalUrl;
	try {
		parsed = parseInternalUrl(path);
	} catch {
		return undefined;
	}
	if (parsed.protocol.toLowerCase() !== "skill:" || parsed.rawHost.length === 0) {
		return undefined;
	}
	return { skill: parsed.rawHost, target };
}
