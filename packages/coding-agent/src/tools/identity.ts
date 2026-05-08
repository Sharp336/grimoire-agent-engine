import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { prompt } from "@oh-my-pi/pi-utils";
import identityDescription from "../prompts/tools/identity.md" with { type: "text" };
import { FilePersonaStore } from "../persona/store";
import { createEmptyPersona, type UserPersona } from "../persona/types";
import type { ToolSession } from ".";

const identitySchema = Type.Object({
	action: Type.String({
		description: "whoRu: agent identity; whoisme: user persona; update_persona: update persona",
	}),
	section: Type.Optional(
		Type.String({
			description:
				"For update_persona: section to update (basics/career/interests/preferences/interaction/thinking/constraints)",
		}),
	),
	data: Type.Optional(
		Type.Object(
			{},
			{
				description: "For update_persona: partial persona data to merge",
				additionalProperties: true,
			},
		),
	),
});

interface AgentIdentity {
	name: string;
	role: string;
	model: string;
	agentId: string;
	taskDepth: number;
	cwd: string;
	availableTools: string[];
	skills: string[];
	capabilities: string[];
	workStyle: string;
	constraints: string[];
}

export interface IdentityToolDetails {
	action: string;
	data: AgentIdentity | UserPersona | { success: boolean; updatedFields: string[] };
}

export class IdentityTool implements AgentTool<typeof identitySchema, IdentityToolDetails> {
	readonly name = "identity";
	readonly label = "Identity";
	readonly description: string;
	readonly parameters = identitySchema;
	readonly strict = true;

	readonly #session: ToolSession;
	readonly #store: FilePersonaStore;

	constructor(session: ToolSession) {
		this.description = prompt.render(identityDescription);
		this.#session = session;
		this.#store = new FilePersonaStore();
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof identitySchema>,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<IdentityToolDetails>> {
		const { action } = params;

		switch (action) {
			case "whoRu":
				return this.#handleWhoRu();
			case "whoisme":
				return this.#handleWhoisme();
			case "update_persona":
				return this.#handleUpdatePersona(params.section, params.data);
			default:
				return {
					content: [
						{
							type: "text",
							text: `Unknown action: ${action}. Use whoRu, whoisme, or update_persona.`,
						},
					],
					isError: true,
				};
		}
	}

	#handleWhoRu(): AgentToolResult<IdentityToolDetails> {
		const identity: AgentIdentity = {
			name: "Oh My Pi",
			role: "全栈编码搭档与技术顾问",
			model: this.#session.getActiveModelString?.() ?? "unknown",
			agentId: this.#session.getAgentId?.() ?? "0-Main",
			taskDepth: this.#session.taskDepth ?? 0,
			cwd: this.#session.cwd,
			availableTools: [], // populated from session context
			skills: this.#session.skills?.map(s => s.name) ?? [],
			capabilities: [
				"代码操作：读取、编辑、重构、搜索、批量替换",
				"运行时：执行 Bash 命令、Python 脚本、Node.js",
				"代码智能：AST 分析、LSP 语义查询、类型检查",
				"项目管理：任务拆分、并行子智能体、待办追踪",
				"外部集成：GitHub、Web 搜索、浏览器、MCP 服务器",
				"架构分析：GitNexus 代码知识图谱、路由/工具映射",
			],
			workStyle: "简洁直接，拒绝废话。先理解问题，再给出方案。高 agency，主动推进。严谨验证，不编造信息。",
			constraints: [
				"必须回答完整才能 yield",
				"禁止编造未观察到的结果",
				"禁止解决假想问题而非实际问题",
				"用户指令优先于默认风格",
			],
		};

		const text = this.#formatWhoRu(identity);
		return {
			content: [{ type: "text", text }],
			details: { action: "whoRu", data: identity },
		};
	}

	#formatWhoRu(identity: AgentIdentity): string {
		const lines: string[] = [
			"# Oh My Pi 智能助手",
			"",
			"## 身份定位",
			`- 名称：${identity.name}`,
			`- 角色：${identity.role}`,
			"- 形态：基于 Claude 大模型的 AI 编程智能体",
			"",
			"## 当前配置",
			`- 模型：${identity.model}`,
			`- 会话：${identity.agentId} | 深度 ${identity.taskDepth}`,
			`- 工作目录：${identity.cwd}`,
			"",
			"## 核心能力",
			...identity.capabilities.map(c => `- ${c}`),
			"",
			"## 工作风格",
			`- ${identity.workStyle}`,
			"",
			"## 当前状态",
			`- 可用工具：${identity.availableTools.length} 个`,
			`- 已加载技能：${identity.skills.join(", ") || "none"}`,
			"",
			"## Agent 约束",
			...identity.constraints.map(c => `- ${c}`),
		];
		return lines.join("\n");
	}

	async #handleWhoisme(): Promise<AgentToolResult<IdentityToolDetails>> {
		const persona = await this.#store.load();
		if (!persona) {
			const empty = createEmptyPersona();
			const text = "尚未配置用户人设。你可以通过 identity 工具的 update_persona 动作来填写你的人设模板。";
			return {
				content: [{ type: "text", text }],
				details: { action: "whoisme", data: empty },
			};
		}

		const text = this.#formatWhoisme(persona);
		return {
			content: [{ type: "text", text }],
			details: { action: "whoisme", data: persona },
		};
	}

	#formatWhoisme(persona: UserPersona): string {
		const b = persona.basics;
		const c = persona.career;
		const i = persona.interests;
		const p = persona.preferences;
		const inter = persona.interaction;
		const t = persona.thinking;
		const cons = persona.constraints;

		const lines: string[] = ["# 用户人设", "", "## 一、基础个人信息"];
		if (b.gender) lines.push(`- 性别：${b.gender}`);
		if (b.birthday) lines.push(`- 生日：${b.birthday}`);
		if (b.zodiac) lines.push(`- 星座：${b.zodiac}`);
		if (b.mbti) lines.push(`- MBTI：${b.mbti}`);
		if (b.lifeStage) lines.push(`- 人生阶段：${b.lifeStage}`);
		if (b.location) lines.push(`- 地域：${b.location}`);
		if (b.pace) lines.push(`- 做事节奏：${b.pace}`);
		if (b.languageStyle) lines.push(`- 语言风格：${b.languageStyle}`);

		lines.push("", "## 二、职业与身份画像");
		if (c.industry) lines.push(`- 行业：${c.industry}`);
		if (c.role) lines.push(`- 岗位：${c.role}`);
		if (c.dailyWork) lines.push(`- 日常工作：${c.dailyWork}`);
		if (c.expertise?.length) lines.push(`- 擅长领域：${c.expertise.join("、")}`);
		if (c.lifeGoal) lines.push(`- 人生目标：${c.lifeGoal}`);
		if (c.thinkingPattern) lines.push(`- 思维范式：${c.thinkingPattern}`);

		lines.push("", "## 三、关注话题图谱");
		if (i.longTerm.length) lines.push(`- 长期关注：${i.longTerm.join("、")}`);
		if (i.shortTerm.length) lines.push(`- 短期兴趣：${i.shortTerm.join("、")}`);
		if (i.avoid.length) lines.push(`- 避坑话题：${i.avoid.join("、")}`);
		if (i.priorities.length) lines.push(`- 优先级：${i.priorities.join(" > ")}`);

		lines.push("", "## 四、喜好与风格特质");
		if (p.contentType) lines.push(`- 内容偏好：${p.contentType}`);
		if (p.communicationStyle) lines.push(`- 沟通风格：${p.communicationStyle}`);
		if (p.outputFormat) lines.push(`- 输出格式：${p.outputFormat}`);
		if (p.contentStyle) lines.push(`- 内容风格：${p.contentStyle}`);
		if (p.tolerance) lines.push(`- 纠错习惯：${p.tolerance}`);
		if (p.hobbies?.length) lines.push(`- 兴趣爱好：${p.hobbies.join("、")}`);

		lines.push("", "## 五、交互对话习惯");
		if (inter.commonCommands?.length) lines.push(`- 常用指令：${inter.commonCommands.join("、")}`);
		if (inter.replyStyle) lines.push(`- 回复风格：${inter.replyStyle}`);
		lines.push(`- 允许主动延伸：${inter.proactive ? "是" : "否"}`);
		if (inter.errorHandling) lines.push(`- 出错处理：${inter.errorHandling}`);

		lines.push("", "## 六、思维决策模式");
		if (t.workStyle) lines.push(`- 做事风格：${t.workStyle}`);
		if (t.choicePreference) lines.push(`- 选择倾向：${t.choicePreference}`);
		if (t.logicHabit) lines.push(`- 逻辑习惯：${t.logicHabit}`);
		if (t.riskAppetite) lines.push(`- 风险偏好：${t.riskAppetite}`);

		lines.push("", "## 七、Agent 专属约束");
		if (cons.forbidden.length) lines.push(`- 禁止行为：${cons.forbidden.join("、")}`);
		if (cons.formatRules) lines.push(`- 格式规则：${cons.formatRules}`);
		if (cons.memoryRules) lines.push(`- 记忆规则：${cons.memoryRules}`);
		if (cons.accuracyRules) lines.push(`- 专业对齐：${cons.accuracyRules}`);

		return lines.join("\n");
	}

	async #handleUpdatePersona(
		section?: string,
		data?: Record<string, unknown>,
	): Promise<AgentToolResult<IdentityToolDetails>> {
		if (!section || !data) {
			return {
				content: [
					{
						type: "text",
						text: "update_persona requires both 'section' and 'data' parameters.",
					},
				],
				isError: true,
			};
		}

		const validSections = [
			"basics",
			"career",
			"interests",
			"preferences",
			"interaction",
			"thinking",
			"constraints",
		];
		if (!validSections.includes(section)) {
			return {
				content: [
					{
						type: "text",
						text: `Invalid section "${section}". Valid: ${validSections.join(", ")}`,
					},
				],
				isError: true,
			};
		}

		let persona = await this.#store.load();
		if (!persona) {
			persona = createEmptyPersona();
		}

		// Merge data into the specified section
		const existing = persona[section as keyof UserPersona] as Record<string, unknown>;
		const merged = { ...existing, ...data };
		(persona as Record<string, unknown>)[section] = merged;
		persona.updatedAt = Date.now();

		await this.#store.save(persona);

		const updatedFields = Object.keys(data);
		const text = `已更新人设 [${section}]：${updatedFields.join("、")}`;
		return {
			content: [{ type: "text", text }],
			details: { action: "update_persona", data: { success: true, updatedFields } },
		};
	}
}
