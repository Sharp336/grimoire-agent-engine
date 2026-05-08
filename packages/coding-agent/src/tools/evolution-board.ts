import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { createEvolutionBoard } from "../evolution-board/board";
import type { ToolSession } from ".";
import evolutionBoardDescription from "../prompts/tools/evolution-board.md" with { type: "text" };

const evolutionBoardSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("list"), Type.Literal("show"), Type.Literal("filter")],
		{ description: "操作类型" },
	),
	topicId: Type.Optional(Type.String({ description: "Topic ID（show 时必填）" })),
	filter: Type.Optional(
		Type.Object({
			status: Type.Optional(Type.String({ description: "按状态过滤" })),
			module: Type.Optional(Type.String({ description: "按模块过滤" })),
			tag: Type.Optional(Type.String({ description: "按标签过滤" })),
		}),
	),
});

type EvolutionBoardParams = Static<typeof evolutionBoardSchema>;

export class EvolutionBoardTool implements AgentTool<typeof evolutionBoardSchema> {
	readonly name = "evolution_board";
	readonly label = "Evolution Board";
	readonly description: string;
	readonly parameters = evolutionBoardSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(evolutionBoardDescription);
	}

	async execute(
		_toolCallId: string,
		params: EvolutionBoardParams,
	): Promise<AgentToolResult> {
		const board = createEvolutionBoard();

		const yamlPath = `${this.session.cwd}/docs/evolution-board.yaml`;
		try {
			const content = await Bun.file(yamlPath).text();
			board.load(content);
		} catch {
			return {
				content: [
					{
						type: "text",
						text: "No evolution board found. Create docs/evolution-board.yaml first.",
					},
				],
			};
		}

		switch (params.action) {
			case "list": {
				const topics = board.getTopics();
				const output = topics
					.map((t) => `${t.status} | ${t.name} | ${t.brief}`)
					.join("\n");
				return {
					content: [{ type: "text", text: output || "No topics found." }],
				};
			}
			case "show": {
				if (!params.topicId) {
					return {
						content: [
							{
								type: "text",
								text: "topicId is required for show action.",
							},
						],
						isError: true,
					};
				}
				const topic = board.getTopic(params.topicId);
				if (!topic) {
					return {
						content: [
							{
								type: "text",
								text: `Topic "${params.topicId}" not found.`,
							},
						],
						isError: true,
					};
				}
				const lines = [
					`# ${topic.name}`,
					`Status: ${topic.status}${topic.progress !== undefined ? ` (${topic.progress}%)` : ""}`,
					`Brief: ${topic.brief}`,
				];
				if (topic.description) lines.push(`\nDescription:\n${topic.description}`);
				if (topic.modules) lines.push(`\nModules: ${topic.modules.join(", ")}`);
				if (topic.references) {
					lines.push("\nReferences:");
					for (const ref of topic.references) {
						lines.push(`- ${ref.name}: ${ref.url}`);
					}
				}
				if (topic.notes) lines.push(`\nNotes:\n${topic.notes}`);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
				};
			}
			case "filter": {
				let topics = board.getTopics();
				if (params.filter?.status) {
					topics = board.getByStatus(params.filter.status as never);
				}
				if (params.filter?.module) {
					topics = board.getByModule(params.filter.module);
				}
				if (params.filter?.tag) {
					topics = board.getByTag(params.filter.tag);
				}
				const output = topics
					.map((t) => `${t.status} | ${t.name} | ${t.brief}`)
					.join("\n");
				return {
					content: [
						{ type: "text", text: output || "No topics match the filter." },
					],
				};
			}
		}
	}
}
