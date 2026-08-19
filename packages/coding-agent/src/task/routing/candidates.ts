import type { RoutingCandidateInput, RoutingRequest } from "./types";

function matchesPool(
	pool: { provider: string; accountKey: string; label: string; key: string },
	pattern: string,
): boolean {
	const lower = pattern.trim().toLowerCase();
	if (!lower) return false;
	return (
		pool.provider.toLowerCase().includes(lower) ||
		pool.accountKey.toLowerCase().includes(lower) ||
		pool.label.toLowerCase().includes(lower) ||
		pool.key.toLowerCase().includes(lower)
	);
}

export function filterRoutingCandidates(request: RoutingRequest): {
	viable: RoutingCandidateInput[];
	antiAffinityApplied: boolean;
	exclusionsApplied: string[];
	usageInfluenced: boolean;
	trace: string[];
} {
	const trace: string[] = [];
	let viable: RoutingCandidateInput[] = [...request.candidates];
	let usageInfluenced = false;
	const exclusionsApplied: string[] = [];

	// 1. depleted removed
	const beforeDepleted = viable.length;
	viable = viable.filter(c => c.usage !== "depleted");
	if (viable.length !== beforeDepleted) {
		usageInfluenced = true;
		trace.push(`depleted removed: ${beforeDepleted - viable.length}`);
	} else {
		trace.push("depleted: none removed");
	}
	// 2. dead routes suppressed for this run (bounded, per-orchestration)
	const deadSelectors = request.deadSelectors ?? [];
	if (deadSelectors.length > 0) {
		const deadSet = new Set(deadSelectors.map(s => s.toLowerCase()));
		const beforeDead = viable.length;
		viable = viable.filter(c => {
			const sel = c.selector.toLowerCase();
			if (deadSet.has(sel)) return false;
			// Also match bare id extracted from dead message (e.g. gemini-1.5-flash)
			for (const dead of deadSet) {
				const deadId = dead.includes("/") ? (dead.split("/")[1] ?? dead) : dead;
				if (deadId && c.selector.toLowerCase().endsWith(`/${deadId.toLowerCase()}`)) return false;
			}
			return true;
		});
		if (viable.length !== beforeDead) trace.push(`dead suppressed: ${beforeDead - viable.length}`);
		else trace.push("dead: none suppressed");
	} else {
		trace.push("dead: none");
	}

	// 3. exclusion patterns removed (ALWAYS, never relaxed)
	const excludePatterns = request.policy.excludePools ?? [];
	for (const pattern of excludePatterns) {
		const before = viable.length;
		viable = viable.filter(c => !matchesPool(c.pool, pattern));
		if (viable.length !== before) {
			exclusionsApplied.push(pattern);
			trace.push(`exclusion "${pattern}" removed ${before - viable.length}`);
		}
	}
	if (exclusionsApplied.length === 0) trace.push("exclusions: none applied");

	// effective requirements
	const effectiveVision = request.requirements.vision === true || request.intent === "vision";
	let effectiveMinContext = request.requirements.minContextWindow;
	if (request.intent === "large-context") {
		const intentMin = 200_000;
		effectiveMinContext = Math.max(effectiveMinContext ?? 0, intentMin);
		if (effectiveMinContext === 0) effectiveMinContext = intentMin;
	}
	const effectiveStructured = request.requirements.structuredOutput === true;

	const beforeReq = viable.length;
	viable = viable.filter(c => {
		if (effectiveVision && !c.vision) return false;
		if (effectiveMinContext !== undefined && effectiveMinContext !== null && effectiveMinContext > 0) {
			if (c.contextWindow === null) return false;
			if (c.contextWindow < effectiveMinContext) return false;
		}
		if (effectiveStructured && !c.supportsTools) return false;
		return true;
	});
	if (viable.length !== beforeReq) {
		trace.push(`requirements filtered ${beforeReq - viable.length}`);
	} else {
		trace.push("requirements: all passed");
	}

	// 4b. "strong" is a capability floor, not a preference: once any reasoning
	// candidate survives, non-reasoning routes leave the viable set entirely so
	// no combination of cheapness/headroom/preference bonuses can downgrade it.
	if (request.intent === "strong") {
		const reasoning = viable.filter(candidate => candidate.reasoning);
		if (reasoning.length > 0 && reasoning.length !== viable.length) {
			trace.push(`strong intent removed ${viable.length - reasoning.length} non-reasoning candidate(s)`);
			viable = reasoning;
		}
	}

	trace.push(
		`intent=${request.intent} vision=${String(effectiveVision)} minContext=${String(effectiveMinContext ?? "none")} structured=${String(effectiveStructured)}`,
	);

	// 5. parent-pool anti-affinity
	let antiAffinityApplied = false;
	const parentPool = request.parentPool;
	if (parentPool && request.policy.avoidParentPool && request.intent !== "same-pool-ok") {
		const nonParent = viable.filter(c => c.pool.key !== parentPool.key);
		if (nonParent.length > 0) {
			const parentCount = viable.length - nonParent.length;
			if (parentCount > 0) {
				antiAffinityApplied = true;
				trace.push(`anti-affinity removed ${parentCount} parent-pool candidate(s)`);
				viable = nonParent;
			} else {
				trace.push("anti-affinity: no parent-pool candidates to remove");
			}
		} else {
			trace.push("anti-affinity: no non-parent alternative, parent pool retained");
		}
	} else {
		if (!parentPool) trace.push("anti-affinity: no parent pool");
		else if (!request.policy.avoidParentPool) trace.push("anti-affinity: disabled by policy");
		else trace.push("anti-affinity: same-pool-ok intent");
	}

	// usage unknown never hard-filtered is implicit (no removal)
	trace.push(`viable=${viable.length} usageInfluenced=${String(usageInfluenced)}`);

	return {
		viable,
		antiAffinityApplied,
		exclusionsApplied,
		usageInfluenced,
		trace,
	};
}
