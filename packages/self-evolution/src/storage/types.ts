import type {
	Episode,
	EpisodeEffectiveness,
	EpisodeIntent,
	EvolvedSkill,
	NudgeRecord,
	SkillEffectiveness,
	SkillVersion,
	UserProfile,
	WorkflowPattern,
} from "../types";

export interface EpisodeStore {
	insert(episode: Episode): Promise<void>;
	listRecent(limit: number): Promise<Episode[]>;
	searchByKeyword(query: string, limit: number): Promise<Episode[]>;
	searchFailedByKeyword(query: string, limit: number): Promise<Episode[]>;
	deleteOld(keepCount: number): Promise<number>;
	count(): Promise<number>;
}

export interface SkillStore {
	get(name: string): Promise<EvolvedSkill | undefined>;
	list(filter?: { deprecated?: boolean }): Promise<EvolvedSkill[]>;
	upsert(skill: EvolvedSkill): Promise<void>;
	delete(name: string): Promise<void>;
	count(): Promise<number>;
}

export interface SkillVersionStore {
	record(version: SkillVersion): Promise<void>;
	getHistory(name: string): Promise<SkillVersion[]>;
	getSpecific(name: string, version: number): Promise<SkillVersion | undefined>;
	prune(name: string, keepCount: number): Promise<number>;
	count(): Promise<number>;
}

export interface StatsStore {
	get(key: string): Promise<number>;
	increment(key: string, delta?: number): Promise<void>;
}

export interface IntentStore {
	insert(intent: EpisodeIntent): Promise<void>;
	getByEpisode(episodeId: string): Promise<EpisodeIntent[]>;
	getByIntent(intent: string, limit: number): Promise<EpisodeIntent[]>;
}

export interface WorkflowPatternStore {
	upsert(pattern: WorkflowPattern): Promise<void>;
	getByIntent(intent: string, limit: number): Promise<WorkflowPattern[]>;
	getById(id: string): Promise<WorkflowPattern | undefined>;
	listAll(): Promise<WorkflowPattern[]>;
}

export interface ProfileStore {
	get(id: string): Promise<UserProfile | undefined>;
	upsert(id: string, profile: UserProfile): Promise<void>;
}

export interface EffectivenessStore {
	get(episodeId: string): Promise<EpisodeEffectiveness | undefined>;
	recordInjection(episodeId: string): Promise<void>;
	recordOutcome(episodeId: string, helped: boolean): Promise<void>;
}
export interface SkillEffectivenessStore {
	get(skillName: string): Promise<SkillEffectiveness | undefined>;
	recordInjection(skillName: string): Promise<void>;
	recordOutcome(skillName: string, succeeded: boolean): Promise<void>;
}

export interface NudgeHistoryStore {
	insert(record: NudgeRecord): Promise<void>;
	listRecent(limit: number): Promise<NudgeRecord[]>;
	listByType(type: string, limit: number): Promise<NudgeRecord[]>;
	countByType(type: string, since: number): Promise<number>;
}
