import { YAML } from "bun";
import { type Routine, type RoutineStep, routineCapability } from "../capability/routine";
import type { SourceMeta } from "../capability/types";
import { loadCapability } from "../discovery";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { type FileSlashCommand, renderFileSlashCommand } from "./slash-commands";

export type { Routine, RoutineCommandStep, RoutineMessageStep, RoutineStep } from "../capability/routine";

export const ROUTINE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type RoutineProgressStatus = "queued" | "running" | "failed" | "complete" | "cancelled";

export interface RoutineProgress {
	routine: string;
	status: RoutineProgressStatus;
	index: number;
	total: number;
	step?: string;
	message?: string;
}

export interface RoutineInvocation {
	routine: Routine;
	argsText: string;
}

export interface RenderedRoutineStep {
	kind: "command" | "message";
	label: string;
	text: string;
}

export interface RoutineExecutionPlan {
	routine: Routine;
	argsText: string;
	steps: RenderedRoutineStep[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) {
			throw new Error(`${context} has unsupported key: ${key}`);
		}
	}
}

function requireRoutineName(name: string): string {
	const routineName = name.replace(/\.yaml$/, "");
	if (!ROUTINE_NAME_PATTERN.test(routineName)) {
		throw new Error(`Invalid routine name: ${routineName}`);
	}
	return routineName;
}

function parseStep(raw: unknown, index: number): RoutineStep {
	if (!isRecord(raw)) {
		throw new Error(`Step ${index + 1} must be an object`);
	}
	const hasCommand = Object.hasOwn(raw, "command");
	const hasMessage = Object.hasOwn(raw, "message");
	if (hasCommand === hasMessage) {
		throw new Error(`Step ${index + 1} must contain exactly one of command or message`);
	}
	if (hasCommand) {
		assertOnlyKeys(raw, ["command", "args"], `Step ${index + 1}`);
		if (typeof raw.command !== "string") {
			throw new Error(`Step ${index + 1} command must be a string`);
		}
		const command = raw.command.trim();
		if (!ROUTINE_NAME_PATTERN.test(command)) {
			throw new Error(`Invalid routine command step: ${command}`);
		}
		if (raw.args !== undefined && typeof raw.args !== "string") {
			throw new Error(`Step ${index + 1} args must be a string`);
		}
		return raw.args === undefined ? { command } : { command, args: raw.args };
	}
	assertOnlyKeys(raw, ["message"], `Step ${index + 1}`);
	if (typeof raw.message !== "string") {
		throw new Error(`Step ${index + 1} message must be a string`);
	}
	if (!raw.message.trim()) {
		throw new Error(`Step ${index + 1} message must not be empty`);
	}
	return { message: raw.message };
}

export async function loadRoutines(options: { cwd?: string } = {}): Promise<Routine[]> {
	const result = await loadCapability<Routine>(routineCapability.id, { cwd: options.cwd });
	if (result.warnings.length > 0) {
		throw new Error(`Failed to load routines:\n${result.warnings.join("\n")}`);
	}
	return result.items;
}

export function validateRoutineCommandNames(
	routines: readonly Routine[],
	reservedNames: ReadonlySet<string>,
): Set<string> {
	const routineNames = new Set<string>();
	for (const routine of routines) {
		if (routineNames.has(routine.name)) {
			throw new Error(`Duplicate routine /${routine.name}`);
		}
		if (reservedNames.has(routine.name)) {
			throw new Error(`Routine /${routine.name} conflicts with existing slash command /${routine.name}`);
		}
		routineNames.add(routine.name);
	}
	return routineNames;
}

export function parseRoutineFile(input: { name: string; content: string; path: string; source: SourceMeta }): Routine {
	if (input.content.trimStart().startsWith("---")) {
		throw new Error("Routine files must be plain YAML without frontmatter");
	}
	const name = requireRoutineName(input.name);
	const parsed: unknown = YAML.parse(input.content);
	if (!isRecord(parsed)) {
		throw new Error("Routine YAML root must be an object");
	}
	assertOnlyKeys(parsed, ["description", "steps"], "Routine");
	if (typeof parsed.description !== "string" || !parsed.description.trim()) {
		throw new Error("Routine description must be a non-empty string");
	}
	if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
		throw new Error("Routine steps must be a non-empty array");
	}
	return {
		name,
		path: input.path,
		description: parsed.description.trim(),
		steps: parsed.steps.map(parseStep),
		level: "user",
		_source: input.source,
	};
}

export function parseRoutineInvocation(text: string, routines: readonly Routine[]): RoutineInvocation | null {
	const parsed = parseSlashCommand(text);
	if (!parsed) return null;
	const routine = routines.find(candidate => candidate.name === parsed.name);
	if (!routine) return null;
	return { routine, argsText: parsed.args };
}

function composeRoutineCommandArgs(stepArgs: string | undefined, invocationArgs: string): string {
	const left = stepArgs?.trimEnd() ?? "";
	const right = invocationArgs.trim();
	if (!left) return right;
	if (!right) return left;
	return `${left}\n\n${right}`;
}

function replaceRoutineArguments(text: string, argsText: string): string {
	return text.split("$ARGUMENTS").join(argsText);
}

export function buildRoutineExecutionPlan(
	invocation: RoutineInvocation,
	fileCommands: readonly FileSlashCommand[],
	routineNames: ReadonlySet<string> = new Set(),
): RoutineExecutionPlan {
	const commandByName = new Map(fileCommands.map(command => [command.name, command]));
	const steps = invocation.routine.steps.map((step): RenderedRoutineStep => {
		if ("message" in step) {
			return {
				kind: "message",
				label: "message",
				text: replaceRoutineArguments(step.message, invocation.argsText),
			};
		}
		if (routineNames.has(step.command)) {
			throw new Error(`Routine steps cannot target routines: ${step.command}`);
		}
		const command = commandByName.get(step.command);
		if (!command) {
			throw new Error(`Unknown routine command step: ${step.command}`);
		}
		const argsText = composeRoutineCommandArgs(step.args, invocation.argsText);
		return {
			kind: "command",
			label: `/${step.command}`,
			text: renderFileSlashCommand(command, argsText, { rawArgumentsText: argsText }),
		};
	});
	return { routine: invocation.routine, argsText: invocation.argsText, steps };
}

export function formatRoutineProgress(progress: RoutineProgress): string {
	const routine = `/${progress.routine}`;
	if (progress.status === "queued") {
		return `Queued routine ${routine}`;
	}
	if (progress.status === "running") {
		return `Running routine ${routine} ${progress.index}/${progress.total}${progress.step ? `: ${progress.step}` : ""}`;
	}
	if (progress.status === "complete") {
		return `Completed routine ${routine} ${progress.total}/${progress.total}`;
	}
	if (progress.status === "cancelled") {
		return `Cancelled routine ${routine}${progress.message ? `: ${progress.message}` : ""}`;
	}
	return `Failed routine ${routine} ${progress.index}/${progress.total}${progress.message ? `: ${progress.message}` : ""}`;
}
