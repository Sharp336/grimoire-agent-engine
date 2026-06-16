import { useEffect, useState } from "react";

type Locale = "en" | "zh";

const translations = {
	en: {
		// Header
		"header.title": "AI Usage",
		"header.subtitle": "Statistics & Analytics",
		"header.sync": "Sync",
		"header.syncing": "Syncing...",
		"header.tab.overview": "overview",
		"header.tab.requests": "requests",
		"header.tab.errors": "errors",
		"header.tab.models": "models",
		"header.tab.costs": "costs",
		"header.tab.behavior": "behavior",
		"header.range.all": "All time",
		"header.range.last": "Last",

		// Request List
		"requestList.model": "Model",
		"requestList.provider": "Provider",
		"requestList.time": "Time",
		"requestList.tokens": "Tokens",
		"requestList.cost": "Cost",
		"requestList.duration": "Duration",
		"requestList.status": "Status",
		"requestList.input": "Input",
		"requestList.output": "Output",
		"requestList.cacheRead": "Cache Read",
		"requestList.cacheWrite": "Cache Write",
		"requestList.reasoning": "Reasoning",
		"requestList.tps": "Tok/s",
		"requestList.noRequests": "No requests found",
		"requestList.recentRequests": "Recent Requests",
		"requestList.recentErrors": "Recent Errors",
		"requestList.allRequests": "All Recent Requests",
		"requestList.failedRequests": "Failed Requests",
		"requestList.showing": "Showing {start}-{end} of {total}",
		"requestList.pageSize": "Page size",

		// Request Detail
		"requestDetail.title": "Request Details",
		"requestDetail.success": "Success",
		"requestDetail.error": "Error",
		"requestDetail.cost": "Cost",
		"requestDetail.premiumReqs": "Premium Reqs",
		"requestDetail.tokens": "Tokens",
		"requestDetail.duration": "Duration",
		"requestDetail.ttft": "TTFT",
		"requestDetail.throughput": "Throughput",
		"requestDetail.tokensPerSecond": "tokens/second",
		"requestDetail.output": "Output",
		"requestDetail.rawMetadata": "Raw Metadata",
		"requestDetail.inputTokens": "Input Tokens",
		"requestDetail.outputTokens": "Output Tokens",
		"requestDetail.cacheReadTokens": "Cache Read",
		"requestDetail.cacheWriteTokens": "Cache Write",
		"requestDetail.totalTokens": "Total Tokens",
		"requestDetail.reasoningTokens": "Reasoning Tokens",

		// Stats Grid
		"statsGrid.totalRequests": "Total Requests",
		"statsGrid.successErrors": "success · {0} errors",
		"statsGrid.totalTokens": "Total Tokens",
		"statsGrid.inputOutput": "input · {0} output",
		"statsGrid.totalCost": "Total Cost",
		"statsGrid.avgCostPerReq": "avg ${0}/req",
		"statsGrid.inputTokens": "Input Tokens",
		"statsGrid.outputTokens": "Output Tokens",
		"statsGrid.cacheRead": "Cache Read",
		"statsGrid.cacheWrite": "Cache Write",
		"statsGrid.reasoningTokens": "Reasoning Tokens",
		"statsGrid.avgTTFT": "Avg TTFT",
		"statsGrid.avgDuration": "Avg Duration",
		"statsGrid.avgThroughput": "Avg Throughput",
		"statsGrid.tps": "tok/s",

		// Cost Summary
		"costSummary.total": "Total",
		"costSummary.avgPerDay": "Avg / day",
		"costSummary.topModel": "Top model",

		// Behavior Summary
		"behaviorSummary.messages": "Messages",
		"behaviorSummary.inRange": "in selected range",
		"behaviorSummary.yelling": "Yelling",
		"behaviorSummary.profanity": "Profanity hits",
		"behaviorSummary.anguish": "Anguish",
		"behaviorSummary.frustration": "Frustration",
		"behaviorSummary.mostYelledAt": "Most yelled-at",
		"behaviorSummary.perMsg": "/ msg",
		"behaviorSummary.hits": "hits",

		// Models Table
		"modelsTable.model": "Model",
		"modelsTable.requests": "Requests",
		"modelsTable.cost": "Cost",
		"modelsTable.tokens": "Tokens",
		"modelsTable.tokensPerSec": "Tokens/s",
		"modelsTable.ttft": "TTFT",

		// Charts
		"charts.modelPreference": "Model Preference",
		"charts.shareOfRequests": "Share of requests over {0}",
		"charts.other": "Other",

		// Behavior Chart Metrics
		"behaviorMetric.yelling": "Yelling",
		"behaviorMetric.profanity": "Profanity",
		"behaviorMetric.anguish": "Anguish (!!!, nooo, dude, ..)",
		"behaviorMetric.negation": "Negation (no/nope/wrong)",
		"behaviorMetric.repetition": "Repetition (i meant, still doesnt)",
		"behaviorMetric.blame": "Blame (you didnt, stop X-ing)",
		"behaviorMetric.frustration": "Frustration (neg + rep + blame)",
		"statsGrid.avgTTFT": "Avg TTFT",
		"statsGrid.ofRequests": "of requests",
		"statsGrid.cachedTokens": "cached tokens",
		"statsGrid.ofPromptCompletion": "of prompt+completion",
		"statsGrid.failedRequests": "failed requests",
		"statsGrid.totalPromptCompletion": "total prompt+completion",
		"statsGrid.timeToFirstToken": "Time to first token",

		// Behavior Chart
		"behaviorChart.tantrums": "User Tantrums",
		"behaviorChart.subtitle": "{metric} as % of user messages per day",
		"behaviorChart.hits": "Hits",
		"behaviorChart.noData": "No behavioral data yet. Sync to scan your sessions.",
		"behaviorChart.subtitleByModel": "{metric} by model",

		// Cost Chart
		"costChart.dailyCost": "Daily Cost",
		"costChart.subtitle": "API spending over time",
		"costChart.noData": "No cost data available",
		"costChart.cost": "Cost",
		"costChart.total": "Total",

		// Chart Common
		"chart.allModels": "All Models",
		"chart.byModel": "By Model",
		"chart.total": "Total",

		"behaviorModelsTable.trend": "Trend",
		"behaviorModelsTable.avgCharsPerMsg": "Avg chars / msg",
		"behaviorModelsTable.total": "Total",
		"behaviorModelsTable.percentOfMsgs": "% of msgs",
		"behaviorModelsTable.perMsg": "Per msg",
		"behaviorModelsTable.caps": "CAPS",
		"behaviorModelsTable.frustration": "Frustration",
		"behaviorModelsTable.profanity": "Profanity",
		"behaviorModelsTable.anguish": "Anguish (!!!, nooo, dude, ..)",
		"behaviorModelsTable.negation": "Negation (no/nope/wrong)",
		"behaviorModelsTable.repetition": "Repetition (i meant, still doesnt)",
		"behaviorModelsTable.blame": "Blame (you didnt, stop X-ing)",
		"behaviorModelsTable.noData": "No user behavior recorded for this range yet.",
		"modelsTable.title": "Model Statistics",

		// Behavior Models Table
		"behaviorModelsTable.title": "Behavior by Model",
		"behaviorModelsTable.subtitle": "How often each model elicited a tantrum — rates are per user message",
		"behaviorModelsTable.model": "Model",
		"behaviorModelsTable.messages": "Messages",
		"behaviorModelsTable.capsPercent": "CAPS %",
		"behaviorModelsTable.profanityPercent": "Profanity %",
		"behaviorModelsTable.anguishPercent": "Anguish %",
		"behaviorModelsTable.frustrationPercent": "Frustration %",
		"behaviorModelsTable.hitsPercent": "Hits %",
		"behaviorModelsTable.trend": "Trend",

		// Common
		"common.loading": "Loading...",
		"common.noData": "No data available",
		"common.previous": "Previous",
		"common.next": "Next",
	},
	zh: {
		// Header
		"header.title": "AI 使用情况",
		"header.subtitle": "统计与分析",
		"header.sync": "同步",
		"header.syncing": "同步中...",
		"header.tab.overview": "概览",
		"header.tab.requests": "请求",
		"header.tab.errors": "错误",
		"header.tab.models": "模型",
		"header.tab.costs": "成本",
		"header.tab.behavior": "行为",
		"header.range.all": "全部时间",
		"header.range.last": "最近",

		// Request List
		"requestList.model": "模型",
		"requestList.provider": "服务商",
		"requestList.time": "时间",
		"requestList.tokens": "Tokens",
		"requestList.cost": "成本",
		"requestList.duration": "耗时",
		"requestList.status": "状态",
		"requestList.input": "输入",
		"requestList.output": "输出",
		"requestList.cacheRead": "缓存读取",
		"requestList.cacheWrite": "缓存写入",
		"requestList.reasoning": "推理",
		"requestList.tps": "Tok/秒",
		"requestList.noRequests": "未找到请求",
		"requestList.recentRequests": "最近请求",
		"requestList.recentErrors": "最近错误",
		"requestList.allRequests": "所有最近请求",
		"requestList.failedRequests": "失败请求",
		"requestList.showing": "显示 {start}-{end}，共 {total} 条",
		"requestList.pageSize": "每页条数",

		// Request Detail
		"requestDetail.title": "请求详情",
		"requestDetail.success": "成功",
		"requestDetail.error": "错误",
		"requestDetail.cost": "成本",
		"requestDetail.premiumReqs": "高级请求",
		"requestDetail.tokens": "Tokens",
		"requestDetail.duration": "耗时",
		"requestDetail.ttft": "首字时间",
		"requestDetail.throughput": "吞吐量",
		"requestDetail.tokensPerSecond": "tokens/秒",
		"requestDetail.output": "输出",
		"requestDetail.rawMetadata": "原始元数据",
		"requestDetail.inputTokens": "输入 Tokens",
		"requestDetail.outputTokens": "输出 Tokens",
		"requestDetail.cacheReadTokens": "缓存读取",
		"requestDetail.cacheWriteTokens": "缓存写入",
		"requestDetail.totalTokens": "总 Tokens",
		"requestDetail.reasoningTokens": "推理 Tokens",

		// Stats Grid
		"statsGrid.totalRequests": "总请求数",
		"statsGrid.successErrors": "成功 · {0} 错误",
		"statsGrid.totalTokens": "总 Tokens",
		"statsGrid.inputOutput": "输入 · {0} 输出",
		"statsGrid.totalCost": "总成本",
		"statsGrid.avgCostPerReq": "平均 ${0}/请求",
		"statsGrid.inputTokens": "输入 Tokens",
		"statsGrid.outputTokens": "输出 Tokens",
		"statsGrid.avgTTFT": "平均 TTFT",
		"statsGrid.ofRequests": "的请求",
		"statsGrid.cachedTokens": "缓存 tokens",
		"statsGrid.ofPromptCompletion": "的提示+补全",
		"statsGrid.failedRequests": "失败请求",
		"statsGrid.totalPromptCompletion": "总提示+补全",
		"statsGrid.timeToFirstToken": "首字时间",
		"statsGrid.cacheWrite": "缓存写入",
		"statsGrid.reasoningTokens": "推理 Tokens",
		"statsGrid.avgDuration": "平均耗时",
		"statsGrid.avgThroughput": "平均吞吐量",

		// Cost Summary
		"costSummary.total": "总计",
		"costSummary.avgPerDay": "日均",
		"costSummary.topModel": "最贵模型",

		// Behavior Summary
		"behaviorSummary.messages": "消息数",
		"behaviorSummary.inRange": "在所选范围内",
		"behaviorSummary.yelling": "大喊",
		"behaviorSummary.profanity": "脏话",
		"behaviorSummary.anguish": "痛苦",
		"behaviorSummary.frustration": "沮丧",
		"behaviorSummary.mostYelledAt": "被骂最多",
		"behaviorSummary.perMsg": "/ 条",
		"behaviorSummary.hits": "次",

		// Models Table
		"modelsTable.model": "模型",
		"modelsTable.requests": "请求数",
		"modelsTable.cost": "成本",
		"modelsTable.tokens": "Tokens",
		"modelsTable.tokensPerSec": "Tokens/秒",
		"modelsTable.ttft": "TTFT",

		// Charts
		"charts.modelPreference": "模型偏好",
		"charts.shareOfRequests": "在 {0} 内的请求占比",
		"charts.other": "其他",

		// Cost Chart
		"costChart.dailyCost": "每日成本",
		"costChart.subtitle": "API 支出随时间变化",
		"costChart.noData": "暂无成本数据",
		"costChart.cost": "成本",
		"costChart.total": "总计",

		// Chart Common
		"chart.allModels": "所有模型",
		"chart.byModel": "按模型",
		"chart.total": "总计",

		// Models Table
		"modelsTable.title": "模型统计",

		// Behavior Chart Metrics
		"behaviorMetric.yelling": "大喊",
		"behaviorMetric.profanity": "脏话",
		"behaviorMetric.anguish": "痛苦 (!!!, nooo, dude, ..)",
		"behaviorMetric.negation": "否定 (no/nope/wrong)",
		"behaviorMetric.repetition": "重复 (i meant, still doesnt)",
		"behaviorMetric.blame": "责备 (you didnt, stop X-ing)",
		"behaviorMetric.frustration": "沮丧 (neg + rep + blame)",
		"behaviorMetric.total": "所有信号合并",

		// Behavior Chart
		"behaviorChart.tantrums": "用户情绪波动",
		"behaviorChart.subtitle": "{metric} 占每日用户消息的百分比",
		"behaviorChart.hits": "次数",
		"behaviorChart.noData": "暂无行为数据。同步以扫描您的会话。",
		"behaviorChart.subtitleByModel": "按模型分类的 {metric}",

		// Behavior Models Table
		"behaviorModelsTable.title": "按模型统计行为",
		"behaviorModelsTable.subtitle": "每个模型引发情绪波动的频率 — 比率基于用户消息",
		"behaviorModelsTable.model": "模型",
		"behaviorModelsTable.messages": "消息数",
		"behaviorModelsTable.capsPercent": "大写 %",
		"behaviorModelsTable.profanityPercent": "脏话 %",
		"behaviorModelsTable.anguishPercent": "痛苦 %",
		"behaviorModelsTable.frustrationPercent": "沮丧 %",
		"behaviorModelsTable.hitsPercent": "命中 %",
		"behaviorModelsTable.trend": "趋势",
		"behaviorModelsTable.yellingCaps": "大喊 (大写)",
		"behaviorModelsTable.profanity": "脏话",
		"behaviorModelsTable.anguish": "痛苦 (!!!, nooo, dude, ..)",
		"behaviorModelsTable.negation": "否定 (no/nope/wrong)",
		"behaviorModelsTable.repetition": "重复 (i meant, still doesnt)",
		"behaviorModelsTable.blame": "责备 (you didnt, stop X-ing)",
		"behaviorModelsTable.avgCharsPerMsg": "平均字符/消息",
		"behaviorModelsTable.total": "总计",
		"behaviorModelsTable.percentOfMsgs": "消息占比",
		"behaviorModelsTable.perMsg": "每条消息",
		"behaviorModelsTable.caps": "大写",
		"behaviorModelsTable.frustration": "沮丧",
		"behaviorModelsTable.noData": "此范围内暂无用户行为记录",

		"common.loading": "加载中...",
		"common.noData": "暂无数据",
		"common.previous": "上一页",
		"common.next": "下一页",
	},
};

export type TranslationKey = keyof typeof translations.en;

function getInitialLocale(): Locale {
	if (typeof window !== "undefined") {
		const stored = localStorage.getItem("omp-stats-locale");
		if (stored === "en" || stored === "zh") return stored;

		const browserLang = navigator.language.toLowerCase();
		if (browserLang.startsWith("zh")) return "zh";
	}
	return "en";
}

let currentLocale: Locale = getInitialLocale();
const listeners = new Set<() => void>();

export function setLocale(locale: Locale) {
	currentLocale = locale;
	if (typeof window !== "undefined") {
		localStorage.setItem("omp-stats-locale", locale);
		document.documentElement.lang = locale;
	}
	listeners.forEach(listener => listener());
}

export function getLocale(): Locale {
	return currentLocale;
}

export function useTranslation() {
	const [locale, setLocaleState] = useState<Locale>(currentLocale);

	useEffect(() => {
		const listener = () => setLocaleState(currentLocale);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);

	const t = (key: TranslationKey, params?: Record<string, string | number>) => {
		let text = translations[locale][key] || translations.en[key] || key;
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				text = text.replace(`{${k}}`, String(v));
			}
		}
		return text;
	};

	return { t, locale, setLocale };
}

export function useLocale() {
	const [locale, setLocaleState] = useState<Locale>(currentLocale);

	useEffect(() => {
		const listener = () => setLocaleState(currentLocale);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);

	return { locale, setLocale };
}
