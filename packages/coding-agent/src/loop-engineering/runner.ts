import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { parse } from "@babel/parser";
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
const REPORT_LOOP_TOOLS = ["read", "grep", "glob", "web_search"];
const VERIFIER_TIMEOUT_MS = 120_000;
const SHELL_EXECUTABLES = new Set(["bash", "cmd", "fish", "powershell", "pwsh", "sh", "zsh"]);
const PACKAGE_SCRIPT_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const VERIFIER_SCRIPT_OPERAND_RUNNERS = new Set(["bun", "deno", "node"]);
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
	"node:process",
	"node:repl",
	"node:vm",
	"node:worker_threads",
	"repl",
	"process",
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
const VERIFIER_UNSAFE_DEPENDENCY_EXTENSIONS = new Set([".node", ".wasm"]);
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
		agentOutput = redactAndTruncate(result.output);
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
	runtimePath: string;
	runtimeDigest: string;
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
				runtimePath: "",
				runtimeDigest: "",
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
			const runtimePath =
				script.error === null
					? await resolveVerifierRuntimePath(script.scriptValue, verifierRuntimePath(cwd, rootReal), cwd, rootReal)
					: "";
			const runtimeDigest = runtimePath ? await verifierFileState(runtimePath) : "";
			const referencedFiles =
				script.error === null ? await captureVerifierReferencedFiles(rootReal, commandCwd, script.scriptValue) : [];
			snapshots.push(
				script.error
					? {
							packageJsonPath: "",
							packageJsonDigest: "",
							scriptName: "",
							scriptValue: "",
							runtimePath: "",
							runtimeDigest: "",
							referencedFiles: [],
							error: script.error,
						}
					: { ...script, runtimePath, runtimeDigest, referencedFiles },
			);
		} catch (error) {
			snapshots.push({
				packageJsonPath: "",
				packageJsonDigest: "",
				scriptName: "",
				scriptValue: "",
				runtimePath: "",
				runtimeDigest: "",
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
		if (snapshot.runtimePath) {
			const currentRuntimeDigest = await verifierFileState(snapshot.runtimePath);
			if (currentRuntimeDigest !== snapshot.runtimeDigest) {
				return "verifier runtime changed before verifier execution";
			}
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
	if (digest === "missing") return;
	if (!shouldScanVerifierDependencies(filePath)) {
		if (VERIFIER_UNSAFE_DEPENDENCY_EXTENSIONS.has(path.extname(filePath)))
			throw new Error("verifier dependencies must not use native or WebAssembly files");
		return;
	}
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
		if (path.extname(dependencySpecifier).length === 0)
			throw new Error("verifier dependencies must use explicit file extensions");
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
	return /\b(?:constructor|eval|Function|SharedWorker|WebAssembly|Worker)\b/.test(content);
}

function hasVerifierEscapedIdentifier(content: string): boolean {
	return /\\(?:u\{?[0-9a-fA-F]+}?|x[0-9a-fA-F]{2})/.test(content);
}

function hasVerifierDynamicPropertyAccess(content: string): boolean {
	let ast: unknown;
	try {
		ast = parse(content, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
	} catch {
		return true;
	}
	const globalAliases = collectGlobalAliases(ast);
	return hasUnsafeDynamicPropertyNode(ast, globalAliases);
}

function hasUnsafeDynamicPropertyNode(node: unknown, globalAliases = new Set<string>()): boolean {
	if (!node || typeof node !== "object") return false;
	if (Array.isArray(node)) return node.some(item => hasUnsafeDynamicPropertyNode(item, globalAliases));
	const record = node as Record<string, unknown>;
	if (isComputedMemberExpression(record) && !isNumericLiteralNode(record.property)) return true;
	if (isUnsafeReflectivePropertyAccess(record, globalAliases)) return true;
	if (record.type === "ObjectPattern" && hasComputedPatternProperty(record.properties)) return true;
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end") continue;
		if (hasUnsafeDynamicPropertyNode(value, globalAliases)) return true;
	}
	return false;
}

function isComputedMemberExpression(record: Record<string, unknown>): boolean {
	return (
		(record.type === "MemberExpression" || record.type === "OptionalMemberExpression") && record.computed === true
	);
}

function isUnsafeReflectivePropertyAccess(record: Record<string, unknown>, globalAliases = new Set<string>()): boolean {
	const reflectCall = reflectedBuiltinCall(
		record,
		"Reflect",
		new Set(["get", "getOwnPropertyDescriptor"]),
		globalAliases,
	);
	if (reflectCall) {
		if (reflectCall.unknownApply) return true;
		const target = reflectCall.args[0];
		const targetIsProcess = isIdentifierNamed(target, "process");
		const targetIsGlobalObject = isGlobalObjectExpression(target, globalAliases);
		const reflectedProperty = reflectedPropertyKeyName(reflectCall.args[1]);
		return targetIsProcess || (targetIsGlobalObject && isUnsafeGlobalReflectedProperty(reflectedProperty));
	}
	const objectCall = reflectedBuiltinCall(
		record,
		"Object",
		new Set(["values", "entries", "assign", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]),
		globalAliases,
	);
	if (!objectCall) return false;
	if (objectCall.unknownApply) return true;
	const target =
		objectCall.method === "assign"
			? objectCall.args.find(arg => isGlobalObjectExpression(arg, globalAliases))
			: objectCall.args[0];
	const targetIsProcess = isIdentifierNamed(target, "process");
	const targetIsGlobalObject = isGlobalObjectExpression(target, globalAliases);
	if (objectCall.method === "getOwnPropertyDescriptor") {
		const reflectedProperty = reflectedPropertyKeyName(objectCall.args[1]);
		return targetIsProcess || (targetIsGlobalObject && isUnsafeGlobalReflectedProperty(reflectedProperty));
	}
	return targetIsProcess || targetIsGlobalObject;
}

function isUnsafeGlobalReflectedProperty(property: string | null): boolean {
	return property === null || property === "process" || property === "Bun" || property === "Deno";
}

function isNumericLiteralNode(node: unknown): boolean {
	return (
		!!node &&
		typeof node === "object" &&
		((node as Record<string, unknown>).type === "NumericLiteral" ||
			(node as Record<string, unknown>).type === "NumberLiteral")
	);
}

function hasComputedPatternProperty(properties: unknown): boolean {
	if (!Array.isArray(properties)) return false;
	return properties.some(property => {
		if (!property || typeof property !== "object") return false;
		const record = property as Record<string, unknown>;
		return record.computed === true || hasUnsafeDynamicPropertyNode(record);
	});
}

function hasVerifierProcessExecutionApi(content: string): boolean {
	let ast: unknown;
	try {
		ast = parse(content, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
	} catch {
		return true;
	}
	const globalAliases = collectGlobalAliases(ast);
	const processAliases = collectProcessAliases(ast, new Set<string>(), globalAliases);
	return hasUnsafeProcessApiNode(ast, processAliases, globalAliases);
}

function collectProcessAliases(
	node: unknown,
	aliases = new Set<string>(),
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
	visibleProcessAliases = aliases,
): Set<string> {
	if (!node || typeof node !== "object") return aliases;
	if (Array.isArray(node)) {
		for (const item of node)
			collectProcessAliases(item, aliases, globalAliases, shadowBareProcess, visibleProcessAliases);
		return aliases;
	}
	const record = node as Record<string, unknown>;
	const params = isFunctionLikeExpression(record) && Array.isArray(record.params) ? record.params : [];
	const nestedProcessAliases = aliasesWithoutBoundParams(visibleProcessAliases, params);
	const nestedGlobalAliases = aliasesWithoutBoundParams(globalAliases, params);
	const nestedShadowBareProcess = shadowBareProcess || params.some(param => patternBindsIdentifier(param, "process"));
	if (isFunctionLikeExpression(record)) {
		for (const [key, value] of Object.entries(record)) {
			if (key === "loc" || key === "start" || key === "end" || key === "body" || key === "params") continue;
			collectProcessAliases(value, aliases, globalAliases, shadowBareProcess, visibleProcessAliases);
		}
		return aliases;
	}
	if (
		record.type === "VariableDeclarator" &&
		isIdentifierNode(record.id) &&
		isProcessExpression(record.init, visibleProcessAliases, globalAliases, shadowBareProcess)
	) {
		const aliasName = String((record.id as Record<string, unknown>).name);
		aliases.add(aliasName);
		visibleProcessAliases.add(aliasName);
	}
	if (
		record.type === "AssignmentExpression" &&
		isIdentifierNode(record.left) &&
		isProcessExpression(record.right, visibleProcessAliases, globalAliases, shadowBareProcess)
	) {
		const aliasName = String((record.left as Record<string, unknown>).name);
		aliases.add(aliasName);
		visibleProcessAliases.add(aliasName);
	}
	if (
		record.type === "AssignmentExpression" &&
		isGlobalProcessDestructurePattern(record.left, record.right, globalAliases)
	) {
		addGlobalProcessDestructureAliases(record.left, aliases);
		if (visibleProcessAliases !== aliases) addGlobalProcessDestructureAliases(record.left, visibleProcessAliases);
	}
	if (
		record.type === "VariableDeclarator" &&
		isGlobalProcessDestructurePattern(record.id, record.init, globalAliases)
	) {
		addGlobalProcessDestructureAliases(record.id, aliases);
		if (visibleProcessAliases !== aliases) addGlobalProcessDestructureAliases(record.id, visibleProcessAliases);
	}
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end" || (isFunctionLikeExpression(record) && key === "params"))
			continue;
		collectProcessAliases(value, aliases, nestedGlobalAliases, nestedShadowBareProcess, nestedProcessAliases);
	}
	return aliases;
}

function collectGlobalAliases(node: unknown, aliases = new Set<string>()): Set<string> {
	if (!node || typeof node !== "object") return aliases;
	if (Array.isArray(node)) {
		for (const item of node) collectGlobalAliases(item, aliases);
		return aliases;
	}
	const record = node as Record<string, unknown>;
	if (isFunctionLikeExpression(record)) {
		for (const [key, value] of Object.entries(record)) {
			if (key === "loc" || key === "start" || key === "end" || key === "body" || key === "params") continue;
			collectGlobalAliases(value, aliases);
		}
		return aliases;
	}
	if (
		record.type === "VariableDeclarator" &&
		isIdentifierNode(record.id) &&
		isGlobalObjectExpression(record.init, aliases)
	)
		aliases.add(String((record.id as Record<string, unknown>).name));
	if (
		record.type === "AssignmentExpression" &&
		isIdentifierNode(record.left) &&
		isGlobalObjectExpression(record.right, aliases)
	)
		aliases.add(String((record.left as Record<string, unknown>).name));
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end") continue;
		collectGlobalAliases(value, aliases);
	}
	return aliases;
}

function hasUnsafeProcessApiNode(
	node: unknown,
	processAliases: Set<string>,
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
): boolean {
	if (!node || typeof node !== "object") return false;
	if (Array.isArray(node))
		return node.some(item => hasUnsafeProcessApiNode(item, processAliases, globalAliases, shadowBareProcess));
	const record = node as Record<string, unknown>;
	if (isIdentifierNamed(record, "Bun") || isIdentifierNamed(record, "Deno")) return true;
	if (isGlobalRuntimeObjectExpression(record, globalAliases)) return true;
	if (isUnsafeGlobalObjectReflectionCall(record, globalAliases)) return true;
	if (
		record.type === "WithStatement" &&
		isProcessExpression(record.object, processAliases, globalAliases, shadowBareProcess)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		isIdentifierNode(record.left) &&
		isProcessExpression(record.right, processAliases, globalAliases, shadowBareProcess)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		isIdentifierNode(record.left) &&
		isGlobalObjectExpression(record.right, globalAliases)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		isIdentifierNode(record.left) &&
		(isSensitiveReflectionMethodExpression(record.right, globalAliases) ||
			isSensitiveReflectionMethodBindExpression(record.right, globalAliases) ||
			containsSensitiveReflectionObjectValue(record.right, globalAliases))
	)
		return true;
	if (
		record.type === "VariableDeclarator" &&
		isIdentifierNode(record.id) &&
		(isSensitiveReflectionMethodExpression(record.init, globalAliases) ||
			isSensitiveReflectionMethodBindExpression(record.init, globalAliases) ||
			containsSensitiveReflectionObjectValue(record.init, globalAliases))
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		isSensitiveReflectionMethodDestructurePattern(record.left, record.right, globalAliases)
	)
		return true;
	if (
		record.type === "VariableDeclarator" &&
		isSensitiveReflectionMethodDestructurePattern(record.id, record.init, globalAliases)
	)
		return true;
	if (
		record.type === "VariableDeclarator" &&
		isProcessBindingPattern(record.id, record.init, processAliases, globalAliases, shadowBareProcess)
	)
		return true;
	if (record.type === "VariableDeclarator" && isGlobalProcessBindingPattern(record.id, record.init, globalAliases))
		return true;
	if (record.type === "VariableDeclarator" && isGlobalRuntimeDestructurePattern(record.id, record.init, globalAliases))
		return true;
	if (record.type === "VariableDeclarator" && isGlobalObjectDestructurePattern(record.id, record.init, globalAliases))
		return true;
	if (record.type === "VariableDeclarator" && containsGlobalObjectContainerValue(record.init, globalAliases))
		return true;
	if (
		record.type === "VariableDeclarator" &&
		containsProcessContainerValue(record.init, processAliases, globalAliases, shadowBareProcess)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		isProcessBindingPattern(record.left, record.right, processAliases, globalAliases, shadowBareProcess)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		isGlobalProcessBindingPattern(record.left, record.right, globalAliases)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		isGlobalProcessDestructurePattern(record.left, record.right, globalAliases)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		isGlobalRuntimeDestructurePattern(record.left, record.right, globalAliases)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		isGlobalObjectDestructurePattern(record.left, record.right, globalAliases)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		!isIdentifierNode(record.left) &&
		containsGlobalObjectValue(record.right, globalAliases)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		!isIdentifierNode(record.left) &&
		(isSensitiveReflectionMethodExpression(record.right, globalAliases) ||
			isSensitiveReflectionMethodBindExpression(record.right, globalAliases) ||
			containsSensitiveReflectionObjectValue(record.right, globalAliases))
	)
		return true;
	if (record.type === "AssignmentExpression" && containsGlobalObjectContainerValue(record.right, globalAliases))
		return true;
	if (
		record.type === "AssignmentExpression" &&
		containsProcessContainerValue(record.right, processAliases, globalAliases, shadowBareProcess)
	)
		return true;
	if (
		record.type === "AssignmentExpression" &&
		!isIdentifierNode(record.left) &&
		isProcessExpression(record.right, processAliases, globalAliases, shadowBareProcess)
	)
		return true;
	if (isFunctionLikeExpression(record)) {
		const params = Array.isArray(record.params) ? record.params : [];
		if (
			params.some(
				param =>
					parameterDefaultContainsProcessValue(param, processAliases, globalAliases, shadowBareProcess) ||
					parameterDefaultContainsGlobalObjectValue(param, globalAliases),
			)
		)
			return true;
		const nestedProcessAliases = aliasesWithoutBoundParams(processAliases, params);
		const nestedGlobalAliases = aliasesWithoutBoundParams(globalAliases, params);
		const nestedShadowBareProcess =
			shadowBareProcess || params.some(param => patternBindsIdentifier(param, "process"));
		const scopedGlobalAliases = collectGlobalAliases(record.body, new Set(nestedGlobalAliases));
		const scopedProcessAliases = collectProcessAliases(
			record.body,
			new Set(nestedProcessAliases),
			scopedGlobalAliases,
			nestedShadowBareProcess,
		);
		if (
			functionExposesProcessValue(record, processAliases, globalAliases, shadowBareProcess) ||
			functionExposesGlobalObjectValue(record, globalAliases)
		)
			return true;
		return hasUnsafeProcessApiNode(record.body, scopedProcessAliases, scopedGlobalAliases, nestedShadowBareProcess);
	}
	if (isUnsafeProcessMemberAccess(record, processAliases, globalAliases, shadowBareProcess)) return true;
	if (isUnsafeProcessMemberCall(record, processAliases, globalAliases, shadowBareProcess)) return true;
	if (isUnsafeProcessReflectionCall(record, processAliases, globalAliases, shadowBareProcess)) return true;
	if (isProcessValueCallArgument(record, processAliases, globalAliases, shadowBareProcess)) return true;
	if (isGlobalObjectValueCallArgument(record, globalAliases)) return true;
	if (
		(record.type === "ThrowStatement" || record.type === "YieldExpression") &&
		(containsProcessValue(record.argument, processAliases, globalAliases, shadowBareProcess) ||
			containsGlobalObjectValue(record.argument, globalAliases))
	)
		return true;
	if (
		isClassFieldRecord(record) &&
		(containsProcessValue(record.value, processAliases, globalAliases, shadowBareProcess) ||
			containsGlobalObjectValue(record.value, globalAliases))
	)
		return true;
	if (
		record.type === "ExportDefaultDeclaration" &&
		(containsProcessValue(record.declaration, processAliases, globalAliases, shadowBareProcess) ||
			containsGlobalObjectValue(record.declaration, globalAliases))
	)
		return true;
	if (
		record.type === "ExportSpecifier" &&
		(containsProcessValue(record.local, processAliases, globalAliases, shadowBareProcess) ||
			containsGlobalObjectValue(record.local, globalAliases))
	)
		return true;
	if (
		record.type === "SpreadElement" &&
		(isProcessExpression(record.argument, processAliases, globalAliases, shadowBareProcess) ||
			containsGlobalObjectValue(record.argument, globalAliases))
	)
		return true;
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end" || isNonComputedMemberProperty(record, key)) continue;
		if (hasUnsafeProcessApiNode(value, processAliases, globalAliases, shadowBareProcess)) return true;
	}
	return false;
}

function isUnsafeProcessMemberAccess(
	record: Record<string, unknown>,
	processAliases: Set<string>,
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
): boolean {
	if (
		!isMemberLikeNode(record) ||
		!isProcessExpression(record.object, processAliases, globalAliases, shadowBareProcess)
	)
		return false;
	const property = staticMemberPropertyName(record);
	return property === "binding" || property === "dlopen" || property === "getBuiltinModule";
}

function isUnsafeProcessMemberCall(
	record: Record<string, unknown>,
	processAliases: Set<string>,
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
): boolean {
	if (record.type !== "CallExpression" && record.type !== "OptionalCallExpression") return false;
	const callee = record.callee;
	if (!callee || typeof callee !== "object") return false;
	const member = callee as Record<string, unknown>;
	if (
		!isMemberLikeNode(member) ||
		!isProcessExpression(member.object, processAliases, globalAliases, shadowBareProcess)
	)
		return false;
	const property = staticMemberPropertyName(member);
	return property === "binding" || property === "dlopen" || property === "getBuiltinModule";
}

function isUnsafeProcessReflectionCall(
	record: Record<string, unknown>,
	processAliases: Set<string>,
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
): boolean {
	if (record.type !== "CallExpression" && record.type !== "OptionalCallExpression") return false;
	const callee = record.callee;
	if (!callee || typeof callee !== "object") return false;
	const member = callee as Record<string, unknown>;
	if (!isMemberLikeNode(member)) return false;
	const objectName = identifierName(member.object);
	const property = staticMemberPropertyName(member);
	const args = Array.isArray(record.arguments) ? record.arguments : [];
	if (objectName === "Reflect" && property === "get")
		return args.some(arg => isProcessExpression(arg, processAliases, globalAliases, shadowBareProcess));
	if (
		objectName === "Object" &&
		(property === "values" ||
			property === "entries" ||
			property === "assign" ||
			property === "getOwnPropertyDescriptor" ||
			property === "getOwnPropertyDescriptors")
	) {
		return args.some(arg => isProcessExpression(arg, processAliases, globalAliases, shadowBareProcess));
	}
	return false;
}
function isProcessValueCallArgument(
	record: Record<string, unknown>,
	processAliases: Set<string>,
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
): boolean {
	if (record.type === "TaggedTemplateExpression") {
		const quasi = record.quasi as Record<string, unknown> | undefined;
		const expressions = Array.isArray(quasi?.expressions) ? quasi.expressions : [];
		return expressions.some(expression =>
			containsProcessValue(expression, processAliases, globalAliases, shadowBareProcess),
		);
	}
	if (record.type !== "CallExpression" && record.type !== "OptionalCallExpression" && record.type !== "NewExpression")
		return false;
	const args = Array.isArray(record.arguments) ? record.arguments : [];
	return args.some(arg => containsProcessValue(arg, processAliases, globalAliases, shadowBareProcess));
}

function containsProcessValue(
	node: unknown,
	processAliases: Set<string>,
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
): boolean {
	if (shadowBareProcess && isIdentifierNamed(node, "process") && !processAliases.has("process")) return false;
	if (isProcessExpression(node, processAliases, globalAliases, shadowBareProcess)) return true;
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (
		record.type === "CallExpression" ||
		record.type === "OptionalCallExpression" ||
		record.type === "NewExpression"
	) {
		const callee = record.callee;
		return isFunctionLikeExpression(callee as Record<string, unknown>)
			? functionExposesProcessValue(
					callee as Record<string, unknown>,
					processAliases,
					globalAliases,
					shadowBareProcess,
				)
			: false;
	}

	if (isMemberLikeNode(record)) {
		return (
			isProcessExpression(record, processAliases, globalAliases, shadowBareProcess) ||
			isUnsafeProcessMemberAccess(record, processAliases, globalAliases, shadowBareProcess)
		);
	}
	if (record.type === "SpreadElement")
		return containsProcessValue(record.argument, processAliases, globalAliases, shadowBareProcess);
	if (record.type === "ArrayExpression" && Array.isArray(record.elements))
		return record.elements.some(element =>
			containsProcessValue(element, processAliases, globalAliases, shadowBareProcess),
		);
	if (isFunctionLikeExpression(record)) {
		const params = Array.isArray(record.params) ? record.params : [];
		if (
			params.some(param =>
				parameterDefaultContainsProcessValue(param, processAliases, globalAliases, shadowBareProcess),
			)
		)
			return true;
		return functionExposesProcessValue(record, processAliases, globalAliases, shadowBareProcess);
	}
	if (record.type === "ObjectExpression" && Array.isArray(record.properties)) {
		return record.properties.some(property => {
			if (!property || typeof property !== "object") return false;
			const propertyRecord = property as Record<string, unknown>;
			if (propertyRecord.type === "SpreadElement")
				return containsProcessValue(propertyRecord.argument, processAliases, globalAliases, shadowBareProcess);
			if (isFunctionLikeExpression(propertyRecord))
				return containsProcessValue(propertyRecord, processAliases, globalAliases, shadowBareProcess);
			return containsProcessValue(propertyRecord.value, processAliases, globalAliases, shadowBareProcess);
		});
	}
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end" || isNonComputedMemberProperty(record, key)) continue;
		if (containsProcessValue(value, processAliases, globalAliases, shadowBareProcess)) return true;
	}
	return false;
}

function isGlobalObjectValueCallArgument(record: Record<string, unknown>, globalAliases = new Set<string>()): boolean {
	if (isSafeGlobalObjectReadCall(record, globalAliases)) return false;
	if (record.type === "TaggedTemplateExpression") {
		const quasi = record.quasi as Record<string, unknown> | undefined;
		const expressions = Array.isArray(quasi?.expressions) ? quasi.expressions : [];
		return expressions.some(expression => containsGlobalObjectValue(expression, globalAliases));
	}
	if (record.type !== "CallExpression" && record.type !== "OptionalCallExpression" && record.type !== "NewExpression")
		return false;
	const args = Array.isArray(record.arguments) ? record.arguments : [];
	return args.some(arg => containsGlobalObjectValue(arg, globalAliases));
}

function isSafeGlobalObjectReadCall(record: Record<string, unknown>, globalAliases = new Set<string>()): boolean {
	const reflectCall = reflectedBuiltinCall(record, "Reflect", new Set(["get"]), globalAliases);
	if (reflectCall && !reflectCall.unknownApply) {
		const reflectedProperty = reflectedPropertyKeyName(reflectCall.args[1]);
		return (
			reflectedProperty !== null &&
			isGlobalObjectExpression(reflectCall.args[0], globalAliases) &&
			!isUnsafeGlobalReflectedProperty(reflectedProperty)
		);
	}
	const objectCall = reflectedBuiltinCall(record, "Object", new Set(["getOwnPropertyDescriptor"]), globalAliases);
	if (!objectCall || objectCall.unknownApply) return false;
	const reflectedProperty = reflectedPropertyKeyName(objectCall.args[1]);
	return (
		reflectedProperty !== null &&
		isGlobalObjectExpression(objectCall.args[0], globalAliases) &&
		!isUnsafeGlobalReflectedProperty(reflectedProperty)
	);
}

function isFunctionLikeExpression(record: Record<string, unknown>): boolean {
	return (
		record.type === "FunctionDeclaration" ||
		record.type === "FunctionExpression" ||
		record.type === "ArrowFunctionExpression" ||
		record.type === "ObjectMethod" ||
		record.type === "ClassMethod" ||
		record.type === "ClassPrivateMethod"
	);
}

function aliasesWithoutBoundParams(aliases: Set<string>, params: unknown[]): Set<string> {
	let narrowed: Set<string> | null = null;
	for (const alias of aliases) {
		if (!params.some(param => patternBindsIdentifier(param, alias))) continue;
		if (!narrowed) narrowed = new Set(aliases);
		narrowed.delete(alias);
	}
	return narrowed ?? aliases;
}

function functionExposesProcessValue(
	record: Record<string, unknown>,
	processAliases: Set<string>,
	globalAliases: Set<string>,
	shadowBareProcess = false,
): boolean {
	const params = Array.isArray(record.params) ? record.params : [];
	const nestedProcessAliases = aliasesWithoutBoundParams(processAliases, params);
	const nestedGlobalAliases = aliasesWithoutBoundParams(globalAliases, params);
	const shadowsProcess = shadowBareProcess || params.some(param => patternBindsIdentifier(param, "process"));
	const body = record.body;
	if (!body || typeof body !== "object") return false;
	const scopedGlobalAliases = collectGlobalAliases(body, new Set(nestedGlobalAliases));
	const scopedProcessAliases = collectProcessAliases(
		body,
		new Set(nestedProcessAliases),
		scopedGlobalAliases,
		shadowsProcess,
	);
	const bodyRecord = body as Record<string, unknown>;
	if (bodyRecord.type !== "BlockStatement")
		return containsProcessValue(body, scopedProcessAliases, scopedGlobalAliases, shadowsProcess);
	const statements = Array.isArray(bodyRecord.body) ? bodyRecord.body : [];
	return statements.some(statement =>
		returnStatementExposesProcess(statement, scopedProcessAliases, scopedGlobalAliases, shadowsProcess),
	);
}

function returnStatementExposesProcess(
	node: unknown,
	processAliases: Set<string>,
	globalAliases: Set<string>,
	shadowBareProcess: boolean,
): boolean {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (isFunctionLikeExpression(record)) return false;
	if (record.type === "ReturnStatement")
		return containsProcessValue(record.argument, processAliases, globalAliases, shadowBareProcess);
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end") continue;
		if (returnStatementExposesProcess(value, processAliases, globalAliases, shadowBareProcess)) return true;
	}
	return false;
}

function functionExposesGlobalObjectValue(record: Record<string, unknown>, globalAliases: Set<string>): boolean {
	const params = Array.isArray(record.params) ? record.params : [];
	const nestedGlobalAliases = aliasesWithoutBoundParams(globalAliases, params);
	const body = record.body;
	if (!body || typeof body !== "object") return false;
	const scopedGlobalAliases = collectGlobalAliases(body, new Set(nestedGlobalAliases));
	const bodyRecord = body as Record<string, unknown>;
	if (bodyRecord.type !== "BlockStatement") return containsGlobalObjectValue(body, scopedGlobalAliases);
	const statements = Array.isArray(bodyRecord.body) ? bodyRecord.body : [];
	return statements.some(statement => returnStatementExposesGlobalObject(statement, scopedGlobalAliases));
}

function returnStatementExposesGlobalObject(node: unknown, globalAliases: Set<string>): boolean {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (isFunctionLikeExpression(record)) return false;
	if (record.type === "ReturnStatement") return containsGlobalObjectValue(record.argument, globalAliases);
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end") continue;
		if (returnStatementExposesGlobalObject(value, globalAliases)) return true;
	}
	return false;
}

function patternBindsIdentifier(node: unknown, name: string): boolean {
	if (isIdentifierNamed(node, name)) return true;
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (record.type === "AssignmentPattern") return patternBindsIdentifier(record.left, name);
	if (record.type === "RestElement") return patternBindsIdentifier(record.argument, name);
	if (record.type === "ObjectProperty") return patternBindsIdentifier(record.value, name);
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end" || key === "right") continue;
		if (patternBindsIdentifier(value, name)) return true;
	}
	return false;
}

function parameterDefaultContainsProcessValue(
	node: unknown,
	processAliases: Set<string>,
	globalAliases: Set<string>,
	shadowBareProcess = false,
): boolean {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (record.type === "AssignmentPattern")
		return containsProcessValue(record.right, processAliases, globalAliases, shadowBareProcess);
	if (record.type === "ObjectProperty")
		return parameterDefaultContainsProcessValue(record.value, processAliases, globalAliases, shadowBareProcess);
	if (record.type === "RestElement") return false;
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end" || key === "key") continue;
		if (parameterDefaultContainsProcessValue(value, processAliases, globalAliases, shadowBareProcess)) return true;
	}
	return false;
}

function parameterDefaultContainsGlobalObjectValue(node: unknown, globalAliases: Set<string>): boolean {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (record.type === "AssignmentPattern") return containsGlobalObjectValue(record.right, globalAliases);
	if (record.type === "ObjectProperty") return parameterDefaultContainsGlobalObjectValue(record.value, globalAliases);
	if (record.type === "RestElement") return false;
	for (const [key, value] of Object.entries(record)) {
		if (key === "loc" || key === "start" || key === "end" || key === "key") continue;
		if (parameterDefaultContainsGlobalObjectValue(value, globalAliases)) return true;
	}
	return false;
}

function containsProcessContainerValue(
	node: unknown,
	processAliases: Set<string>,
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
): boolean {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (record.type !== "SpreadElement" && record.type !== "ArrayExpression" && record.type !== "ObjectExpression")
		return false;
	return containsProcessValue(record, processAliases, globalAliases, shadowBareProcess);
}

function containsGlobalObjectContainerValue(node: unknown, globalAliases = new Set<string>()): boolean {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (record.type !== "SpreadElement" && record.type !== "ArrayExpression" && record.type !== "ObjectExpression")
		return false;
	return containsGlobalObjectValue(record, globalAliases);
}

function containsGlobalObjectValue(node: unknown, globalAliases = new Set<string>()): boolean {
	if (isGlobalObjectExpression(node, globalAliases)) return true;
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (
		record.type === "CallExpression" ||
		record.type === "OptionalCallExpression" ||
		record.type === "NewExpression"
	) {
		if (isGlobalObjectWrapperExpression(record, globalAliases)) return true;
		const callee = record.callee;
		return callee && typeof callee === "object"
			? isFunctionLikeExpression(callee as Record<string, unknown>) &&
					functionExposesGlobalObjectValue(callee as Record<string, unknown>, globalAliases)
			: false;
	}
	if (record.type === "SpreadElement") return containsGlobalObjectValue(record.argument, globalAliases);
	if (record.type === "ArrayExpression" && Array.isArray(record.elements))
		return record.elements.some(element => containsGlobalObjectValue(element, globalAliases));
	if (isFunctionLikeExpression(record)) return functionExposesGlobalObjectValue(record, globalAliases);
	if (record.type === "ObjectExpression" && Array.isArray(record.properties)) {
		return record.properties.some(property => {
			if (!property || typeof property !== "object") return false;
			const propertyRecord = property as Record<string, unknown>;
			if (propertyRecord.type === "SpreadElement")
				return containsGlobalObjectValue(propertyRecord.argument, globalAliases);
			return containsGlobalObjectValue(propertyRecord.value, globalAliases);
		});
	}
	return false;
}

function containsSensitiveReflectionObjectValue(node: unknown, globalAliases = new Set<string>()): boolean {
	if (!node || typeof node !== "object") return false;
	const unwrapped = unwrapStaticExpression(node);
	if (
		isSensitiveReflectionMethodExpression(unwrapped, globalAliases) ||
		isSensitiveReflectionMethodBindExpression(unwrapped, globalAliases) ||
		isSensitiveBuiltinObjectExpression(unwrapped, "Reflect", globalAliases) ||
		isSensitiveBuiltinObjectExpression(unwrapped, "Object", globalAliases)
	)
		return true;
	if (!unwrapped || typeof unwrapped !== "object") return false;
	const record = unwrapped as Record<string, unknown>;
	if (record.type === "SpreadElement") return containsSensitiveReflectionObjectValue(record.argument, globalAliases);
	if (record.type === "ArrayExpression" && Array.isArray(record.elements))
		return record.elements.some(element => containsSensitiveReflectionObjectValue(element, globalAliases));
	if (record.type === "ObjectExpression" && Array.isArray(record.properties)) {
		return record.properties.some(property => {
			if (!property || typeof property !== "object") return false;
			const propertyRecord = property as Record<string, unknown>;
			if (propertyRecord.type === "SpreadElement")
				return containsSensitiveReflectionObjectValue(propertyRecord.argument, globalAliases);
			return containsSensitiveReflectionObjectValue(propertyRecord.value, globalAliases);
		});
	}
	return false;
}

function isProcessBindingPattern(
	pattern: unknown,
	init: unknown,
	processAliases: Set<string>,
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
): boolean {
	if (
		!isProcessExpression(init, processAliases, globalAliases, shadowBareProcess) ||
		!pattern ||
		typeof pattern !== "object"
	)
		return false;
	const record = pattern as Record<string, unknown>;
	if (record.type !== "ObjectPattern" || !Array.isArray(record.properties)) return false;
	return record.properties.some(property => {
		if (!property || typeof property !== "object") return false;
		const propertyRecord = property as Record<string, unknown>;
		if (propertyRecord.type === "RestElement") return true;
		const key = propertyRecord.key;
		return isUnsafeProcessStaticProperty(key);
	});
}

function isGlobalProcessBindingPattern(pattern: unknown, init: unknown, globalAliases = new Set<string>()): boolean {
	if (!isGlobalObjectExpression(init, globalAliases) || !pattern || typeof pattern !== "object") return false;
	const record = pattern as Record<string, unknown>;
	if (record.type !== "ObjectPattern" || !Array.isArray(record.properties)) return false;
	return record.properties.some(property => {
		if (!property || typeof property !== "object") return false;
		const propertyRecord = property as Record<string, unknown>;
		if (propertyRecord.type === "RestElement") return true;
		if (staticPropertyKeyName(propertyRecord.key) !== "process") return false;
		const value = unwrapAssignmentPattern(propertyRecord.value);
		if (!value || typeof value !== "object") return false;
		const valueRecord = value as Record<string, unknown>;
		if (valueRecord.type !== "ObjectPattern" || !Array.isArray(valueRecord.properties)) return false;
		return valueRecord.properties.some(nestedProperty => {
			if (!nestedProperty || typeof nestedProperty !== "object") return false;
			const nestedRecord = nestedProperty as Record<string, unknown>;
			if (nestedRecord.type === "RestElement") return true;
			return isUnsafeProcessStaticProperty(nestedRecord.key);
		});
	});
}

function isUnsafeProcessStaticProperty(key: unknown): boolean {
	const property = staticPropertyKeyName(key);
	return property === "binding" || property === "dlopen" || property === "getBuiltinModule";
}
function isGlobalProcessDestructurePattern(
	pattern: unknown,
	init: unknown,
	globalAliases = new Set<string>(),
): boolean {
	if (!isGlobalObjectExpression(init, globalAliases) || !pattern || typeof pattern !== "object") return false;
	const record = pattern as Record<string, unknown>;
	if (record.type !== "ObjectPattern" || !Array.isArray(record.properties)) return false;
	return record.properties.some(property => {
		if (!property || typeof property !== "object") return false;
		const propertyRecord = property as Record<string, unknown>;
		return (
			staticPropertyKeyName(propertyRecord.key) === "process" &&
			bindingTargetIdentifierName(propertyRecord.value) !== null
		);
	});
}

function isGlobalRuntimeDestructurePattern(
	pattern: unknown,
	init: unknown,
	globalAliases = new Set<string>(),
): boolean {
	if (!isGlobalObjectExpression(init, globalAliases) || !pattern || typeof pattern !== "object") return false;
	const record = pattern as Record<string, unknown>;
	if (record.type !== "ObjectPattern" || !Array.isArray(record.properties)) return false;
	return record.properties.some(property => {
		if (!property || typeof property !== "object") return false;
		const propertyRecord = property as Record<string, unknown>;
		if (propertyRecord.type === "RestElement") return true;
		const key = staticPropertyKeyName(propertyRecord.key);
		return key === "Bun" || key === "Deno";
	});
}

function isGlobalObjectDestructurePattern(pattern: unknown, init: unknown, globalAliases = new Set<string>()): boolean {
	if (!isGlobalObjectExpression(init, globalAliases) || !pattern || typeof pattern !== "object") return false;
	const record = pattern as Record<string, unknown>;
	if (record.type !== "ObjectPattern" || !Array.isArray(record.properties)) return false;
	return record.properties.some(property => {
		if (!property || typeof property !== "object") return false;
		const propertyRecord = property as Record<string, unknown>;
		if (propertyRecord.type === "RestElement") return true;
		const key = staticPropertyKeyName(propertyRecord.key);
		return key === "globalThis" || key === "global";
	});
}

function addGlobalProcessDestructureAliases(pattern: unknown, aliases: Set<string>): void {
	if (!pattern || typeof pattern !== "object") return;
	const record = pattern as Record<string, unknown>;
	if (record.type !== "ObjectPattern" || !Array.isArray(record.properties)) return;
	for (const property of record.properties) {
		if (!property || typeof property !== "object") continue;
		const propertyRecord = property as Record<string, unknown>;
		if (staticPropertyKeyName(propertyRecord.key) !== "process") continue;
		const aliasName = bindingTargetIdentifierName(propertyRecord.value);
		if (aliasName) aliases.add(aliasName);
	}
}

function bindingTargetIdentifierName(node: unknown): string | null {
	if (isIdentifierNode(node)) return String((node as Record<string, unknown>).name);
	if (!node || typeof node !== "object") return null;
	const record = node as Record<string, unknown>;
	if (record.type === "AssignmentPattern") return bindingTargetIdentifierName(record.left);
	return null;
}

function unwrapAssignmentPattern(node: unknown): unknown {
	if (!node || typeof node !== "object") return node;
	const record = node as Record<string, unknown>;
	return record.type === "AssignmentPattern" ? record.left : node;
}

function unwrapStaticExpression(node: unknown): unknown {
	if (!node || typeof node !== "object") return node;
	const record = node as Record<string, unknown>;
	if (record.type === "SequenceExpression" && Array.isArray(record.expressions)) {
		return unwrapStaticExpression(record.expressions.at(-1));
	}
	if (
		record.type === "ParenthesizedExpression" ||
		record.type === "ChainExpression" ||
		record.type === "TSAsExpression" ||
		record.type === "TSTypeAssertion" ||
		record.type === "TSNonNullExpression"
	) {
		return unwrapStaticExpression(record.expression);
	}
	return node;
}

function isGlobalObjectExpression(node: unknown, globalAliases = new Set<string>()): boolean {
	const unwrapped = unwrapStaticExpression(node);
	if (isIdentifierNamed(unwrapped, "globalThis") || isIdentifierNamed(unwrapped, "global")) return true;
	const name = identifierName(unwrapped);
	if (name && globalAliases.has(name)) return true;
	if (!unwrapped || typeof unwrapped !== "object") return false;
	const record = unwrapped as Record<string, unknown>;
	if (isGlobalObjectWrapperExpression(record, globalAliases)) return true;
	if (isMemberLikeNode(record) && isGlobalObjectExpression(record.object, globalAliases)) {
		const property = staticMemberPropertyName(record);
		if (property === "globalThis" || property === "global") return true;
	}
	return false;
}

function isGlobalObjectWrapperExpression(record: Record<string, unknown>, globalAliases = new Set<string>()): boolean {
	if (record.type !== "CallExpression" && record.type !== "OptionalCallExpression" && record.type !== "NewExpression")
		return false;
	const args = Array.isArray(record.arguments) ? record.arguments : [];
	const callee = record.callee;
	if (isIdentifierNamed(callee, "Object")) return isGlobalObjectExpression(args[0], globalAliases);
	if (!callee || typeof callee !== "object") return false;
	const calleeRecord = callee as Record<string, unknown>;
	return (
		isMemberLikeNode(calleeRecord) &&
		isIdentifierNamed(calleeRecord.object, "Object") &&
		staticMemberPropertyName(calleeRecord) === "create" &&
		isGlobalObjectExpression(args[0], globalAliases)
	);
}

function isGlobalRuntimeObjectExpression(node: unknown, globalAliases = new Set<string>()): boolean {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (isReflectGlobalRuntimeLookup(record, globalAliases)) return true;
	if (isGlobalRuntimeDescriptorProperty(record, globalAliases)) return true;
	if (!isMemberLikeNode(record) || !isGlobalObjectExpression(record.object, globalAliases)) return false;
	const property = staticMemberPropertyName(record);
	return property === "Bun" || property === "Deno";
}

function isProcessExpression(
	node: unknown,
	processAliases: Set<string>,
	globalAliases = new Set<string>(),
	shadowBareProcess = false,
): boolean {
	if (!node || typeof node !== "object") return false;
	const record = node as Record<string, unknown>;
	if (isIdentifierNamed(record, "process")) return processAliases.has("process") || !shadowBareProcess;
	const name = identifierName(record);
	if (name && processAliases.has(name)) return true;
	if (record.type === "LogicalExpression")
		return (
			isProcessExpression(record.left, processAliases, globalAliases, shadowBareProcess) ||
			isProcessExpression(record.right, processAliases, globalAliases, shadowBareProcess)
		);
	if (record.type === "ConditionalExpression")
		return (
			isProcessExpression(record.consequent, processAliases, globalAliases, shadowBareProcess) ||
			isProcessExpression(record.alternate, processAliases, globalAliases, shadowBareProcess)
		);
	if (record.type === "SequenceExpression" && Array.isArray(record.expressions))
		return isProcessExpression(record.expressions.at(-1), processAliases, globalAliases, shadowBareProcess);
	if (
		record.type === "ParenthesizedExpression" ||
		record.type === "ChainExpression" ||
		record.type === "TSAsExpression" ||
		record.type === "TSTypeAssertion" ||
		record.type === "TSNonNullExpression"
	)
		return isProcessExpression(record.expression, processAliases, globalAliases, shadowBareProcess);
	if (isReflectGlobalProcessLookup(record, globalAliases)) return true;
	if (!isMemberLikeNode(record)) return false;
	return isGlobalObjectExpression(record.object, globalAliases) && staticMemberPropertyName(record) === "process";
}

function isReflectGlobalProcessLookup(record: Record<string, unknown>, globalAliases = new Set<string>()): boolean {
	const reflectCall = reflectedBuiltinCall(record, "Reflect", new Set(["get"]), globalAliases);
	if (!reflectCall) return false;
	if (reflectCall.unknownApply) return true;
	return (
		isGlobalObjectExpression(reflectCall.args[0], globalAliases) &&
		isUnsafeGlobalReflectedProperty(reflectedPropertyKeyName(reflectCall.args[1]))
	);
}

function isReflectGlobalRuntimeLookup(record: Record<string, unknown>, globalAliases = new Set<string>()): boolean {
	const reflectCall = reflectedBuiltinCall(
		record,
		"Reflect",
		new Set(["get", "getOwnPropertyDescriptor"]),
		globalAliases,
	);
	if (!reflectCall) return false;
	if (reflectCall.unknownApply) return true;
	const property = reflectedPropertyKeyName(reflectCall.args[1]);
	return isGlobalObjectExpression(reflectCall.args[0], globalAliases) && isUnsafeGlobalReflectedProperty(property);
}

function isGlobalRuntimeDescriptorProperty(
	record: Record<string, unknown>,
	globalAliases = new Set<string>(),
): boolean {
	if (!isMemberLikeNode(record)) return false;
	const property = staticMemberPropertyName(record);
	if (property !== "Bun" && property !== "Deno") return false;
	const object = record.object;
	if (!object || typeof object !== "object") return false;
	const objectRecord = object as Record<string, unknown>;
	if (objectRecord.type !== "CallExpression" && objectRecord.type !== "OptionalCallExpression") return false;
	const callee = objectRecord.callee;
	if (!callee || typeof callee !== "object") return false;
	const member = callee as Record<string, unknown>;
	if (!isMemberLikeNode(member) || identifierName(member.object) !== "Object") return false;
	if (staticMemberPropertyName(member) !== "getOwnPropertyDescriptors") return false;
	const args = Array.isArray(objectRecord.arguments) ? objectRecord.arguments : [];
	return isGlobalObjectExpression(args[0], globalAliases);
}

function isUnsafeGlobalObjectReflectionCall(
	record: Record<string, unknown>,
	globalAliases = new Set<string>(),
): boolean {
	const objectCall = reflectedBuiltinCall(
		record,
		"Object",
		new Set(["values", "entries", "assign", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]),
		globalAliases,
	);
	if (!objectCall) return false;
	if (objectCall.unknownApply) return true;
	if (objectCall.method === "assign") return objectCall.args.some(arg => isGlobalObjectExpression(arg, globalAliases));

	if (!isGlobalObjectExpression(objectCall.args[0], globalAliases)) return false;
	if (
		objectCall.method === "values" ||
		objectCall.method === "entries" ||
		objectCall.method === "getOwnPropertyDescriptors"
	)
		return true;
	if (objectCall.method !== "getOwnPropertyDescriptor") return false;
	const reflectedProperty = reflectedPropertyKeyName(objectCall.args[1]);
	return isUnsafeGlobalReflectedProperty(reflectedProperty);
}

function isSensitiveReflectionMethodExpression(node: unknown, globalAliases = new Set<string>()): boolean {
	const unwrapped = unwrapStaticExpression(node);
	if (!unwrapped || typeof unwrapped !== "object") return false;
	const record = unwrapped as Record<string, unknown>;
	if (!isMemberLikeNode(record)) return false;
	const property = staticMemberPropertyName(record);
	return (
		(isSensitiveBuiltinObjectExpression(record.object, "Reflect", globalAliases) &&
			(property === "get" || property === "getOwnPropertyDescriptor")) ||
		(isSensitiveBuiltinObjectExpression(record.object, "Object", globalAliases) &&
			(property === "values" ||
				property === "entries" ||
				property === "assign" ||
				property === "getOwnPropertyDescriptor" ||
				property === "getOwnPropertyDescriptors"))
	);
}

function isSensitiveReflectionMethodDestructurePattern(
	pattern: unknown,
	init: unknown,
	globalAliases = new Set<string>(),
): boolean {
	if (!pattern || typeof pattern !== "object" || !init || typeof init !== "object") return false;
	const objectName = isSensitiveBuiltinObjectExpression(init, "Reflect", globalAliases)
		? "Reflect"
		: isSensitiveBuiltinObjectExpression(init, "Object", globalAliases)
			? "Object"
			: null;
	if (objectName === null) return false;
	const record = pattern as Record<string, unknown>;
	if (record.type !== "ObjectPattern" || !Array.isArray(record.properties)) return false;
	return record.properties.some(property => {
		if (!property || typeof property !== "object") return false;
		const propertyRecord = property as Record<string, unknown>;
		if (propertyRecord.type === "RestElement") return true;
		const key = staticPropertyKeyName(propertyRecord.key);
		return (
			(objectName === "Reflect" && (key === "get" || key === "getOwnPropertyDescriptor")) ||
			(objectName === "Object" &&
				(key === "values" ||
					key === "entries" ||
					key === "assign" ||
					key === "getOwnPropertyDescriptor" ||
					key === "getOwnPropertyDescriptors"))
		);
	});
}

function isSensitiveBuiltinObjectExpression(
	node: unknown,
	objectName: "Object" | "Reflect",
	globalAliases = new Set<string>(),
): boolean {
	const unwrapped = unwrapStaticExpression(node);
	if (isIdentifierNamed(unwrapped, objectName)) return true;
	if (!unwrapped || typeof unwrapped !== "object") return false;
	const record = unwrapped as Record<string, unknown>;
	return (
		isMemberLikeNode(record) &&
		isGlobalObjectExpression(record.object, globalAliases) &&
		staticMemberPropertyName(record) === objectName
	);
}

function isSensitiveReflectionMethodBindExpression(node: unknown, globalAliases = new Set<string>()): boolean {
	return (
		boundSensitiveReflectionMethod(node, "Reflect", new Set(["get", "getOwnPropertyDescriptor"]), globalAliases) !==
			null ||
		boundSensitiveReflectionMethod(
			node,
			"Object",
			new Set(["values", "entries", "assign", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]),
			globalAliases,
		) !== null
	);
}

function isClassFieldRecord(record: Record<string, unknown>): boolean {
	return (
		record.type === "ClassProperty" ||
		record.type === "ClassPrivateProperty" ||
		record.type === "PropertyDefinition" ||
		record.type === "ClassAccessorProperty"
	);
}

function boundSensitiveReflectionMethod(
	node: unknown,
	objectName: "Object" | "Reflect",
	methods: Set<string>,
	globalAliases = new Set<string>(),
): string | null {
	const unwrapped = unwrapStaticExpression(node);
	if (!unwrapped || typeof unwrapped !== "object") return null;
	const record = unwrapped as Record<string, unknown>;
	if (record.type !== "CallExpression" && record.type !== "OptionalCallExpression") return null;
	const callee = unwrapStaticExpression(record.callee);
	if (!callee || typeof callee !== "object") return null;
	const member = callee as Record<string, unknown>;
	if (!isMemberLikeNode(member) || staticMemberPropertyName(member) !== "bind") return null;
	const target = unwrapStaticExpression(member.object);
	if (!target || typeof target !== "object") return null;
	const targetMember = target as Record<string, unknown>;
	if (
		!isMemberLikeNode(targetMember) ||
		!isSensitiveBuiltinObjectExpression(targetMember.object, objectName, globalAliases)
	)
		return null;
	const method = staticMemberPropertyName(targetMember);
	return method && methods.has(method) ? method : null;
}

function sensitiveReflectionTargetMethod(
	node: unknown,
	objectName: "Object" | "Reflect",
	methods: Set<string>,
	globalAliases = new Set<string>(),
): string | null {
	const boundMethod = boundSensitiveReflectionMethod(node, objectName, methods, globalAliases);
	if (boundMethod) return boundMethod;
	const unwrapped = unwrapStaticExpression(node);
	if (!unwrapped || typeof unwrapped !== "object") return null;
	const record = unwrapped as Record<string, unknown>;
	if (!isMemberLikeNode(record) || !isSensitiveBuiltinObjectExpression(record.object, objectName, globalAliases)) {
		return null;
	}
	const method = staticMemberPropertyName(record);
	return method && methods.has(method) ? method : null;
}

function reflectedBuiltinCall(
	record: Record<string, unknown>,
	objectName: "Object" | "Reflect",
	methods: Set<string>,
	globalAliases = new Set<string>(),
): { method: string; args: unknown[]; unknownApply?: boolean } | null {
	if (record.type !== "CallExpression" && record.type !== "OptionalCallExpression") return null;
	const callee = unwrapStaticExpression(record.callee);
	if (!callee || typeof callee !== "object") return null;
	const boundMethod = boundSensitiveReflectionMethod(callee, objectName, methods, globalAliases);
	if (boundMethod) {
		const args = Array.isArray(record.arguments) ? record.arguments : [];
		return { method: boundMethod, args };
	}
	const member = callee as Record<string, unknown>;
	if (!isMemberLikeNode(member)) return null;
	const directMethod = staticMemberPropertyName(member);
	const rawArgs = Array.isArray(record.arguments) ? record.arguments : [];
	if (isSensitiveBuiltinObjectExpression(member.object, "Reflect", globalAliases) && directMethod === "apply") {
		const method = sensitiveReflectionTargetMethod(rawArgs[0], objectName, methods, globalAliases);
		if (!method) return null;
		const applyArgs = rawArgs[2];
		if (
			!applyArgs ||
			typeof applyArgs !== "object" ||
			(applyArgs as Record<string, unknown>).type !== "ArrayExpression"
		)
			return { method, args: [], unknownApply: true };
		const elements = (applyArgs as Record<string, unknown>).elements;
		return { method, args: Array.isArray(elements) ? elements : [] };
	}
	if (
		isSensitiveBuiltinObjectExpression(member.object, objectName, globalAliases) &&
		directMethod &&
		methods.has(directMethod)
	) {
		return { method: directMethod, args: rawArgs };
	}
	if (directMethod !== "call" && directMethod !== "apply") return null;
	const method = sensitiveReflectionTargetMethod(member.object, objectName, methods, globalAliases);
	if (!method) return null;
	if (directMethod === "call") return { method, args: rawArgs.slice(1) };
	const applyArgs = rawArgs[1];
	if (!applyArgs || typeof applyArgs !== "object" || (applyArgs as Record<string, unknown>).type !== "ArrayExpression")
		return { method, args: [], unknownApply: true };
	const elements = (applyArgs as Record<string, unknown>).elements;
	return { method, args: Array.isArray(elements) ? elements : [] };
}

function isMemberLikeNode(record: Record<string, unknown>): boolean {
	return record.type === "MemberExpression" || record.type === "OptionalMemberExpression";
}

function isNonComputedMemberProperty(record: Record<string, unknown>, key: string): boolean {
	return key === "property" && isMemberLikeNode(record) && record.computed !== true;
}

function staticMemberPropertyName(record: Record<string, unknown>): string | null {
	return staticPropertyKeyName(record.property);
}

function reflectedPropertyKeyName(node: unknown): string | null {
	if (isIdentifierNode(node)) return null;
	return staticPropertyKeyName(node);
}

function staticPropertyKeyName(node: unknown): string | null {
	if (!node || typeof node !== "object") return null;
	const record = node as Record<string, unknown>;
	if (typeof record.name === "string") return record.name;
	if (typeof record.value === "string") return record.value;
	return null;
}

function isIdentifierNode(node: unknown): boolean {
	return !!node && typeof node === "object" && (node as Record<string, unknown>).type === "Identifier";
}

function isIdentifierNamed(node: unknown, name: string): boolean {
	return isIdentifierNode(node) && (node as Record<string, unknown>).name === name;
}

function identifierName(node: unknown): string | null {
	return isIdentifierNode(node) ? String((node as Record<string, unknown>).name) : null;
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

async function resolveVerifierRuntimePath(
	scriptValue: string,
	runtimePath: string,
	projectCwd: string,
	projectRootReal: string,
): Promise<string> {
	const runtimeToken = tokenizeVerifierScript(scriptValue)[0] ?? "";
	if (
		!runtimeToken ||
		runtimeToken !== path.basename(runtimeToken) ||
		runtimeToken.includes("/") ||
		runtimeToken.includes("\\")
	)
		throw new Error("verifier runtime must be a bare executable name");
	for (const segment of runtimePath.split(path.delimiter)) {
		if (!segment) continue;
		const candidate = path.join(segment, runtimeToken);
		try {
			const stat = await fs.stat(candidate);
			if (!stat.isFile()) continue;
			await fs.access(candidate, nodeFs.constants.X_OK);
			const realCandidate = await fs.realpath(candidate);
			if (isUnsafeVerifierRuntimeLocation(realCandidate, projectCwd, projectRootReal)) continue;
			return realCandidate;
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				(error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES" || error.code === "EPERM")
			)
				continue;
			throw error;
		}
	}
	throw new Error(`verifier runtime ${runtimeToken} could not be resolved from sanitized PATH`);
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
	return rawPath
		.split(path.delimiter)
		.filter(segment => segment.length > 0 && path.isAbsolute(segment))
		.filter(segment => !isUnsafeVerifierRuntimeLocation(segment, projectCwd, projectRootReal))
		.join(path.delimiter);
}

function isUnsafeVerifierRuntimeLocation(targetPath: string, projectCwd: string, projectRootReal: string): boolean {
	if (!path.isAbsolute(targetPath)) return true;
	const normalizedRoots = [
		...new Set(
			[path.resolve(projectCwd), path.resolve(projectRootReal), ...normalizedPathAliases(projectRootReal)].map(
				root => root.toLowerCase(),
			),
		),
	];
	const normalizedSegments = normalizedPathAliases(targetPath).map(candidate => candidate.toLowerCase());
	if (
		normalizedSegments.some(normalizedSegment =>
			normalizedRoots.some(
				normalizedRoot =>
					normalizedSegment === normalizedRoot || normalizedSegment.startsWith(`${normalizedRoot}${path.sep}`),
			),
		)
	)
		return true;
	return normalizedSegments.some(normalizedSegment => normalizedSegment.split(path.sep).includes("node_modules"));
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
	for (const [index, command] of commands.entries()) {
		const snapshot = verifierScripts[index];
		let started = Date.now();
		const beforeReason = await verifierScriptsChanged(verifierScripts);
		if (beforeReason) {
			results.push(verifierError(command, beforeReason, started));
			break;
		}
		results.push(await runCommand(command, cwd, snapshot));
		started = Date.now();
		const afterReason = await verifierScriptsChanged(verifierScripts);
		if (afterReason) {
			results.push(verifierError(command, afterReason, started));
			break;
		}
	}
	return results;
}

async function runCommand(
	command: LoopCommandSpec,
	cwd: string,
	snapshot?: VerifierScriptSnapshot,
): Promise<LoopVerifierResult> {
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
		const runtimePath =
			snapshot?.runtimePath ||
			(await resolveVerifierRuntimePath(script.scriptValue, verifierRuntimePath(cwd, rootReal), cwd, rootReal));
		verifierArgv[0] = runtimePath;
		const proc = Bun.spawn(verifierArgv, {
			cwd: commandCwd,
			env: verifierRuntimeEnv(cwd, rootReal),
			stdout: "pipe",
			stderr: "pipe",
		});
		let sigkillTimer: NodeJS.Timeout | undefined;
		const outputPromise = Promise.all([readLimited(proc.stdout), readLimited(proc.stderr), proc.exited]);
		const timeout = Promise.withResolvers<"timeout">();
		const killTimer: NodeJS.Timeout = setTimeout(() => {
			proc.kill("SIGTERM");
			sigkillTimer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
			timeout.resolve("timeout");
		}, VERIFIER_TIMEOUT_MS);
		const result = await Promise.race([outputPromise, timeout.promise]);
		clearTimeout(killTimer);
		if (result === "timeout") {
			const exitWait = Promise.withResolvers<void>();
			const abandonTimer = setTimeout(() => {
				proc.kill("SIGKILL");
				exitWait.resolve();
			}, 2_000);
			outputPromise.then(
				() => exitWait.resolve(),
				() => exitWait.resolve(),
			);
			await exitWait.promise;
			clearTimeout(abandonTimer);
			if (sigkillTimer) clearTimeout(sigkillTimer);
			return {
				command: command.argv,
				exitCode: null,
				stdout: "",
				stderr: `Verifier timed out after ${VERIFIER_TIMEOUT_MS}ms`,
				durationMs: Date.now() - started,
			};
		}
		if (sigkillTimer) clearTimeout(sigkillTimer);
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
		: {
				...script,
				packageJsonPath,
				packageJsonDigest,
				runtimePath: "",
				runtimeDigest: "",
				referencedFiles: [],
				error: null,
			};
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
	if (VERIFIER_UNSAFE_DEPENDENCY_EXTENSIONS.has(path.extname(operand))) return false;
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
	return {
		packageJsonPath: "",
		packageJsonDigest: "",
		scriptName: "",
		scriptValue: "",
		runtimePath: "",
		runtimeDigest: "",
		referencedFiles: [],
		error,
	};
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
		agentOutput: redactAndTruncate(record.agentOutput),
		approvalReasons: record.approvalReasons.map(redactSecrets),
		error: record.error ? redactSecrets(record.error) : null,
		changedFiles: record.changedFiles.map(redactSecrets),
		verifierResults: record.verifierResults.map(result => ({
			...result,
			command: redactCommandArgs(result.command),
			stdout: redactAndTruncate(result.stdout),
			stderr: redactAndTruncate(result.stderr),
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
		.replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*$/g, "[REDACTED_SECRET]")
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
		.replace(/\b(sk-[A-Za-z0-9_-]{3,})\b/g, "[REDACTED_SECRET]")
		.replace(/\b([A-Za-z0-9._%+-]+:[A-Za-z0-9/+=._-]{16,})\b/g, "[REDACTED_SECRET]");
}

function redactAndTruncate(value: string): string {
	return truncate(redactSecrets(value));
}

function truncate(value: string): string {
	return value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}\n[… truncated …]` : value;
}

function escapeRegex(value: string): string {
	return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
