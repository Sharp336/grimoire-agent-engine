import type { Context, Tool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { SettingValue } from "../config/settings-schema";

export type CompactProviderToolDefinitionsMode = SettingValue<"tools.compactProviderDefinitions">;

const DEFAULT_DESCRIPTION_MAX = 280;

function dropDescriptionField(schema: unknown): unknown {
	if (!isPlainObject(schema) || !("description" in schema)) return schema;
	const { description: _d, ...rest } = schema;
	return rest;
}

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

/** Remove nested `description` fields from a JSON Schema object (wire shape). */
export function stripNestedSchemaDescriptions(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(entry => stripNestedSchemaDescriptions(entry));
	}
	if (!isPlainObject(schema)) return schema;

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "description") continue;
		if (key === "properties" && isPlainObject(value)) {
			const props: Record<string, unknown> = {};
			for (const [propName, propSchema] of Object.entries(value)) {
				props[propName] = dropDescriptionField(stripNestedSchemaDescriptions(propSchema));
			}
			out.properties = props;
			continue;
		}
		if (key === "items") {
			out.items = dropDescriptionField(stripNestedSchemaDescriptions(value));
			continue;
		}
		if (key === "additionalProperties" && isPlainObject(value)) {
			out.additionalProperties = dropDescriptionField(stripNestedSchemaDescriptions(value));
			continue;
		}
		if (key === "patternProperties" && isPlainObject(value)) {
			const mapped: Record<string, unknown> = {};
			for (const [pattern, sub] of Object.entries(value)) {
				mapped[pattern] = dropDescriptionField(stripNestedSchemaDescriptions(sub));
			}
			out.patternProperties = mapped;
			continue;
		}
		if (key === "definitions" && isPlainObject(value)) {
			const mapped: Record<string, unknown> = {};
			for (const [name, sub] of Object.entries(value)) {
				mapped[name] = dropDescriptionField(stripNestedSchemaDescriptions(sub));
			}
			out.definitions = mapped;
			continue;
		}
		if (key === "$defs" && isPlainObject(value)) {
			const mapped: Record<string, unknown> = {};
			for (const [name, sub] of Object.entries(value)) {
				mapped[name] = dropDescriptionField(stripNestedSchemaDescriptions(sub));
			}
			out.$defs = mapped;
			continue;
		}
		out[key] = stripNestedSchemaDescriptions(value);
	}
	return out;
}

function compactWireTool(tool: Tool, mode: CompactProviderToolDefinitionsMode): Tool {
	if (mode === "off") return tool;

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

/** Shrink tool definitions for provider requests only (session tools stay full-fidelity). */
export function compactProviderTools(
	tools: Tool[] | undefined,
	mode: CompactProviderToolDefinitionsMode,
): Tool[] | undefined {
	if (!tools || mode === "off") return tools;
	return tools.map(tool => compactWireTool(tool, mode));
}

/** Apply compaction to an outbound provider context. */
export function compactProviderContext(
	context: Context,
	mode: CompactProviderToolDefinitionsMode,
): Context {
	if (mode === "off" || !context.tools) return context;
	return {
		...context,
		tools: compactProviderTools(context.tools, mode) ?? context.tools,
	};
}