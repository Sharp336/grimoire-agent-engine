import type { ObservabilityTab } from "../data/hash-route";
import type { TimeRange } from "../types";
import { ObservabilitySection } from "./ObservabilitySection";

export interface SessionsRouteProps {
	active: boolean;
	id: string | null;
	tab: ObservabilityTab | null;
	range: TimeRange;
	status: string | null;
	project: string | null;
	failure: string | null;
	q: string | null;
	refreshTrigger: number;
	onOpen: (id: string) => void;
	onTab: (tab: ObservabilityTab) => void;
	onRequestClick?: (id: number) => void;
}

export function SessionsRoute(props: SessionsRouteProps) {
	return <ObservabilitySection kind="sessions" {...props} />;
}
