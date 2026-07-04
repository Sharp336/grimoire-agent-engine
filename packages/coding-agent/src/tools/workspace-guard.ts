import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";

export type WorkspaceGuardAccess = "read" | "mutate";
export type WorkspaceGuardBlockCode = "missing_workspace_binding" | "target_outside_workspace" | "cwd_outside_workspace";
export type WorkspaceGuardPathInput = string | readonly string[] | null | undefined;

export type WorkspaceGuardResolver<TParams, TValue> = (params: TParams) => TValue | Promise<TValue>;
export type WorkspaceGuardValue<TParams, TValue> = TValue | WorkspaceGuardResolver<TParams, TValue>;

export interface WorkspaceGuardToolMetadata<TParams = unknown> {
	access: WorkspaceGuardValue<TParams, WorkspaceGuardAccess | undefined>;
	targetPath?: WorkspaceGuardValue<TParams, WorkspaceGuardPathInput>;
	requestedCwd?: WorkspaceGuardValue<TParams, string | null | undefined>;
}

export interface WorkspaceGuardBindingContext {
	workspaceRoot?: string | null;
	cwd?: string;
	sessionManager?: {
		getCwd?: () => string;
		getWorkspaceRoot?: () => string;
		getHeader?: () => unknown;
	};
}

export interface WorkspaceGuardResolvedContext {
	sessionCwd: string;
	workspaceRoot?: string | null;
}

export interface WorkspaceGuardCheckOptions extends WorkspaceGuardResolvedContext {
	access: WorkspaceGuardAccess;
	toolName: string;
	targetPath?: WorkspaceGuardPathInput;
	requestedCwd?: string | null;
}

interface WorkspaceGuardDecisionBase {
	allowed: boolean;
	access: WorkspaceGuardAccess;
	toolName: string;
	resolvedWorkspaceRoot?: string;
	resolvedTargetPath?: string;
	resolvedTargetPaths?: string[];
	resolvedRequestedCwd?: string;
	message?: string;
}

export interface WorkspaceGuardAllowedDecision extends WorkspaceGuardDecisionBase {
	allowed: true;
}

export interface WorkspaceGuardBlockedDecision extends WorkspaceGuardDecisionBase {
	allowed: false;
	code: WorkspaceGuardBlockCode;
	message: string;
}

export type WorkspaceGuardDecision = WorkspaceGuardAllowedDecision | WorkspaceGuardBlockedDecision;

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any, TTheme = unknown> {
		workspaceGuard?: WorkspaceGuardToolMetadata<Static<TParameters>>;
	}

	interface AgentToolContext {
		workspaceRoot?: string | null;
		cwd?: string;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function getProperty(value: unknown, property: string): unknown {
	if (!isRecord(value)) return undefined;
	return value[property];
}

function getNonEmptyStringProperty(value: unknown, property: string): string | undefined {
	const candidate = getProperty(value, property);
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function workspaceRootFromProvider(value: unknown): string | undefined {
	const getWorkspaceRoot = getProperty(value, "getWorkspaceRoot");
	if (typeof getWorkspaceRoot !== "function") return undefined;

	const result: unknown = getWorkspaceRoot.call(value);
	return typeof result === "string" && result.length > 0 ? result : undefined;
}

function workspaceRootFromUnknown(value: unknown): string | undefined {
	const directRoot = getNonEmptyStringProperty(value, "workspaceRoot");
	if (directRoot) return directRoot;

	const workspaceBinding = getProperty(value, "workspaceBinding");
	const bindingRoot = getNonEmptyStringProperty(workspaceBinding, "workspaceRoot");
	if (bindingRoot) return bindingRoot;

	const metadata = getProperty(value, "metadata");
	const metadataBinding = getProperty(metadata, "workspaceBinding");
	return getNonEmptyStringProperty(metadataBinding, "workspaceRoot");
}

function isPathLookupMiss(error: unknown): boolean {
	const code = getNonEmptyStringProperty(error, "code");
	return code === "ENOENT" || code === "ENOTDIR";
}

function isWorkspaceGuardResolver<TParams, TValue>(
	value: WorkspaceGuardValue<TParams, TValue> | undefined,
): value is WorkspaceGuardResolver<TParams, TValue> {
	return typeof value === "function";
}

function resolveRawPath(rawPath: string, basePath: string): string {
	return path.resolve(basePath, rawPath);
}

function appendMissingSegments(realPrefix: string, missingSegments: readonly string[]): string {
	if (missingSegments.length === 0) return realPrefix;
	return path.join(realPrefix, ...missingSegments);
}

async function canonicalizePossiblyMissingPath(absolutePath: string): Promise<string> {
	let current = path.resolve(absolutePath);
	const missingSegments: string[] = [];

	while (true) {
		try {
			const realPrefix = await fs.realpath(current);
			return appendMissingSegments(realPrefix, [...missingSegments].reverse());
		} catch (error) {
			if (!isPathLookupMiss(error)) throw error;
		}

		try {
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) {
				const linkTarget = await fs.readlink(current);
				const absoluteLinkTarget = path.resolve(path.dirname(current), linkTarget);
				const realLinkTarget = await canonicalizePossiblyMissingPath(absoluteLinkTarget);
				return appendMissingSegments(realLinkTarget, [...missingSegments].reverse());
			}
		} catch (error) {
			if (!isPathLookupMiss(error)) throw error;
		}

		const parent = path.dirname(current);
		if (parent === current) return path.resolve(absolutePath);
		missingSegments.push(path.basename(current));
		current = parent;
	}
}

function isInsideOrSame(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeTargetPaths(targetPath: WorkspaceGuardPathInput): string[] {
	if (!targetPath) return [];
	if (typeof targetPath === "string") return targetPath.length > 0 ? [targetPath] : [];
	return targetPath.filter(item => typeof item === "string" && item.length > 0);
}

function blockedDecision(
	options: WorkspaceGuardCheckOptions,
	code: WorkspaceGuardBlockCode,
	message: string,
	resolved: Partial<WorkspaceGuardDecisionBase>,
): WorkspaceGuardBlockedDecision {
	return {
		allowed: false,
		access: options.access,
		toolName: options.toolName,
		code,
		message,
		...resolved,
	};
}

function allowedDecision(
	options: WorkspaceGuardCheckOptions,
	resolved: Partial<WorkspaceGuardDecisionBase>,
): WorkspaceGuardAllowedDecision {
	return {
		allowed: true,
		access: options.access,
		toolName: options.toolName,
		...resolved,
	};
}

async function resolveGuardValue<TParams, TValue>(
	value: WorkspaceGuardValue<TParams, TValue> | undefined,
	params: TParams,
): Promise<TValue | undefined> {
	if (isWorkspaceGuardResolver(value)) {
		return value(params);
	}
	return value;
}

export function resolveWorkspaceGuardContext(context: WorkspaceGuardBindingContext | undefined): WorkspaceGuardResolvedContext | null {
	if (!context) return null;
	const sessionCwd = context.sessionManager?.getCwd?.() ?? context.cwd;
	if (!sessionCwd) return null;

	const explicitWorkspaceRoot = typeof context.workspaceRoot === "string" && context.workspaceRoot.length > 0
		? context.workspaceRoot
		: undefined;
	const managerWorkspaceRoot = workspaceRootFromProvider(context.sessionManager);
	const headerWorkspaceRoot = workspaceRootFromUnknown(context.sessionManager?.getHeader?.());

	return {
		sessionCwd,
		workspaceRoot: explicitWorkspaceRoot ?? managerWorkspaceRoot ?? headerWorkspaceRoot ?? null,
	};
}

export async function checkWorkspaceGuard(options: WorkspaceGuardCheckOptions): Promise<WorkspaceGuardDecision> {
	if (options.access === "read") {
		return allowedDecision(options, {});
	}

	if (!options.workspaceRoot) {
		return blockedDecision(
			options,
			"missing_workspace_binding",
			`Tool "${options.toolName}" cannot mutate files or run code without a bound workspace.`,
			{},
		);
	}

	let resolvedWorkspaceRoot: string;
	try {
		resolvedWorkspaceRoot = await fs.realpath(options.workspaceRoot);
	} catch {
		return blockedDecision(
			options,
			"missing_workspace_binding",
			`Tool "${options.toolName}" cannot mutate because the bound workspace is unavailable.`,
			{},
		);
	}

	const requestedCwd = options.requestedCwd ?? options.sessionCwd;
	let resolvedRequestedCwd: string | undefined;
	try {
		resolvedRequestedCwd = await canonicalizePossiblyMissingPath(resolveRawPath(requestedCwd, options.sessionCwd));
	} catch {
		return blockedDecision(
			options,
			"cwd_outside_workspace",
			`Tool "${options.toolName}" requested a working directory that cannot be verified inside the bound workspace.`,
			{ resolvedWorkspaceRoot },
		);
	}

	if (!isInsideOrSame(resolvedWorkspaceRoot, resolvedRequestedCwd)) {
		return blockedDecision(
			options,
			"cwd_outside_workspace",
			`Tool "${options.toolName}" requested a working directory outside the bound workspace.`,
			{ resolvedWorkspaceRoot, resolvedRequestedCwd },
		);
	}

	const rawTargetPaths = normalizeTargetPaths(options.targetPath);
	const resolvedTargetPaths: string[] = [];
	for (const rawTargetPath of rawTargetPaths) {
		let resolvedTargetPath: string;
		try {
			resolvedTargetPath = await canonicalizePossiblyMissingPath(resolveRawPath(rawTargetPath, options.sessionCwd));
		} catch {
			return blockedDecision(
				options,
				"target_outside_workspace",
				`Tool "${options.toolName}" requested a target path that cannot be verified inside the bound workspace.`,
				{ resolvedWorkspaceRoot, resolvedRequestedCwd, resolvedTargetPaths },
			);
		}
		resolvedTargetPaths.push(resolvedTargetPath);

		if (!isInsideOrSame(resolvedWorkspaceRoot, resolvedTargetPath)) {
			return blockedDecision(
				options,
				"target_outside_workspace",
				`Tool "${options.toolName}" requested a target path outside the bound workspace.`,
				{ resolvedWorkspaceRoot, resolvedRequestedCwd, resolvedTargetPath, resolvedTargetPaths },
			);
		}
	}

	const resolved: Partial<WorkspaceGuardDecisionBase> = {
		resolvedWorkspaceRoot,
		resolvedRequestedCwd,
		resolvedTargetPaths,
	};
	const firstResolvedTargetPath = resolvedTargetPaths[0];
	if (firstResolvedTargetPath) {
		resolved.resolvedTargetPath = firstResolvedTargetPath;
	}
	return allowedDecision(options, resolved);
}

export async function checkWorkspaceGuardForTool<TParameters extends TSchema = TSchema, TDetails = unknown, TTheme = unknown>(
	tool: AgentTool<TParameters, TDetails, TTheme>,
	params: Static<TParameters>,
	context: WorkspaceGuardResolvedContext,
): Promise<WorkspaceGuardDecision | null> {
	const metadata = tool.workspaceGuard;
	if (!metadata) return null;

	const access = await resolveGuardValue(metadata.access, params);
	if (!access) return null;

	const targetPath = await resolveGuardValue(metadata.targetPath, params);
	const requestedCwd = await resolveGuardValue(metadata.requestedCwd, params);

	return checkWorkspaceGuard({
		access,
		toolName: tool.name,
		workspaceRoot: context.workspaceRoot ?? null,
		sessionCwd: context.sessionCwd,
		targetPath,
		requestedCwd,
	});
}
