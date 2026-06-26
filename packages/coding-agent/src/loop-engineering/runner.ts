import * as fs from "node:fs/promises";
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
const STATUS_OUTPUT_LIMIT = 1_000_000;

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
			? await runVerifierCommands(spec.verifier.commands, options.cwd)
			: [];
	const observedChangedFiles = await listChangedFiles(options.cwd);
	const changedFiles = changedFilesSinceBaseline(baselineChangedFiles, observedChangedFiles);
	const approvalReasons = approvalReasonsFor(spec, changedFiles, verifierResults, {
		canObserveChangedFiles: baselineChangedFiles !== null && observedChangedFiles !== null,
		baselineChangedFileCount: baselineChangedFiles?.length ?? null,
	});
	if (verifierMutationReason) approvalReasons.push(verifierMutationReason);
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
	scriptName: string;
	scriptValue: string;
	error: string | null;
}

async function captureVerifierScriptSnapshots(
	commands: LoopCommandSpec[],
	cwd: string,
): Promise<VerifierScriptSnapshot[]> {
	const snapshots: VerifierScriptSnapshot[] = [];
	for (const command of commands) {
		const invalidReason = validateVerifierCommand(command);
		if (invalidReason) {
			snapshots.push({ packageJsonPath: "", scriptName: "", scriptValue: "", error: invalidReason });
			continue;
		}
		try {
			const commandCwd = command.cwd ? await resolveInsideProject(cwd, command.cwd, "verifier cwd") : cwd;
			const script = await readVerifierPackageScript(command, commandCwd);
			snapshots.push(
				script.error ? { packageJsonPath: "", scriptName: "", scriptValue: "", error: script.error } : script,
			);
		} catch (error) {
			snapshots.push({
				packageJsonPath: "",
				scriptName: "",
				scriptValue: "",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return snapshots;
}

async function verifierScriptsChanged(snapshots: VerifierScriptSnapshot[]): Promise<string | null> {
	for (const snapshot of snapshots) {
		if (snapshot.error) return snapshot.error;
		const current = await readPackageScript(snapshot.packageJsonPath, snapshot.scriptName);
		if (current.error) return current.error;
		if (current.scriptValue !== snapshot.scriptValue) {
			return `verifier package.json script ${snapshot.scriptName} changed before verifier execution`;
		}
	}
	return null;
}

async function runVerifierCommands(commands: LoopCommandSpec[], cwd: string): Promise<LoopVerifierResult[]> {
	const results: LoopVerifierResult[] = [];
	for (const command of commands) {
		results.push(await runCommand(command, cwd));
	}
	return results;
}

async function runCommand(command: LoopCommandSpec, cwd: string): Promise<LoopVerifierResult> {
	const started = Date.now();
	const invalidReason = validateVerifierCommand(command);
	if (invalidReason) return verifierError(command, invalidReason, started);
	try {
		const commandCwd = command.cwd ? await resolveInsideProject(cwd, command.cwd, "verifier cwd") : cwd;
		const scriptError = await validateVerifierPackageScriptTarget(command, commandCwd);
		if (scriptError) return verifierError(command, scriptError, started);
		const proc = Bun.spawn(command.argv, {
			cwd: commandCwd,
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

async function validateVerifierPackageScriptTarget(
	command: LoopCommandSpec,
	commandCwd: string,
): Promise<string | null> {
	const script = await readVerifierPackageScript(command, commandCwd);
	return script.error;
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
	const script = await readPackageScript(packageJsonPath, scriptName);
	return script.error ? verifierScriptError(script.error) : { ...script, packageJsonPath, error: null };
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
	return { scriptName, scriptValue, error: null };
}

function verifierScriptError(error: string): VerifierScriptSnapshot {
	return { packageJsonPath: "", scriptName: "", scriptValue: "", error };
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

function appendLine(value: string, line: string): string {
	return value.length > 0 ? `${value}\n${line}` : line;
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
	await assertSafeProjectWrite(cwd, jsonlPath, "loop JSONL log");
	await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
	await fs.appendFile(jsonlPath, `${JSON.stringify(redactedRecord)}\n`, { encoding: "utf8", mode: 0o600 });
	let markdownLogPath: string | null = null;
	if (spec.state.runLog) {
		markdownLogPath = await resolveInsideProject(cwd, spec.state.runLog, "loop markdown log");
		await assertSafeProjectWrite(cwd, markdownLogPath, "loop markdown log");
		await fs.mkdir(path.dirname(markdownLogPath), { recursive: true });
		await fs.appendFile(markdownLogPath, markdownLine(redactedRecord), { encoding: "utf8", mode: 0o600 });
	}
	return { ...redactedRecord, jsonlPath, markdownLogPath };
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
		.replace(/\b(?:ghp|github_pat|npm|xox[baprs])_[A-Za-z0-9_/-]{10,}\b/g, "[REDACTED_SECRET]")
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
