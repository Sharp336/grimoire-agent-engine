import type { AgentDefinition, SingleResult } from "../task/types";
import { createSubagentSettings, type ExecutorOptions, runSubprocess } from "../task/executor";
import { prepareIsolationContext, runIsolatedSubprocess } from "../task/isolation-runner";
import { getBundledAgent } from "../task/agents";
import * as git from "../utils/git";
import { prompt } from "@oh-my-pi/pi-utils";
import isolatedAssignmentTemplate from "../prompts/evidence/isolated-assignment.md" with { type: "text" };
import librarianAssignmentTemplate from "../prompts/evidence/librarian-assignment.md" with { type: "text" };
import type { EvidenceBrokerOptions } from "./broker";
import type { InvestigationRecord } from "./types";

export interface EvidenceWorkerOptions extends EvidenceBrokerOptions {
	record: InvestigationRecord;
}

export interface EvidenceWorkerResult {
	summary: string;
	artifactBody: string;
	baseRevision?: string;
}

export class EvidenceWorkerFailure extends Error {
	constructor(
		message: string,
		readonly result: EvidenceWorkerResult,
	) {
		super(message);
		this.name = "EvidenceWorkerFailure";
	}
}

interface EvidenceSourceEntry {
	label: string;
	excerpt: string;
	url?: string;
	path?: string;
	line_start?: number;
	line_end?: number;
}

interface EvidenceOutput {
	answer: string;
	sources: EvidenceSourceEntry[];
	commands?: string[];
	caveats: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): value is number | undefined {
	return value === undefined || typeof value === "number";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function isEvidenceSourceEntry(value: unknown): value is EvidenceSourceEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.label === "string" &&
		typeof value.excerpt === "string" &&
		isOptionalString(value.url) &&
		isOptionalString(value.path) &&
		isOptionalNumber(value.line_start) &&
		isOptionalNumber(value.line_end)
	);
}

function isEvidenceOutput(value: unknown): value is EvidenceOutput {
	if (!isRecord(value)) return false;
	return (
		typeof value.answer === "string" &&
		Array.isArray(value.sources) &&
		value.sources.every(isEvidenceSourceEntry) &&
		(value.commands === undefined || isStringArray(value.commands)) &&
		isStringArray(value.caveats)
	);
}

const evidenceOutputSchema = {
	type: "object",
	additionalProperties: false,
	required: ["answer", "sources", "caveats"],
	properties: {
		answer: { type: "string" },
		sources: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["label", "excerpt"],
				properties: {
					label: { type: "string" },
					url: { type: "string" },
					path: { type: "string" },
					line_start: { type: "number" },
					line_end: { type: "number" },
					excerpt: { type: "string" },
				},
			},
		},
		commands: { type: "array", items: { type: "string" } },
		caveats: { type: "array", items: { type: "string" } },
	},
} as const;

const DOCS_MODES: Record<InvestigationRecord["mode"], boolean> = {
	docs: true,
	web: true,
	source: true,
	code_experiment: false,
	reproduction: false,
	compatibility: false,
	benchmark: false,
	browser_probe: false,
};

function constraintsBlock(record: InvestigationRecord): string {
	if (!record.constraints?.length) return "";
	return record.constraints.map(constraint => `- ${constraint}`).join("\n");
}

function assignmentData(record: InvestigationRecord): Record<string, unknown> {
	return {
		question: record.question,
		objective: record.objective,
		mode: record.mode,
		risk: record.risk,
		constraintsBlock: constraintsBlock(record),
	};
}

function resolveAgent(name: "librarian" | "task"): AgentDefinition {
	const agent = getBundledAgent(name);
	if (agent) return agent;
	if (name === "librarian") throw new Error("Bundled librarian agent is unavailable");
	throw new Error("Bundled task agent is unavailable");
}

function buildWorkerSettings(options: EvidenceBrokerOptions) {
	return createSubagentSettings(options.settings, {
		"advisor.enabled": false,
		"advisor.investigations.enabled": false,
		"advisor.investigations.exec": false,
	});
}

function buildExecutorOptions(args: {
	options: EvidenceWorkerOptions;
	agent: AgentDefinition;
	assignment: string;
	artifactsDir: string;
}): ExecutorOptions {
	const cwd = args.options.cwd();
	const settings = buildWorkerSettings(args.options);
	const baseOptions: ExecutorOptions = {
		cwd,
		agent: args.agent,
		task: args.options.record.question,
		assignment: args.assignment,
		description: `Evidence investigation ${args.options.record.id}`,
		role: "Evidence sidecar worker",
		index: 0,
		id: args.options.record.id,
		detached: true,
		outputSchema: evidenceOutputSchema,
		artifactsDir: args.artifactsDir,
		authStorage: args.options.authStorage,
		modelRegistry: args.options.modelRegistry,
		settings,
	};
	if (args.options.localProtocolOptions) baseOptions.localProtocolOptions = args.options.localProtocolOptions;
	if (args.options.artifactManager) baseOptions.parentArtifactManager = args.options.artifactManager;
	if (args.options.parentTelemetry) baseOptions.parentTelemetry = args.options.parentTelemetry;
	if (args.options.eventBus) baseOptions.eventBus = args.options.eventBus;
	return baseOptions;
}

async function readBaseRevision(cwd: string): Promise<string | undefined> {
	try {
		return (await git.head.sha(cwd)) ?? undefined;
	} catch {
		return undefined;
	}
}

function formatSources(sources: readonly EvidenceSourceEntry[]): string {
	if (sources.length === 0) return "No sources were returned.";
	return sources
		.map(source => {
			const locationParts: string[] = [];
			if (source.url) locationParts.push(source.url);
			if (source.path) {
				const lines =
					source.line_start !== undefined
						? `:${source.line_start}${source.line_end !== undefined ? `-${source.line_end}` : ""}`
						: "";
				locationParts.push(`${source.path}${lines}`);
			}
			const location = locationParts.length > 0 ? ` (${locationParts.join(", ")})` : "";
			return `- ${source.label}${location}\n\n  ${source.excerpt}`;
		})
		.join("\n");
}

function formatCommands(commands: readonly string[] | undefined): string {
	if (!commands?.length) return "No commands were reported.";
	return commands.map(command => `- ${command}`).join("\n");
}

function formatCaveats(caveats: readonly string[]): string {
	if (caveats.length === 0) return "No caveats were reported.";
	return caveats.map(caveat => `- ${caveat}`).join("\n");
}

interface ArtifactBodyArgs {
	record: InvestigationRecord;
	answer: string;
	sources: readonly EvidenceSourceEntry[];
	commands?: readonly string[];
	caveats: readonly string[];
	baseRevision?: string;
	patchPath?: string;
	stderr?: string;
	partialOutput?: string;
}


function buildArtifactBody(args: ArtifactBodyArgs): string {
	const snapshotLines = [
		`Base revision: ${args.baseRevision ?? "unavailable"}`,
		args.patchPath ? `Patch artifact: ${args.patchPath}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	const resultParts = [args.answer];
	if (args.commands?.length) resultParts.push(`\nCommands reported:\n${formatCommands(args.commands)}`);
	if (args.stderr?.trim()) resultParts.push(`\nStderr:\n${args.stderr.trim()}`);
	if (args.partialOutput?.trim()) resultParts.push(`\nPartial output:\n${args.partialOutput.trim()}`);
	return [
		`# Investigation ${args.record.id}`,
		"## Question",
		args.record.question,
		"## Objective",
		args.record.objective,
		"## Mode",
		args.record.mode,
		"## Result",
		resultParts.join("\n"),
		"## Sources",
		formatSources(args.sources),
		"## Snapshot",
		snapshotLines,
		"## Caveats",
		formatCaveats(args.caveats),
	]
		.join("\n\n")
		.trimEnd();
}

function parseWorkerOutput(result: SingleResult): EvidenceOutput {
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.output);
	} catch (error) {
		throw new Error(`Evidence worker returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isEvidenceOutput(parsed)) {
		throw new Error("Evidence worker returned structured output that did not match the evidence schema.");
	}
	return parsed;
}

function buildFailureResult(args: {
	record: InvestigationRecord;
	baseRevision?: string;
	message: string;
	stderr?: string;
	partialOutput?: string;
}): EvidenceWorkerResult {
	const artifactArgs: ArtifactBodyArgs = {
		record: args.record,
		answer: args.message,
		sources: [],
		caveats: ["Investigation did not complete successfully."],
	};
	if (args.baseRevision !== undefined) artifactArgs.baseRevision = args.baseRevision;
	if (args.stderr !== undefined) artifactArgs.stderr = args.stderr;
	if (args.partialOutput !== undefined) artifactArgs.partialOutput = args.partialOutput;
	const result: EvidenceWorkerResult = {
		summary: args.message,
		artifactBody: buildArtifactBody(artifactArgs),
	};
	if (args.baseRevision !== undefined) result.baseRevision = args.baseRevision;
	return result;
}

function failedSingleResult(args: {
	record: InvestigationRecord;
	agent: AgentDefinition;
	assignment: string;
	message: string;
}): SingleResult {
	return {
		index: 0,
		id: args.record.id,
		agent: args.agent.name,
		agentSource: args.agent.source,
		task: args.record.question,
		assignment: args.assignment,
		description: `Evidence investigation ${args.record.id}`,
		exitCode: 1,
		output: "",
		stderr: args.message,
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		error: args.message,
	};
}

function toWorkerResult(record: InvestigationRecord, result: SingleResult, baseRevision?: string): EvidenceWorkerResult {
	if (result.exitCode !== 0) {
		const message = result.error ?? (result.stderr.trim() || `Evidence worker exited with code ${result.exitCode}.`);
		const failureResult = buildFailureResult({
			record,
			message,
			stderr: result.stderr,
			partialOutput: result.output,
			...(baseRevision !== undefined ? { baseRevision } : {}),
		});
		throw new EvidenceWorkerFailure(message, failureResult);
	}
	let output: EvidenceOutput;
	try {
		output = parseWorkerOutput(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failureResult = buildFailureResult({
			record,
			message,
			stderr: result.stderr,
			partialOutput: result.output,
			...(baseRevision !== undefined ? { baseRevision } : {}),
		});
		throw new EvidenceWorkerFailure(message, failureResult);
	}
	const caveats = result.error ? [...output.caveats, result.error] : output.caveats;
	const artifactArgs: ArtifactBodyArgs = {
		record,
		answer: output.answer,
		sources: output.sources,
		caveats,
	};
	if (output.commands !== undefined) artifactArgs.commands = output.commands;
	if (baseRevision !== undefined) artifactArgs.baseRevision = baseRevision;
	if (result.patchPath !== undefined) artifactArgs.patchPath = result.patchPath;
	if (result.stderr) artifactArgs.stderr = result.stderr;
	const workerResult: EvidenceWorkerResult = {
		summary: output.answer,
		artifactBody: buildArtifactBody(artifactArgs),
	};
	if (baseRevision !== undefined) workerResult.baseRevision = baseRevision;
	return workerResult;
}

export async function runEvidenceWorker(options: EvidenceWorkerOptions): Promise<EvidenceWorkerResult> {
	const artifactsDir = options.artifactsDir();
	if (!artifactsDir) {
		const result = buildFailureResult({
			record: options.record,
			message: "Evidence artifact storage is unavailable for this session.",
		});
		throw new EvidenceWorkerFailure(result.summary, result);
	}
	const cwd = options.cwd();
	if (DOCS_MODES[options.record.mode]) {
		const agent = resolveAgent("librarian");
		const assignment = prompt.render(librarianAssignmentTemplate, assignmentData(options.record));
		const result = await runSubprocess(buildExecutorOptions({ options, agent, assignment, artifactsDir }));
		return toWorkerResult(options.record, result, await readBaseRevision(cwd));
	}
	const agent = resolveAgent("task");
	const assignment = prompt.render(isolatedAssignmentTemplate, assignmentData(options.record));
	let context;
	try {
		context = await prepareIsolationContext(cwd);
	} catch {
		const result = buildFailureResult({
			record: options.record,
			message: "Code-executing investigations require a Git checkout so they can run in an isolated snapshot.",
		});
		throw new EvidenceWorkerFailure(result.summary, result);
	}
	const baseOptions = buildExecutorOptions({ options, agent, assignment, artifactsDir });
	const result = await runIsolatedSubprocess({
		baseOptions,
		context,
		preferredBackend: undefined,
		agentId: options.record.id,
		mergeMode: "patch",
		artifactsDir,
		description: `Evidence investigation ${options.record.id}`,
		buildFailureResult: err =>
			failedSingleResult({
				record: options.record,
				agent,
				assignment,
				message: err instanceof Error ? err.message : String(err),
			}),
	});
	return toWorkerResult(options.record, result, context.baseline.root.headCommit || undefined);
}
