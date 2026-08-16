/**
 * Langfuse-facing trace attributes.
 *
 * Stamps trace-level context (name, tags, user) that the OTel GenAI semantic
 * conventions do not cover, so backends honoring the `langfuse.*` attribute
 * namespace (https://langfuse.com/integrations/native/opentelemetry) can name,
 * tag, and filter traces. These attributes are inert on other OTLP backends.
 *
 * The agent core's TelemetryAttributeContext carries only span-local facts
 * (kind, model, agent identity), so session-level values are captured in a
 * closure at config-build time in main.ts, where cwd/argv/settings exist.
 */
import { hostname } from "node:os";
import path from "node:path";
import type { AgentTelemetryConfig, TelemetryAttributeContext } from "@oh-my-pi/pi-agent-core";

const MAX_TRACE_NAME_CHARS = 80;

export interface LangfuseAttributeConfigOptions {
	readonly cwd: string;
	/** Headless prompt (print mode); undefined for interactive sessions. */
	readonly prompt?: string | undefined;
	readonly mode: "interactive" | "headless";
	/** The `modelRoles` setting (role -> model string, possibly provider-prefixed). */
	readonly modelRoles: Record<string, string>;
	/** Default-role model id when already resolved at startup. */
	readonly defaultModel?: string | undefined;
}

export function createLangfuseAttributeConfig(options: LangfuseAttributeConfigOptions): AgentTelemetryConfig {
	const project = path.basename(options.cwd);
	const host = hostname();
	const user = process.env.USER ?? process.env.LOGNAME;
	const traceName = options.prompt ? truncate(firstLine(options.prompt), MAX_TRACE_NAME_CHARS) : `omp:${project}`;
	const roleByModelId = invertModelRoles(options.modelRoles);

	return {
		resolveAttributes: (ctx: TelemetryAttributeContext) => {
			switch (ctx.kind) {
				case "invoke_agent": {
					const tags = [`project:${project}`, `mode:${options.mode}`, `host:${host}`];
					const model = ctx.model?.id ?? options.defaultModel;
					if (model) tags.push(`model:${model}`);
					if (ctx.agent?.name) tags.push(`agent:${ctx.agent.name}`);
					return {
						"langfuse.trace.name": traceName,
						"langfuse.trace.tags": tags,
						...(user ? { "user.id": user } : {}),
						"langfuse.trace.metadata.project": project,
					};
				}
				case "chat": {
					const tags: string[] = [];
					if (ctx.model?.provider) tags.push(`provider:${ctx.model.provider}`);
					const role = ctx.model ? roleByModelId.get(ctx.model.id) : undefined;
					if (role) tags.push(`role:${role}`);
					return tags.length > 0 ? { "langfuse.trace.tags": tags } : undefined;
				}
				default:
					return undefined;
			}
		},
	};
}

/** modelRoles maps role -> "provider/model[:effort]"; index by bare model id. */
function invertModelRoles(modelRoles: Record<string, string>): Map<string, string> {
	const byId = new Map<string, string>();
	for (const [role, modelString] of Object.entries(modelRoles)) {
		const noProvider = modelString.includes("/") ? modelString.slice(modelString.lastIndexOf("/") + 1) : modelString;
		const id = noProvider.split(":", 1)[0];
		if (id) byId.set(id, role);
	}
	return byId;
}

function firstLine(text: string): string {
	const line = text.split("\n", 1)[0]?.trim();
	return line && line.length > 0 ? line : text.trim();
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
