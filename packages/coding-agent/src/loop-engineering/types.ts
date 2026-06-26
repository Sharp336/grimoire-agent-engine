export type LoopLevel = "report" | "assisted" | "autonomous";
export type LoopTriggerType = "manual" | "cron" | "github-actions" | "launch-agent";
export type LoopRunStatus = "dry_run" | "passed" | "failed" | "needs_approval";

export interface LoopCommandSpec {
	argv: string[];
	cwd?: string;
}

export interface LoopScope {
	paths: string[];
	branches: string[];
	repos: string[];
}

export interface LoopTrigger {
	type: LoopTriggerType;
	cadence: string | null;
	fireImmediately: boolean;
}

export interface LoopRunnerSpec {
	prompt: string;
}

export interface LoopVerifierSpec {
	separate: boolean;
	commands: LoopCommandSpec[];
}

export interface LoopGuardrails {
	maxIterations: number | null;
	maxFilesChanged: number | null;
	maxAutoPrsPerDay: number | null;
	requireHumanApproval: string[];
	denylistPaths: string[];
}

export interface LoopStateSpec {
	file: string | null;
	runLog: string | null;
	budget: string | null;
}

export interface LoopSpec {
	name: string;
	goal: string;
	level: LoopLevel;
	nonGoals: string[];
	scope: LoopScope;
	trigger: LoopTrigger;
	runner: LoopRunnerSpec;
	verifier: LoopVerifierSpec;
	guardrails: LoopGuardrails;
	state: LoopStateSpec;
	sourcePath?: string;
}

export interface LoopReadinessAssessment {
	ready: boolean;
	score: number;
	issues: string[];
	warnings: string[];
}

export interface LoopRunRecord {
	id: string;
	loop: string;
	status: LoopRunStatus;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	level: LoopLevel;
	prompt: string;
	agentExitCode: number | null;
	agentOutput: string;
	verifierResults: LoopVerifierResult[];
	changedFiles: string[];
	approvalReasons: string[];
	error: string | null;
}

export interface LoopVerifierResult {
	command: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface LoopRunResult extends LoopRunRecord {
	jsonlPath: string | null;
	markdownLogPath: string | null;
}

export interface LoopRunOptions {
	cwd: string;
	dryRun?: boolean;
	now?: () => Date;
	runAgent?: (prompt: string, cwd: string) => Promise<{ exitCode: number | null; output: string }>;
}
