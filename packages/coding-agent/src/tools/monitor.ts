import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { MONITOR_SOURCE_ENTRY_MAX_CHARS, MonitorEventChannel } from "../monitor/events";
import {
	MONITOR_SOURCE_ABORT_FLOOD,
	MONITOR_SOURCE_ABORT_OVERSIZED_INPUT,
	type MonitorSourceResult,
	runCommandMonitor,
	runWebSocketMonitor,
} from "../monitor/sources";
import monitorDescription from "../prompts/tools/monitor.md" with { type: "text" };
import { Ellipsis, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { getBashApprovalDecision } from "./bash";
import { PREVIEW_LIMITS, replaceTabs, shortenPath, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";

const MONITOR_DEFAULT_TIMEOUT_SECONDS = 300;
const MONITOR_MIN_TIMEOUT_SECONDS = 1;
const MONITOR_MAX_TIMEOUT_SECONDS = 3_600;

interface MonitorCommonParams {
	description: string;
	timeout?: number;
	persistent?: boolean;
}

export type MonitorParams = MonitorCommonParams &
	({ command: string; ws?: never; protocols?: never } | { command?: never; ws: string; protocols?: string[] });

const monitorSchemaDocument = {
	type: "object",
	description: "Start one managed command or WebSocket event source.",
	properties: {
		description: {
			type: "string",
			minLength: 1,
			pattern: "\\S",
			description: "human description of the event source",
		},
		command: {
			type: "string",
			minLength: 1,
			pattern: "\\S",
			description: "shell command whose newline-delimited output should be monitored",
		},
		ws: {
			type: "string",
			minLength: 1,
			pattern: "^wss?://[^/@?#]+(?:[/?][^#]*)?$",
			description: "ws:// or wss:// URL without embedded credentials or a fragment",
		},
		protocols: {
			type: "array",
			minItems: 1,
			uniqueItems: true,
			items: { type: "string", minLength: 1, pattern: "^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$" },
			description: "unique non-empty RFC 6455 subprotocol tokens",
		},
		timeout: { type: "number", description: "timeout in seconds; default 300; clamped to 1-3600" },
		persistent: { type: "boolean", description: "run for the session lifetime with no deadline" },
	},
	required: ["description"],
	oneOf: [
		{
			required: ["command"],
			not: { anyOf: [{ required: ["ws"] }, { required: ["protocols"] }] },
		},
		{
			required: ["ws"],
			not: { required: ["command"] },
		},
	],
	additionalProperties: false,
} as const;

/** JSON Schema keeps a provider-compatible object root while the phantom static member types execution. */
export const monitorSchema = monitorSchemaDocument as typeof monitorSchemaDocument & { static: MonitorParams };

export interface MonitorToolDetails {
	description: string;
	source: "command" | "websocket";
	async: {
		state: "running";
		jobId: string;
		type: "monitor";
	};
}

export class MonitorTool implements AgentTool<typeof monitorSchema, MonitorToolDetails> {
	readonly name = "monitor";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		if (!args || typeof args !== "object" || !("command" in args)) return "exec";
		return getBashApprovalDecision(args.command);
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const command = args && typeof args === "object" && "command" in args ? args.command : undefined;
		const ws = args && typeof args === "object" && "ws" in args ? args.ws : undefined;
		const description = args && typeof args === "object" && "description" in args ? args.description : undefined;
		const source =
			typeof command === "string"
				? `Command: ${truncateForPrompt(command)}`
				: `WebSocket: ${truncateForPrompt(safeWebSocketPreview(typeof ws === "string" ? ws : undefined))}`;
		return [`Description: ${truncateForPrompt(typeof description === "string" ? description : "(missing)")}`, source];
	};
	readonly label = "Monitor";
	readonly summary = "Watch bounded shell lines or WebSocket frames and receive events automatically";
	readonly description = prompt.render(monitorDescription);
	readonly parameters = monitorSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly concurrency = "shared" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: MonitorParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<MonitorToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<MonitorToolDetails>> {
		if (!this.session.settings.get("monitor.enabled")) throw new ToolError("Monitor execution is disabled.");
		if (!this.session.settings.get("async.enabled")) throw new ToolError("Async execution is disabled.");
		if (params.command !== undefined && !this.session.settings.get("bash.enabled")) {
			throw new ToolError("Command monitors are disabled because Bash execution is disabled.");
		}
		if (this.session.agentKind !== "main" || (this.session.taskDepth ?? 0) > 0) {
			throw new ToolError("Monitor is available only to the main agent.");
		}
		const manager = this.session.asyncJobManager;
		if (!manager) throw new ToolError("Monitor manager unavailable for this session.");
		const ownerId = this.session.getAgentId?.() ?? undefined;
		if (!ownerId) throw new ToolError("Monitor owner unavailable for this session.");

		const description = params.description.trim().slice(0, MONITOR_SOURCE_ENTRY_MAX_CHARS);
		const timeoutSeconds = params.persistent
			? 0
			: Math.max(
					MONITOR_MIN_TIMEOUT_SECONDS,
					Math.min(MONITOR_MAX_TIMEOUT_SECONDS, params.timeout ?? MONITOR_DEFAULT_TIMEOUT_SECONDS),
				);
		const source = params.command !== undefined ? "command" : "websocket";
		const jobId = manager.register(
			"monitor",
			description,
			async ({ jobId: managedJobId, signal, reportEvent }) => {
				const sourceController = new AbortController();
				const channel = new MonitorEventChannel({
					emit: reportEvent,
					onFlood: () => sourceController.abort(MONITOR_SOURCE_ABORT_FLOOD),
					onOversizedInput: () => sourceController.abort(MONITOR_SOURCE_ABORT_OVERSIZED_INPUT),
				});
				let result: MonitorSourceResult;
				if (params.command !== undefined) {
					result = await runCommandMonitor({
						command: params.command,
						cwd: this.session.cwd,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:async:${managedJobId}`,
						signal,
						sourceController,
						channel,
						timeoutMs: timeoutSeconds * 1_000,
					});
				} else if (params.ws !== undefined) {
					result = await runWebSocketMonitor({
						url: params.ws,
						protocols: params.protocols,
						signal,
						sourceController,
						channel,
						timeoutMs: timeoutSeconds * 1_000,
					});
				} else {
					throw new ToolError("Monitor source unavailable after input validation.");
				}
				if (result.status === "failed") throw new ToolError(result.summary);
				return result.summary;
			},
			{ ownerId, persistent: params.persistent === true },
		);

		const details: MonitorToolDetails = {
			description,
			source,
			async: { state: "running", jobId, type: "monitor" },
		};
		return {
			content: [
				{
					type: "text",
					text: [
						`Monitor job ${jobId} started: ${description}`,
						"Events will arrive automatically; continue working without polling.",
						'Use `hub` with `op: "cancel"` only when intervention is needed.',
					].join("\n"),
				},
			],
			details,
		};
	}
}

export interface MonitorRenderArgs {
	description?: string;
	command?: string;
	ws?: string;
	persistent?: boolean;
}

function boundedRenderLines(text: string, maxLines: number): string[] {
	return replaceTabs(Bun.stripANSI(text))
		.split("\n")
		.slice(0, maxLines)
		.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode));
}

function safeWebSocketPreview(value: string | undefined): string {
	if (!value) return "(missing WebSocket URL)";
	try {
		const url = new URL(value);
		if (url.username || url.password) return "[credentialed WebSocket URL rejected]";
		url.search = "";
		url.hash = "";
		return url.href;
	} catch {
		return "[invalid WebSocket URL]";
	}
}

export const monitorToolRenderer = {
	inline: true,
	renderCall(args: MonitorRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const maxLines = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
		const source = args.command !== undefined ? shortenPath(args.command) : safeWebSocketPreview(args.ws);
		const lines = [
			renderStatusLine(
				{
					icon: "pending",
					title: "Monitor",
					meta: [
						truncateToWidth(
							replaceTabs(Bun.stripANSI(args.description ?? "")),
							TRUNCATE_LENGTHS.TITLE,
							Ellipsis.Unicode,
						),
					],
				},
				uiTheme,
			),
			...boundedRenderLines(source, maxLines).map(line => `  ${uiTheme.fg("dim", line)}`),
		];
		return new Text(lines.join("\n"), 0, 0);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: MonitorToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: MonitorRenderArgs,
	): Component {
		const maxLines = options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		const lines = [
			renderStatusLine(
				{
					icon: result.isError ? "error" : "success",
					title: "Monitor",
					meta: [
						truncateToWidth(
							replaceTabs(Bun.stripANSI(result.details?.description ?? args?.description ?? "")),
							TRUNCATE_LENGTHS.TITLE,
							Ellipsis.Unicode,
						),
					],
				},
				uiTheme,
			),
			...boundedRenderLines(text, maxLines).map(line => `  ${uiTheme.fg(result.isError ? "error" : "muted", line)}`),
		];
		return new Text(lines.join("\n"), 0, 0);
	},
};
