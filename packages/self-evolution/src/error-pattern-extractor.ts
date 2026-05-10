/**
 * ErrorPatternExtractor: analyzes SessionTrace to identify recurring error
 * patterns with root-cause attribution and causal tool-chain context.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { TraceAnalyzer } from "./trace-analyzer";
import type { ErrorPattern, ReadFailureType, SessionTrace } from "./types";

interface ErrorPatternDef {
	id: string;
	name: string;
	description: string;
	regex: RegExp;
	category: ErrorPattern["category"];
	convention: string;
}

const BASE_PATTERNS: Array<{
	id: string;
	name: string;
	description: string;
	regex: string;
	category: ErrorPattern["category"];
	convention: string;
}> = [
	{
		id: "edit-payload-format",
		name: "Edit payload format error",
		description: "Edit tool payload lines must start with ~",
		regex: "unrecognized op|payload lines|Use < ANCHOR|\\+ ANCHOR|- A\\.\\.B|= A\\.\\.B",
		category: "format",
		convention: "使用 edit 工具时，所有 payload lines 必须以 ~ 开头；操作符必须是 <、+、-、= 之一",
	},
	{
		id: "file-not-found",
		name: "File not found",
		description: "File or path does not exist",
		regex: "ENOENT|no such file or directory|Path not found",
		category: "not_found",
		convention: "操作文件前先确认路径存在，或使用 Bun.write 自动创建父目录",
	},
	{
		id: "permission-denied",
		name: "Permission denied",
		description: "Permission denied accessing file or resource",
		regex: "EACCES|permission denied|Access denied",
		category: "permission",
		convention: "遇到权限错误时检查文件权限或使用 sudo",
	},
	{
		id: "type-error",
		name: "Type error",
		description: "Type error in code execution",
		regex: "TypeError|Cannot read propert|Cannot access|is not a function",
		category: "type",
		convention: "访问对象属性前先检查对象是否已定义",
	},
	{
		id: "module-not-found",
		name: "Module not found",
		description: "Module or import not found",
		regex: "Cannot find module|Module not found|import.*failed",
		category: "not_found",
		convention: "导入模块前确认已安装依赖",
	},
	{
		id: "syntax-error",
		name: "Syntax error",
		description: "Syntax error in code",
		regex: "SyntaxError|Unexpected token|Expected.*but got",
		category: "syntax",
		convention: "修改代码后运行类型检查 (bun check) 验证语法",
	},
	{
		id: "json-parse-error",
		name: "JSON parse error",
		description: "Invalid JSON format",
		regex: "JSON\\.parse|Unexpected token.*JSON|invalid json",
		category: "syntax",
		convention: "JSON 内容必须严格符合格式，键名用双引号",
	},
	{
		id: "command-failed",
		name: "Command failed",
		description: "Shell command exited with error",
		regex: "exit code|command failed|Command failed",
		category: "runtime",
		convention: "运行命令前确认工作目录和参数正确",
	},
	{
		id: "rate-limited-429",
		name: "Rate limited (429)",
		description: "API rate limit exceeded",
		regex: "429|rate limit|too many requests|throttled",
		category: "runtime",
		convention: "遇到 429 限流时主动降低请求频率，添加指数退避重试",
	},
	{
		id: "network-timeout",
		name: "Network timeout",
		description: "Request timed out",
		regex: "ETIMEDOUT|ECONNREFUSED|timeout|connection refused|network error",
		category: "runtime",
		convention: "网络超时或连接失败时检查服务可用性，必要时增加超时时间或重试",
	},
	{
		id: "api-error-5xx",
		name: "Server error (5xx)",
		description: "Remote server returned 5xx",
		regex: "500|502|503|504|Internal Server Error|Bad Gateway|Service Unavailable",
		category: "runtime",
		convention: "服务端返回 5xx 时稍后重试，或检查服务状态页面",
	},
];

function compileErrorPatterns(): ErrorPatternDef[] {
	return BASE_PATTERNS.map(def => ({
		id: def.id,
		name: def.name,
		description: def.description,
		regex: new RegExp(def.regex, "i"),
		category: def.category,
		convention: def.convention,
	}));
}

const READ_FAILURE_CONVENTIONS: Record<ReadFailureType, string> = {
	path_not_found: "操作文件前先确认路径存在，或使用 find 定位文件",
	permission_denied: "遇到权限错误时检查文件权限或使用 sudo",
	invalid_sel: "使用 read 时，sel 参数必须是 1-indexed 的有效行范围格式",
	verify_after_edit_failure: "edit/write 失败后，read 验证路径可能是过期的 —— 先确认编辑是否成功再验证",
	search_misled: "search/find 失败后再 read 猜测路径，容易再次失败 —— 先用 find 确认路径存在",
	other: "read 调用失败，请检查路径、参数和文件存在性",
};

export class ErrorPatternExtractor {
	readonly #patterns: ErrorPatternDef[] = compileErrorPatterns();
	readonly #analyzer = new TraceAnalyzer();

	extract(trace: SessionTrace): ErrorPattern[] {
		const results: ErrorPattern[] = [];
		const seen = new Set<string>();
		const now = Date.now();
		const errorDetails = trace.errorDetails ?? [];

		// Phase 1: Base regex matching (backward-compatible)
		for (const errorDetail of errorDetails) {
			for (const def of this.#patterns) {
				if (!def.regex.test(errorDetail)) continue;
				if (seen.has(def.id)) continue;
				seen.add(def.id);

				const pattern: ErrorPattern = {
					id: def.id,
					name: def.name,
					description: def.description,
					regex: def.regex.source,
					category: def.category,
					affectedSessions: [trace.sessionId],
					count: 1,
					firstSeenAt: now,
					lastSeenAt: now,
					extractedConventions: [def.convention],
				};
				results.push(pattern);
				logger.debug("Extracted base error pattern", { id: def.id, sessionId: trace.sessionId });
			}
		}

		// Phase 2: Causal read-failure analysis with root-cause attribution
		const diagnosis = this.#analyzer.analyze(trace);
		for (const rf of diagnosis.readFailures) {
			const id = `read-failure-${rf.failureType}`;
			if (seen.has(id)) continue;
			seen.add(id);

			const convention = READ_FAILURE_CONVENTIONS[rf.failureType];
			const contextualConvention = rf.precedingTool
				? `${convention} (context: preceded by ${rf.precedingTool} which ${rf.precedingToolSuccess ? "succeeded" : "failed"})`
				: convention;

			const pattern: ErrorPattern = {
				id,
				name: `Read failure: ${rf.failureType}`,
				description: `read tool failed with ${rf.failureType}${rf.attemptedPath ? ` on path "${rf.attemptedPath}"` : ""}`,
				regex: rf.failureType,
				category: "not_found",
				affectedSessions: [trace.sessionId],
				count: 1,
				firstSeenAt: now,
				lastSeenAt: now,
				extractedConventions: [contextualConvention, rf.suggestion],
			};
			results.push(pattern);
			logger.debug("Extracted causal read-failure pattern", {
				failureType: rf.failureType,
				precedingTool: rf.precedingTool,
				sessionId: trace.sessionId,
			});
		}

		// Phase 3: Cascade pattern extraction
		for (const cascade of diagnosis.cascadePatterns) {
			const id = `cascade-${cascade.triggerTool}-${cascade.followUpTool}`;
			if (seen.has(id)) continue;
			seen.add(id);

			const pattern: ErrorPattern = {
				id,
				name: `Cascade: ${cascade.triggerTool} → ${cascade.followUpTool}`,
				description: cascade.rootCause,
				regex: `${cascade.triggerTool}.*${cascade.followUpTool}`,
				category: "other",
				affectedSessions: [trace.sessionId],
				count: cascade.count,
				firstSeenAt: now,
				lastSeenAt: now,
				extractedConventions: [
					`${cascade.triggerTool} 失败后不要立即用 ${cascade.followUpTool} 补救，先分析根因: ${cascade.rootCause}`,
				],
			};
			results.push(pattern);
			logger.debug("Extracted cascade pattern", {
				trigger: cascade.triggerTool,
				followUp: cascade.followUpTool,
				rootCause: cascade.rootCause,
				sessionId: trace.sessionId,
			});
		}

		return results;
	}
}
