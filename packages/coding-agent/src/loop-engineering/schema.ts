import * as path from "node:path";
import type {
	LoopCommandSpec,
	LoopGuardrails,
	LoopLevel,
	LoopScope,
	LoopSpec,
	LoopStateSpec,
	LoopTrigger,
	LoopTriggerType,
	LoopVerifierSpec,
} from "./types";

const DEFAULT_DENYLIST_PATHS = [
	".env",
	".env.*",
	"**/secrets/**",
	"**/credentials/**",
	"**/*_key*",
	"**/*_secret*",
	".terraform/**",
	"k8s/production/**",
	"**/migrations/**",
];

const LOOP_LEVELS: Record<LoopLevel, true> = { autonomous: true, assisted: true, report: true };
const TRIGGER_TYPES: Record<LoopTriggerType, true> = {
	cron: true,
	"github-actions": true,
	"launch-agent": true,
	manual: true,
};

export function parseLoopSpec(content: string, sourcePath?: string): LoopSpec {
	const raw = Bun.YAML.parse(content) as unknown;
	const root = asRecord(raw);
	const loop = root ? asRecord(root.loop) : null;
	if (!loop) throw new Error("Loop spec must have a top-level 'loop' object");

	const level = stringValue(loop.level) || "report";
	if (!LOOP_LEVELS[level as LoopLevel]) {
		throw new Error("loop.level must be one of: report, assisted, autonomous");
	}

	return {
		name: normalizeName(stringValue(loop.name) || "loop"),
		goal: stringValue(loop.goal) || "",
		level: level as LoopLevel,
		nonGoals: stringArray(loop.non_goals),
		scope: parseScope(loop.scope),
		trigger: parseTrigger(loop.trigger),
		runner: { prompt: stringValue(asRecord(loop.runner)?.prompt) || "" },
		verifier: parseVerifier(loop.verifier),
		guardrails: parseGuardrails(loop.guardrails),
		state: parseState(loop.state),
		sourcePath,
	};
}

export function normalizeName(name: string): string {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "loop";
}

export function defaultDenylistPaths(): string[] {
	return [...DEFAULT_DENYLIST_PATHS];
}

function parseScope(value: unknown): LoopScope {
	const scope = asRecord(value);
	return {
		paths: stringArray(scope?.paths, ["."]),
		branches: stringArray(scope?.branches),
		repos: stringArray(scope?.repos),
	};
}

function parseTrigger(value: unknown): LoopTrigger {
	const trigger = asRecord(value);
	const type = stringValue(trigger?.type) || "manual";
	return {
		type: TRIGGER_TYPES[type as LoopTriggerType] ? (type as LoopTriggerType) : "manual",
		cadence: stringValue(trigger?.cadence),
		fireImmediately: booleanValue(trigger?.fire_immediately) ?? false,
	};
}

function parseVerifier(value: unknown): LoopVerifierSpec {
	const verifier = asRecord(value);
	return {
		separate: booleanValue(verifier?.separate) ?? false,
		commands: commandArray(verifier?.commands),
	};
}

function parseGuardrails(value: unknown): LoopGuardrails {
	const guardrails = asRecord(value);
	return {
		maxIterations: positiveInteger(guardrails?.max_iterations),
		maxFilesChanged: nonNegativeInteger(guardrails?.max_files_changed),
		maxAutoPrsPerDay: nonNegativeInteger(guardrails?.max_auto_prs_per_day),
		requireHumanApproval: stringArray(guardrails?.require_human_approval),
		denylistPaths: [...new Set([...DEFAULT_DENYLIST_PATHS, ...stringArray(guardrails?.denylist_paths)])],
	};
}

function parseState(value: unknown): LoopStateSpec {
	const state = asRecord(value);
	return {
		file: projectRelativePath(state?.file, "loop.state.file"),
		runLog: safeRunLogPath(state?.run_log),
		budget: projectRelativePath(state?.budget, "loop.state.budget"),
	};
}

function commandArray(value: unknown): LoopCommandSpec[] {
	if (!Array.isArray(value)) return [];
	const commands: LoopCommandSpec[] = [];
	for (const item of value) {
		if (Array.isArray(item)) {
			commands.push({ argv: parseArgv(item) });
			continue;
		}
		const record = asRecord(item);
		if (!record) throw new Error("loop.verifier.commands entries must be argv arrays or objects with argv arrays");
		if (!Array.isArray(record.argv))
			throw new Error("loop.verifier.commands object entries must include an argv array");
		const cwd = record.cwd === undefined ? undefined : stringValue(record.cwd);
		if (record.cwd !== undefined && !cwd) throw new Error("loop.verifier.commands cwd must be a non-empty string");
		commands.push({ argv: parseArgv(record.argv), cwd: cwd ?? undefined });
	}
	return commands;
}

function parseArgv(value: unknown[]): string[] {
	if (value.length === 0) throw new Error("loop.verifier.commands argv must not be empty");
	return value.map(part => {
		if (typeof part !== "string" || part.length === 0) {
			throw new Error("loop.verifier.commands argv entries must be non-empty strings");
		}
		return part;
	});
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function projectRelativePath(value: unknown, label: string): string | null {
	const raw = stringValue(value);
	if (!raw) return null;
	if (path.isAbsolute(raw)) throw new Error(`${label} must be relative to the project`);
	const normalized = path.normalize(raw);
	if (normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
		throw new Error(`${label} must stay inside the project`);
	}
	return normalized;
}

function safeRunLogPath(value: unknown): string | null {
	const raw = projectRelativePath(value, "loop.state.run_log");
	if (!raw) return null;
	const normalized = raw.replaceAll("\\", "/");
	if (normalized === "loop-run-log.md") return raw;
	if (normalized.startsWith(".omp/loop-runs/") && normalized.endsWith(".md")) return raw;
	throw new Error("loop.state.run_log must be loop-run-log.md or a Markdown file under .omp/loop-runs/");
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function stringArray(value: unknown, fallback: string[] = []): string[] {
	if (!Array.isArray(value)) return [...fallback];
	return value.filter(item => typeof item === "string" && item.trim().length > 0).map(item => item.trim());
}

function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function nonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
