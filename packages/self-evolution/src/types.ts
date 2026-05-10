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
	errorDetails?: string[];
	nudges?: import("./nudge-detector").Nudge[];
	injectedEpisodeIds?: string[];
	injectedSkillNames?: string[];
	injectedConventionIds?: string[];
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
	autonomyNotes?: string;
	lastOptimizedAt?: number;
	optimizationCount?: number;
	userRating?: number; // 1-5 star rating from user
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
	autonomyNotes?: string;
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
	/** Use a global store shared across all projects instead of per-project isolation */
	globalStore: boolean;
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

// ============================================================================
// Intent Classification (v2)
// ============================================================================

export type IntentCategory =
	| "refactoring"
	| "bugfix"
	| "feature-add"
	| "testing"
	| "documentation"
	| "configuration"
	| "exploration"
	| "optimization"
	| "integration";

export interface IntentResult {
	intent: IntentCategory;
	confidence: number;
	source: "rule" | "llm";
	allScores: Record<IntentCategory, number>;
}

export interface EpisodeIntent {
	episodeId: string;
	intent: IntentCategory;
	confidence: number;
	source: "rule" | "llm";
}

// ============================================================================
// Workflow Patterns (v2)
// ============================================================================

export interface WorkflowPattern {
	id: string;
	intent: IntentCategory;
	toolSequence: string[];
	occurrenceCount: number;
	avgQualityScore: number;
	lastSeenAt: number;
}

// ============================================================================
// User Profile (v2)
// ============================================================================

export interface UserProfile {
	toolFrequency: Record<string, number>;
	toolTransitions: Record<string, number>;
	intentDistribution: Record<string, number>;
	avgToolCallsPerSession: number;
	avgFilesModifiedPerSession: number;
	errorRate: number;
	recoveryRate: number;
	preferredLanguages: string[];
	sessionCount: number;
	updatedAt: number;
}

// ============================================================================
// Episode Effectiveness (v2)
// ============================================================================

export interface EpisodeEffectiveness {
	episodeId: string;
	timesInjected: number;
	timesHelped: number;
	timesFailed: number;
}
// ============================================================================
// Skill Effectiveness (v2)
// ============================================================================

export interface SkillEffectiveness {
	skillName: string;
	timesInjected: number;
	timesHelped: number;
	timesFailed: number;
	lastInjectedAt: number;
}

// ============================================================================
// Cross-Session Nudges
// ============================================================================

export interface CrossSessionNudge {
	type: string;
	severity: "info" | "warn";
	message: string;
	suggestion: string;
	detectedAt: number;
}

export interface NudgeRecord {
	id: string;
	sessionId: string;
	project: string;
	type: string;
	severity: string;
	message: string;
	suggestion: string;
	detectedAt: number;
	dismissedAt?: number;
	acknowledged?: boolean;
}

// ============================================================================
// Convention — project-specific rules extracted from user dialogue (v2.5)
// ============================================================================

export type ConventionType = "negative_rule" | "positive_rule" | "preference" | "project_fact" | "procedural_rule";

export interface Convention {
	id: string;
	type: ConventionType;
	content: string;
	sourceEpisodeId: string;
	confidence: number;
	timesApplied: number;
	timesViolated: number;
	createdAt: number;
	lastSeenAt: number;
}

export interface ConventionFeedback {
	conventionId: string;
	sessionId: string;
	complied: boolean; // true = agent followed, false = violated
	violationDetails?: string; // what the agent did that violated the rule
	recordedAt: number;
}

export interface ConventionViolation {
	convention: Convention;
	violationCount: number;
	lastViolationAt: number;
}

// ============================================================================
// Injection Outcome — multi-dimensional effectiveness scoring (v2.5)
// ============================================================================

export interface InjectionOutcome {
	episodeId: string;
	helpfulness: number;
	hasExplicitCorrection: boolean;
	hasExplicitApproval: boolean;
	wasRedundant: boolean;
	avoidedPreviousErrors: boolean;
	toolEfficiency: number;
}

export interface ErrorPattern {
	id: string;
	name: string;
	description: string;
	regex: string;
	category: "syntax" | "format" | "runtime" | "permission" | "not_found" | "type" | "other";
	affectedSessions: string[];
	count: number;
	firstSeenAt: number;
	lastSeenAt: number;
	extractedConventions: string[];
}

export interface DailyReport {
	date: string;
	totalSessions: number;
	successfulSessions: number;
	failedSessions: number;
	emptySessions: number;
	partialSessions: number;
	sessions: Array<{
		sessionId: string;
		userPrompt: string;
		toolCallCount: number;
		errorCount: number;
		completedSuccessfully: boolean;
		errors: string[];
		highlights: string[];
	}>;
	topErrorPatterns: ErrorPattern[];
	newConventions: Convention[];
	topTools: Array<{ tool: string; count: number }>;
	keyMoments: Array<{
		type: "error" | "recovery" | "success" | "correction";
		sessionId: string;
		description: string;
		timestamp: number;
	}>;
}
