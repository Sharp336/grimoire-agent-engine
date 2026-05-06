/**
 * Storage abstraction interfaces for self-evolution.
 */
import type { Episode, EvolvedSkill, SkillVersion } from "../types";

export interface EpisodeStore {
	insert(episode: Episode): Promise<void>;
	listRecent(limit: number): Promise<Episode[]>;
	searchByKeyword(query: string, limit: number): Promise<Episode[]>;
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
