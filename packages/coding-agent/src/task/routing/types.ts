export type RoutingIntent = "default" | "cheap" | "normal" | "strong" | "vision" | "large-context" | "same-pool-ok";

export type ResourcePoolIdentity = {
	key: string;
	provider: string;
	baseUrl?: string;
	accountKey: string;
	label: string;
};

export type RoutingUsageState = "healthy" | "reserve" | "depleted" | "unknown";

export type RoutingCandidateInput = {
	selector: string;
	pool: ResourcePoolIdentity;
	vision: boolean;
	supportsTools: boolean;
	contextWindow: number | null;
	costPerMTokenTotal: number;
	reasoning: boolean;
	usage: RoutingUsageState;
	preferredRank?: number;
};

export type RoutingPolicy = {
	enabled: boolean;
	avoidParentPool: boolean;
	parentPoolFallback: "allow" | "deny";
	excludePools: readonly string[];
	preferPools: readonly string[];
};

export type RoutingRequirements = { vision?: boolean; minContextWindow?: number; structuredOutput?: boolean };

export type RoutingRequest = {
	agent: string;
	intent: RoutingIntent;
	requirements: RoutingRequirements;
	parentPool?: ResourcePoolIdentity;
	siblingPools?: readonly string[];
	deadSelectors?: readonly string[];
	policy: RoutingPolicy;
	candidates: readonly RoutingCandidateInput[];
	random?: () => number;
};

export type RoutingDecision = {
	ok: true;
	selectors: string[];
	pool: ResourcePoolIdentity;
	intent: RoutingIntent;
	antiAffinityApplied: boolean;
	parentPoolFallback: boolean;
	usageInfluenced: boolean;
	exclusionsApplied: string[];
	reason: string;
	trace: string[];
};

export type RoutingFailure = {
	ok: false;
	code: "no_viable_candidate" | "parent_pool_fail_closed" | "routing_disabled";
	reason: string;
	trace: string[];
};

export type RoutingOutcome = RoutingDecision | RoutingFailure;
