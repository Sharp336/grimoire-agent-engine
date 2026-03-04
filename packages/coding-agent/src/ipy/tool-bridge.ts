/**
 * Python tool bridge: exposes agent tools as callable functions in the IPython kernel.
 *
 * Uses Jupyter's stdin channel (input_request/input_reply) for IPC.
 * Python calls `input("__omp_tool__:{json}")`, TypeScript intercepts it,
 * dispatches to the real tool, and sends the result back via input_reply.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { TSchema } from "@sinclair/typebox";
import type { ModelRegistry } from "../config/model-registry";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import type { MCPToolDetails } from "../mcp/tool-bridge";
import type { ReadonlySessionManager } from "../session/session-manager";
import type { ToolSession } from "../tools";

export const TOOL_BRIDGE_PREFIX = "__omp_tool__:";

/** Tool names that already have prelude Python equivalents — do not bridge these. */
const PRELUDE_COVERED = new Set([
	// File I/O
	"read",
	"write",
	// File ops
	"find",
	"grep",
	// Edit (hashline-based)
	"edit",
	// Interactive / meta
	"ask",
	"todo_write",
	"exit_plan_mode",
	"resolve",
	"submit_result",
	"report_finding",
	// Python itself (recursive)
	"python",
	// Browser (not useful from Python)
	"browser",
	"puppeteer",
	// Checkpoint/rewind (session-level, not useful from Python)
	"checkpoint",
	"rewind",
	// Calculator (Python IS a calculator)
	"calc",
	// SSH (interactive, not useful from Python)
	"ssh",
	// Await/cancel (async job management, not useful from Python)
	"await",
	"cancel_job",
	// Render mermaid (visual, not useful from Python)
	"render_mermaid",
	// Image generation (visual, not useful from Python)
	"generate_image",
]);

/** Python reserved words that cannot be used as function names. */
const PYTHON_RESERVED = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
]);

/**
 * Stub context for MCP tool dispatch from the Python bridge.
 * MCP tool implementations do not access ctx fields (all params are prefixed with `_`).
 * Using typed stubs instead of `{} as any` ensures TypeScript errors if CustomToolContext changes.
 */
const BRIDGE_CTX: CustomToolContext = {
	sessionManager: null as unknown as ReadonlySessionManager,
	modelRegistry: null as unknown as ModelRegistry,
	model: undefined,
	isIdle: () => true,
	hasQueuedMessages: () => false,
	abort: () => {},
};

export function shouldBridge(toolName: string): boolean {
	return !PRELUDE_COVERED.has(toolName);
}

export interface BridgeableToolInfo {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/**
 * Collect all tools that should be bridged to Python.
 */
export function collectBridgeableTools(
	builtinTools: AgentTool[],
	mcpTools: CustomTool<TSchema, MCPToolDetails>[],
): BridgeableToolInfo[] {
	const result: BridgeableToolInfo[] = [];

	for (const tool of builtinTools) {
		if (shouldBridge(tool.name)) {
			result.push({
				name: tool.name,
				description: tool.description ?? "",
				parameters: (tool.parameters ?? {}) as Record<string, unknown>,
			});
		}
	}

	for (const tool of mcpTools) {
		// MCP tools are always bridged (they never have prelude equivalents)
		result.push({
			name: tool.name,
			description: tool.description ?? "",
			parameters: (tool.parameters ?? {}) as Record<string, unknown>,
		});
	}

	return result;
}

/**
 * Generate a Python parameter signature from a JSON Schema properties object.
 * Produces keyword-only args with type hints.
 */
function generatePythonParams(schema: Record<string, unknown>): string {
	const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
	const required = new Set((schema.required ?? []) as string[]);

	// Sort: required params first, then optional (preserves order within each group)
	const entries = Object.entries(properties).sort(([nameA], [nameB]) => {
		const aRequired = required.has(nameA);
		const bRequired = required.has(nameB);
		if (aRequired && !bRequired) return -1;
		if (!aRequired && bRequired) return 1;
		return 0;
	});

	const params: string[] = [];
	for (const [name, prop] of entries) {
		const pyType = jsonSchemaToPythonType(prop);
		if (required.has(name)) {
			params.push(`${name}: ${pyType}`);
		} else {
			params.push(`${name}: ${pyType} = None`);
		}
	}

	if (params.length === 0) return "**kwargs";
	return `${params.join(", ")}, **kwargs`;
}

function jsonSchemaToPythonType(prop: Record<string, unknown>): string {
	const type = prop.type;
	switch (type) {
		case "string":
			return "str";
		case "number":
			return "float";
		case "integer":
			return "int";
		case "boolean":
			return "bool";
		case "array":
			return "list";
		case "object":
			return "dict";
		default:
			return "object";
	}
}

/**
 * Generate the Python bridge prelude code that defines `call_tool()` and typed wrappers.
 */
export function generateToolBridgePrelude(tools: BridgeableToolInfo[]): string {
	const lines: string[] = [
		"# --- OMP Tool Bridge (auto-generated) ---",
		"import json as _json",
		"",
		"def call_tool(__name: str, **kwargs) -> dict:",
		'    """Call an agent tool by name. Returns the result as a dict."""',
		`    request = _json.dumps({"tool": __name, "args": kwargs})`,
		`    response = input("${TOOL_BRIDGE_PREFIX}" + request)`,
		"    result = _json.loads(response)",
		'    if isinstance(result.get("error"), str):',
		"        raise RuntimeError(f\"Tool {__name} failed: {result['error']}\")",
		"    return result",
		"",
	];

	// Generate typed wrappers for each bridged tool
	for (const tool of tools) {
		const params = generatePythonParams(tool.parameters);
		const docstring = escapePythonString(tool.description || `Call the ${tool.name} tool.`);
		// Sanitize name for Python (replace dots/hyphens with underscores, ensure valid identifier)
		let pyName = tool.name.replace(/[^a-zA-Z0-9_]/g, "_");
		if (/^\d/.test(pyName)) pyName = `_${pyName}`;
		if (PYTHON_RESERVED.has(pyName)) pyName = `${pyName}_`;

		lines.push(`def ${pyName}(${params}) -> dict:`);
		lines.push(`    """${docstring}"""`);
		lines.push(
			`    return call_tool("${tool.name}", **{k: v for k, v in {**locals(), **kwargs}.items() if k != "kwargs"})`,
		);
		lines.push("");
	}

	// refresh_tools: re-queries available tools from TypeScript
	lines.push("def refresh_tools() -> list:");
	lines.push('    """Refresh available tool list from the agent. Returns list of tool names."""');
	lines.push('    result = call_tool("__bridge_refresh_tools__")');
	lines.push('    return result.get("tools", [])');
	lines.push("");

	return lines.join("\n");
}

function escapePythonString(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Handler type for tool bridge dispatch. */
export type ToolBridgeHandler = (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Create a tool bridge handler that dispatches Python tool calls to real tools.
 */
export function createToolBridgeHandler(builtinTools: AgentTool[], session: ToolSession): ToolBridgeHandler {
	// Build a lookup map for fast dispatch
	const toolMap = new Map<string, AgentTool>();
	for (const tool of builtinTools) {
		if (shouldBridge(tool.name)) {
			toolMap.set(tool.name, tool);
		}
	}

	return async (toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
		// Special: refresh tools list
		if (toolName === "__bridge_refresh_tools__") {
			const mcpTools = session.mcpManager?.getTools() ?? [];
			const allNames = [...Array.from(toolMap.keys()), ...mcpTools.map(t => t.name)];
			return { tools: allNames };
		}

		// Try builtin tools first
		const builtin = toolMap.get(toolName);
		if (builtin) {
			return dispatchBuiltinTool(builtin, args);
		}

		// Try MCP tools
		const mcpTools = session.mcpManager?.getTools() ?? [];
		const mcpTool = mcpTools.find(t => t.name === toolName);
		if (mcpTool) {
			return dispatchMCPTool(mcpTool, args);
		}

		return { error: `Unknown tool: ${toolName}` };
	};
}

async function dispatchBuiltinTool(tool: AgentTool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	try {
		const result = await tool.execute("bridge", args);
		return flattenToolResult(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn("Tool bridge dispatch failed", { tool: tool.name, error: msg });
		return { error: msg };
	}
}

async function dispatchMCPTool(
	tool: CustomTool<TSchema, MCPToolDetails>,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	try {
		const result = await tool.execute("bridge", args, undefined, BRIDGE_CTX);
		return flattenToolResult(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.warn("Tool bridge MCP dispatch failed", { tool: tool.name, error: msg });
		return { error: msg };
	}
}

/**
 * Flatten an AgentToolResult into a simple dict for Python consumption.
 * Tries to parse JSON content strings into objects.
 */
function flattenToolResult(result: {
	content: Array<{ type: string; text?: string }>;
	details?: { isError?: boolean };
}): Record<string, unknown> {
	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
		}
	}
	const text = textParts.join("\n");

	if (result.details?.isError) {
		return { error: text };
	}

	// Try to parse as JSON for structured results
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null) {
			return { content: parsed, isError: false };
		}
	} catch {
		// Not JSON, return as string
	}

	return { content: text, isError: false };
}
