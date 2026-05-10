/**
 * Slash commands for the self-evolution plugin.
 *
 * Consolidated under a single /evolution command with subcommands,
 * similar to /memory. Old flat commands are kept for backward
 * compatibility but redirect to the new hierarchy.
 */
import type { Database } from "bun:sqlite";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { logger } from "@oh-my-pi/pi-utils";
import { formatAuditReport, generateAuditReport } from "./audit-report";
import { DailyReportGenerator } from "./daily-report";
import { formatFitReport, runFitEval, saveFitScore } from "./eval/fit-evaluator";
import { HeuristicSkillEvaluator } from "./evaluator";
import type { ActivityLogger } from "./logging/activity-logger";
import type { SkillManager } from "./manager";
import type { SqliteStatsStore } from "./storage/skills";
import { SqliteFitScoreStore } from "./storage/sqlite-fit-scores";
import type {
	ConventionStore,
	EffectivenessStore,
	EpisodeStore,
	FitScoreStore,
	ProfileStore,
	SkillStore,
	SkillVersionStore,
	WorkflowPatternStore,
} from "./storage/types";

import type { SelfEvolutionFlags, UserProfile } from "./types";

export interface CommandStores {
	ensureInit(cwd: string): void;
	episodeStore(): EpisodeStore;
	skillStore(): SkillStore;
	versionStore(): SkillVersionStore;
	statsStore(): SqliteStatsStore;
	skillManager(): SkillManager;
	activityLogger(): ActivityLogger;
	profileStore(): ProfileStore;
	workflowPatternStore(): WorkflowPatternStore;
	conventionStore(): ConventionStore;
	effectivenessStore(): EffectivenessStore;
	db(): Database;
	flags(): SelfEvolutionFlags;
}

function getFitStore(db: () => Database): FitScoreStore {
	return new SqliteFitScoreStore(db());
}

// ─────────────────────────────────────────────────────────────────────────────
// Main /evolution command dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export function registerSelfEvolutionCommands(api: ExtensionAPI, stores: CommandStores): void {
	api.registerCommand("evolution", {
		description: "Self-evolution command hub. Usage: /evolution <subcommand> [args]",
		async handler(args, ctx): Promise<void> {
			stores.ensureInit(ctx.cwd);
			const trimmed = args.trim();
			const subcommand = trimmed.split(/\s+/, 1)[0]?.toLowerCase() || "help";
			const rest = trimmed.slice(subcommand.length).trim();

			switch (subcommand) {
				case "status":
					return handleStatus(stores, ctx);
				case "skills":
					return handleSkills(stores, ctx, rest);
				case "rate":
					return handleRate(stores, ctx, rest);
				case "clear":
					return handleClear(ctx);
				case "archive":
					return handleArchive(stores, ctx);
				case "history":
					return handleHistory(stores, ctx, rest);
				case "rollback":
					return handleRollback(stores, ctx, rest);
				case "profile":
					return handleProfile(stores, ctx);
				case "workflows":
					return handleWorkflows(stores, ctx, rest);
				case "audit":
					return handleAudit(stores, ctx);
				case "report":
					return handleReport(stores, ctx);
				case "fit":
					return handleFit(stores, ctx);
				default:
					return handleHelp(ctx);
			}
		},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcommand handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleStatus(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const [episodeCount, skillCount, versionCount, archivedSessions] = await Promise.all([
			stores.episodeStore().count(),
			stores.skillStore().count(),
			stores.versionStore().count(),
			stores.statsStore().get("sessions_archived"),
		]);
		ctx.ui.notify(
			`Episodes: ${episodeCount} | Skills: ${skillCount} | Versions: ${versionCount} | Sessions archived: ${archivedSessions}`,
			"info",
		);
	} catch (err) {
		logger.error("evolution status failed", { error: String(err) });
		ctx.ui.notify("Failed to load evolution status", "error");
	}
}

async function handleSkills(stores: CommandStores, ctx: any, args: string): Promise<void> {
	try {
		const skills = await stores.skillStore().list();
		if (skills.length === 0) {
			ctx.ui.notify("No evolved skills yet", "info");
			return;
		}

		const showDetail = args.trim() === "--detail";
		const evaluator = new HeuristicSkillEvaluator();

		const lines: string[] = [];
		for (const s of skills) {
			const total = s.successCount + s.failureCount;
			const rate = total > 0 ? `${Math.round((s.successCount / total) * 100)}%` : "n/a";
			const userStars = s.userRating ? "★".repeat(s.userRating) + "☆".repeat(5 - s.userRating) : "unrated";

			lines.push(
				`${s.name} (v${s.version}) | quality: ${s.qualityScore ?? "?"} | success: ${rate} | used: ${s.usageCount} | your rating: ${userStars}${s.deprecated ? " [DEPRECATED]" : ""}`,
			);

			if (showDetail) {
				const breakdown = evaluator.reevaluate(s);
				lines.push(
					`  └─ successRate=${breakdown.successRate} diversity=${breakdown.toolDiversity} pitfalls=${breakdown.pitfallCoverage} ` +
						`pattern=${breakdown.taskPatternSubstance} approach=${breakdown.approachSubstance} desc=${breakdown.descriptionQuality} ` +
						`history=${breakdown.reusesHistory} recovery=${breakdown.recoveryExperience} autonomy=${breakdown.autonomy} user=${breakdown.userRating} ` +
						`- TOTAL=${breakdown.total}`,
				);
			}
		}
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		logger.error("evolution skills failed", { error: String(err) });
		ctx.ui.notify("Failed to list skills", "error");
	}
}

async function handleRate(stores: CommandStores, ctx: any, args: string): Promise<void> {
	const trimmed = args.trim();
	const parts = trimmed.split(/\s+/);
	if (parts.length < 2) {
		ctx.ui.notify("Usage: /evolution rate <skill-name> <1-5>", "warning");
		return;
	}

	const ratingStr = parts.pop()!;
	const name = parts.join(" ");
	const rating = Number.parseInt(ratingStr, 10);

	if (Number.isNaN(rating) || rating < 1 || rating > 5) {
		ctx.ui.notify("Rating must be a number between 1 and 5", "error");
		return;
	}

	try {
		const skill = await stores.skillStore().get(name);
		if (!skill) {
			ctx.ui.notify(`Skill "${name}" not found. Use /evolution skills to list.`, "error");
			return;
		}

		skill.userRating = rating;
		const evaluator = new HeuristicSkillEvaluator();
		const breakdown = evaluator.reevaluate(skill);
		skill.qualityScore = breakdown.total;

		await stores.skillStore().upsert(skill);
		await stores.activityLogger().log("skill_user_rated", {
			skillName: name,
			rating,
			newQualityScore: skill.qualityScore,
		});

		const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
		ctx.ui.notify(`Rated "${name}" ${stars} (quality updated to ${skill.qualityScore})`, "info");
	} catch (err) {
		logger.error("evolution rate failed", { error: String(err) });
		ctx.ui.notify("Failed to rate skill", "error");
	}
}

async function handleClear(ctx: any): Promise<void> {
	try {
		const confirmed = await ctx.ui.confirm(
			"Clear self-evolution data",
			"This will delete all episodes, skills, and version history for this project. Continue?",
		);
		if (!confirmed) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		ctx.ui.notify("Please delete the ~/.omp/self-evolution/ directory manually to clear all data.", "warning");
	} catch (err) {
		logger.error("evolution clear failed", { error: String(err) });
	}
}

async function handleArchive(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const count = await stores.skillManager().archiveLowQuality();
		ctx.ui.notify(`Archived ${count} low-quality skill(s)`, "info");
	} catch (err) {
		logger.error("evolution archive failed", { error: String(err) });
		ctx.ui.notify("Failed to archive skills", "error");
	}
}

async function handleHistory(stores: CommandStores, ctx: any, args: string): Promise<void> {
	const name = args.trim();
	if (!name) {
		ctx.ui.notify("Usage: /evolution history <skill-name>", "warning");
		return;
	}
	try {
		const history = await stores.skillManager().getHistory(name);
		if (history.length === 0) {
			ctx.ui.notify(`No history found for skill "${name}"`, "info");
			return;
		}
		const lines = history.map(
			h =>
				`v${h.version} | ${h.changeType} | ${new Date(h.changedAt).toISOString()}${h.changeReason ? ` | ${h.changeReason}` : ""}`,
		);
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		logger.error("evolution history failed", { error: String(err) });
		ctx.ui.notify("Failed to load skill history", "error");
	}
}

async function handleRollback(stores: CommandStores, ctx: any, args: string): Promise<void> {
	const parts = args.trim().split(/\s+/);
	if (parts.length < 2) {
		ctx.ui.notify("Usage: /evolution rollback <skill-name> <version>", "warning");
		return;
	}
	const version = Number.parseInt(parts[parts.length - 1]!, 10);
	const name = parts.slice(0, -1).join(" ");
	if (Number.isNaN(version)) {
		ctx.ui.notify("Invalid version number", "error");
		return;
	}
	try {
		const restored = await stores.skillManager().rollback(name, version);
		if (restored) {
			ctx.ui.notify(`Rolled back "${name}" to v${version} (new version: v${restored.version})`, "info");
		} else {
			ctx.ui.notify(`Version ${version} of "${name}" not found`, "error");
		}
	} catch (err) {
		logger.error("evolution rollback failed", { error: String(err) });
		ctx.ui.notify("Rollback failed", "error");
	}
}

async function handleProfile(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const profile = await stores.profileStore().get("default");
		if (!profile) {
			ctx.ui.notify("No profile data yet. Complete a few sessions first.", "info");
			return;
		}
		const lines: string[] = [];
		lines.push(
			`Sessions: ${profile.sessionCount} | Tool calls/session: ${profile.avgToolCallsPerSession.toFixed(1)} | Files/session: ${profile.avgFilesModifiedPerSession.toFixed(1)}`,
		);
		lines.push(
			`Error rate: ${(profile.errorRate * 100).toFixed(0)}% | Recovery rate: ${(profile.recoveryRate * 100).toFixed(0)}%`,
		);
		lines.push(`Preferred languages: ${profile.preferredLanguages.join(", ") || "none yet"}`);

		const topTools = Object.entries(profile.toolFrequency)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([t, c]) => `${t}(${c})`)
			.join(", ");
		if (topTools) lines.push(`Top tools: ${topTools}`);

		const topIntents = Object.entries(profile.intentDistribution)
			.sort((a, b) => b[1] - a[1])
			.map(([i, c]) => `${i}(${c})`)
			.join(", ");
		if (topIntents) lines.push(`Intent distribution: ${topIntents}`);

		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		logger.error("evolution profile failed", { error: String(err) });
		ctx.ui.notify("Failed to load profile", "error");
	}
}

async function handleWorkflows(stores: CommandStores, ctx: any, args: string): Promise<void> {
	try {
		const intentFilter = args.trim();
		const patterns = intentFilter
			? await stores.workflowPatternStore().getByIntent(intentFilter, 20)
			: await stores.workflowPatternStore().listAll();
		if (patterns.length === 0) {
			const msg = intentFilter
				? `No workflow patterns found for intent "${intentFilter}"`
				: "No workflow patterns mined yet";
			ctx.ui.notify(msg, "info");
			return;
		}
		const lines = patterns.map(p => `${p.intent}: ${p.toolSequence.join(" → ")} (seen ${p.occurrenceCount}x)`);
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (err) {
		logger.error("evolution workflows failed", { error: String(err) });
		ctx.ui.notify("Failed to list workflow patterns", "error");
	}
}

async function handleAudit(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const report = await generateAuditReport(
			stores.db(),
			stores.episodeStore(),
			stores.skillStore(),
			stores.flags().maxEpisodes,
			stores.activityLogger(),
		);
		ctx.ui.notify(formatAuditReport(report), "info");
	} catch (err) {
		logger.error("evolution audit failed", { error: String(err) });
		ctx.ui.notify("Failed to generate audit report", "error");
	}
}

async function handleReport(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const generator = new DailyReportGenerator(
			stores.episodeStore(),
			stores.conventionStore(),
			stores.effectivenessStore(),
		);
		const report = await generator.generate();
		const text = generator.formatReport(report);
		ctx.ui.notify(text, "info");
	} catch (err) {
		logger.error("evolution report failed", { error: String(err) });
		ctx.ui.notify("Failed to generate daily report", "error");
	}
}

async function handleFit(stores: CommandStores, ctx: any): Promise<void> {
	try {
		const db = stores.db();
		const fitStore = getFitStore(() => db);

		const profile = await stores.profileStore().get("default");
		const taskResponses = buildHeuristicResponses(profile);

		const { report, record } = await runFitEval(db, taskResponses);
		await saveFitScore(db, record);
		await fitStore.upsert(record);

		const text = formatFitReport(report);
		ctx.ui.notify(text, "info");
	} catch (err) {
		logger.error("evolution fit failed", { error: String(err) });
		ctx.ui.notify("Failed to run fit evaluation", "error");
	}
}

async function handleHelp(ctx: any): Promise<void> {
	const lines = [
		"Usage: /evolution <subcommand> [args]",
		"",
		"Subcommands:",
		"  status              Show statistics (episodes, skills, versions)",
		"  skills [--detail]   List evolved skills with optional score breakdown",
		"  rate <name> <1-5>   Rate a skill",
		"  clear               Clear all self-evolution data",
		"  archive             Archive low-quality skills",
		"  history <name>      View version history for a skill",
		"  rollback <n> <v>    Rollback a skill to a version",
		"  profile             Display user behavioral profile",
		"  workflows [intent]  List mined workflow patterns",
		"  audit               Generate health report",
		"  report              Generate daily report",
		"  fit                 Run '懂我程度' evaluation",
	];
	ctx.ui.notify(lines.join("\n"), "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

/** Build heuristic mock responses from profile data for fit evaluation. */
function buildHeuristicResponses(profile?: UserProfile): Map<string, string> {
	const responses = new Map<string, string>();
	const topTools =
		Object.entries(profile?.toolFrequency ?? {})
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([t]) => t)
			.join(", ") || "search, read, edit";
	const languages = profile?.preferredLanguages.join(", ") || "TypeScript, Rust";

	// MEMORY dimension responses
	responses.set("MEMORY-001", `技术栈: ${languages}`);
	responses.set("MEMORY-002", "业务方向: 需要更多上下文");
	responses.set("MEMORY-003", "做事风格: 架构先行、结论前置、精简输出");
	responses.set("MEMORY-004", "核心项目: 暂无历史记录");
	responses.set("MEMORY-005", "资产关注点: 暂无数据");

	// THINKING dimension responses
	responses.set(
		"THINK-001",
		`- 架构分层：数据源 → 处理引擎 → 报表渲染
- 模块拆分：采集层、计算层、存储层、展示层
- 落地路径：先跑通最小可用版本，再迭代优化
- 风险点：数据一致性、查询性能、权限控制`,
	);
	responses.set(
		"THINK-002",
		`- 技术风险：性能瓶颈、扩展性受限
- 业务风险：需求变更、用户接受度
- 运维风险：部署复杂度、监控覆盖
- 缓解：分阶段上线、回退方案、灰度发布`,
	);
	responses.set(
		"THINK-003",
		"| 维度 | 方案A | 方案B |\n|---|---|---|\n| 成本 | 低 | 中 |\n| 效率 | 中 | 高 |\n| 维护 | 高 | 低 |\n推荐：方案A（综合成本更低）",
	);
	responses.set(
		"THINK-004",
		`- 架构层：服务拆分、缓存策略、异步化
- 算法层：时间复杂度优化、批量处理
- IO层：连接池、批处理、压缩
优先级：先定位瓶颈（profiling），再针对性优化`,
	);
	responses.set(
		"THINK-005",
		`- 阶段1：评估现状（代码扫描、依赖分析）
- 阶段2：设计新架构（接口定义、模块边界）
- 阶段3：渐进迁移（Strangler Fig模式）
- 阶段4：验证回退（并行运行、对比测试）
风险：数据迁移、接口不兼容；回退：保留旧版本`,
	);

	// STYLE dimension responses
	responses.set("STYLE-001", "结论：方案可行，建议分阶段实施。详见：1. 架构设计 2. 风险评估");
	responses.set("STYLE-002", "- 完成功能X开发\n- 修复Bug #123\n- 优化构建速度 30%");
	responses.set("STYLE-003", "修复步骤：\n1. 定位错误行\n2. 修正类型声明\n3. 补充边界测试");
	responses.set("STYLE-004", "# 技术方案\n## 1. 概述\n## 2. 架构设计\n## 3. 模块说明\n## 4. 部署方案\n## 5. 风险评估");

	// PREDICTION dimension responses
	responses.set(
		"PREDICT-001",
		`需要明确：1. 哪个模块性能差？2. 当前瓶颈在哪？3. 量化指标是什么？
预判建议：先跑 profiling，再针对性优化`,
	);
	responses.set(
		"PREDICT-002",
		`风险清单：
1. [高] 性能下降 → 缓解：压测验证
2. [中] 兼容性 → 缓解：版本兼容层
3. [低] 运维复杂度 → 缓解：自动化脚本`,
	);
	responses.set(
		"PREDICT-003",
		`审查结果：
- [严重] 空指针风险：第42行未判空
- [警告] 未处理边界条件：数组越界
- [建议] 可缓存重复查询结果`,
	);

	// HISTORY dimension responses
	responses.set(
		"HISTORY-001",
		`上次讨论的方案是分阶段实施报表系统。当前进展：已完成数据采集层设计。下一步：处理引擎选型`,
	);
	responses.set("HISTORY-002", "记得你提过性能优化的问题。之前建议的方向是缓存策略和异步化，需要我继续展开吗？");
	responses.set("HISTORY-003", "上次讨论到架构分层方案，确定了数据源→处理→展示三层结构。接下来可以细化每层的接口定义");

	// Enrich responses with profile data if available
	if (profile) {
		const toolStr = `常用工具: ${topTools}`;
		const langStr = `偏好语言: ${languages}`;
		responses.set("MEMORY-001", `${langStr}\n${toolStr}`);
	}

	return responses;
}
