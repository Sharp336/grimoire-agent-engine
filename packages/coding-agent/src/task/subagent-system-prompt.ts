import { prompt } from "@oh-my-pi/pi-utils";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import type { SystemPromptTransform } from "../sdk";
import {
	type DynamicPromptPart,
	discoverSubagentBaseSystemPromptTemplate,
	discoverSubagentSystemPromptTemplate,
} from "../system-prompt";
import { normalizeSchema } from "../tools/jtd-to-json-schema";
import { shortenPath } from "../tools/render-utils";

export interface SubagentSystemPromptInput {
	agent: string;
	context?: string;
	planReference?: { path: string; content: string };
	worktree?: string;
	outputSchema?: unknown;
	outputSchemaOverridesAgent?: boolean;
	ircPeers?: string;
	ircSelfId?: string;
}

export interface ResolvedSubagentSystemPrompt {
	systemPromptTemplate?: string;
	wrapperTemplatePath?: string;
	transform: SystemPromptTransform;
}

export async function resolveSubagentSystemPrompt(
	cwd: string,
	input: SubagentSystemPromptInput,
): Promise<ResolvedSubagentSystemPrompt> {
	const systemPromptTemplate = discoverSubagentBaseSystemPromptTemplate(cwd);
	const wrapperTemplatePath = discoverSubagentSystemPromptTemplate(cwd);
	let wrapperTemplate = subagentSystemPromptTemplate;
	if (wrapperTemplatePath) {
		try {
			wrapperTemplate = await Bun.file(wrapperTemplatePath).text();
		} catch (error) {
			throw new Error(`Could not read subagent system prompt template: ${shortenPath(wrapperTemplatePath)}`, {
				cause: error,
			});
		}
		if (wrapperTemplate.replace(/^\uFEFF/, "").trim().length === 0) {
			throw new Error(`Subagent system prompt template is empty: ${shortenPath(wrapperTemplatePath)}`);
		}
	}

	const { normalized: outputSchema } = normalizeSchema(input.outputSchema);
	const wrapper = prompt.render(wrapperTemplate, {
		agent: input.agent,
		context: input.context?.trim() ?? "",
		planReference: input.planReference?.content ?? "",
		planReferencePath: input.planReference?.path ?? "",
		worktree: input.worktree ?? "",
		outputSchema,
		outputSchemaOverridesAgent: input.outputSchemaOverridesAgent === true,
		ircPeers: input.ircPeers ?? "",
		ircSelfId: input.ircSelfId ?? "",
	});
	const source = wrapperTemplatePath ? "SUBAGENT-SYSTEM.template.md" : "subagent-system-prompt.md";

	return {
		systemPromptTemplate,
		wrapperTemplatePath,
		transform: result => {
			const providerBlockIndex = Math.max(0, result.systemPrompt.length - 1);
			const systemPrompt = [...result.systemPrompt];
			systemPrompt.splice(providerBlockIndex, 0, wrapper);
			const dynamicParts = result.dynamicParts.map(part =>
				part.providerBlockIndex >= providerBlockIndex
					? { ...part, providerBlockIndex: part.providerBlockIndex + 1 }
					: part,
			);
			const wrapperPart: DynamicPromptPart = {
				id: "subagent-wrapper",
				source,
				providerBlockIndex,
				text: wrapper,
			};
			const nextPartIndex = dynamicParts.findIndex(part => part.providerBlockIndex > providerBlockIndex);
			if (nextPartIndex === -1) dynamicParts.push(wrapperPart);
			else dynamicParts.splice(nextPartIndex, 0, wrapperPart);
			return { ...result, systemPrompt, dynamicParts };
		},
	};
}
