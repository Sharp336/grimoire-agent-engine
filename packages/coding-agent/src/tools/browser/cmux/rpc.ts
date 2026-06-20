import type { Observation, ObservationEntry } from "../tab-protocol";

export interface CmuxKind {
	kind: "cmux";
	socketPath: string;
	password?: string;
	surface?: string;
}

export interface CmuxOpenSplitResult {
	surface_id?: unknown;
	url?: unknown;
	workspace_id?: unknown;
	created_split?: unknown;
	placement_strategy?: unknown;
}

export interface CmuxSnapshotRef {
	role?: unknown;
	name?: unknown;
}

export interface CmuxSnapshotPage {
	title?: unknown;
	url?: unknown;
	ready_state?: unknown;
	text?: unknown;
	html?: unknown;
}

export interface CmuxSnapshotResult {
	snapshot?: unknown;
	refs?: Record<string, CmuxSnapshotRef>;
	page?: CmuxSnapshotPage;
	url?: unknown;
	title?: unknown;
	ready_state?: unknown;
	surface_id?: unknown;
}

export interface CmuxEvalResult {
	value?: unknown;
	surface_id?: unknown;
	content_world?: unknown;
}

export interface CmuxUrlGetResult {
	url?: unknown;
	surface_id?: unknown;
	workspace_id?: unknown;
}

export interface CmuxScreenshotResult {
	png_base64?: unknown;
	path?: unknown;
	url?: unknown;
	surface_id?: unknown;
	width?: unknown;
	height?: unknown;
}

export interface CmuxGeometry {
	innerWidth: number;
	innerHeight: number;
	dpr: number;
	scrollX: number;
	scrollY: number;
	scrollWidth: number;
	scrollHeight: number;
}

export const GEOMETRY_SCRIPT =
	"(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio||1, scrollX: window.scrollX, scrollY: window.scrollY, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }))()";

export function cmuxSnapshotToObservation(
	result: CmuxSnapshotResult,
	viewport: Observation["viewport"],
	geometry: CmuxGeometry,
): Observation {
	const elements: ObservationEntry[] = [];
	const refs = result.refs ?? {};
	for (const ref in refs) {
		const value = refs[ref];
		if (!value) continue;
		// Keep the full ref string (e.g. "e2") as the element ID for aria-ref selectors.
		const normalizedRef = ref.startsWith("@") ? ref.slice(1) : ref;
		if (!normalizedRef.startsWith("e")) continue;
		const role = typeof value.role === "string" && value.role.length > 0 ? value.role : "generic";
		const name = typeof value.name === "string" && value.name.length > 0 ? value.name : undefined;
		elements.push({ id: normalizedRef, role, name, states: [] });
	}
	elements.sort((a, b) => {
		const aNum = Number.parseInt(a.id.replace(/^e/, ""), 10) || 0;
		const bNum = Number.parseInt(b.id.replace(/^e/, ""), 10) || 0;
		return aNum - bNum;
	});

	const url =
		(typeof result.url === "string" && result.url.length > 0 ? result.url : undefined) ??
		(typeof result.page?.url === "string" && result.page.url.length > 0 ? result.page.url : undefined) ??
		"about:blank";
	const title =
		(typeof result.title === "string" && result.title.length > 0 ? result.title : undefined) ??
		(typeof result.page?.title === "string" && result.page.title.length > 0 ? result.page.title : undefined);
	return {
		url,
		title,
		viewport,
		scroll: {
			x: geometry.scrollX,
			y: geometry.scrollY,
			width: geometry.innerWidth,
			height: geometry.innerHeight,
			scrollWidth: geometry.scrollWidth,
			scrollHeight: geometry.scrollHeight,
		},
		elements,
	};
}

export function serializeEval(fn: string | ((...args: unknown[]) => unknown), args: unknown[]): string {
	if (typeof fn === "string") {
		return fn;
	}
	return `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(",")})`;
}

export function mapWaitUntil(waitUntil: string | undefined): "interactive" | "complete" {
	return waitUntil === "domcontentloaded" ? "interactive" : "complete";
}

const TRUTHY_ENV_VALUES = new Set(["1", "Y", "y", "TRUE", "true", "YES", "yes", "ON", "on"]);

function resolveCmuxEnabled(envValue: string | undefined, settingEnabled: boolean): boolean {
	if (!envValue) return settingEnabled;
	return TRUTHY_ENV_VALUES.has(envValue);
}

export interface ResolveCmuxKindOptions {
	surface?: string;
	settingEnabled?: boolean;
}

export function resolveCmuxKind(
	options?: ResolveCmuxKindOptions | null,
	env: Record<string, string | undefined> = process.env,
): CmuxKind | null {
	if (!resolveCmuxEnabled(env.PI_BROWSER_CMUX, options?.settingEnabled ?? true)) {
		return null;
	}
	const socketPath = env.CMUX_SOCKET_PATH;
	if (!socketPath) {
		return null;
	}
	return {
		kind: "cmux",
		socketPath,
		password: env.CMUX_SOCKET_PASSWORD || undefined,
		surface: options?.surface,
	};
}

export type SelectorKind = "css" | "ref" | "text" | "aria" | "xpath" | "pierce" | "ax";

export interface SelectorSpec {
	kind: SelectorKind;
	value: string;
	raw: string;
	ref?: string;
	name?: string;
	role?: string;
}

function ariaNameFrom(value: string): string | undefined {
	const m = value.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
	return (m?.[1] ?? m?.[2] ?? m?.[3])?.trim();
}

/**
 * Parse a selector string into a {@link SelectorSpec} the cmux selector pipeline
 * understands. Accepts CSS, aria-ref ids (`e2` / `@e2`), the legacy slash query
 * handlers (`text/`, `aria/`, `xpath/`, `pierce/`, plus their `p-` variants), and
 * the Playwright engine syntax advertised to agents (`text=`, `xpath=`, `role=`).
 *
 * `role=button` / `role=button[name="Save"]` resolve to a role-aware aria spec so
 * cmux matches the same elements Playwright's `role=` engine does in the headless
 * worker (implicit roles + accessible name) instead of dropping the role or
 * forwarding an invalid CSS selector.
 */
export function cmuxSelectorSpec(selector: string): SelectorSpec {
	const raw = selector;
	let normalized = selector;
	// Translate Playwright engine= syntax (text=, xpath=, role=) before the legacy
	// slash handling so both selector dialects reach the same matcher.
	const eqIdx = selector.indexOf("=");
	if (
		eqIdx > 0 &&
		!selector.startsWith("aria/") &&
		!selector.startsWith("text/") &&
		!selector.startsWith("xpath/") &&
		!selector.startsWith("pierce/")
	) {
		const prefix = selector.slice(0, eqIdx);
		const value = selector.slice(eqIdx + 1);
		if (prefix === "text") normalized = `text/${value}`;
		else if (prefix === "xpath") normalized = `xpath/${value}`;
		else if (prefix === "role") {
			const name = ariaNameFrom(value);
			const role = value.replace(/\[.*$/, "").trim();
			if (role) return { kind: "aria", value: name ?? role, raw, role, name };
		}
	}
	if (normalized.startsWith("p-text/")) normalized = `text/${normalized.slice("p-text/".length)}`;
	else if (normalized.startsWith("p-aria/")) normalized = `aria/${normalized.slice("p-aria/".length)}`;
	else if (normalized.startsWith("p-xpath/")) normalized = `xpath/${normalized.slice("p-xpath/".length)}`;
	else if (normalized.startsWith("p-pierce/")) normalized = `pierce/${normalized.slice("p-pierce/".length)}`;
	const ref = /^@?(e\d+)$/.exec(normalized);
	if (ref) return { kind: "ref", value: ref[1]!, raw, ref: `@${ref[1]}` };
	const slash = normalized.indexOf("/");
	if (slash > 0) {
		const prefix = normalized.slice(0, slash);
		const value = normalized.slice(slash + 1);
		if (prefix === "aria") {
			const name = ariaNameFrom(value);
			const roleMatch = value.match(/^(\w+)\s*\[\s*name\s*=/);
			const role = roleMatch?.[1];
			// `aria/Save` (bare token) is an accessible name; `aria/role[name="…"]` carries both.
			const resolvedName = name ?? (role ? undefined : value.trim() || undefined);
			return { kind: "aria", value: resolvedName ?? value, raw, role, name: resolvedName };
		}
		if (prefix === "text" || prefix === "xpath" || prefix === "pierce") {
			return { kind: prefix, value, raw };
		}
	}
	return { kind: "css", value: normalized, raw };
}
