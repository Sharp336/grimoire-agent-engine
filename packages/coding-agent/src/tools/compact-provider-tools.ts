import type { Context, Tool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { stamp } from "@oh-my-pi/pi-ai/utils/schema/stamps";
import type { SettingValue } from "../config/settings-schema";

export type CompactProviderToolDefinitionsMode = SettingValue<"tools.compactProviderDefinitions">;

const DEFAULT_DESCRIPTION_MAX = 280;

const kCompactToolByMode = Symbol("pi.coding-agent.compactProviderToolByMode");

/** First substantive line of a tool description (drops empty lines and markdown headings). */
export function compactToolDescription(description: string, maxLen = DEFAULT_DESCRIPTION_MAX): string {
	const trimmed = description.trim();
	if (!trimmed) return trimmed;

	const lines = trimmed.split(/\r?\n/);
	for (const line of lines) {
		if (/^#+\s/.test(line)) continue;
		const stripped = line.trim();
		if (stripped.length > 0) {
			if (stripped.length <= maxLen) return stripped;
			return `${stripped.slice(0, maxLen - 1)}…`;
		}
	}

	if (trimmed.length <= maxLen) return trimmed;
	return `${trimmed.slice(0, maxLen - 1)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripSchemaArrayKeyword(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map(entry => stripNestedSchemaDescriptions(entry));
}

/** Remove nested `description` fields from a JSON Schema object (wire shape). */
export function stripNestedSchemaDescriptions(schema: unknown): unknown {
	if (!isPlainObject(schema)) return schema;

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "description") continue;
		if (key === "properties" && isPlainObject(value)) {
			const props: Record<string, unknown> = {};
			for (const [propName, propSchema] of Object.entries(value)) {
				props[propName] = stripNestedSchemaDescriptions(propSchema);
			}
			out.properties = props;
			continue;
		}
		if (key === "items") {
			out.items = stripNestedSchemaDescriptions(value);
			continue;
		}
		if (key === "prefixItems") {
			out.prefixItems = stripSchemaArrayKeyword(value);
			continue;
		}
		if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			out[key] = stripSchemaArrayKeyword(value);
			continue;
		}
		if (key === "additionalProperties" && isPlainObject(value)) {
			out.additionalProperties = stripNestedSchemaDescriptions(value);
			continue;
		}
		if (key === "patternProperties" && isPlainObject(value)) {
			const mapped: Record<string, unknown> = {};
			for (const [pattern, sub] of Object.entries(value)) {
				mapped[pattern] = stripNestedSchemaDescriptions(sub);
			}
			out.patternProperties = mapped;
			continue;
		}
		if (key === "definitions" && isPlainObject(value)) {
			const mapped: Record<string, unknown> = {};
			for (const [name, sub] of Object.entries(value)) {
				mapped[name] = stripNestedSchemaDescriptions(sub);
			}
			out.definitions = mapped;
			continue;
		}
		if (key === "$defs" && isPlainObject(value)) {
			const mapped: Record<string, unknown> = {};
			for (const [name, sub] of Object.entries(value)) {
				mapped[name] = stripNestedSchemaDescriptions(sub);
			}
			out.$defs = mapped;
			continue;
		}
		if (key === "enum" || key === "const" || key === "required" || key === "type") {
			out[key] = value;
			continue;
		}
		out[key] = stripNestedSchemaDescriptions(value);
	}
	return out;
}

function computeCompactWireTool(tool: Tool, mode: CompactProviderToolDefinitionsMode): Tool {
	let description = tool.description;
	if (mode === "description" || mode === "schema") {
		description = compactToolDescription(description);
	}

	let parameters = tool.parameters;
	if (mode === "schema") {
		const wire = toolWireSchema(tool);
		parameters = stripNestedSchemaDescriptions(wire) as Tool["parameters"];
	}

	return {
		...tool,
		description,
		parameters,
	};
}

function compactWireTool(tool: Tool, mode: CompactProviderToolDefinitionsMode): Tool {
	if (mode === "off") return tool;
	const cache = stamp(
		tool as object,
		kCompactToolByMode,
		(): Partial<Record<CompactProviderToolDefinitionsMode, Tool>> => ({}),
	);
	const hit = cache[mode];
	if (hit) return hit;
	const compacted = computeCompactWireTool(tool, mode);
	cache[mode] = compacted;
	return compacted;
}

/** Shrink tool definitions for provider requests only (session tools stay full-fidelity). */
export function compactProviderTools(
	tools: Tool[] | undefined,
	mode: CompactProviderToolDefinitionsMode,
): Tool[] | undefined {
	if (!tools || mode === "off") return tools;
	return tools.map(tool => compactWireTool(tool, mode));
}

/** Apply compaction to an outbound provider context. */
export function compactProviderContext(context: Context, mode: CompactProviderToolDefinitionsMode): Context {
	if (mode === "off" || !context.tools) return context;
	return {
		...context,
		tools: compactProviderTools(context.tools, mode) ?? context.tools,
	};
}
