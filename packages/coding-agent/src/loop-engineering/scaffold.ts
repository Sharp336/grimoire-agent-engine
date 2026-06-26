import * as fs from "node:fs/promises";
import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import { assertSafeProjectWrite, resolveInsideProject } from "./paths";
import { normalizeName } from "./schema";
import loopDocTemplate from "./templates/LOOP.md" with { type: "text" };
import budgetTemplate from "./templates/loop-budget.md" with { type: "text" };
import runLogTemplate from "./templates/loop-run-log.md" with { type: "text" };
import specTemplate from "./templates/loop-spec.loop.yaml" with { type: "text" };
import stateTemplate from "./templates/STATE.md" with { type: "text" };

export interface ScaffoldLoopOptions {
	cwd: string;
	name: string;
	pattern?: string;
	force?: boolean;
}

export interface ScaffoldLoopResult {
	name: string;
	created: string[];
	skipped: string[];
}

export async function scaffoldLoopProject(options: ScaffoldLoopOptions): Promise<ScaffoldLoopResult> {
	const name = normalizeName(options.name);
	const context = buildScaffoldContext(name, options.pattern ?? "daily-triage");
	const files = [
		{ relativePath: path.join(".omp", "loops", `${name}.loop.yaml`), content: prompt.render(specTemplate, context) },
		{ relativePath: "LOOP.md", content: prompt.render(loopDocTemplate, context) },
		{ relativePath: "STATE.md", content: prompt.render(stateTemplate, context) },
		{ relativePath: "loop-budget.md", content: prompt.render(budgetTemplate, context) },
		{ relativePath: "loop-run-log.md", content: prompt.render(runLogTemplate, context) },
	];

	const created: string[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		const absolutePath = await resolveInsideProject(options.cwd, file.relativePath, file.relativePath);
		if (!options.force && (await fileExists(absolutePath))) {
			throw new Error(`${file.relativePath} already exists; pass --force to overwrite loop starter files`);
		}
		if (options.force && (await fileExists(absolutePath))) skipped.push(absolutePath);
		await assertSafeProjectWrite(options.cwd, absolutePath, file.relativePath);
		await fs.mkdir(path.dirname(absolutePath), { recursive: true });
		await Bun.write(absolutePath, file.content);
		created.push(absolutePath);
	}
	return { name, created, skipped };
}

function buildScaffoldContext(name: string, pattern: string): Record<string, unknown> {
	const title = titleCase(name);
	const isCi = pattern === "ci-sweeper" || name.includes("ci");
	return {
		name,
		title,
		goal: isCi
			? "Find one actionable CI failure, fix it when safe, and report verifier results."
			: "Triage repository activity and report the most important next actions.",
		level: isCi ? "assisted" : "report",
		non_goals: ["Do not deploy, push, merge, or comment publicly without explicit approval."],
		scope_paths: ["."],
		max_iterations: isCi ? 3 : 1,
		verifier_command: isCi,
		max_files_changed: isCi ? 8 : 0,
		run_log: "loop-run-log.md",
	};
}

function titleCase(value: string): string {
	return value
		.split("-")
		.filter(part => part.length > 0)
		.map(part => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join(" ");
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
