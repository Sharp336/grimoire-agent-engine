import * as path from "node:path";
import { listLoopSpecs, loadLoopSpec } from "./paths";
import { assessLoopReadiness } from "./readiness";
import { executeLoopIteration } from "./runner";
import { scaffoldLoopProject } from "./scaffold";

export interface LoopCliOptions {
	cwd: string;
	json?: boolean;
	force?: boolean;
	dryRun?: boolean;
	pattern?: string;
}

export async function runLoopCli(action: string, target: string | undefined, options: LoopCliOptions): Promise<void> {
	if (action === "init") {
		const result = await scaffoldLoopProject({
			cwd: options.cwd,
			name: target || options.pattern || "daily-triage",
			pattern: options.pattern,
			force: options.force,
		});
		writeOutput(options.json, result, `Created loop ${result.name} (${result.created.length} files)\n`);
		return;
	}
	if (action === "check") {
		const spec = await loadLoopSpec(options.cwd, target);
		const assessment = assessLoopReadiness(spec);
		writeOutput(
			options.json,
			{ spec, assessment },
			renderAssessment(spec.name, assessment.score, assessment.issues, assessment.warnings),
		);
		if (!assessment.ready) process.exitCode = 1;
		return;
	}
	if (action === "run") {
		const spec = await loadLoopSpec(options.cwd, target);
		const result = await executeLoopIteration(spec, { cwd: options.cwd, dryRun: options.dryRun });
		writeOutput(
			options.json,
			result,
			renderRunResult(result.status, result.loop, result.jsonlPath, result.markdownLogPath),
		);
		if (result.status === "failed" || result.status === "needs_approval") process.exitCode = 1;
		return;
	}
	const specs = await listLoopSpecs(options.cwd);
	const rows = specs.map(spec => {
		const assessment = assessLoopReadiness(spec);
		return {
			name: spec.name,
			level: spec.level,
			score: assessment.score,
			ready: assessment.ready,
			path: spec.sourcePath,
		};
	});
	writeOutput(options.json, rows, renderStatus(rows));
}

function writeOutput(json: boolean | undefined, value: unknown, text: string): void {
	process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function renderAssessment(name: string, score: number, issues: string[], warnings: string[]): string {
	const lines = [`Loop ${name}: readiness ${score}/100`];
	for (const issue of issues) lines.push(`Issue: ${issue}`);
	for (const warning of warnings) lines.push(`Warning: ${warning}`);
	if (issues.length === 0) lines.push("Ready for one scheduled-safe iteration.");
	return `${lines.join("\n")}\n`;
}

function renderRunResult(
	status: string,
	name: string,
	jsonlPath: string | null,
	markdownLogPath: string | null,
): string {
	const lines = [`Loop ${name}: ${status}`];
	if (jsonlPath) lines.push(`State: ${jsonlPath}`);
	if (markdownLogPath) lines.push(`Run log: ${markdownLogPath}`);
	return `${lines.join("\n")}\n`;
}

function renderStatus(
	rows: Array<{ name: string; level: string; score: number; ready: boolean; path?: string }>,
): string {
	if (rows.length === 0) return "No loop specs found. Run `omp loop init daily-triage` first.\n";
	return `${rows
		.map(
			row =>
				`${row.ready ? "✓" : "!"} ${row.name} ${row.level} readiness=${row.score}/100 ${row.path ? path.relative(process.cwd(), row.path) : ""}`,
		)
		.join("\n")}\n`;
}
