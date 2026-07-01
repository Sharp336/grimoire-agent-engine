import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { SSHConnectionTarget } from "../../ssh/connection-manager";
import type { ToolSession } from "../../tools";
import { splitPathAndSel } from "../../tools/path-utils";
import { resolveSshHostByName } from "../../tools/ssh-host-resolution";
import { ToolError } from "../../tools/tool-errors";
import { EVAL_AGENT_BRIDGE_NAME, runEvalAgent } from "../agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME, type EvalBudgetResult, runEvalBudget } from "../budget-bridge";
import { EVAL_COMPLETION_BRIDGE_NAME, runEvalCompletion } from "../completion-bridge";
import { EVAL_CONCURRENCY_BRIDGE_NAME, type EvalConcurrencyResult, runEvalConcurrency } from "../concurrency-bridge";
import type { JsStatusEvent } from "./shared/types";

export type { JsStatusEvent } from "./shared/types";

export interface ToolBridgeInvocationContext {
	defaultSshHost?: SSHConnectionTarget;
	remoteCwd?: string;
}

interface ToolBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
	invocationContext?: ToolBridgeInvocationContext;
}

type ToolValue =
	| string
	| EvalBudgetResult
	| EvalConcurrencyResult
	| {
			text: string;
			details?: unknown;
			images?: Array<{ mimeType: string; data: string }>;
			hasError?: boolean;
	  };
function toolResultHasError(result: AgentToolResult): boolean {
	if ((result as { isError?: unknown }).isError === true) {
		return true;
	}
	if (!(result.details && typeof result.details === "object")) {
		return false;
	}
	return (result.details as { isError?: unknown }).isError === true;
}

function getTool(session: ToolSession, name: string): AgentTool {
	const tool = session.getToolByName?.(name);
	if (!tool) {
		throw new ToolError(`Unknown tool from js runtime: ${name}`);
	}
	return tool;
}

function normalizeArgs(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return args;
	}
	const record = { ...(args as Record<string, unknown>) };
	if (record[INTENT_FIELD] === undefined) {
		record[INTENT_FIELD] = "js prelude";
	}
	return record;
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const REMOTE_FILE_BRIDGE_TOOLS = new Set(["read", "write", "grep", "copy"]);
const REMOTE_CONTEXT_UNSUPPORTED_TOOLS = new Set(["glob", "ast_grep", "ast_edit", "edit", "lsp", "debug"]);
const REMOTE_BRIDGE_DEFAULT_TOOLS = new Set(["bash", "ssh", ...REMOTE_FILE_BRIDGE_TOOLS]);

function recordArgs(args: unknown): Record<string, unknown> | null {
	if (!args || typeof args !== "object" || Array.isArray(args)) return null;
	return args as Record<string, unknown>;
}

function explicitBridgeHostName(args: Record<string, unknown> | null): string | undefined {
	if (!args || args.host === undefined) return undefined;
	if (typeof args.host !== "string" || args.host.trim().length === 0) {
		throw new ToolError("SSH host must be a non-empty string");
	}
	return args.host.trim();
}

function encodedSshPath(remotePath: string): string {
	const normalized = path.posix.normalize(remotePath);
	const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
	return absolute
		.split("/")
		.map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
		.join("/");
}

function sshUrlForPath(host: SSHConnectionTarget, remotePath: string): string {
	return `ssh://${encodeURIComponent(host.name)}${encodedSshPath(remotePath)}`;
}

function shouldKeepPathLocal(value: string): boolean {
	const trimmed = value.trim();
	return URL_SCHEME_RE.test(trimmed) || trimmed.startsWith("local:/");
}

function rewriteRemotePath(value: string, host: SSHConnectionTarget, remoteCwd: string | undefined): string {
	if (shouldKeepPathLocal(value)) return value;
	const split = splitPathAndSel(value);
	const rawPath = split.path || ".";
	let absolutePath: string;
	if (path.posix.isAbsolute(rawPath)) {
		absolutePath = path.posix.normalize(rawPath);
	} else {
		if (!remoteCwd || !path.posix.isAbsolute(remoteCwd)) {
			throw new ToolError(`Remote tool path "${value}" is relative, but no absolute remote cwd is available`);
		}
		absolutePath = path.posix.resolve(remoteCwd, rawPath);
	}
	const rewritten = sshUrlForPath(host, absolutePath);
	return split.sel ? `${rewritten}:${split.sel}` : rewritten;
}

function resolveRemoteCwd(rawCwd: unknown, defaultCwd: string | undefined): string | undefined {
	if (typeof rawCwd !== "string") return defaultCwd;
	if (path.posix.isAbsolute(rawCwd)) return path.posix.normalize(rawCwd);
	return defaultCwd && path.posix.isAbsolute(defaultCwd) ? path.posix.resolve(defaultCwd, rawCwd) : rawCwd;
}

function rewritePathField(
	record: Record<string, unknown>,
	host: SSHConnectionTarget,
	remoteCwd: string | undefined,
): void {
	if (typeof record.path === "string") {
		record.path = rewriteRemotePath(record.path, host, remoteCwd);
	}
}

function rewritePathsField(
	record: Record<string, unknown>,
	host: SSHConnectionTarget,
	remoteCwd: string | undefined,
): void {
	if (typeof record.paths === "string") {
		record.paths = rewriteRemotePath(record.paths, host, remoteCwd);
		return;
	}
	if (Array.isArray(record.paths)) {
		record.paths = record.paths.map(entry =>
			typeof entry === "string" ? rewriteRemotePath(entry, host, remoteCwd) : entry,
		);
	}
}

function rewriteCopyFields(
	record: Record<string, unknown>,
	host: SSHConnectionTarget,
	remoteCwd: string | undefined,
): void {
	if (typeof record.source !== "string" || typeof record.destination !== "string") {
		throw new ToolError("copy requires source and destination strings for SSH remote execution");
	}
	record.source = rewriteRemotePath(record.source, host, remoteCwd);
	record.destination = rewriteRemotePath(record.destination, host, remoteCwd);
}

async function resolveBridgeHost(
	name: string,
	args: Record<string, unknown> | null,
	options: ToolBridgeOptions,
): Promise<SSHConnectionTarget | undefined> {
	const explicitHost = explicitBridgeHostName(args);
	if (explicitHost && REMOTE_BRIDGE_DEFAULT_TOOLS.has(name)) {
		return await resolveSshHostByName(options.session, explicitHost);
	}
	if (!explicitHost && REMOTE_BRIDGE_DEFAULT_TOOLS.has(name)) {
		return options.invocationContext?.defaultSshHost;
	}
	return undefined;
}

async function applyBridgeInvocationContext(name: string, args: unknown, options: ToolBridgeOptions): Promise<unknown> {
	const record = recordArgs(args);
	const explicitHost = explicitBridgeHostName(record);
	if (explicitHost && REMOTE_CONTEXT_UNSUPPORTED_TOOLS.has(name)) {
		throw new ToolError(`${name} does not support SSH host execution from eval cells yet.`);
	}
	if (options.invocationContext?.defaultSshHost !== undefined && REMOTE_CONTEXT_UNSUPPORTED_TOOLS.has(name)) {
		throw new ToolError(
			`${name} does not support default SSH execution from a remote eval cell yet; call an explicit SSH-capable tool/path instead.`,
		);
	}
	const host = await resolveBridgeHost(name, record, options);
	if (!record || !host) return args;
	const next = { ...record };
	const remoteCwd = resolveRemoteCwd(next.cwd, options.invocationContext?.remoteCwd);
	if (name === "bash" || name === "ssh") {
		next.host = host.name;
		if (next.cwd === undefined && remoteCwd) next.cwd = remoteCwd;
		return next;
	}
	if (name === "read" || name === "write") {
		if (typeof next.path !== "string") {
			throw new ToolError(`${name} requires a path string for SSH remote execution`);
		}
		rewritePathField(next, host, remoteCwd);
		delete next.host;
		delete next.cwd;
		return next;
	}
	if (name === "copy") {
		rewriteCopyFields(next, host, remoteCwd);
		delete next.host;
		delete next.cwd;
		return next;
	}
	if (name === "grep") {
		const paths = next.paths;
		const validPaths =
			typeof paths === "string" ||
			(Array.isArray(paths) && paths.length > 0 && paths.every(entry => typeof entry === "string"));
		if (!validPaths) {
			throw new ToolError(
				"grep requires explicit string paths for SSH remote execution; remote directory recursion is not supported by grep yet",
			);
		}
		rewritePathsField(next, host, remoteCwd);
		delete next.host;
		delete next.cwd;
		return next;
	}
	return args;
}

function summarizeToolResult(
	name: string,
	args: unknown,
	result: AgentToolResult,
	text: string,
	hasError: boolean,
): JsStatusEvent {
	const record = (args && typeof args === "object" ? (args as Record<string, unknown>) : {}) as Record<
		string,
		unknown
	>;
	const details = (
		result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {}
	) as Record<string, unknown>;
	const withError = (event: JsStatusEvent): JsStatusEvent =>
		hasError ? { ...event, hasError: true, error: text.slice(0, 500) } : event;

	switch (name) {
		case "read":
			return withError({ op: "read", path: record.path, chars: text.length, preview: text.slice(0, 500) });
		case "write":
			return withError({
				op: "write",
				path: record.path,
				chars: typeof record.content === "string" ? record.content.length : 0,
			});
		case "grep":
			return withError({
				op: "grep",
				pattern: record.pattern,
				path: record.path,
				count: details.matchCount ?? undefined,
			});
		case "glob":
			return withError({
				op: "glob",
				pattern: record.pattern,
				count: details.fileCount ?? undefined,
				matches: Array.isArray(details.files) ? details.files.slice(0, 20) : undefined,
			});
		case "bash":
			return withError({
				op: "run",
				cmd: record.command,
				code: typeof details.exitCode === "number" ? details.exitCode : undefined,
				output: text.slice(0, 500),
			});
		default:
			return withError({ op: name, chars: text.length });
	}
}

export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	if (name === EVAL_COMPLETION_BRIDGE_NAME) {
		return await runEvalCompletion(args, options);
	}
	if (name === EVAL_AGENT_BRIDGE_NAME) {
		return await runEvalAgent(args, options);
	}
	if (name === EVAL_BUDGET_BRIDGE_NAME) {
		return await runEvalBudget(args, options);
	}
	if (name === EVAL_CONCURRENCY_BRIDGE_NAME) {
		return runEvalConcurrency(args, options);
	}
	const tool = getTool(options.session, name);
	const normalizedArgs = await applyBridgeInvocationContext(name, normalizeArgs(args), options);
	const toolCallId = `js-${name}-${crypto.randomUUID()}`;
	try {
		const result = await tool.execute(toolCallId, normalizedArgs, options.signal);
		const textBlocks = result.content.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		);
		const imageBlocks = result.content.filter(
			(content): content is { type: "image"; mimeType: string; data: string } =>
				content.type === "image" && typeof content.mimeType === "string" && typeof content.data === "string",
		);
		const text = textBlocks.map(block => block.text).join("");
		const hasError = toolResultHasError(result);
		options.emitStatus?.(summarizeToolResult(name, normalizedArgs, result, text, hasError));
		if (result.details === undefined && imageBlocks.length === 0 && !hasError) {
			return text;
		}
		const value: Exclude<ToolValue, string> = {
			text,
			details: result.details,
		};
		if (imageBlocks.length > 0) {
			value.images = imageBlocks.map(block => ({
				mimeType: block.mimeType,
				data: block.data,
			}));
		}
		if (hasError) {
			value.hasError = true;
		}
		return value;
	} catch (error) {
		options.emitStatus?.({
			op: name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
