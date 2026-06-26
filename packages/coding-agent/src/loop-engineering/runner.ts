import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { builtinModules } from "node:module";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { createAgentSession } from "../sdk";
import { assertSafeProjectWrite, resolveInsideProject } from "./paths";
import { assessLoopReadiness } from "./readiness";
import runPromptTemplate from "./templates/run-prompt.md" with { type: "text" };
import type {
	LoopCommandSpec,
	LoopRunOptions,
	LoopRunRecord,
	LoopRunResult,
	LoopSpec,
	LoopVerifierResult,
} from "./types";

const OUTPUT_LIMIT = 8_000;
const REPORT_LOOP_TOOLS = ["read", "search", "find", "web_search"];
const VERIFIER_TIMEOUT_MS = 120_000;
const SHELL_EXECUTABLES = new Set(["bash", "cmd", "fish", "powershell", "pwsh", "sh", "zsh"]);
const PACKAGE_SCRIPT_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const VERIFIER_SCRIPT_OPERAND_RUNNERS = new Set(["bun", "deno", "node", "tsx", "ts-node"]);
const NODE_BUILTIN_MODULES = new Set(builtinModules.flatMap(name => [name, `node:${name.replace(/^node:/, "")}`]));
const VERIFIER_DENIED_NODE_BUILTINS = new Set([
	"child_process",
	"cluster",
	"inspector",
	"module",
	"node:child_process",
	"node:cluster",
	"node:inspector",
	"node:module",
	"node:repl",
	"node:vm",
	"node:worker_threads",
	"repl",
	"vm",
	"worker_threads",
]);
const VERIFIER_ENV_ALLOWLIST = new Set([
	"CI",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOGNAME",
	"PATH",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"USER",
	"WINDIR",
]);
const VERIFIER_SCRIPT_RUNNER_SUBCOMMANDS = new Map([
	["bun", new Set(["add", "build", "create", "fig", "help", "init", "install", "pm", "remove", "run", "test", "x"])],
	[
		"deno",
		new Set(["bench", "bundle", "check", "compile", "doc", "fmt", "info", "install", "lint", "run", "task", "test"]),
	],
]);
const VERIFIER_SCRIPT_VALUE_FLAGS = new Map([
	["bun", new Set(["--define", "--origin", "--preload", "--tsconfig-override", "--user-agent"])],
	[
		"deno",
		new Set(["--cert", "--config", "--env-file", "--import-map", "--location", "--node-modules-dir", "--vendor"]),
	],
	[
		"node",
		new Set([
			"--conditions",
			"-C",
			"--eval",
			"-e",
			"--experimental-loader",
			"--import",
			"--loader",
			"--print",
			"-p",
			"--require",
			"-r",
		]),
	],
	["python", new Set(["-c", "-m", "-W", "-X"])],
	["python3", new Set(["-c", "-m", "-W", "-X"])],
	["tsx", new Set(["--require", "-r", "--tsconfig"])],
	["ts-node", new Set(["--compiler", "-C", "--project", "-P", "--require", "-r", "--transpiler"])],
]);
const STATUS_OUTPUT_LIMIT = 1_000_000;
const VERIFIER_REFERENCE_EXTENSIONS = new Set([
	".cjs",
	".cts",
	".js",
	".json",
	".jsonc",
	".jsx",
	".mjs",
	".mts",
	".py",
	".sh",
	".toml",
	".ts",
	".tsx",
	".yaml",
	".yml",
]);
const PACKAGE_MANAGER_CONFIG_FILES = [
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	"bun.lock",
	"bunfig.toml",
	"package-lock.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"yarn.lock",
];
const VERIFIER_DEPENDENCY_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const VERIFIER_CONFIG_FILES = [
	"biome.json",
	"biome.jsonc",
	"eslint.config.cjs",
	"eslint.config.js",
	"eslint.config.mjs",
	"tsconfig.json",
	"tsconfig.build.json",
	"vitest.config.mts",
	"vitest.config.ts",
];

export function buildLoopRunPrompt(spec: LoopSpec): string {
	return prompt.render(runPromptTemplate, {
		name: spec.name,
		level: spec.level,
		goal: spec.goal,
		non_goals: spec.nonGoals,
		scope_paths: spec.scope.paths,
		max_files_changed: spec.guardrails.maxFilesChanged ?? "not set",
		max_iterations: spec.guardrails.maxIterations ?? "not set",
		denylist_paths: spec.guardrails.denylistPaths,
		state_file: spec.state.file,
		budget_file: spec.state.budget,
		run_log: spec.state.runLog,
		runner_prompt: spec.runner.prompt,
	});
}

export async function executeLoopIteration(spec: LoopSpec, options: LoopRunOptions): Promise<LoopRunResult> {
	const started = options.now?.() ?? new Date();
	const promptText = buildLoopRunPrompt(spec);
	const baseRecord = createBaseRecord(spec, started, promptText);
	if (options.dryRun) {
		return {
			...baseRecord,
			status: "dry_run",
			finishedAt: started.toISOString(),
			jsonlPath: null,
			markdownLogPath: null,
		};
	}

	const readiness = assessLoopReadiness(spec);
	if (!readiness.ready) {
		const finishedAt = options.now?.() ?? new Date();
		const record: LoopRunRecord = {
			...baseRecord,
			status: "failed",
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - started.getTime(),
			error: readiness.issues.join("; "),
		};
		return persistRunRecord(spec, options.cwd, record);
	}

	const baselineChangedFiles = await listChangedFiles(options.cwd);
	const verifierScripts =
		spec.level === "report" ? [] : await captureVerifierScriptSnapshots(spec.verifier.commands, options.cwd);
	const verifierPreflightError = verifierScripts.find(script => script.error)?.error ?? null;
	if (verifierPreflightError) {
		const finishedAt = options.now?.() ?? new Date();
		const record: LoopRunRecord = {
			...baseRecord,
			status: "failed",
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - started.getTime(),
			error: verifierPreflightError,
		};
		return persistRunRecord(spec, options.cwd, record);
	}

	let agentExitCode: number | null = null;
	let agentOutput = "";
	let error: string | null = null;
	try {
		const runAgent = options.runAgent ?? ((text, cwd) => runAgentInProcess(text, cwd, spec));
		const result = await runAgent(promptText, options.cwd);
		agentExitCode = result.exitCode;
		agentOutput = truncate(result.output);
	} catch (err) {
		agentExitCode = 1;
		error = err instanceof Error ? err.message : String(err);
	}

	const verifierMutationReason =
		agentExitCode === 0 && spec.level !== "report" ? await verifierScriptsChanged(verifierScripts) : null;
	const verifierResults =
		agentExitCode === 0 && spec.level !== "report" && !verifierMutationReason
			? await runVerifierCommands(spec.verifier.commands, options.cwd, verifierScripts)
			: [];
	const postVerifierMutationReason =
		verifierResults.length > 0 && agentExitCode === 0 && spec.level !== "report"
			? await verifierScriptsChanged(verifierScripts)
			: null;
	const observedChangedFiles = await listChangedFiles(options.cwd);
	const changedFiles = changedFilesSinceBaseline(baselineChangedFiles, observedChangedFiles);
	const approvalReasons = approvalReasonsFor(spec, changedFiles, verifierResults, {
		canObserveChangedFiles: baselineChangedFiles !== null && observedChangedFiles !== null,
		baselineChangedFileCount: baselineChangedFiles?.length ?? null,
	});
	if (verifierMutationReason) approvalReasons.push(verifierMutationReason);
	if (postVerifierMutationReason) approvalReasons.push(postVerifierMutationReason);
	const failedVerifier = verifierResults.some(result => result.exitCode !== 0);
	const finishedAt = options.now?.() ?? new Date();
	const status =
		error || agentExitCode !== 0 || failedVerifier
			? "failed"
			: approvalReasons.length > 0
				? "needs_approval"
				: "passed";
	const record: LoopRunRecord = {
		...baseRecord,
		status,
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - started.getTime(),
		agentExitCode,
		agentOutput,
		verifierResults,
		changedFiles,
		approvalReasons,
		error,
	};
	return persistRunRecord(spec, options.cwd, record);
}

async function runAgentInProcess(
	promptText: string,
	cwd: string,
	spec: LoopSpec,
): Promise<{ exitCode: number | null; output: string }> {
	const reportMode = spec.level === "report";
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd,
		customTools: reportMode ? [] : undefined,
		disableExtensionDiscovery: reportMode,
		enableMCP: reportMode ? false : undefined,
		preloadedCustomToolPaths: reportMode ? [] : undefined,
		strictToolNames: reportMode,
		toolNames: reportMode ? REPORT_LOOP_TOOLS : undefined,
	});
	try {
		if (modelFallbackMessage) process.stderr.write(`${modelFallbackMessage}\n`);
		await session.prompt(promptText);
		const lastMessage = session.state.messages[session.state.messages.length - 1];
		if (lastMessage?.role !== "assistant")
			return { exitCode: 1, output: "Loop agent did not produce an assistant message." };
		const assistantMessage = lastMessage as AssistantMessage;
		const output = assistantMessage.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n");
		const failed = assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted";
		return { exitCode: failed ? 1 : 0, output: assistantMessage.errorMessage ?? output };
	} finally {
		await session.dispose();
	}
}

function createBaseRecord(spec: LoopSpec, started: Date, promptText: string): LoopRunRecord {
	return {
		id: `${started.toISOString().replace(/[^0-9TZ]/g, "")}-${spec.name}`,
		loop: spec.name,
		status: "dry_run",
		startedAt: started.toISOString(),
		finishedAt: started.toISOString(),
		durationMs: 0,
		level: spec.level,
		prompt: promptText,
		agentExitCode: null,
		agentOutput: "",
		verifierResults: [],
		changedFiles: [],
		approvalReasons: [],
		error: null,
	};
}

interface VerifierScriptSnapshot {
	packageJsonPath: string;
	packageJsonDigest: string;
	scriptName: string;
	scriptValue: string;
	referencedFiles: VerifierReferencedFileSnapshot[];
	error: string | null;
}

interface VerifierReferencedFileSnapshot {
	filePath: string;
	displayPath: string;
	digest: string;
}

async function captureVerifierScriptSnapshots(
	commands: LoopCommandSpec[],
	cwd: string,
): Promise<VerifierScriptSnapshot[]> {
	const snapshots: VerifierScriptSnapshot[] = [];
	for (const command of commands) {
		const invalidReason = validateVerifierCommand(command);
		if (invalidReason) {
			snapshots.push({
				packageJsonPath: "",
				packageJsonDigest: "",
				scriptName: "",
				scriptValue: "",
				referencedFiles: [],
				error: invalidReason,
			});
			continue;
		}
		try {
			const rootReal = await fs.realpath(cwd);
			const pathError = verifierSafePathError(cwd, rootReal);
			if (pathError) throw new Error(pathError);
			const commandCwd = command.cwd ? await resolveInsideProject(cwd, command.cwd, "verifier cwd") : rootReal;
			await rejectSymlinkPathComponents(rootReal, commandCwd, "verifier cwd");
			const script = await readVerifierPackageScript(command, commandCwd);
			const referencedFiles =
				script.error === null ? await captureVerifierReferencedFiles(rootReal, commandCwd, script.scriptValue) : [];
			snapshots.push(
				script.error
					? {
							packageJsonPath: "",
							packageJsonDigest: "",
							scriptName: "",
							scriptValue: "",
							referencedFiles: [],
							error: script.error,
						}
					: { ...script, referencedFiles },
			);
		} catch (error) {
			snapshots.push({
				packageJsonPath: "",
				packageJsonDigest: "",
				scriptName: "",
				scriptValue: "",
				referencedFiles: [],
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return snapshots;
}

async function verifierScriptsChanged(snapshots: VerifierScriptSnapshot[]): Promise<string | null> {
	for (const snapshot of snapshots) {
		if (snapshot.error) return snapshot.error;
		const currentPackageJsonDigest = await verifierFileState(snapshot.packageJsonPath);
		if (currentPackageJsonDigest !== snapshot.packageJsonDigest) {
			return "verifier package.json changed before verifier execution";
		}
		const current = await readPackageScript(snapshot.packageJsonPath, snapshot.scriptName);
		if (current.error) return current.error;
		if (current.scriptValue !== snapshot.scriptValue) {
			return `verifier package.json script ${snapshot.scriptName} changed before verifier execution`;
		}
		for (const file of snapshot.referencedFiles) {
			const currentDigest = await verifierFileState(file.filePath);
			if (currentDigest !== file.digest) {
				return `verifier referenced file ${file.displayPath} changed before verifier execution`;
			}
		}
	}
	return null;
}

async function captureVerifierReferencedFiles(
	projectCwd: string,
	commandCwd: string,
	scriptValue: string,
): Promise<VerifierReferencedFileSnapshot[]> {
	const snapshots: VerifierReferencedFileSnapshot[] = [];
	const rootReal = await fs.realpath(projectCwd);
	const commandReal = await fs.realpath(commandCwd);
	const candidates = new Set(verifierScriptLocalPathTokens(scriptValue));
	for (const candidate of candidates) {
		const filePath = await resolveVerifierReferencePath(rootReal, commandReal, candidate);
		await captureVerifierFileAndDependencies(rootReal, commandReal, filePath, snapshots, new Set());
	}
	for (const configPath of verifierConfigPaths(rootReal, commandReal)) {
		const filePath = await resolveVerifierFilePath(rootReal, configPath);
		snapshots.push({
			filePath,
			displayPath: path.relative(commandReal, filePath) || path.basename(filePath),
			digest: await verifierFileState(filePath),
		});
	}
	return snapshots;
}

async function captureVerifierFileAndDependencies(
	rootReal: string,
	commandReal: string,
	filePath: string,
	snapshots: VerifierReferencedFileSnapshot[],
	seen: Set<string>,
): Promise<void> {
	if (seen.has(filePath)) return;
	seen.add(filePath);
	const digest = await verifierFileState(filePath);
	snapshots.push({
		filePath,
		displayPath: path.relative(commandReal, filePath) || path.basename(filePath),
		digest,
	});
	if (digest === "missing" || !shouldScanVerifierDependencies(filePath)) return;
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch {
		return;
	}
	if (hasDynamicVerifierDependency(content)) throw new Error("verifier dependencies must use literal imports");
	if (hasDeniedVerifierBuiltinDependency(content))
		throw new Error("verifier dependencies must not import dangerous builtins");
	if (hasVerifierDynamicCodeApi(content)) throw new Error("verifier dependencies must not use dynamic code APIs");
	if (hasVerifierEscapedIdentifier(content)) throw new Error("verifier dependencies must not use escaped identifiers");
	if (hasVerifierProcessExecutionApi(content))
		throw new Error("verifier dependencies must not use process execution APIs");
	if (hasVerifierDynamicPropertyAccess(content))
		throw new Error("verifier dependencies must not use dynamic property access");
	if (hasBareVerifierDependency(content)) throw new Error("verifier dependencies must use relative or node: imports");
	const importerDir = path.dirname(filePath);
	for (const dependencySpecifier of verifierStaticDependencySpecifiers(content)) {
		const dependencyPath = await resolveVerifierDependencyPath(rootReal, importerDir, dependencySpecifier);
		if (!dependencyPath) throw new Error(`verifier dependency ${dependencySpecifier} could not be resolved`);
		await captureVerifierFileAndDependencies(rootReal, commandReal, dependencyPath, snapshots, seen);
	}
}

function shouldScanVerifierDependencies(filePath: string): boolean {
	const extension = path.extname(filePath);
	return extension.length === 0 || VERIFIER_DEPENDENCY_EXTENSIONS.has(extension);
}

function verifierStaticDependencySpecifiers(content: string): string[] {
	const specifiers = new Set<string>();
	for (const match of content.matchAll(verifierDependencyPattern())) {
		specifiers.add(match[1] ?? match[2] ?? match[3] ?? "");
	}
	specifiers.delete("");
	return [...specifiers];
}

function hasBareVerifierDependency(content: string): boolean {
	for (const match of content.matchAll(verifierAnyLiteralDependencyPattern())) {
		const specifier = match[1] ?? match[2] ?? match[3] ?? "";
		if (specifier && !specifier.startsWith(".") && !NODE_BUILTIN_MODULES.has(specifier)) return true;
	}
	return false;
}

function hasDeniedVerifierBuiltinDependency(content: string): boolean {
	for (const match of content.matchAll(verifierAnyLiteralDependencyPattern())) {
		const specifier = match[1] ?? match[2] ?? match[3] ?? "";
		if (VERIFIER_DENIED_NODE_BUILTINS.has(specifier)) return true;
	}
	return false;
}

function hasVerifierDynamicCodeApi(content: string): boolean {
	return /\b(?:constructor|eval|Function|SharedWorker|Worker)\b/.test(content);
}

function hasVerifierEscapedIdentifier(content: string): boolean {
	return /\\(?:u\{?[0-9a-fA-F]+}?|x[0-9a-fA-F]{2})/.test(content);
}

function hasVerifierDynamicPropertyAccess(content: string): boolean {
	const gap = verifierJsGap();
	return new RegExp(`(?:\\b[A-Za-z_$][\\w$]*|\\)|\\])${gap}(?:\\?\\.${gap})?\\[${gap}(?!\\d+${gap}\\])`).test(content);
}

function hasVerifierProcessExecutionApi(content: string): boolean {
	const gap = verifierJsGap();
	return new RegExp(
		`\\bBun\\b|\\bDeno\\b|\\bprocess${gap}(?:(?:\\?\\.|\\.)${gap}(?:binding|dlopen)\\b|(?:\\?\\.${gap})?\\[${gap}["'](?:binding|dlopen)["']${gap}\\])`,
	).test(content);
}

function hasDynamicVerifierDependency(content: string): boolean {
	const requireRemainder = content.replace(verifierApprovedRequireLiteralPattern(), "");
	const importRemainder = content.replace(verifierApprovedDynamicImportLiteralPattern(), "");
	return (
		/createRequire\b/.test(content) ||
		/(?:\b|\.)require\b/.test(requireRemainder) ||
		verifierAnyDynamicImportPattern().test(importRemainder)
	);
}

function verifierDependencyPattern(): RegExp {
	const gap = verifierJsGap();
	const requireCall = verifierRequireCallPrefix();
	return new RegExp(
		`(?:import|export)${gap}(?:[^"']*?${gap}from${gap})?["'](\\.{1,2}\\/[^"']+)["']|import${gap}\\(${gap}["'](\\.{1,2}\\/[^"']+)["']${gap}\\)|${requireCall}${gap}["'](\\.{1,2}\\/[^"']+)["']${gap}\\)`,
		"g",
	);
}

function verifierAnyLiteralDependencyPattern(): RegExp {
	const gap = verifierJsGap();
	const requireCall = verifierRequireCallPrefix();
	return new RegExp(
		`(?:import|export)${gap}(?:[^"']*?${gap}from${gap})?["']([^"']+)["']|import${gap}\\(${gap}["']([^"']+)["']${gap}\\)|${requireCall}${gap}["']([^"']+)["']${gap}\\)`,
		"g",
	);
}

function verifierAnyDynamicImportPattern(): RegExp {
	const gap = verifierJsGap();
	return new RegExp(`\\bimport${gap}\\(`);
}

function verifierRequireCallPrefix(): string {
	const gap = verifierJsGap();
	return `(?:\\b|\\.)require${gap}(?:\\?\\.${gap})?\\(${gap}`;
}

function verifierApprovedRequireLiteralPattern(): RegExp {
	const gap = verifierJsGap();
	return new RegExp(`${verifierRequireCallPrefix()}["'][^"']+["']${gap}\\)`, "g");
}

function verifierApprovedDynamicImportLiteralPattern(): RegExp {
	const gap = verifierJsGap();
	return new RegExp(`\\bimport${gap}\\(${gap}["'][^"']+["']${gap}\\)`, "g");
}

function verifierJsGap(): string {
	return String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*`;
}

async function resolveVerifierDependencyPath(
	rootReal: string,
	importerDir: string,
	specifier: string,
): Promise<string | null> {
	for (const candidate of verifierDependencyCandidates(specifier)) {
		try {
			const filePath = await resolveVerifierReferencePath(rootReal, importerDir, candidate);
			if ((await verifierFileState(filePath)) !== "missing") return filePath;
		} catch (error) {
			if (error instanceof Error && error.message === "verifier referenced file must be a file") continue;
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
	}
	return null;
}

function verifierDependencyCandidates(specifier: string): string[] {
	if (path.extname(specifier).length > 0) return [specifier];
	const candidates = [specifier];
	for (const extension of VERIFIER_DEPENDENCY_EXTENSIONS) candidates.push(`${specifier}${extension}`);
	for (const extension of VERIFIER_DEPENDENCY_EXTENSIONS) candidates.push(path.join(specifier, `index${extension}`));
	return candidates;
}

function verifierScriptLocalPathTokens(scriptValue: string): string[] {
	const tokens = new Set<string>();
	for (const rawToken of scriptValue.match(/(?:\.{0,2}\/)?[A-Za-z0-9_@+./-]+\.[A-Za-z0-9]+/g) ?? []) {
		addVerifierPathToken(tokens, rawToken, true);
	}
	for (const match of scriptValue.matchAll(
		/(?:^|[\s"'(])((?:\.{1,2}\/|[A-Za-z0-9_@+-]+\/)[A-Za-z0-9_@+./-]+)(?=$|[\s"')\],;&|])/g,
	)) {
		addVerifierPathToken(tokens, match[1] ?? "", false);
	}
	const words = tokenizeVerifierScript(scriptValue);
	for (const [index, word] of words.entries()) {
		const runnerName = path.basename(word).toLowerCase();
		if (!VERIFIER_SCRIPT_OPERAND_RUNNERS.has(runnerName)) continue;
		for (const operand of verifierRunnerOperands(runnerName, words, index + 1)) {
			if (isVerifierRunnerSubcommand(runnerName, operand)) continue;
			addVerifierPathToken(tokens, operand, false);
		}
	}
	return [...tokens];
}

function addVerifierPathToken(tokens: Set<string>, rawToken: string, requireKnownExtension: boolean): void {
	const token = rawToken.replace(/^['"({[]+|['")}\],;]+$/g, "");
	if (token.length === 0 || token.startsWith("-")) return;
	const extension = path.extname(token);
	if (extension.length > 0 && !VERIFIER_REFERENCE_EXTENSIONS.has(extension)) return;
	if (requireKnownExtension && extension.length === 0) return;
	tokens.add(token);
}

function tokenizeVerifierScript(scriptValue: string): string[] {
	return [...scriptValue.matchAll(/"([^"]*)"|'([^']*)'|[^\s"';&|()]+/g)].map(
		match => match[1] ?? match[2] ?? match[0],
	);
}

function verifierRunnerOperands(runnerName: string, words: string[], start: number): string[] {
	const operands: string[] = [];
	for (let index = start; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word.length === 0) continue;
		if (word === "--") {
			operands.push(...words.slice(index + 1).filter(value => value.length > 0));
			break;
		}
		if (word.startsWith("-")) {
			if (verifierRunnerFlagConsumesValue(runnerName, word)) index++;
			continue;
		}
		operands.push(word);
	}
	return operands;
}

function firstVerifierRunnerOperand(runnerName: string, words: string[], start: number): string | null {
	return verifierRunnerOperands(runnerName, words, start)[0] ?? null;
}

function verifierRunnerFlagConsumesValue(runnerName: string, word: string): boolean {
	const flag = word.split("=", 1)[0] ?? word;
	return !word.includes("=") && (VERIFIER_SCRIPT_VALUE_FLAGS.get(runnerName)?.has(flag) ?? false);
}

function isVerifierRunnerSubcommand(runnerName: string, operand: string): boolean {
	return VERIFIER_SCRIPT_RUNNER_SUBCOMMANDS.get(runnerName)?.has(operand) ?? false;
}

async function resolveVerifierReferencePath(
	rootReal: string,
	commandReal: string,
	relativePath: string,
): Promise<string> {
	if (path.isAbsolute(relativePath)) throw new Error("verifier referenced file must be relative to the project");
	return resolveVerifierFilePath(rootReal, path.resolve(commandReal, relativePath));
}

async function resolveVerifierFilePath(rootReal: string, filePath: string): Promise<string> {
	const lexicalContainment = path.relative(rootReal, filePath);
	if (lexicalContainment.startsWith("..") || path.isAbsolute(lexicalContainment)) {
		throw new Error("verifier referenced file must stay inside the project");
	}
	await rejectSymlinkPathComponents(rootReal, filePath, "verifier referenced file");
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(filePath);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return filePath;
		throw error;
	}
	if (stat.isSymbolicLink()) throw new Error("verifier referenced file must not be a symlink");
	if (!stat.isFile()) throw new Error("verifier referenced file must be a file");
	const targetReal = await fs.realpath(filePath);
	const containment = path.relative(rootReal, targetReal);
	if (containment.startsWith("..") || path.isAbsolute(containment)) {
		throw new Error("verifier referenced file must stay inside the project");
	}
	return targetReal;
}
async function rejectSymlinkPathComponents(rootReal: string, targetPath: string, label: string): Promise<void> {
	const relative = path.relative(rootReal, targetPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside the project`);
	let current = rootReal;
	for (const part of relative.split(path.sep)) {
		if (!part) continue;
		current = path.join(current, part);
		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) throw new Error(`${label} must not pass through a symlink`);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
	}
}

function inheritedPathValue(): string {
	for (const [key, value] of Object.entries(process.env)) {
		if (key.toUpperCase() === "PATH" && typeof value === "string") return value;
	}
	return "";
}

function verifierRuntimePath(projectCwd: string, projectRootReal: string): string {
	return sanitizedVerifierPath(inheritedPathValue(), projectCwd, projectRootReal);
}

function verifierSafePathError(projectCwd: string, projectRootReal: string): string | null {
	return verifierRuntimePath(projectCwd, projectRootReal).split(path.delimiter).some(Boolean)
		? null
		: "verifier PATH has no safe absolute runtime entries";
}

function verifierRuntimeEnv(
	projectCwd: string,
	projectRootReal: string = path.resolve(projectCwd),
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		const envKey = key.toUpperCase();
		if (envKey === "PATH" || typeof value !== "string" || !VERIFIER_ENV_ALLOWLIST.has(envKey)) continue;
		env[key] = value;
	}
	env.PATH = verifierRuntimePath(projectCwd, projectRootReal);
	return env;
}

function sanitizedVerifierPath(rawPath: string, projectCwd: string, projectRootReal: string): string {
	const normalizedRoots = [
		...new Set(
			[path.resolve(projectCwd), path.resolve(projectRootReal), ...normalizedPathAliases(projectRootReal)].map(
				root => root.toLowerCase(),
			),
		),
	];
	return rawPath
		.split(path.delimiter)
		.filter(segment => {
			if (segment.length === 0 || !path.isAbsolute(segment)) return false;
			const normalizedSegments = normalizedPathAliases(segment).map(candidate => candidate.toLowerCase());
			if (
				normalizedSegments.some(normalizedSegment =>
					normalizedRoots.some(
						normalizedRoot =>
							normalizedSegment === normalizedRoot ||
							normalizedSegment.startsWith(`${normalizedRoot}${path.sep}`),
					),
				)
			)
				return false;
			return !normalizedSegments.some(normalizedSegment =>
				normalizedSegment.split(path.sep).includes("node_modules"),
			);
		})
		.join(path.delimiter);
}

function normalizedPathAliases(targetPath: string): string[] {
	const resolved = path.resolve(targetPath);
	const aliases = [resolved];
	try {
		aliases.push(nodeFs.realpathSync(resolved));
	} catch {
		// Nonexistent PATH segments are compared lexically only.
	}
	return [...new Set(aliases)];
}

function verifierConfigPaths(rootReal: string, commandReal: string): string[] {
	const paths: string[] = [];
	for (let current = commandReal; ; current = path.dirname(current)) {
		for (const configFile of [...VERIFIER_CONFIG_FILES, ...PACKAGE_MANAGER_CONFIG_FILES])
			paths.push(path.join(current, configFile));
		if (current === rootReal) break;
		const relative = path.relative(rootReal, path.dirname(current));
		if (relative.startsWith("..") || path.isAbsolute(relative)) break;
	}
	return paths;
}

async function hashFile(filePath: string): Promise<string> {
	return createHash("sha256")
		.update(await fs.readFile(filePath))
		.digest("hex");
}

async function verifierFileState(filePath: string): Promise<string> {
	try {
		const stat = await fs.lstat(filePath);
		if (stat.isSymbolicLink()) return "symlink";
		if (!stat.isFile()) return "non-file";
		return `sha256:${await hashFile(filePath)}`;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error) {
			const code = error.code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return "missing";
		}
		throw error;
	}
}

async function runVerifierCommands(
	commands: LoopCommandSpec[],
	cwd: string,
	verifierScripts: VerifierScriptSnapshot[],
): Promise<LoopVerifierResult[]> {
	const results: LoopVerifierResult[] = [];
	for (const command of commands) {
		let started = Date.now();
		const beforeReason = await verifierScriptsChanged(verifierScripts);
		if (beforeReason) {
			results.push(verifierError(command, beforeReason, started));
			break;
		}
		results.push(await runCommand(command, cwd));
		started = Date.now();
		const afterReason = await verifierScriptsChanged(verifierScripts);
		if (afterReason) {
			results.push(verifierError(command, afterReason, started));
			break;
		}
	}
	return results;
}

async function runCommand(command: LoopCommandSpec, cwd: string): Promise<LoopVerifierResult> {
	const started = Date.now();
	const invalidReason = validateVerifierCommand(command);
	if (invalidReason) return verifierError(command, invalidReason, started);
	try {
		const rootReal = await fs.realpath(cwd);
		const pathError = verifierSafePathError(cwd, rootReal);
		if (pathError) return verifierError(command, pathError, started);
		const commandCwd = command.cwd ? await resolveInsideProject(cwd, command.cwd, "verifier cwd") : rootReal;
		await rejectSymlinkPathComponents(rootReal, commandCwd, "verifier cwd");
		const script = await readVerifierPackageScript(command, commandCwd);
		if (script.error) return verifierError(command, script.error, started);
		const verifierArgv = tokenizeVerifierScript(script.scriptValue);
		const proc = Bun.spawn(verifierArgv, {
			cwd: commandCwd,
			env: verifierRuntimeEnv(cwd, rootReal),
			stdout: "pipe",
			stderr: "pipe",
		});
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		const outputPromise = Promise.all([readLimited(proc.stdout), readLimited(proc.stderr), proc.exited]);
		const timeoutPromise = new Promise<"timeout">(resolve => {
			killTimer = setTimeout(() => {
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 1_000);
				resolve("timeout");
			}, VERIFIER_TIMEOUT_MS);
		});
		const result = await Promise.race([outputPromise, timeoutPromise]);
		if (killTimer) clearTimeout(killTimer);
		if (result === "timeout") {
			outputPromise.catch(() => undefined);
			return {
				command: command.argv,
				exitCode: null,
				stdout: "",
				stderr: `Verifier timed out after ${VERIFIER_TIMEOUT_MS}ms`,
				durationMs: Date.now() - started,
			};
		}
		const [stdout, stderr, exitCode] = result;
		return {
			command: command.argv,
			exitCode,
			stdout,
			stderr,
			durationMs: Date.now() - started,
		};
	} catch (error) {
		return verifierError(command, error instanceof Error ? error.message : String(error), started);
	}
}

function validateVerifierCommand(command: LoopCommandSpec): string | null {
	const executable = command.argv[0];
	if (!executable || executable.trim().length === 0) return "verifier argv[0] is required";
	if (executable !== path.basename(executable) || executable.includes("/") || executable.includes("\\")) {
		return "verifier executable must be a bare package runner name";
	}
	const executableName = path.basename(executable).toLowerCase();
	if (SHELL_EXECUTABLES.has(executableName)) {
		return `verifier executable ${executable} is not allowed; use argv commands without a shell`;
	}
	if (!isAllowedVerifierPackageScript(executableName, command.argv)) {
		return "verifier commands must use a package-script form like `bun run check`";
	}
	return null;
}

function isAllowedVerifierPackageScript(executableName: string, argv: string[]): boolean {
	if (!PACKAGE_SCRIPT_RUNNERS.has(executableName)) return false;
	if (executableName === "npm" && argv[1] === "test") return true;
	return argv[1] === "run" && typeof argv[2] === "string" && argv[2].length > 0 && !argv[2].startsWith("-");
}

async function readVerifierPackageScript(
	command: LoopCommandSpec,
	commandCwd: string,
): Promise<VerifierScriptSnapshot> {
	if (command.argv[0] === "npm" && command.argv[1] === "test" && command.argv.length > 2) {
		return verifierScriptError("verifier package scripts do not accept extra argv by default");
	}
	if (!(command.argv[0] === "npm" && command.argv[1] === "test") && command.argv.length > 3) {
		return verifierScriptError("verifier package scripts do not accept extra argv by default");
	}
	const scriptName = command.argv[0] === "npm" && command.argv[1] === "test" ? "test" : command.argv[2];
	if (
		!scriptName ||
		scriptName.includes("/") ||
		scriptName.includes("\\") ||
		scriptName === "." ||
		scriptName === ".."
	) {
		return verifierScriptError("verifier script name must be a package.json script key");
	}
	const packageJsonPath = await resolveInsideProject(commandCwd, "package.json", "verifier package.json");
	const packageJsonError = await validateVerifierPackageJson(packageJsonPath);
	if (packageJsonError) return verifierScriptError(packageJsonError);
	const packageJsonDigest = await verifierFileState(packageJsonPath);
	const script = await readPackageScript(packageJsonPath, scriptName);
	return script.error
		? verifierScriptError(script.error)
		: { ...script, packageJsonPath, packageJsonDigest, referencedFiles: [], error: null };
}

async function validateVerifierPackageJson(packageJsonPath: string): Promise<string | null> {
	try {
		const stat = await fs.lstat(packageJsonPath);
		if (stat.isSymbolicLink()) return "verifier package.json must not be a symlink";
		if (!stat.isFile()) return "verifier package.json must be a file";
		return null;
	} catch (error) {
		return `verifier package.json could not be read: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function readPackageScript(
	packageJsonPath: string,
	scriptName: string,
): Promise<{ scriptName: string; scriptValue: string; error: string | null }> {
	let parsed: { scripts?: Record<string, unknown> };
	try {
		parsed = JSON.parse(await Bun.file(packageJsonPath).text()) as { scripts?: Record<string, unknown> };
	} catch (error) {
		return {
			scriptName,
			scriptValue: "",
			error: `verifier package.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const scriptValue = parsed.scripts?.[scriptName];
	if (typeof scriptValue !== "string") {
		return { scriptName, scriptValue: "", error: `verifier script ${scriptName} is not defined in package.json` };
	}
	const safetyError = validateVerifierPackageScriptSafety(scriptName, scriptValue, parsed.scripts ?? {});
	if (safetyError) return { scriptName, scriptValue: "", error: safetyError };
	return { scriptName, scriptValue, error: null };
}

function validateVerifierPackageScriptSafety(
	scriptName: string,
	scriptValue: string,
	scripts: Record<string, unknown>,
): string | null {
	for (const lifecycleScriptName of [`pre${scriptName}`, `post${scriptName}`]) {
		if (typeof scripts[lifecycleScriptName] === "string") {
			return `verifier lifecycle script ${lifecycleScriptName} is not allowed`;
		}
	}
	if (containsUnsafeVerifierShellSyntax(scriptValue)) {
		return "verifier package scripts must not use shell expansion, escaping, or metacharacters";
	}
	if (containsNodePackageScriptDelegation(scriptValue)) {
		return "verifier package scripts must not delegate through node --run";
	}
	if (containsNestedPackageRunner(scriptValue)) {
		return "verifier package scripts must not invoke nested package scripts";
	}
	if (containsUnsupportedVerifierRunnerSubcommand(scriptValue)) {
		return "verifier package scripts must not use runner subcommands";
	}
	if (!usesApprovedLocalVerifierEntrypoint(scriptValue)) {
		return "verifier package scripts must execute a local verifier file through an approved runtime";
	}
	return null;
}

function containsUnsafeVerifierShellSyntax(scriptValue: string): boolean {
	return /["'\\`$*?[\]{}<>;&|\r\n]/.test(scriptValue) || /:\/\/|(?:^|\s)[A-Za-z][A-Za-z0-9+.-]*:/.test(scriptValue);
}

function containsNodePackageScriptDelegation(scriptValue: string): boolean {
	const words = tokenizeVerifierScript(scriptValue);
	for (const [index, word] of words.entries()) {
		if (path.basename(word).toLowerCase() !== "node") continue;
		if (words.slice(index + 1).some(value => value === "--run" || value.startsWith("--run="))) return true;
	}
	return false;
}

function usesApprovedLocalVerifierEntrypoint(scriptValue: string): boolean {
	const words = tokenizeVerifierScript(scriptValue);
	const runtimeToken = words[0] ?? "";
	if (
		runtimeToken !== path.basename(runtimeToken) ||
		runtimeToken.includes("/") ||
		runtimeToken.includes("\\") ||
		path.isAbsolute(runtimeToken)
	) {
		return false;
	}
	const runnerName = runtimeToken.toLowerCase();
	if (!VERIFIER_SCRIPT_OPERAND_RUNNERS.has(runnerName)) return false;
	if (hasEntrypointBlockingFlag(words, 1)) return false;
	const operand = firstVerifierRunnerOperand(runnerName, words, 1);
	return !!operand && !isVerifierRunnerSubcommand(runnerName, operand) && looksLikeDirectVerifierFileOperand(operand);
}

function hasEntrypointBlockingFlag(words: string[], start: number): boolean {
	for (let index = start; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word.length === 0) continue;
		if (word === "--") return false;
		return word.startsWith("-");
	}
	return false;
}

function containsNestedPackageRunner(scriptValue: string): boolean {
	const words = tokenizeVerifierScript(scriptValue);
	for (const [index, word] of words.entries()) {
		const runnerName = path.basename(word).toLowerCase();
		if (!PACKAGE_SCRIPT_RUNNERS.has(runnerName)) continue;
		if (runnerName !== "bun") return true;
		const operand = firstVerifierRunnerOperand(runnerName, words, index + 1);
		if (!operand || isVerifierRunnerSubcommand(runnerName, operand) || !looksLikeDirectVerifierFileOperand(operand)) {
			return true;
		}
	}
	return false;
}

function looksLikeDirectVerifierFileOperand(operand: string): boolean {
	if (
		operand.includes("://") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(operand) ||
		path.isAbsolute(operand) ||
		operand.startsWith("-")
	) {
		return false;
	}
	return (
		operand.startsWith("./") || operand.startsWith("../") || VERIFIER_REFERENCE_EXTENSIONS.has(path.extname(operand))
	);
}

function looksLikeExplicitVerifierFileOperand(operand: string): boolean {
	return (
		looksLikeDirectVerifierFileOperand(operand) &&
		(operand.startsWith("./") ||
			operand.startsWith("../") ||
			VERIFIER_REFERENCE_EXTENSIONS.has(path.extname(operand)))
	);
}

function containsUnsupportedVerifierRunnerSubcommand(scriptValue: string): boolean {
	const words = tokenizeVerifierScript(scriptValue);
	for (const [index, word] of words.entries()) {
		const runnerName = path.basename(word).toLowerCase();
		if (!VERIFIER_SCRIPT_RUNNER_SUBCOMMANDS.has(runnerName)) continue;
		const operand = firstVerifierRunnerOperand(runnerName, words, index + 1);
		if (runnerName === "deno" && operand && !looksLikeExplicitVerifierFileOperand(operand)) return true;
		if (operand && !looksLikeDirectVerifierFileOperand(operand)) return true;
	}
	return false;
}

function verifierScriptError(error: string): VerifierScriptSnapshot {
	return { packageJsonPath: "", packageJsonDigest: "", scriptName: "", scriptValue: "", referencedFiles: [], error };
}

function verifierError(command: LoopCommandSpec, message: string, started: number): LoopVerifierResult {
	return {
		command: command.argv,
		exitCode: null,
		stdout: "",
		stderr: message,
		durationMs: Date.now() - started,
	};
}

async function readLimited(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			const remaining = OUTPUT_LIMIT - output.length;
			if (remaining > 0) output += chunk.slice(0, remaining);
			if (chunk.length > remaining) {
				truncated = true;
				await reader.cancel();
				break;
			}
		}
		output += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	return truncated ? `${output}\n... truncated ...` : output;
}

async function readStatusOutput(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			if (output.length + chunk.length > STATUS_OUTPUT_LIMIT) {
				await reader.cancel();
				return null;
			}
			output += chunk;
		}
		return output + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function listChangedFiles(cwd: string): Promise<string[] | null> {
	try {
		const proc = Bun.spawn(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		const [stdout, exitCode] = await Promise.all([readStatusOutput(proc.stdout), proc.exited]);
		if (exitCode !== 0 || stdout === null) return null;
		return parsePorcelainStatusZ(stdout);
	} catch {
		return null;
	}
}

export function parsePorcelainStatusZ(stdout: string): string[] {
	const records = stdout.split("\0").filter(Boolean);
	const files: string[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.length < 4) continue;
		const status = record.slice(0, 2);
		files.push(record.slice(3));
		if (status.includes("R") || status.includes("C")) {
			const previousPath = records[index + 1];
			if (previousPath) files.push(previousPath);
			index++;
		}
	}
	return [...new Set(files)];
}

function changedFilesSinceBaseline(baseline: string[] | null, observed: string[] | null): string[] {
	if (!baseline || !observed) return [];
	const before = new Set(baseline);
	return observed.filter(file => !before.has(file));
}

interface ApprovalContext {
	canObserveChangedFiles: boolean;
	baselineChangedFileCount: number | null;
}

function approvalReasonsFor(
	spec: LoopSpec,
	changedFiles: string[],
	verifierResults: LoopVerifierResult[],
	context: ApprovalContext,
): string[] {
	const reasons: string[] = [];
	if (!context.canObserveChangedFiles && spec.level !== "report") {
		reasons.push("changed files could not be observed with git status");
	}
	if (context.baselineChangedFileCount && context.baselineChangedFileCount > 0 && spec.level !== "report") {
		reasons.push(`worktree had ${context.baselineChangedFileCount} pre-existing changed files before loop run`);
	}
	if (spec.guardrails.maxFilesChanged !== null && changedFiles.length > spec.guardrails.maxFilesChanged) {
		reasons.push(`changed ${changedFiles.length} files, above max_files_changed ${spec.guardrails.maxFilesChanged}`);
	}
	const outsideScope = changedFiles.find(file => !spec.scope.paths.some(scope => pathWithinScope(scope, file)));
	if (outsideScope) reasons.push(`changed out-of-scope path ${outsideScope}`);
	const denylistHit = changedFiles.find(file =>
		spec.guardrails.denylistPaths.some(pattern => pathMatches(pattern, file)),
	);
	if (denylistHit) reasons.push(`changed denylisted path ${denylistHit}`);
	if (spec.level === "autonomous" && verifierResults.length === 0)
		reasons.push("autonomous loop has no verifier command result");
	return reasons;
}

function pathWithinScope(scope: string, filePath: string): boolean {
	const normalizedScope = normalizeRepoPath(scope);
	const normalizedFile = normalizeRepoPath(filePath);
	if (normalizedScope === "." || normalizedScope === "") return true;
	if (normalizedScope.includes("*")) return pathMatches(normalizedScope, normalizedFile);
	return normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`);
}

export function pathMatches(pattern: string, filePath: string): boolean {
	const normalizedPattern = normalizeRepoPath(pattern);
	const normalizedFile = normalizeRepoPath(filePath);
	if (normalizedPattern === "." || normalizedPattern === normalizedFile) return true;
	if (normalizedPattern.startsWith("**/") && pathMatches(normalizedPattern.slice(3), normalizedFile)) return true;
	if (normalizedPattern.endsWith("/**") && !normalizedPattern.slice(0, -3).includes("*")) {
		const base = normalizedPattern.slice(0, -3);
		return normalizedFile === base || normalizedFile.startsWith(`${base}/`);
	}
	if (!normalizedPattern.includes("/")) {
		return (
			globRegex(normalizedPattern).test(path.basename(normalizedFile)) ||
			globRegex(normalizedPattern).test(normalizedFile)
		);
	}
	if (!normalizedPattern.includes("*")) return false;
	return globRegex(normalizedPattern).test(normalizedFile);
}

function normalizeRepoPath(value: string): string {
	return (
		value
			.replaceAll("\\", "/")
			.replace(/^\.\/+/, "")
			.replace(/\/+$/, "") || "."
	);
}

function globRegex(pattern: string): RegExp {
	let source = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		const next = pattern[index + 1];
		const afterNext = pattern[index + 2];
		if (char === "*" && next === "*" && afterNext === "/") {
			source += "(?:.*/)?";
			index += 2;
			continue;
		}
		if (char === "*" && next === "*") {
			source += ".*";
			index++;
			continue;
		}
		if (char === "*") {
			source += "[^/]*";
			continue;
		}
		source += escapeRegex(char);
	}
	return new RegExp(`${source}$`);
}

async function persistRunRecord(spec: LoopSpec, cwd: string, record: LoopRunRecord): Promise<LoopRunResult> {
	const redactedRecord = redactRunRecord(record);
	const jsonlPath = await resolveInsideProject(
		cwd,
		path.join(".omp", "loop-runs", `${spec.name}.jsonl`),
		"loop JSONL log",
	);
	await appendRunLogLine(cwd, jsonlPath, "loop JSONL log", `${JSON.stringify(redactedRecord)}\n`);
	let markdownLogPath: string | null = null;
	if (spec.state.runLog) {
		markdownLogPath = await resolveInsideProject(cwd, spec.state.runLog, "loop markdown log");
		await appendRunLogLine(cwd, markdownLogPath, "loop markdown log", markdownLine(redactedRecord));
	}
	return { ...redactedRecord, jsonlPath, markdownLogPath };
}

async function appendRunLogLine(cwd: string, logPath: string, label: string, line: string): Promise<void> {
	await assertSafeProjectWrite(cwd, logPath, label);
	await fs.mkdir(path.dirname(logPath), { recursive: true });
	await assertSafeProjectWrite(cwd, logPath, label);
	const rootReal = await fs.realpath(cwd);
	await rejectSymlinkPathComponents(rootReal, logPath, label);
	const noFollow = "O_NOFOLLOW" in nodeFs.constants ? nodeFs.constants.O_NOFOLLOW : 0;
	const fd = nodeFs.openSync(
		logPath,
		nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_APPEND | noFollow,
		0o600,
	);
	try {
		const stat = nodeFs.fstatSync(fd);
		if (!stat.isFile()) throw new Error(`${label} must be a file`);
		nodeFs.writeFileSync(fd, line, { encoding: "utf8" });
	} finally {
		nodeFs.closeSync(fd);
	}
}

function markdownLine(record: LoopRunRecord): string {
	const summary =
		record.error ?? (record.approvalReasons.join("; ") || record.agentOutput.split("\n")[0] || "completed");
	return `| ${record.finishedAt} | ${record.status} | ${record.loop}: ${markdownCell(summary)} |\n`;
}

function redactRunRecord(record: LoopRunRecord): LoopRunRecord {
	return {
		...record,
		prompt: redactSecrets(record.prompt),
		agentOutput: redactSecrets(record.agentOutput),
		approvalReasons: record.approvalReasons.map(redactSecrets),
		error: record.error ? redactSecrets(record.error) : null,
		verifierResults: record.verifierResults.map(result => ({
			...result,
			command: redactCommandArgs(result.command),
			stdout: redactSecrets(result.stdout),
			stderr: redactSecrets(result.stderr),
		})),
	};
}

function markdownCell(value: string): string {
	return sanitizeText(redactSecrets(value))
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replaceAll("|", "\\|")
		.slice(0, 500);
}

function redactCommandArgs(argv: string[]): string[] {
	const redacted: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (isSecretFlag(arg) && index + 1 < argv.length) {
			redacted.push(arg);
			redacted.push("[REDACTED_SECRET]");
			index++;
			continue;
		}
		redacted.push(redactSecrets(arg));
	}
	return redacted;
}

function isSecretFlag(value: string): boolean {
	return /^--?[A-Za-z0-9_-]*(token|key|secret|password|credential)[A-Za-z0-9_-]*$/i.test(value);
}

function redactSecrets(value: string): string {
	return value
		.replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_SECRET]")
		.replace(/\b(?:ghp|github_pat|npm|xox[baprs])[-_][A-Za-z0-9_/-]{10,}\b/g, "[REDACTED_SECRET]")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_SECRET]")
		.replace(/\b(Authorization\s*:\s*Bearer\s+)["']?[^"'\s]+/gi, "$1[REDACTED_SECRET]")
		.replace(
			/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*)["']?[^"'\s]{6,}/gi,
			"$1[REDACTED_SECRET]",
		)
		.replace(
			/\b(--?[A-Za-z0-9_-]*(?:token|key|secret|password|credential)[A-Za-z0-9_-]*=)["']?[^"'\s]+/gi,
			"$1[REDACTED_SECRET]",
		)
		.replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_SECRET]")
		.replace(/\b([A-Za-z0-9._%+-]+:[A-Za-z0-9/+=._-]{16,})\b/g, "[REDACTED_SECRET]");
}

function truncate(value: string): string {
	return value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}\n[… truncated …]` : value;
}

function escapeRegex(value: string): string {
	return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
