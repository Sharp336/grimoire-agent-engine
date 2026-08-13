import { useCallback, useEffect, useState } from "react";
import type { DashboardSection } from "../app/routes";
import type { TimeRange } from "../types";
import {
	canonicalizeStatsHash,
	formatStatsHash,
	parseStatsHash,
	type ObservabilityTab,
	type StatsHashRoute,
} from "./hash-route";

export function useHashRoute() {
	const [route, setRouteState] = useState(() => parseStatsHash(window.location.hash));

	useEffect(() => {
		const handleHashChange = () => {
			const canonical = canonicalizeStatsHash(window.location.hash);
			if (window.location.hash !== canonical) {
				window.location.hash = canonical.slice(1);
				return;
			}
			setRouteState(parseStatsHash(canonical));
		};

		window.addEventListener("hashchange", handleHashChange);
		handleHashChange();
		return () => window.removeEventListener("hashchange", handleHashChange);
	}, []);

	const updateRoute = useCallback((next: StatsHashRoute) => {
		const hash = formatStatsHash(next);
		if (window.location.hash === hash) {
			setRouteState(next);
		} else {
			window.location.hash = hash.slice(1);
		}
	}, []);

	const setSection = useCallback(
		(section: DashboardSection) => {
			updateRoute({
				...route,
				section,
				id: null,
				tab: null,
				status: null,
				project: null,
				failure: null,
				q: null,
			});
		},
		[route, updateRoute],
	);

	const setRange = useCallback(
		(value: string) => {
			const next = parseStatsHash(`#/${route.section}?range=${encodeURIComponent(value)}`).range;
			updateRoute({ ...route, range: next });
		},
		[route, updateRoute],
	);

	const openDetail = useCallback(
		(section: "sessions" | "runs", id: string) => {
			updateRoute({
				...route,
				section,
				id,
				tab: "requests",
				status: null,
				project: null,
				failure: null,
				q: null,
			});
		},
		[route, updateRoute],
	);

	const setTab = useCallback(
		(tab: ObservabilityTab) => {
			if (!route.id) return;
			updateRoute({ ...route, tab });
		},
		[route, updateRoute],
	);

	return {
		...route,
		setSection,
		setRange: (range: TimeRange) => setRange(range),
		openDetail,
		setTab,
	};
}
