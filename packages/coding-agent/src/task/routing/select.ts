import type { RoutingCandidateInput, RoutingRequest } from "./types";

/**
 * Deterministic RNG for the bounded tie-break. Routing is resolved twice for a
 * spawn (batch preflight, then dispatch); seeding from a stable per-spawn string
 * keeps both resolutions on the same candidate instead of drifting apart.
 */
export function seededRandom(seed: string): () => number {
	let state = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		state = ((state ^ seed.charCodeAt(i)) * 0x01000193) >>> 0;
	}
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

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

export function scoreRoutingCandidate(candidate: RoutingCandidateInput, request: RoutingRequest): number {
	let score = 0;

	// usage: healthy +30, unknown +10, reserve -40
	if (candidate.usage === "healthy") score += 30;
	else if (candidate.usage === "unknown") score += 10;
	else if (candidate.usage === "reserve") score -= 40;

	// pool preference: preferPools match +25
	const preferPools = request.policy.preferPools ?? [];
	for (const pattern of preferPools) {
		if (matchesPool(candidate.pool, pattern)) {
			score += 25;
			break;
		}
	}

	// Sibling diversity: penalize pools already chosen in this batch so parallel
	// children spread across providers. -30 outweighs preferredRank (+8) and
	// unknown->healthy (+20) so a healthy alternative pool beats a preferred
	// repeat, but not a depleted/reserve one (handled by hard filters).
	const siblingPools = request.siblingPools ?? [];
	if (siblingPools.includes(candidate.pool.key)) score -= 30;

	// Intent fit. Cost terms are continuous so a materially cheaper candidate
	// wins outright instead of landing inside the tie-break band.
	if (request.intent === "cheap") {
		score += 40 / (1 + candidate.costPerMTokenTotal);
	} else if (request.intent === "strong") {
		// A capability floor, not a preference: never rank non-reasoning above reasoning.
		score += candidate.reasoning ? 40 : -40;
	} else if (request.intent === "normal" || request.intent === "default") {
		score += 10 / (1 + candidate.costPerMTokenTotal);
	}
	// vision / large-context neutral (already hard-filtered)

	// preferredRank small bonus: 0 => +8, 1=>+6, 2=>+4, 3=>+2
	if (candidate.preferredRank !== undefined) {
		const bonus = Math.max(0, 8 - candidate.preferredRank * 2);
		score += bonus;
	}

	return score;
}

export function selectRoutingCandidate(
	candidates: readonly RoutingCandidateInput[],
	request: RoutingRequest,
): RoutingCandidateInput[] {
	if (candidates.length === 0) return [];

	const scored = candidates.map(c => ({
		candidate: c,
		score: scoreRoutingCandidate(c, request),
	}));

	scored.sort((a, b) => b.score - a.score);

	const topScore = scored[0].score;
	const band: typeof scored = [];
	const rest: typeof scored = [];
	for (const s of scored) {
		if (s.score >= topScore - 5) band.push(s);
		else rest.push(s);
	}

	// Bounded tie-break: shuffle band using request.random
	const random = request.random ?? Math.random;
	for (let i = band.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		const tmp = band[i];
		band[i] = band[j];
		band[j] = tmp;
	}

	const ordered = [...band, ...rest];
	return ordered.map(s => s.candidate);
}
