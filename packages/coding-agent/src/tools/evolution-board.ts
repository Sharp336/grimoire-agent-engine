import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { createEvolutionBoard, generateTopicId } from "../evolution-board/board";
import type { EvolutionTopic } from "../evolution-board/types";
import evolutionBoardDescription from "../prompts/tools/evolution-board.md" with { type: "text" };
import type { ToolSession } from ".";

const evolutionBoardSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("show"), Type.Literal("filter"), Type.Literal("add")], {
		description: "操作类型",
	}),
	topicId: Type.Optional(Type.String({ description: "Topic ID（show 时必填）" })),
	filter: Type.Optional(
		Type.Object({
			status: Type.Optional(
				Type.String({ description: "按状态过滤（planned|in-progress|review|testing|shipped|deferred）" }),
			),
			module: Type.Optional(Type.String({ description: "按模块过滤" })),
			tag: Type.Optional(Type.String({ description: "按标签过滤" })),
		}),
	),
	topic: Type.Optional(
		Type.Object({
			name: Type.String({ description: "Topic 名称（add 时必填）" }),
			brief: Type.String({ description: "Topic 简述（add 时必填）" }),
			description: Type.Optional(Type.String({ description: "详细描述" })),
			status: Type.Optional(
				Type.String({ description: "状态: planned|in-progress|review|testing|shipped|deferred" }),
			),
			progress: Type.Optional(Type.Number({ description: "进度百分比 0-100" })),
			modules: Type.Optional(Type.Array(Type.String(), { description: "所属模块列表" })),
			tags: Type.Optional(Type.Array(Type.String(), { description: "标签列表" })),
			notes: Type.Optional(Type.String({ description: "备注" })),
			references: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "引用名称" }),
						url: Type.String({ description: "引用 URL" }),
						note: Type.Optional(Type.String({ description: "引用备注" })),
					}),
					{ description: "参考链接列表" },
				),
			),
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

	async execute(_toolCallId: string, params: EvolutionBoardParams): Promise<AgentToolResult> {
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
				const output = topics.map(t => `${t.status} | ${t.name} | ${t.brief}`).join("\n");
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
				const output = topics.map(t => `${t.status} | ${t.name} | ${t.brief}`).join("\n");
				return {
					content: [{ type: "text", text: output || "No topics match the filter." }],
				};
			}
			case "add": {
				if (!params.topic) {
					return {
						content: [
							{
								type: "text",
								text: "topic is required for add action. Provide topic name and brief at minimum.",
							},
						],
					};
				}
				const { name, brief } = params.topic;
				if (!name || name.trim() === "") {
					return { content: [{ type: "text", text: "Topic name is required." }] };
				}
				if (!brief || brief.trim() === "") {
					return { content: [{ type: "text", text: "Brief description is required." }] };
				}
				const id = generateTopicId(name);
				if (board.getTopic(id)) {
					return {
						content: [{ type: "text", text: `A topic with ID "${id}" already exists. Use a different name.` }],
					};
				}
				const validStatuses = ["planned", "in-progress", "review", "testing", "shipped", "deferred"] as const;
				const rawStatus = params.topic.status ?? "planned";
				const status = validStatuses.includes(rawStatus as (typeof validStatuses)[number])
					? (rawStatus as EvolutionTopic["status"])
					: "planned";
				const topic: EvolutionTopic = {
					id,
					name: name.trim(),
					brief: brief.trim(),
					status,
					...(params.topic.description ? { description: params.topic.description } : {}),
					...(params.topic.progress !== undefined ? { progress: params.topic.progress } : {}),
					...(params.topic.modules && params.topic.modules.length > 0 ? { modules: params.topic.modules } : {}),
					...(params.topic.tags && params.topic.tags.length > 0 ? { tags: params.topic.tags } : {}),
					...(params.topic.notes ? { notes: params.topic.notes } : {}),
					...(params.topic.references && params.topic.references.length > 0
						? { references: params.topic.references }
						: {}),
				};
				try {
					board.addTopic(topic);
					await board.save(yamlPath);
					return {
						content: [{ type: "text", text: `Topic "${name}" added successfully with ID: ${id}` }],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Failed to save topic: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
					};
				}
			}
		}
	}
}
