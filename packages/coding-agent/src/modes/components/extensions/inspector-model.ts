/**
 * Kind-specific view-models for `/extensions`.
 *
 * Discovery `Extension.raw` stays the capability record. Live session tools
 * are joined here at render time — the same seam as {@link snapshotMcpRuntime}.
 */
import { arkToWireSchema, isArkSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { parseRuleConditionAndScope } from "../../../capability/rule";
import type { Extension, ExtensionState } from "./types";

export interface LiveToolRecord {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	hidden?: boolean;
	loadMode?: "essential" | "discoverable";
}

export interface ToolRuntimeSource {
	getLiveTool(name: string): LiveToolRecord | undefined;
	listLiveTools?(): LiveToolRecord[];
}

export interface ToolParamView {
	name: string;
	type: string;
	required: boolean;
	flag: string;
	description?: string;
}

export interface CommandPreview {
	description?: string;
	body: string;
	argumentHint?: string;
	usesArguments: boolean;
}

export function isPlaceholderToolDescription(name: string, description: string | undefined): boolean {
	if (!description || description.trim().length === 0) return true;
	return description === `${name} custom tool`;
}

export function commandPreview(content: string | undefined): CommandPreview {
	if (typeof content !== "string" || content.length === 0) {
		return { body: "", usesArguments: false };
	}
	const { frontmatter, body } = parseFrontmatter(content, { source: "slash-command" });
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	const argumentHintRaw =
		frontmatter.argumentHint ?? ("argument-hint" in frontmatter ? frontmatter["argument-hint"] : undefined);
	const argumentHint = typeof argumentHintRaw === "string" ? argumentHintRaw.trim() : "";
	const text = body.length > 0 ? body : content;
	return {
		description: description.length > 0 ? description : undefined,
		body: text,
		argumentHint: argumentHint.length > 0 ? argumentHint : undefined,
		usesArguments: /\$ARGUMENTS\b/.test(text),
	};
}

function asRecord(raw: unknown): Record<string, unknown> | null {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const token = value.trim();
		return token.length > 0 ? [token] : undefined;
	}
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return items.length > 0 ? items : undefined;
}

function asJsonSchema(schema: unknown): Record<string, unknown> | undefined {
	if (!schema) return undefined;
	try {
		if (isArkSchema(schema)) return arkToWireSchema(schema);
	} catch {
		// fall through
	}
	if (typeof schema === "object" && schema !== null && "toJsonSchema" in schema) {
		const candidate = schema.toJsonSchema;
		if (typeof candidate === "function") {
			try {
				const json: unknown = candidate.call(schema);
				if (json && typeof json === "object") return json as Record<string, unknown>;
			} catch {
				// fall through
			}
		}
	}
	return typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : undefined;
}

function propertiesFromSchema(schema: unknown): Record<string, unknown> | undefined {
	const wire = asJsonSchema(schema);
	if (!wire) return undefined;
	const properties = wire.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
	return properties as Record<string, unknown>;
}

function requiredFromSchema(schema: unknown): Set<string> {
	const wire = asJsonSchema(schema);
	const required = wire?.required;
	return new Set(
		Array.isArray(required) ? required.filter((value): value is string => typeof value === "string") : [],
	);
}

function paramType(spec: Record<string, unknown>): string {
	if (typeof spec.type === "string" && spec.type.length > 0) return spec.type;
	if (Array.isArray(spec.enum) && spec.enum.length > 0) return "enum";
	if (spec.anyOf || spec.oneOf) return "union";
	return "any";
}

export function toolParamsFromSchema(schema: unknown): ToolParamView[] {
	const properties = propertiesFromSchema(schema);
	if (!properties) return [];
	const required = requiredFromSchema(schema);
	const params: ToolParamView[] = [];
	for (const [name, spec] of Object.entries(properties)) {
		const record = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
		const isRequired = required.has(name);
		const defaultVal = record.default !== undefined ? `Default: ${String(record.default)}` : null;
		params.push({
			name,
			type: paramType(record),
			required: isRequired,
			flag: isRequired ? "Required" : (defaultVal ?? "Optional"),
			description: typeof record.description === "string" ? record.description : undefined,
		});
	}
	return params;
}

export function countToolParams(schema: unknown): number | undefined {
	const properties = propertiesFromSchema(schema);
	if (!properties) return undefined;
	return Object.keys(properties).length;
}

export function liveToolsForExtension(ext: Extension, source: ToolRuntimeSource | undefined): LiveToolRecord[] {
	if (!source) return [];
	const exact = source.getLiveTool(ext.name);
	if (exact) return [exact];
	const listed = source.listLiveTools?.() ?? [];
	return listed.filter(
		tool => tool.name === ext.name || tool.name.startsWith(`${ext.name}_`) || tool.name.startsWith(`${ext.name}-`),
	);
}

export function liveToolDetail(live: LiveToolRecord | undefined): string | undefined {
	if (!live) return undefined;
	if (live.hidden) return "hidden";
	if (live.loadMode === "discoverable") return "discoverable";
	return undefined;
}

export function formatExtensionListHint(ext: Extension, lives: LiveToolRecord[] = []): string | undefined {
	switch (ext.kind) {
		case "tool": {
			if (lives.length > 1) return `${lives.length} tools`;
			const live = lives[0];
			const liveHint = liveToolDetail(live);
			if (liveHint) return liveHint;
			const raw = asRecord(ext.raw);
			const count = countToolParams(live?.parameters ?? raw?.parameters ?? raw?.inputSchema);
			if (count === undefined) return ext.trigger;
			if (count === 0) return "no args";
			return `${count} arg${count === 1 ? "" : "s"}`;
		}
		case "slash-command":
			return ext.trigger ?? `/${ext.name}`;
		default:
			return ext.trigger;
	}
}

export function toolInspectorData(
	ext: Extension,
	lives: LiveToolRecord[],
): {
	label?: string;
	description?: string;
	params: ToolParamView[];
	runtimeDetail?: string;
	factory: LiveToolRecord[];
} {
	if (lives.length > 1) {
		const raw = asRecord(ext.raw);
		const discovered = raw ? stringField(raw, "description") : ext.description;
		return {
			description: isPlaceholderToolDescription(ext.name, discovered) ? undefined : discovered,
			params: [],
			runtimeDetail: `${lives.length} tools`,
			factory: lives,
		};
	}
	const live = lives[0];
	const raw = asRecord(ext.raw);
	const discovered = raw ? stringField(raw, "description") : ext.description;
	const description =
		live?.description && (isPlaceholderToolDescription(ext.name, discovered) || !discovered)
			? live.description
			: (discovered ?? live?.description);
	return {
		label: live?.label && live.label !== ext.displayName ? live.label : undefined,
		description,
		params: toolParamsFromSchema(live?.parameters ?? raw?.parameters ?? raw?.inputSchema),
		runtimeDetail: liveToolDetail(live) ?? ext.trigger,
		factory: lives,
	};
}

export function ruleInspectorData(ext: Extension): {
	description?: string;
	alwaysApply: boolean;
	globs?: string[];
	condition?: string[];
	astCondition?: string[];
	scope?: string[];
	interruptMode?: string;
	content: string;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	const alwaysApply = raw.alwaysApply === true;
	const globs = stringArray(raw.globs);
	const parsed = parseRuleConditionAndScope({
		condition: stringArray(raw.condition) ?? stringField(raw, "condition"),
		astCondition: stringArray(raw.astCondition) ?? stringField(raw, "astCondition"),
		scope: stringArray(raw.scope) ?? stringField(raw, "scope"),
	});
	const interruptMode = stringField(raw, "interruptMode");
	const content = stringField(raw, "content") ?? "";
	return {
		description: stringField(raw, "description") ?? ext.description,
		alwaysApply,
		globs,
		condition: parsed.condition,
		astCondition: parsed.astCondition,
		scope: parsed.scope,
		interruptMode,
		content,
		runtimeDetail: ext.trigger,
	};
}

export function skillInspectorData(ext: Extension): {
	description?: string;
	content: string;
	globs?: string[];
	alwaysApply: boolean;
	hidden: boolean;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	const frontmatter = asRecord(raw.frontmatter) ?? {};
	const hidden = frontmatter.hide === true || frontmatter.disableModelInvocation === true;
	const alwaysApply = frontmatter.alwaysApply === true;
	const globs = stringArray(frontmatter.globs) ?? stringArray(raw.globs);
	let runtimeDetail: string | undefined;
	if (hidden) runtimeDetail = "opt-in";
	else if (alwaysApply) runtimeDetail = "always";
	else if (globs) runtimeDetail = globs.join(", ");
	return {
		description: stringField(frontmatter, "description") ?? ext.description,
		content: stringField(raw, "content") ?? "",
		globs,
		alwaysApply,
		hidden,
		runtimeDetail: runtimeDetail ?? ext.trigger,
	};
}

export function commandInspectorData(ext: Extension): {
	description?: string;
	body: string;
	argumentHint?: string;
	usesArguments: boolean;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	const preview = commandPreview(stringField(raw, "content"));
	return {
		...preview,
		description: preview.description ?? ext.description,
		runtimeDetail: ext.trigger ?? `/${ext.name}`,
	};
}

export function hookInspectorData(ext: Extension): {
	hookType?: string;
	tool?: string;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	const hookType = stringField(raw, "type");
	const tool = stringField(raw, "tool");
	return {
		hookType,
		tool,
		runtimeDetail: ext.trigger ?? (hookType && tool ? `${hookType}:${tool}` : undefined),
	};
}

export function promptInspectorData(ext: Extension): { content: string; runtimeDetail?: string } {
	const raw = asRecord(ext.raw) ?? {};
	return {
		content: stringField(raw, "content") ?? "",
		runtimeDetail: ext.trigger,
	};
}

export function instructionInspectorData(ext: Extension): {
	content: string;
	applyTo?: string;
	runtimeDetail?: string;
} {
	const raw = asRecord(ext.raw) ?? {};
	return {
		content: stringField(raw, "content") ?? "",
		applyTo: stringField(raw, "applyTo"),
		runtimeDetail: ext.trigger,
	};
}

export function contextInspectorData(ext: Extension): { content: string; runtimeDetail?: string } {
	const raw = asRecord(ext.raw) ?? {};
	const content = stringField(raw, "content") ?? "";
	return {
		content,
		runtimeDetail: ext.trigger,
	};
}

export function enablementLabel(state: ExtensionState, reason?: string, shadowedBy?: string): string {
	switch (state) {
		case "active":
			return "Active";
		case "disabled": {
			const reasonText =
				reason === "provider-disabled"
					? "provider disabled"
					: reason === "item-disabled"
						? "manually disabled"
						: "unknown";
			return `Disabled (${reasonText})`;
		}
		case "shadowed":
			return `Shadowed${shadowedBy ? ` by ${shadowedBy}` : ""}`;
	}
}
