import type { AgentStorage } from "../session/agent-storage";
import type { Skill } from "./skills";

/** Minimum total invocations before switching from full-list to top-N mode. */
const SKILL_FREQUENCY_WARMUP_THRESHOLD = 10;
/** Recent-use window for inclusion in the frequent set. */
const SKILL_FREQUENCY_RECENT_DAYS = 7;
const SKILL_FREQUENCY_RECENT_SECS = SKILL_FREQUENCY_RECENT_DAYS * 86_400;
/** SQLite cache key for the daily-computed frequent skill names. */
const FREQUENT_SKILL_CACHE_KEY = "skills.frequentSet";

interface FrequentSkillsPayload {
	settingsHash: string;
	names: string[];
}

interface UsageEntry {
	name: string;
	score: number;
	lastUsedAt: number;
	totalCount: number;
}

/**
 * Pure computation of the frequent skill set.
 * `nowSec` is injected so tests can control time.
 */
export function computeFrequentSkillNames({
	skills,
	usage,
	frequentCount,
	alwaysInclude,
	nowSec,
}: {
	skills: Pick<Skill, "name" | "hide">[];
	usage: UsageEntry[];
	frequentCount: number;
	alwaysInclude: string[];
	nowSec: number;
}): Set<string> {
	const nonHiddenSkills = skills.filter(s => !s.hide);

	// Warmup gate: not enough data → render everything
	const totalInvocations = usage.reduce((sum, u) => sum + u.totalCount, 0);
	if (totalInvocations < SKILL_FREQUENCY_WARMUP_THRESHOLD) {
		return new Set(nonHiddenSkills.map(s => s.name));
	}

	const loadedNames = new Set(nonHiddenSkills.map(s => s.name));
	const frequent = new Set<string>();

	// Pinned: alwaysInclude glob patterns
	if (alwaysInclude.length > 0) {
		for (const skill of nonHiddenSkills) {
			if (alwaysInclude.some(pattern => new Bun.Glob(pattern).match(skill.name))) {
				frequent.add(skill.name);
			}
		}
	}

	// Recent: used within the last 7 days
	const recentCutoff = nowSec - SKILL_FREQUENCY_RECENT_SECS;
	for (const entry of usage) {
		if (entry.lastUsedAt >= recentCutoff && loadedNames.has(entry.name)) {
			frequent.add(entry.name);
		}
	}

	// Top-N by decayed score, alphabetical tiebreak
	const usageByName = new Map(usage.map(u => [u.name, u]));
	const scored = nonHiddenSkills
		.filter(s => !frequent.has(s.name))
		.map(s => ({ name: s.name, score: usageByName.get(s.name)?.score ?? 0 }))
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, Math.max(0, frequentCount - frequent.size));

	for (const { name } of scored) {
		frequent.add(name);
	}

	return frequent;
}

/**
 * Resolves the frequent skill set with a daily SQLite cache.
 * Cache is authoritative on hit; recomputed on hash mismatch or miss.
 * Null storage: compute without caching.
 */
export function resolveFrequentSkillNames(
	storage: AgentStorage | null,
	skills: Pick<Skill, "name" | "hide">[],
	settings: { frequentCount: number; alwaysInclude: string[] },
	nowSec: number,
): Set<string> {
	const nonHiddenNames = skills
		.filter(s => !s.hide)
		.map(s => s.name)
		.sort();
	const settingsHash = JSON.stringify({
		frequentCount: settings.frequentCount,
		alwaysInclude: settings.alwaysInclude,
		skillNames: nonHiddenNames,
	});

	// Try cache hit
	if (storage) {
		try {
			const raw = storage.getCache(FREQUENT_SKILL_CACHE_KEY);
			const cached = raw ? (JSON.parse(raw) as FrequentSkillsPayload) : null;
			if (cached && cached.settingsHash === settingsHash) {
				// Intersect with currently-loaded skills (handles uninstalls)
				const loadedSet = new Set(nonHiddenNames);
				return new Set(cached.names.filter(n => loadedSet.has(n)));
			}
		} catch {
			// cache miss / parse error → recompute
		}
	}

	// Recompute
	const usage = storage ? storage.getSkillUsage() : [];
	const frequent = computeFrequentSkillNames({
		skills,
		usage,
		frequentCount: settings.frequentCount,
		alwaysInclude: settings.alwaysInclude,
		nowSec,
	});

	if (storage) {
		try {
			const payload: FrequentSkillsPayload = {
				settingsHash,
				names: Array.from(frequent),
			};
			storage.setCache(FREQUENT_SKILL_CACHE_KEY, JSON.stringify(payload), Math.floor(nowSec) + 86_400);
		} catch {
			// cache write failure is non-fatal
		}
	}

	return frequent;
}
