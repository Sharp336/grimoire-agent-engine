/**
 * Inspect provider-facing system prompts.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "@oh-my-pi/pi-ai";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { postmortem, setProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { APP_DISPLAY_NAME } from "../app-version";
import { systemPromptHelp as commandHelp } from "../cli/command-help";
import { ModelRegistry } from "../config/model-registry";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { buildDiscoveredSystemPromptOptions } from "../main";
import { type CreateAgentSessionResult, createAgentSession, discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";
import type { BuildSystemPromptResult, DynamicPromptPart } from "../system-prompt";
import { discoverAgents, getAgent } from "../task/discovery";
import { createSubagentSettings, resolveSubagentCapabilities } from "../task/subagent-runtime-config";
import { resolveSubagentSystemPrompt } from "../task/subagent-system-prompt";
import type { AgentSource } from "../task/types";
import { shortenPath } from "../tools/render-utils";

const ACTIONS = ["inspect"] as const;
type SystemPromptAction = (typeof ACTIONS)[number];

const BREAKDOWN_ENCODING = Encoding.O200kBase;
const BREAKDOWN_ENCODING_LABEL = "o200k_base";

export interface SubagentInspectTarget {
	kind: "subagent";
	name: string;
	source: AgentSource;
	filePath: string | null;
	fidelity: "configured-preview";
	baseTemplate: string | "bundled";
	wrapperTemplate: string | "bundled";
	omittedRuntimeInputs: [
		"batch-context",
		"plan-reference",
		"worktree",
		"irc-peers",
		"parent-mcp-state",
		"prewalk-handoff",
	];
}
interface ProviderBlock {
	index: number;
	text: string;
}

interface ProviderInspectJson {
	cwd: string;
	mode: "provider";
	blocks: ProviderBlock[];
	target?: SubagentInspectTarget;
}

interface DynamicInspectJson {
	cwd: string;
	mode: "dynamic-parts";
	blocks: DynamicPromptPart[];
	target?: SubagentInspectTarget;
}

interface TokenMeasurement {
	characters: number;
	tokens: number;
	percentOfMeasuredContext: number;
}

interface BreakdownPart extends TokenMeasurement {
	id: string;
	source: string;
	providerBlockIndex: number;
}

interface BreakdownSource extends TokenMeasurement {
	source: string;
	partIds: string[];
	providerBlockIndexes: number[];
}

interface BreakdownTool {
	name: string;
	wireName: string;
	prompt: TokenMeasurement;
	schema: TokenMeasurement;
}

interface BreakdownInspectJson {
	cwd: string;
	mode: "breakdown";
	target?: SubagentInspectTarget;
	tokenizer: {
		provider: "openai";
		encoding: typeof BREAKDOWN_ENCODING_LABEL;
	};
	model: { provider: string; id: string } | null;
	measurementScope: {
		includes: string[];
		excludes: string[];
	};
	totalMeasuredContextTokens: number;
	categories: {
		providerPrompt: TokenMeasurement;
		toolPrompts: TokenMeasurement;
		toolSchemas: TokenMeasurement;
	};
	providerBlocks: Array<TokenMeasurement & { index: number }>;
	dynamicParts: BreakdownPart[];
	dynamicSources: BreakdownSource[];
	dynamicPercentagesMayOverlap: true;
	tools: BreakdownTool[];
}

export interface SystemPromptInspection extends BuildSystemPromptResult {
	providerTools: Tool[];
	model: { provider: string; id: string } | null;
	target?: SubagentInspectTarget;
}

export interface FormatInspectOptions {
	mode: "provider" | "dynamic-parts" | "breakdown";
	json: boolean;
}

function renderProviderBlocks(blocks: string[]): string {
	return blocks.map((text, index) => `--- provider block ${index} ---\n${text}`).join("\n\n");
}

function renderDynamicParts(parts: DynamicPromptPart[]): string {
	return parts
		.map(part => `--- ${part.id} (${part.source}, provider block ${part.providerBlockIndex}) ---\n${part.text}`)
		.join("\n\n");
}

function measureTexts(texts: readonly string[]): Omit<TokenMeasurement, "percentOfMeasuredContext"> {
	return {
		characters: texts.reduce((total, text) => total + text.length, 0),
		tokens: texts.length === 0 ? 0 : countTokens([...texts], BREAKDOWN_ENCODING),
	};
}

function withPercentage(
	measurement: Omit<TokenMeasurement, "percentOfMeasuredContext">,
	totalMeasuredContextTokens: number,
): TokenMeasurement {
	return {
		...measurement,
		percentOfMeasuredContext:
			totalMeasuredContextTokens === 0
				? 0
				: Math.round((measurement.tokens / totalMeasuredContextTokens) * 10_000) / 100,
	};
}

function serializeToolSchema(tool: Tool): string {
	const parameters = JSON.stringify(tool.parameters ?? {});
	if (!tool.customFormat) return parameters;
	return `${parameters}\n${JSON.stringify(tool.customFormat)}`;
}

function buildBreakdown(cwd: string, result: SystemPromptInspection): BreakdownInspectJson {
	const toolPrompts = result.providerTools.map(tool => tool.description ?? "");
	const toolSchemas = result.providerTools.map(serializeToolSchema);
	const providerPromptMeasurement = measureTexts(result.systemPrompt);
	const toolPromptMeasurement = measureTexts(toolPrompts);
	const toolSchemaMeasurement = measureTexts(toolSchemas);
	const totalMeasuredContextTokens =
		providerPromptMeasurement.tokens + toolPromptMeasurement.tokens + toolSchemaMeasurement.tokens;

	const sourceParts = new Map<string, DynamicPromptPart[]>();
	for (const part of result.dynamicParts) {
		const parts = sourceParts.get(part.source);
		if (parts) parts.push(part);
		else sourceParts.set(part.source, [part]);
	}
	const dynamicSources = [...sourceParts.entries()]
		.map(
			([source, parts]): BreakdownSource => ({
				source,
				partIds: parts.map(part => part.id),
				providerBlockIndexes: [...new Set(parts.map(part => part.providerBlockIndex))],
				...withPercentage(measureTexts(parts.map(part => part.text)), totalMeasuredContextTokens),
			}),
		)
		.sort((left, right) => right.tokens - left.tokens || left.source.localeCompare(right.source));

	const dynamicParts = result.dynamicParts
		.map(
			(part): BreakdownPart => ({
				id: part.id,
				source: part.source,
				providerBlockIndex: part.providerBlockIndex,
				...withPercentage(measureTexts([part.text]), totalMeasuredContextTokens),
			}),
		)
		.sort((left, right) => right.tokens - left.tokens || left.id.localeCompare(right.id));

	return {
		cwd,
		mode: "breakdown",
		...(result.target ? { target: result.target } : {}),
		tokenizer: { provider: "openai", encoding: BREAKDOWN_ENCODING_LABEL },
		model: result.model,
		measurementScope: {
			includes: ["provider prompt blocks", "normalized tool descriptions", "tool parameter schemas and grammars"],
			excludes: ["conversation messages", "provider-specific request framing and control metadata"],
		},
		totalMeasuredContextTokens,
		categories: {
			providerPrompt: withPercentage(providerPromptMeasurement, totalMeasuredContextTokens),
			toolPrompts: withPercentage(toolPromptMeasurement, totalMeasuredContextTokens),
			toolSchemas: withPercentage(toolSchemaMeasurement, totalMeasuredContextTokens),
		},
		providerBlocks: result.systemPrompt.map((text, index) => ({
			index,
			...withPercentage(measureTexts([text]), totalMeasuredContextTokens),
		})),
		dynamicParts,
		dynamicSources,
		dynamicPercentagesMayOverlap: true,
		tools: result.providerTools.map((tool, index) => ({
			name: tool.name,
			wireName: tool.customWireName ?? tool.name,
			prompt: withPercentage(measureTexts([toolPrompts[index] ?? ""]), totalMeasuredContextTokens),
			schema: withPercentage(measureTexts([toolSchemas[index] ?? "{}"]), totalMeasuredContextTokens),
		})),
	};
}

function renderBreakdown(output: BreakdownInspectJson): string {
	const lines = [
		`Tokenizer: ${output.tokenizer.provider}/${output.tokenizer.encoding}`,
		`Model: ${output.model ? `${output.model.provider}/${output.model.id}` : "none"}`,
		`Total measured context: ${output.totalMeasuredContextTokens} tokens`,
		`Provider prompt: ${output.categories.providerPrompt.tokens} tokens (${output.categories.providerPrompt.percentOfMeasuredContext}%)`,
		`Tool prompts: ${output.categories.toolPrompts.tokens} tokens (${output.categories.toolPrompts.percentOfMeasuredContext}%)`,
		`Tool schemas: ${output.categories.toolSchemas.tokens} tokens (${output.categories.toolSchemas.percentOfMeasuredContext}%)`,
		`Excluded: ${output.measurementScope.excludes.join("; ")}`,
		"",
		"Dynamic parts (standalone shares; overlapping parts are not additive):",
		...output.dynamicParts.map(
			part => `${part.id} [${part.source}]: ${part.tokens} tokens (${part.percentOfMeasuredContext}%)`,
		),
		"",
		"Dynamic sources (standalone shares; overlapping sources are not additive):",
		...output.dynamicSources.map(
			source => `${source.source}: ${source.tokens} tokens (${source.percentOfMeasuredContext}%)`,
		),
		"",
		"Tools:",
		...output.tools.map(
			tool =>
				`${tool.name}: prompt ${tool.prompt.tokens} tokens (${tool.prompt.percentOfMeasuredContext}%), schema ${tool.schema.tokens} tokens (${tool.schema.percentOfMeasuredContext}%)`,
		),
	];
	return lines.join("\n");
}

function renderSubagentTarget(target: SubagentInspectTarget): string {
	const targetSource = target.filePath ? `${target.source}: ${shortenPath(target.filePath)}` : target.source;
	const baseTemplate = target.baseTemplate === "bundled" ? target.baseTemplate : shortenPath(target.baseTemplate);
	const wrapperTemplate =
		target.wrapperTemplate === "bundled" ? target.wrapperTemplate : shortenPath(target.wrapperTemplate);
	return [
		`Target: subagent ${target.name} (${targetSource})`,
		`Templates: base=${baseTemplate}, wrapper=${wrapperTemplate}`,
		`Omitted runtime inputs: ${target.omittedRuntimeInputs.join(", ")}`,
	].join("\n");
}

export function formatInspectOutput(
	cwd: string,
	result: BuildSystemPromptResult | SystemPromptInspection,
	options: FormatInspectOptions,
): string {
	const target = "target" in result ? result.target : undefined;
	const targetPrefix = target ? `${renderSubagentTarget(target)}\n\n` : "";
	if (options.mode === "dynamic-parts") {
		const output: DynamicInspectJson = {
			cwd,
			mode: "dynamic-parts",
			blocks: result.dynamicParts,
			...(target ? { target } : {}),
		};
		return options.json
			? `${JSON.stringify(output, null, 2)}\n`
			: `${targetPrefix}${renderDynamicParts(result.dynamicParts)}\n`;
	}
	if (options.mode === "breakdown") {
		if (!("providerTools" in result)) {
			throw new Error("System prompt breakdown requires provider tool metadata");
		}
		const output = buildBreakdown(cwd, result);
		return options.json ? `${JSON.stringify(output, null, 2)}\n` : `${targetPrefix}${renderBreakdown(output)}\n`;
	}
	const output: ProviderInspectJson = {
		cwd,
		mode: "provider",
		blocks: result.systemPrompt.map((text, index) => ({ index, text })),
		...(target ? { target } : {}),
	};
	return options.json
		? `${JSON.stringify(output, null, 2)}\n`
		: `${targetPrefix}${renderProviderBlocks(result.systemPrompt)}\n`;
}

async function writeStdout(text: string): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	process.stdout.write(text, error => {
		if (error) reject(error);
		else resolve();
	});
	await promise;
}

async function resolveCwd(cwdFlag: string | undefined): Promise<string> {
	const cwd = path.resolve(cwdFlag ?? process.cwd());
	const stat = await fs.stat(cwd).catch((error: unknown) => {
		throw new Error(`Invalid --cwd: ${cwd} does not exist`, { cause: error });
	});
	if (!stat.isDirectory()) {
		throw new Error(`Invalid --cwd: ${cwd} is not a directory`);
	}
	return cwd;
}
export async function inspectSystemPrompt(cwd: string): Promise<SystemPromptInspection> {
	setProjectDir(cwd);
	const systemPromptOptions = await buildDiscoveredSystemPromptOptions({ cwd });
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	let result: CreateAgentSessionResult | undefined;
	try {
		result = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			hasUI: false,
			sessionManager: SessionManager.inMemory(cwd),
			...systemPromptOptions,
		});
		if (!result.systemPromptResult) {
			throw new Error("System prompt inspection did not produce prompt metadata");
		}
		const providerContext = await result.session.agent.buildSideRequestContext(
			[],
			result.systemPromptResult.systemPrompt,
		);
		const model = result.session.model;
		return {
			...result.systemPromptResult,
			providerTools: providerContext.tools ?? [],
			model: model ? { provider: model.provider, id: model.id } : null,
		};
	} finally {
		await result?.session.dispose();
		await result?.mcpManager?.disconnectAll();
		authStorage.close();
	}
}

export async function inspectSubagentSystemPrompt(cwd: string, rawName: string): Promise<SystemPromptInspection> {
	const name = rawName.trim();
	if (!name) throw new Error("--subagent requires a non-empty agent name");

	setProjectDir(cwd);
	const settings = await Settings.loadReadOnly({ cwd });
	const discovery = await discoverAgents(cwd);
	const agent = getAgent(discovery.agents, name);
	if (!agent) {
		const available = discovery.agents.map(candidate => candidate.name).join(", ") || "none";
		throw new Error(`Unknown agent "${name}". Available: ${available}`);
	}
	const disabledAgents = settings.get("task.disabledAgents");
	if (disabledAgents.includes(name)) {
		const enabled = discovery.agents
			.filter(candidate => !disabledAgents.includes(candidate.name))
			.map(candidate => candidate.name);
		throw new Error(
			`Agent "${name}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
		);
	}

	const subagentSettings = createSubagentSettings(
		settings,
		agent.readSummarize === false ? { "read.summarize.enabled": false } : undefined,
	);
	const defaultModelPattern = settings.getModelRole("default");
	const modelPatterns = resolveAgentModelPatterns({
		settingsOverride: settings.get("task.agentModelOverrides")[name],
		agentModel: agent.model,
		settings,
		activeModelPattern: defaultModelPattern,
		fallbackModelPattern: defaultModelPattern,
	});
	const capabilities = resolveSubagentCapabilities(agent, subagentSettings);
	const subagentPrompt = await resolveSubagentSystemPrompt(cwd, {
		agent: agent.systemPrompt,
		outputSchema: agent.output,
	});
	const authStorage = await discoverAuthStorage();
	let result: CreateAgentSessionResult | undefined;
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		result = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			settings: subagentSettings,
			modelPattern: modelPatterns,
			modelPatternAuthFallback: defaultModelPattern,
			thinkingLevel: agent.thinkingLevel,
			toolNames: capabilities.toolNames,
			outputSchema: agent.output,
			requireYieldTool: true,
			hasUI: false,
			sessionManager: SessionManager.inMemory(cwd),
			spawns: capabilities.spawns,
			taskDepth: capabilities.childDepth,
			enableLsp: settings.get("task.enableLsp"),
			enableIrc: false,
			enableMCP: false,
			systemPromptTemplate: subagentPrompt.systemPromptTemplate,
			systemPromptTransform: subagentPrompt.transform,
		});
		const enabledToolNames = result.session.getEnabledToolNames();
		const childToolNames = enabledToolNames.filter(toolName => toolName !== "todo");
		if (childToolNames.length !== enabledToolNames.length) {
			await result.session.setActiveToolsByName(childToolNames);
		}
		const promptResult = result.session.getSystemPromptResult();
		const providerContext = await result.session.agent.buildSideRequestContext([], promptResult.systemPrompt);
		const model = result.session.model;
		return {
			...promptResult,
			providerTools: providerContext.tools ?? [],
			model: model ? { provider: model.provider, id: model.id } : null,
			target: {
				kind: "subagent",
				name,
				source: agent.source,
				filePath: agent.filePath ? path.resolve(agent.filePath) : null,
				fidelity: "configured-preview",
				baseTemplate: subagentPrompt.systemPromptTemplate
					? path.resolve(subagentPrompt.systemPromptTemplate)
					: "bundled",
				wrapperTemplate: subagentPrompt.wrapperTemplatePath
					? path.resolve(subagentPrompt.wrapperTemplatePath)
					: "bundled",
				omittedRuntimeInputs: [
					"batch-context",
					"plan-reference",
					"worktree",
					"irc-peers",
					"parent-mcp-state",
					"prewalk-handoff",
				],
			},
		};
	} finally {
		try {
			await result?.session.dispose();
		} finally {
			authStorage.close();
		}
	}
}

export default class SystemPrompt extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "System prompt action",
			required: false,
			options: [...ACTIONS],
		}),
	};

	static flags = {
		cwd: Flags.string({ description: "Project directory to inspect" }),
		subagent: Flags.string({ description: "Inspect the configured prompt for a named subagent" }),
		"dynamic-parts": Flags.boolean({ description: "Output dynamic prompt parts only" }),
		provider: Flags.boolean({ description: "Output complete provider-facing prompt blocks" }),
		breakdown: Flags.boolean({ description: "Output token shares for prompt sources and provider tools" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		`# Inspect provider-facing blocks\n  ${APP_DISPLAY_NAME} system-prompt inspect --cwd /root/projects/project-paperless-go-classifier`,
		`# Inspect dynamic prompt parts\n  ${APP_DISPLAY_NAME} system-prompt inspect --cwd /root/projects/project-paperless-go-classifier --dynamic-parts`,
		`# Inspect dynamic prompt parts as JSON\n  ${APP_DISPLAY_NAME} system-prompt inspect --cwd /root/projects/project-paperless-go-classifier --dynamic-parts --json`,
		`# Inspect token shares by prompt source and provider tool\n  ${APP_DISPLAY_NAME} system-prompt inspect --cwd /root/projects/project-paperless-go-classifier --breakdown --json`,
		`# Inspect a configured subagent's provider-facing blocks
  ${APP_DISPLAY_NAME} system-prompt inspect --subagent scout --provider`,
		`# Inspect a configured subagent's dynamic prompt parts
  ${APP_DISPLAY_NAME} system-prompt inspect --subagent scout --dynamic-parts --json`,
		`# Inspect a configured subagent's model and tool-aware token breakdown
  ${APP_DISPLAY_NAME} system-prompt inspect --subagent scout --breakdown --json`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(SystemPrompt);
		const action = args.action as SystemPromptAction | undefined;
		if (!action) {
			renderCommandHelp(APP_DISPLAY_NAME, "system-prompt", SystemPrompt);
			return;
		}
		if (action !== "inspect") {
			throw new Error(`Unsupported system-prompt action: ${action}`);
		}
		const selectedModes = [flags.provider, flags["dynamic-parts"], flags.breakdown].filter(Boolean).length;
		if (selectedModes > 1) {
			throw new Error("Use only one of --provider, --dynamic-parts, or --breakdown");
		}

		const cwd = await resolveCwd(flags.cwd);
		const result =
			flags.subagent === undefined
				? await inspectSystemPrompt(cwd)
				: await inspectSubagentSystemPrompt(cwd, flags.subagent);
		const mode = flags.breakdown ? "breakdown" : flags["dynamic-parts"] ? "dynamic-parts" : "provider";
		await writeStdout(formatInspectOutput(cwd, result, { mode, json: flags.json === true }));
		await postmortem.quit(0);
	}
}
