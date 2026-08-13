import type { DashboardSection } from "../app/routes";
import type { TimeRange } from "../types";

export const OBSERVABILITY_TABS = [
	"timeline",
	"requests",
	"tools",
	"failures",
	"behavior",
	"tokens",
	"models-routes",
	"logs-raw",
] as const;

export type ObservabilityTab = (typeof OBSERVABILITY_TABS)[number];

const VALID_SECTIONS: DashboardSection[] = [
	"overview",
	"sessions",
	"runs",
	"requests",
	"errors",
	"models",
	"providers",
	"tools",
	"costs",
	"behavior",
	"projects",
	"gain",
];
const VALID_RANGES: TimeRange[] = ["1h", "24h", "7d", "30d", "90d", "all"];

export interface StatsHashRoute {
	section: DashboardSection;
	id: string | null;
	range: TimeRange;
	tab: ObservabilityTab | null;
	status: string | null;
	project: string | null;
	failure: string | null;
	q: string | null;
}

function safeDecode(value: string): string | null {
	try {
		const decoded = decodeURIComponent(value);
		return decoded || null;
	} catch {
		return null;
	}
}

export function parseStatsHash(hash: string): StatsHashRoute {
	const cleanHash = hash.replace(/^#\/?/, "");
	const [pathPart = "", queryPart = ""] = cleanHash.split("?", 2);
	const [rawSection = "", rawId] = pathPart.split("/", 2);
	const section = VALID_SECTIONS.includes(rawSection as DashboardSection)
		? (rawSection as DashboardSection)
		: "overview";
	const observabilitySection = section === "sessions" || section === "runs";
	const id = observabilitySection && rawId ? safeDecode(rawId) : null;
	const params = new URLSearchParams(queryPart);
	const rangeParam = params.get("range") as TimeRange;
	const range = VALID_RANGES.includes(rangeParam) ? rangeParam : "24h";
	const rawTab = params.get("tab");
	const tab = id
		? OBSERVABILITY_TABS.includes(rawTab as ObservabilityTab)
			? (rawTab as ObservabilityTab)
			: "requests"
		: null;
	const listRoute = observabilitySection && !id;

	return {
		section,
		id,
		range,
		tab,
		status: listRoute ? params.get("status") : null,
		project: listRoute ? params.get("project") : null,
		failure: listRoute ? params.get("failure") : null,
		q: listRoute ? params.get("q") : null,
	};
}

export function formatStatsHash(route: StatsHashRoute): string {
	const path = `#/${route.section}${route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
	const params = new URLSearchParams();
	params.set("range", route.range);
	if (route.id && route.tab) params.set("tab", route.tab);
	if (!route.id && (route.section === "sessions" || route.section === "runs")) {
		if (route.status) params.set("status", route.status);
		if (route.project) params.set("project", route.project);
		if (route.failure) params.set("failure", route.failure);
		if (route.q) params.set("q", route.q);
	}
	return `${path}?${params.toString()}`;
}

export function canonicalizeStatsHash(hash: string): string {
	return formatStatsHash(parseStatsHash(hash));
}
