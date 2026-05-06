/**
 * Core types for the self-evolution plugin.
 */

// ============================================================================
// Session Trace (in-memory, per-session)
// ============================================================================

export interface TraceEntry {
	type: "tool_call" | "tool_result" | "user_input" | "assistant_message";
	timestamp: number;
	toolName?: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	content?: string;
}

export interface SessionTrace {
	sessionId: string;
	cwd: string;
	userPrompt: string;
	startTime: number;
	endTime: number;
	entries: TraceEntry[];
	toolCallCount: number;
	errorCount: number;
	hadRecovery: boolean;
	completedSuccessfully: boolean;
}

// ============================================================================
// Episode (persisted)
// ============================================================================

export interface Episode {
	id: string;
	sessionId: string;
	cwd: string;
	userPrompt: string;
	timestamp: number;
	durationMs: number;
	toolCallCount: number;
	errorCount: number;
	hadRecovery: boolean;
	completedSuccessfully: boolean;
	summary: string;
	toolsUsed: string[];
	filesModified: string[];
}

// ============================================================================
// EvolvedSkill (persisted)
// ============================================================================

export interface EvolvedSkill {
	name: string;
	description: string;
	taskPattern: string;
	approach: string;
	tools: string[];
	pitfalls: string[];
	createdAt: number;
	usageCount: number;
	lastUsedAt: number;
	successCount: number;
	failureCount: number;
	version: number;
	qualityScore?: number;
	optimizedPrompt?: string;
	deprecated?: boolean;
	deprecationReason?: string;
}

// ============================================================================
// Skill Version (persisted snapshot)
// ============================================================================

export interface SkillVersion {
	name: string;
	version: number;
	skill: EvolvedSkill;
	changedAt: number;
	changeType: "extracted" | "merged" | "optimized" | "deprecated" | "rolled_back";
	changeReason?: string;
}

// ============================================================================
// Activity Log
// ============================================================================

export interface LogEntry {
	timestamp: number;
	event: string;
	details: Record<string, unknown>;
}

// ============================================================================
// Skill Extraction Result
// ============================================================================

export interface ExtractedSkill {
	name: string;
	description: string;
	taskPattern: string;
	approach: string;
	tools: string[];
	pitfalls: string[];
	qualityScore: number;
	llmRefined: boolean;
}

// ============================================================================
// Plugin Flags
// ============================================================================

export interface SelfEvolutionFlags {
	enabled: boolean;
	skillThreshold: number;
	maxEpisodes: number;
	enablePromptInjection: boolean;
	llmRefinement: boolean;
	llmRerank: boolean;
	enableVersioning: boolean;
	enableActivityLog: boolean;
}

// ============================================================================
// Episode Retrieval
// ============================================================================

export interface EpisodeCandidate {
	episode: Episode;
	keywordScore: number;
}

export interface RerankedEpisode {
	episode: Episode;
	relevanceScore: number;
	reason: string;
}
