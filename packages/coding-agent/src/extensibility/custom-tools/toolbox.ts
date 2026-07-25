/**
 * Toolbox tools — executable files discovered from `.omp/toolbox/` and `~/.omp/toolbox/`.
 *
 * Providers yield capability descriptors (path = executable). Loading runs a describe/execute
 * handshake instead of `import()`, because shell scripts cannot be imported as modules.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, logger, ptree, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../../capability";
import { type CustomTool as CustomToolDescriptor, toolCapability } from "../../capability/tool";
import type { LoadContext, LoadResult } from "../../capability/types";
import { createSourceMeta } from "../../discovery/helpers";
import { PREVIEW_LIMITS, replaceTabs } from "../../tools/render-utils";
import { toolResult } from "../../tools/tool-result";
import { Type } from "../typebox";
import type { CustomTool, LoadedCustomTool, ToolLoadError } from "./types";

export const TOOLBOX_PROVIDER_ID = "toolbox";

const DISPLAY_NAME = "Toolbox";
const DESCRIPTION = "Executable tools from .omp/toolbox/ and ~/.omp/toolbox/";
const PRIORITY = 80;
const DESCRIBE_DEADLINE_MS = 5_000;
/** Owner-execute bit (S_IXUSR). Non-executable files are ignored silently. */
const OWNER_EXECUTE = 0o100;

interface LoadToolResult {
	tools: LoadedCustomTool[];
	errors: ToolLoadError[];
}

type ToolboxSource = { provider: string; providerName: string; level: "user" | "project" };

interface ToolboxDescribePayload {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

type SpawnOutcome =
	| { kind: "ok"; stdout: string; stderr: string }
	| { kind: "nonzero"; exitCode: number; stdout: string; stderr: string }
	| { kind: "timeout"; stderr: string }
	| { kind: "killed"; stderr: string };

function isOwnerExecutable(mode: number): boolean {
	return (mode & OWNER_EXECUTE) !== 0;
}

function basenameWithoutExtension(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	if (dot <= 0) return fileName;
	return fileName.slice(0, dot);
}

function formatPreviewText(text: string): string {
	const normalized = replaceTabs(text);
	const lines = normalized.split("\n");
	const max = PREVIEW_LIMITS.EXPANDED_LINES;
	if (lines.length <= max) return normalized;
	return `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines`;
}

function classifyExecResult(result: ptree.ExecResult): SpawnOutcome {
	if (result.exitError instanceof ptree.TimeoutError) {
		return { kind: "timeout", stderr: result.stderr };
	}
	if (result.exitError?.aborted) {
		return { kind: "killed", stderr: result.stderr };
	}
	if (result.exitCode !== null && result.exitCode !== 0) {
		return {
			kind: "nonzero",
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}
	if (!result.ok) {
		return {
			kind: "nonzero",
			exitCode: result.exitCode ?? 1,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	}
	return { kind: "ok", stdout: result.stdout, stderr: result.stderr };
}

function parseDescribePayload(stdout: string, defaultName: string): ToolboxDescribePayload | string {
	const trimmed = stdout.trim();
	if (!trimmed) return "describe produced empty stdout";

	const parsed = tryParseJson<unknown>(trimmed);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return "describe produced unparsable JSON";
	}

	const record = parsed as Record<string, unknown>;
	const description = record.description;
	if (typeof description !== "string" || !description.trim()) {
		return "describe JSON missing string description";
	}

	const parameters = record.parameters;
	if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
		return "describe JSON missing parameters object";
	}

	const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : defaultName;

	return {
		name,
		description: description.trim(),
		parameters: parameters as Record<string, unknown>,
	};
}

function skipTool(resolvedPath: string, reason: string, source?: ToolboxSource): LoadToolResult {
	logger.warn(`Toolbox tool skipped (${resolvedPath}): ${reason}`);
	return {
		tools: [],
		errors: [{ path: resolvedPath, error: reason, source }],
	};
}

async function runToolboxAction(
	resolvedPath: string,
	action: "describe" | "execute",
	options: { input?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<SpawnOutcome> {
	const result = await ptree.exec([resolvedPath], {
		env: { ...Bun.env, OMP_TOOLBOX_ACTION: action },
		input: options.input,
		timeout: options.timeout,
		signal: options.signal,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});
	return classifyExecResult(result);
}

function synthesizeToolboxTool(resolvedPath: string, desc: ToolboxDescribePayload): CustomTool {
	const name = desc.name;
	const parameters = Type.Unsafe(desc.parameters);

	return {
		name,
		label: name,
		description: desc.description,
		parameters,
		approval: "exec",
		strict: true,
		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			const outcome = await runToolboxAction(resolvedPath, "execute", {
				input: JSON.stringify(params),
				signal,
			});

			switch (outcome.kind) {
				case "ok":
					return toolResult()
						.text(outcome.stdout || "(no output)")
						.done();
				case "nonzero": {
					const stderr = formatPreviewText(outcome.stderr || `(exit code ${outcome.exitCode})`);
					return toolResult().text(stderr).error().done();
				}
				case "timeout":
					return toolResult().text("Toolbox tool timed out").error().done();
				case "killed":
					return toolResult().text("Toolbox tool was killed before completion").error().done();
			}
		},
	};
}

/**
 * Load one toolbox executable via describe/execute handshake.
 * Failures never throw: they return a ToolLoadError and one logger.warn.
 */
export async function loadToolboxTool(
	resolvedPath: string,
	source?: ToolboxSource,
	options?: { describeTimeoutMs?: number },
): Promise<LoadToolResult> {
	const defaultName = basenameWithoutExtension(path.basename(resolvedPath));

	let outcome: SpawnOutcome;
	try {
		// Overridable so the deadline path is provable without sleeping the real 5s.
		outcome = await runToolboxAction(resolvedPath, "describe", {
			timeout: options?.describeTimeoutMs ?? DESCRIBE_DEADLINE_MS,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return skipTool(resolvedPath, `describe failed: ${message}`, source);
	}

	switch (outcome.kind) {
		case "timeout":
			return skipTool(resolvedPath, "describe exceeded 5s deadline", source);
		case "killed":
			return skipTool(resolvedPath, "describe process was killed", source);
		case "nonzero":
			return skipTool(resolvedPath, `describe exited with code ${outcome.exitCode}`, source);
		case "ok": {
			const parsed = parseDescribePayload(outcome.stdout, defaultName);
			if (typeof parsed === "string") {
				return skipTool(resolvedPath, parsed, source);
			}

			const tool = synthesizeToolboxTool(resolvedPath, parsed);
			return {
				tools: [
					{
						path: resolvedPath,
						resolvedPath,
						tool,
						source,
					},
				],
				errors: [],
			};
		}
	}
}

async function scanToolboxDir(dir: string, level: "user" | "project"): Promise<CustomToolDescriptor[]> {
	const items: CustomToolDescriptor[] = [];
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return items;
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let stats: fs.Stats;
		try {
			stats = await fs.promises.stat(filePath);
		} catch {
			continue;
		}
		if (!stats.isFile()) continue;
		if (!isOwnerExecutable(stats.mode)) continue;

		const name = basenameWithoutExtension(entry.name);
		items.push({
			name,
			path: filePath,
			description: `${name} toolbox tool`,
			level,
			_source: createSourceMeta(TOOLBOX_PROVIDER_ID, filePath, level),
		});
	}

	return items;
}

async function loadToolboxDescriptors(ctx: LoadContext): Promise<LoadResult<CustomToolDescriptor>> {
	const projectDir = path.join(ctx.cwd, CONFIG_DIR_NAME, "toolbox");
	const userDir = path.join(ctx.home, CONFIG_DIR_NAME, "toolbox");
	const [projectItems, userItems] = await Promise.all([
		scanToolboxDir(projectDir, "project"),
		scanToolboxDir(userDir, "user"),
	]);
	// Project first: capability key-dedup keeps the first item per name.
	return { items: [...projectItems, ...userItems], warnings: [] };
}

registerProvider<CustomToolDescriptor>(toolCapability.id, {
	id: TOOLBOX_PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadToolboxDescriptors,
});
