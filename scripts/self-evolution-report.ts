#!/usr/bin/env bun
/**
 * Self-evolution evolution report generator.
 * Queries the evolution SQLite DB and outputs a human-readable summary.
 */
import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as os from "node:os";

const dbPath = path.join(os.homedir(), ".omp", "self-evolution", "evolution.db");

function fmtDate(ts: number): string {
	return new Date(ts).toLocaleString("zh-CN");
}

function main() {
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch {
		console.log("Self-evolution 数据库尚未创建，还没有进化数据。");
		process.exit(0);
	}

	function tableExists(name: string): boolean {
		const r = db!.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) as
			| { 1: number }
			| undefined;
		return !!r;
	}

	// 1. 统计概览
	const episodeCount = tableExists("episodes")
		? ((db.query("SELECT COUNT(*) as c FROM episodes").get() as { c: number })?.c ?? 0)
		: 0;
	const skillCount = tableExists("skills")
		? ((db.query("SELECT COUNT(*) as c FROM skills WHERE deprecated = 0").get() as { c: number })?.c ?? 0)
		: 0;
	const skillTotal = tableExists("skills")
		? ((db.query("SELECT COUNT(*) as c FROM skills").get() as { c: number })?.c ?? 0)
		: 0;
	const versionCount = tableExists("skill_versions")
		? ((db.query("SELECT COUNT(*) as c FROM skill_versions").get() as { c: number })?.c ?? 0)
		: 0;
	const patternCount = tableExists("workflow_patterns")
		? ((db.query("SELECT COUNT(*) as c FROM workflow_patterns").get() as { c: number })?.c ?? 0)
		: 0;
	const nudgeCount = tableExists("nudge_history")
		? ((db.query("SELECT COUNT(*) as c FROM nudge_history").get() as { c: number })?.c ?? 0)
		: 0;

	console.log("╔══════════════════════════════════════════════════════════════╗");
	console.log("║           Self-Evolution 进化报告                            ║");
	console.log("╚══════════════════════════════════════════════════════════════╝");
	console.log();
	console.log(`📊 数据概览`);
	console.log(`   经验片段 (Episodes): ${episodeCount}`);
	console.log(`   进化技能 (Skills):   ${skillCount} (活跃) / ${skillTotal} (总计)`);
	console.log(`   技能版本 (Versions): ${versionCount}`);
	console.log(`   工作流模式 (Patterns): ${patternCount}`);
	console.log(`   跨会话提醒 (Nudges): ${nudgeCount}`);
	console.log();

	// 2. 最近的经验片段
	if (episodeCount > 0) {
		const recentEpisodes = db.query(
			"SELECT user_prompt, summary, timestamp, tool_call_count, completed_successfully FROM episodes ORDER BY timestamp DESC LIMIT 5",
		).all() as Array<{
			user_prompt: string;
			summary: string;
			timestamp: number;
			tool_call_count: number;
			completed_successfully: number;
		}>;
		console.log(`📝 最近 ${recentEpisodes.length} 条经验片段:`);
		for (const ep of recentEpisodes) {
			const status = ep.completed_successfully ? "✓" : "✗";
			const prompt = ep.user_prompt.length > 40 ? ep.user_prompt.slice(0, 40) + "..." : ep.user_prompt;
			console.log(`   [${status}] ${fmtDate(ep.timestamp)} | ${prompt} (${ep.tool_call_count} 工具调用)`);
		}
		console.log();
	}

	// 3. 技能进化
	if (skillCount > 0) {
		const topSkills = db.query(
			"SELECT name, description, quality_score, usage_count, success_count, failure_count, version, created_at FROM skills WHERE deprecated = 0 ORDER BY quality_score DESC LIMIT 5",
		).all() as Array<{
			name: string;
			description: string;
			quality_score: number | null;
			usage_count: number;
			success_count: number;
			failure_count: number;
			version: number;
			created_at: number;
		}>;
		console.log(`🧬 高质量进化技能 (Top ${topSkills.length}):`);
		for (const s of topSkills) {
			const total = s.success_count + s.failure_count;
			const rate = total > 0 ? `${Math.round((s.success_count / total) * 100)}%` : "n/a";
			const score = s.quality_score ?? "?";
			console.log(`   • ${s.name} (v${s.version}, 质量:${score}) — ${s.description.slice(0, 50)}${s.description.length > 50 ? "..." : ""}`);
			console.log(`     使用:${s.usage_count}次 | 成功率:${rate} | 创建于 ${fmtDate(s.created_at)}`);
		}
		console.log();
	}

	// 4. 工作流模式
	if (patternCount > 0) {
		const patterns = db.query(
			"SELECT intent, tool_sequence, occurrence_count, avg_quality_score FROM workflow_patterns ORDER BY occurrence_count DESC LIMIT 5",
		).all() as Array<{
			intent: string;
			tool_sequence: string;
			occurrence_count: number;
			avg_quality_score: number | null;
		}>;
		console.log(`🔄 常见工作流模式 (Top ${patterns.length}):`);
		for (const p of patterns) {
			const seq = p.tool_sequence;
			console.log(`   • ${p.intent}: ${seq} (出现 ${p.occurrence_count} 次)`);
		}
		console.log();
	}

	// 5. 用户画像
	if (tableExists("user_profiles")) {
		const profile = db.query("SELECT profile_json FROM user_profiles WHERE id = 'default'").get() as
			| { profile_json: string }
			| undefined;
		if (profile) {
			const p = JSON.parse(profile.profile_json) as {
				sessionCount: number;
				avgToolCallsPerSession: number;
				avgFilesModifiedPerSession: number;
				errorRate: number;
				recoveryRate: number;
				preferredLanguages: string[];
				toolFrequency: Record<string, number>;
				intentDistribution: Record<string, number>;
			};
			console.log(`👤 用户行为画像:`);
			console.log(`   会话数: ${p.sessionCount} | 平均工具调用/会话: ${p.avgToolCallsPerSession.toFixed(1)}`);
			console.log(`   平均修改文件/会话: ${p.avgFilesModifiedPerSession.toFixed(1)}`);
			console.log(`   错误率: ${(p.errorRate * 100).toFixed(0)}% | 恢复率: ${(p.recoveryRate * 100).toFixed(0)}%`);
			console.log(`   偏好语言: ${p.preferredLanguages.join(", ") || "暂无"}`);
			const topTools = Object.entries(p.toolFrequency)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([t, c]) => `${t}(${c})`)
				.join(", ");
			if (topTools) console.log(`   常用工具: ${topTools}`);
			const topIntents = Object.entries(p.intentDistribution)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([i, c]) => `${i}(${c})`)
				.join(", ");
			if (topIntents) console.log(`   意图分布: ${topIntents}`);
			console.log();
		}
	}

	// 6. 最近的跨会话提醒
	if (nudgeCount > 0) {
		const nudges = db.query(
			"SELECT type, severity, message, detected_at FROM nudge_history ORDER BY detected_at DESC LIMIT 3",
		).all() as Array<{
			type: string;
			severity: string;
			message: string;
			detected_at: number;
		}>;
		console.log(`⚠️ 最近跨会话提醒:`);
		for (const n of nudges) {
			const icon = n.severity === "warn" ? "🔶" : "ℹ️";
			console.log(`   ${icon} [${n.type}] ${n.message} (${fmtDate(n.detected_at)})`);
		}
		console.log();
	}

	// 7. 版本历史中的变更
	if (versionCount > 0) {
		const recentVersions = db.query(
			"SELECT name, version, change_type, change_reason, changed_at FROM skill_versions ORDER BY changed_at DESC LIMIT 5",
		).all() as Array<{
			name: string;
			version: number;
			change_type: string;
			change_reason: string | null;
			changed_at: number;
		}>;
		console.log(`📈 最近技能变更:`);
		for (const v of recentVersions) {
			const reason = v.change_reason ? ` — ${v.change_reason}` : "";
			console.log(`   • ${v.name} v${v.version}: ${v.change_type}${reason} (${fmtDate(v.changed_at)})`);
		}
		console.log();
	}

	console.log("═══════════════════════════════════════════════════════════════");
	console.log("报告生成完成。");

	db.close();
}

main();
