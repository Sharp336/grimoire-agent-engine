#!/usr/bin/env bun
/**
 * 批量翻译设置文件 - 使用翻译映射表完成大部分翻译
 * 剩余未翻译的由子代理处理
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LAN_DIR = path.join(os.homedir(), ".omp", "lang");

// 翻译映射表
const MAP: Record<string, string> = {
	// Tab 名称
	Appearance: "外观",
	Model: "模型",
	Interaction: "交互",
	Context: "上下文",
	Memory: "记忆",
	Files: "文件",
	Shell: "Shell",
	Tools: "工具",
	Tasks: "任务",
	Providers: "提供商",

	// 分组名
	Theme: "主题",
	"Status Line": "状态栏",
	Display: "显示",
	Images: "图片",
	Thinking: "思考",
	Sampling: "采样",
	Prompt: "提示词",
	"Retry & Fallback": "重试与回退",
	Network: "网络",
	Generating: "生成",
	Agent: "代理",
	Input: "输入",
	Approvals: "审批",
	Notifications: "通知",
	Voice: "语音",
	Collab: "协作",
	General: "通用",
	Git: "Git",
	"Magic Keywords": "魔法关键词",
	"Launch & Update": "启动与更新",
	"Power (macOS)": "电源 (macOS)",
	Proxy: "代理",
	Compaction: "压缩",
	"Rules (TTSR)": "规则 (TTSR)",
	Experimental: "实验性",
	LSP: "LSP",
	Editing: "编辑",
	Reading: "读取",
	"Read Summaries": "读取摘要",
	Session: "会话",
	Subagents: "子代理",
	Toolbox: "工具箱",
	Manual: "手动",
	Sandbox: "沙箱",
	Attribution: "归属",
	Permissions: "权限",
	Browsing: "浏览",
	Media: "媒体",
	Caching: "缓存",
	"Error Handling": "错误处理",
	Advanced: "高级",
	Output: "输出",
	"Auto-Update": "自动更新",
	Defaults: "默认值",
	Fallbacks: "回退",
	Rules: "规则",
	Watchdog: "看门狗",
	Security: "安全",
	Developer: "开发者",
	Debug: "调试",
	State: "状态",
	Selection: "选择",
	Inline: "内联",
	Shortcuts: "快捷键",
	"API Keys": "API 密钥",
	Provider: "提供商",
	Authentication: "认证",
	Visibility: "可见性",
	Cost: "费用",
	History: "历史",
	Browser: "浏览器",
	Preview: "预览",
	Search: "搜索",
	"Editing Tools": "编辑工具",
	"File System": "文件系统",
	Terminal: "终端",
	Background: "后台",
	Batch: "批量",
	Templates: "模板",
	Format: "格式",
	Formatting: "格式化",
	Persistence: "持久化",
	Stats: "统计",
	Dashboard: "仪表盘",
	Sync: "同步",
	Behavior: "行为",
	Environment: "环境",
	Variables: "变量",
	Logging: "日志",
	Timeouts: "超时",
	Limits: "限制",
	Encoding: "编码",
	Charset: "字符集",
	Patterns: "模式",
	Excludes: "排除",
	Filters: "过滤器",
	Sorting: "排序",
	Pagination: "分页",
	Markdown: "Markdown",
	"Code Blocks": "代码块",
	"Line Numbers": "行号",
	Syntax: "语法",
	Highlighting: "高亮",
	Colors: "颜色",
	Contrast: "对比度",
	Font: "字体",
	Scale: "缩放",
	Layout: "布局",
	Spacing: "间距",
	Scrollback: "回滚",
	Performance: "性能",
	"Memory Usage": "内存使用",
	"Background Tasks": "后台任务",
	"Auto-Save": "自动保存",
	Backup: "备份",
	Restore: "恢复",
	"Session Restore": "会话恢复",
	Startup: "启动",
	Shutdown: "关闭",
	Cleanup: "清理",
	Optimization: "优化",
	Preloading: "预加载",
	Warmup: "预热",
	Modes: "模式",
	Profiles: "配置文件",
	Custom: "自定义",
	Default: "默认",
	System: "系统",
	Local: "本地",
	Remote: "远程",
	Server: "服务器",
	Client: "客户端",
	Host: "主机",
	Port: "端口",
	URL: "URL",
	Path: "路径",
	Timeout: "超时",
	Retries: "重试次数",
	Delay: "延迟",
	Interval: "间隔",
	Frequency: "频率",
	Threshold: "阈值",
	Maximum: "最大",
	Minimum: "最小",
	Size: "大小",
	Width: "宽度",
	Height: "高度",
	Depth: "深度",

	// Commands 相关
	USAGE: "用法",
	COMMANDS: "命令",
	ARGUMENTS: "参数",
	FLAGS: "选项",
	EXAMPLES: "示例",
	"Show what the read tool will return for a path, URL, or internal URI":
		"显示 read 工具对路径、URL 或内部 URI 返回的内容",
	"Path, URL, or internal URI to read": "要读取的路径、URL 或内部 URI",
	"Test web search providers": "测试网络搜索提供商",
	"Search query text": "搜索查询文本",
	"Search provider": "搜索提供商",
	"Recency filter": "时效性过滤",
	"Max results to return": "最大返回结果数",
	"Render condensed output": "渲染压缩输出",
	"View, clean, or push reported tool issues": "查看、清理或推送报告的工具问题",
	"list (default), clean, or push": "list（默认）、clean 或 push",
	"Number of recent issues to show": "显示的最近问题数",
	"Filter by tool name": "按工具名过滤",
	"Output as JSON": "输出为 JSON",
	"Delete a single grievance by id": "按 id 删除单个问题",
	"Delete every grievance": "删除所有问题",
	"Show provider usage limits": "显示提供商使用限制",
	"Optional subcommand to execute": "可选的子命令",
	"Output usage reports as JSON": "以 JSON 输出使用报告",
	"Only show usage for this provider": "仅显示此提供商的使用情况",
	"Redact account emails/ids": "脱敏账户邮箱/ID",
	"Show recorded usage-limit history": "显示记录的使用限制历史",
	"History window in days": "历史窗口（天）",
	"Preview tool renderers": "预览工具渲染器",
	"Render a single tool by name": "按名称渲染单个工具",
	"Render only the given lifecycle state(s)": "仅渲染指定的生命周期状态",
	"Render width in columns": "渲染宽度（列数）",
	"Render the expanded variant": "渲染展开变体",
	"Strip ANSI styling": "去除 ANSI 样式",
	"Capture as PNG screenshot(s)": "捕获为 PNG 截图",
	"Screenshot output path": "截图输出路径",
	"Screenshot font family": "截图字体",
	"Screenshot font size in points": "截图字号（磅）",
	"Manage SSH host configurations": "管理 SSH 主机配置",
	"SSH action": "SSH 操作",
	"Host name or arguments": "主机名或参数",
	"Output JSON": "输出 JSON",
	"Host address": "主机地址",
	Username: "用户名",
	"Port number": "端口号",
	"Identity key path": "身份密钥路径",
	"Host description": "主机描述",
	"Enable compatibility mode": "启用兼容模式",
	"Config scope": "配置范围",
	"Install or link an extension package": "安装或链接扩展包",
	"Local path, npm spec, or marketplace ref": "本地路径、npm 规格或市场引用",
	"Force install": "强制安装",
	"Show actions without applying changes": "显示操作而不应用更改",
	"List or clear agent-managed git worktrees": "列出或清理代理管理的 git worktree",
	"list (default) or clear": "list（默认）或 clear",
	"Clear every entry": "清理所有条目",
	"Print what would be removed": "打印将被删除的内容",
	"Emit machine-readable JSON": "输出机器可读的 JSON",
	"Manage plugins": "管理插件",
	"Plugin action": "插件操作",
	"Packages, paths, or plugin names": "包、路径或插件名",
	"Attempt to fix issues": "尝试修复问题",
	"Operate on local plugin directory": "操作本地插件目录",
	"Enable a feature": "启用功能",
	"Disable a feature": "禁用功能",
	"Set plugin config": "设置插件配置",
	"View usage statistics": "查看使用统计",
	"Port for the dashboard server": "仪表盘服务器端口",
	"Output stats as JSON": "以 JSON 输出统计",
	"Print summary to console": "打印摘要到控制台",
	"AI coding assistant": "AI 编程助手",
	"Messages to send": "要发送的消息",
	"Smol/fast model": "轻量/快速模型",
	"Slow/reasoning model": "慢速/推理模型",
	"Plan model": "规划模型",
	"Switch models at first edit": "首次编辑时切换模型",
	"Disable prewalk": "禁用 prewalk",
	"Force read-only plan mode": "强制只读规划模式",
	"Provider to use": "使用的提供商",
	"API key": "API 密钥",
	"System prompt": "系统提示词",
	"Append text to system prompt": "追加文本到系统提示词",
	"Allow starting in home directory": "允许在主目录启动",
	"Use isolated profile": "使用隔离配置",
	"Create shell shortcut": "创建 shell 快捷方式",
	"Directory to start in": "启动目录",
	"Output mode": "输出模式",
	"Load extra config overlay": "加载额外配置覆盖",
	"Add workspace directory": "添加工作区目录",
	"Non-interactive mode": "非交互模式",
	"Continue previous session": "继续上次会话",
	"Resume a session": "恢复会话",
	"Directory for session storage": "会话存储目录",
	"Don't save session": "不保存会话",
	"Model patterns for cycling": "循环切换的模型模式",
	"Disable all built-in tools": "禁用所有内置工具",
	"Disable LSP tools": "禁用 LSP 工具",
	"Disable PTY execution": "禁用 PTY 执行",
	"Tools to enable": "要启用的工具",
	"Hide thinking blocks": "隐藏思考块",
	"Enable advisor runtime": "启用顾问运行时",
	"Load hook/extension file": "加载 hook/扩展文件",
	"Load extension file": "加载扩展文件",
	"Disable extension discovery": "禁用扩展发现",
	"Disable skills discovery": "禁用技能发现",
	"Filter skills by glob": "按 glob 过滤技能",
	"Disable rules discovery": "禁用规则发现",
	"Export session to HTML": "导出会话为 HTML",
	"Disable title generation": "禁用标题生成",
	"Include thinking in output": "输出中包含思考",
	"Stop session after duration": "在指定时长后停止会话",
	"Auto-approve all tool calls": "自动批准所有工具调用",
	"Override approval mode": "覆盖审批模式",
	"Run onboarding setup": "运行入门设置",
	"Optional component to install": "可选安装组件",
	"Check if dependencies installed": "检查依赖是否已安装",
	"Output status as JSON": "以 JSON 输出状态",
	"Run as ACP server": "作为 ACP 服务器运行",
	"Print shell completion script": "打印 shell 补全脚本",
	"Target shell": "目标 shell",
	"Manage auth-broker": "管理认证代理",
	"Sub-command": "子命令",
	"OAuth provider id or path": "OAuth 提供商 ID 或路径",
	"Bind address for serve": "serve 的绑定地址",
	"Regenerate bearer token": "重新生成 bearer 令牌",
	"SSH user@host for remote login": "远程登录的 SSH user@host",
	"Override provider id": "覆盖提供商 ID",
	"Import disabled credentials": "导入禁用的凭据",
	"migrate source": "迁移来源",
	"Capture env-var API keys": "捕获环境变量 API 密钥",
	"Upload OAuth during migrate": "迁移时上传 OAuth",
	"Print actions without executing": "显示操作而不执行",
	"Benchmark models": "基准测试模型",
	"Model selectors": "模型选择器",
	"Requests per model": "每模型请求数",
	"Max output tokens": "最大输出 token",
	"Custom prompt text": "自定义提示词文本",
	"Service tier": "服务层级",
	"Execute runs in parallel": "并行执行",
	"Run cache pairs": "运行缓存对",
	"Stable prompt prefix file": "稳定的提示词前缀文件",
	"Stable prefix byte budget": "稳定前缀字节预算",
	"Cold/warm pairs per model": "每模型的冷/热对数",
	"Concurrent cache pairs": "并发缓存对",
	"Join collab session": "加入协作会话",
	"Collab link": "协作链接",
	"Manage bundled task agents": "管理内置任务代理",
	"Agents action": "代理操作",
	"Overwrite existing agent files": "覆盖现有代理文件",
	"Output directory": "输出目录",
	"Write to user directory": "写入用户目录",
	"Write to project directory": "写入项目目录",
	"Test grep tool": "测试 grep 工具",
	"Regex pattern": "正则表达式模式",
	"Directory or file to search": "搜索的目录或文件",
	"Filter by glob pattern": "按 glob 模式过滤",
	"Max matches": "最大匹配数",
	"Context lines": "上下文行数",
	"Output file names only": "仅输出文件名",
	"Output match counts": "输出匹配计数",
	"Include gitignored files": "包含 gitignore 的文件",
	"Generate commit message": "生成提交信息",
	"Push after committing": "提交后推送",
	"Preview without committing": "预览而不提交",
	"Skip changelog updates": "跳过更新日志",
	"Use legacy pipeline": "使用旧版流水线",
	"Additional context": "额外上下文",
	"Override model selection": "覆盖模型选择",
	"Interactive shell console": "交互式 shell 控制台",
	"Set working directory": "设置工作目录",
	"Timeout per command": "每命令超时",
	"Skip sourcing snapshot": "跳过加载快照",
	"Synthesize text with TTS": "使用 TTS 合成文本",
	"Text to speak": "要朗读的文本",
	"Voice id": "语音 ID",
	"Local TTS model": "本地 TTS 模型",
	"Read text from file": "从文件读取文本",
	"Write WAV to path": "写入 WAV 到路径",
	"Download tiny local models": "下载本地小模型",
	"Action to perform": "要执行的操作",
	"Model key or all": "模型键或 all",
	"Run garbage collection": "运行垃圾回收",
	"Apply changes": "应用更改",
	"Agent directory to maintain": "要维护的代理目录",
	"Sweep unreferenced blobs": "清理未引用的 blob",
	"Archive cold sessions": "归档冷会话",
	"Checkpoint WAL files": "检查点 WAL 文件",
	"Minimum session age": "最小会话年龄",
	"Keep newest sessions globally": "全局保留最新会话数",
	"Keep newest sessions per cwd": "每工作目录保留最新会话数",
	"List and search models": "列出和搜索模型",
	"ls, find, refresh, or provider": "ls、find、refresh 或提供商",
	"Filter/search substring": "过滤/搜索子串",
	"Load extension before listing": "列出前加载扩展",
	"Dry-run OAuth balancing": "试运行 OAuth 平衡",
	"Model selector": "模型选择器",
	"Number of random session ids": "随机会话 ID 数",
	"Maximum concurrent credentials": "最大并发凭据数",
	"Send live benchmark request": "发送实时基准请求",
	"Manage configuration": "管理配置",
	"Config action": "配置操作",
	"Setting key": "设置键",
	"Value for set/reset": "set/reset 的值",
	"Inspect TTSR rules": "检查 TTSR 规则",
	"TTSR action": "TTSR 操作",
	"Snippet text or directory": "片段文本或目录",
	"Snippet file path": "片段文件路径",
	"Rule markdown file": "规则 Markdown 文件",
	"Match source": "匹配来源",
	"Tool name": "工具名",
	"Candidate file path": "候选文件路径",
	"Show every evaluated rule": "显示每个评估的规则",
	"Maximum file size": "最大文件大小",
	"Get API key or token": "获取 API 密钥或令牌",
	"Provider ID": "提供商 ID",
	"Output raw credential": "输出原始凭据",
	"Force refresh OAuth token": "强制刷新 OAuth 令牌",
	"Select OAuth account": "选择 OAuth 账户",
	"List OAuth accounts": "列出 OAuth 账户",
	"Run auth-gateway proxy": "运行认证网关代理",
	"Bind address": "绑定地址",
	"Regenerate gateway token": "重新生成网关令牌",
	"Disable inbound auth": "禁用入站认证",
	"Probe credentials": "探测凭据",
	"Check for updates": "检查更新",
	"Force update": "强制更新",
	"Check without installing": "检查而不安装",
	"Update installed plugins": "更新已安装的插件",
};

function translate(text: string): string {
	// 精确匹配
	if (MAP[text]) return MAP[text];

	// 常见后缀模式
	if (text.startsWith("Show ")) return `显示${translate(text.slice(5))}`;
	if (text.startsWith("Hide ")) return `隐藏${translate(text.slice(5))}`;
	if (text.startsWith("Enable ")) return `启用${translate(text.slice(7))}`;
	if (text.startsWith("Disable ")) return `禁用${translate(text.slice(8))}`;
	if (text.startsWith("Use ")) return `使用${translate(text.slice(4))}`;
	if (text.startsWith("Set ")) return `设置${translate(text.slice(4))}`;
	if (text.startsWith("Allow ")) return `允许${translate(text.slice(6))}`;
	if (text.startsWith("Block ")) return `阻止${translate(text.slice(6))}`;
	if (text.startsWith("Auto ")) return `自动${translate(text.slice(5))}`;
	if (text.startsWith("Manual ")) return `手动${translate(text.slice(7))}`;

	// 未匹配则返回空字符串，标记需要手动翻译
	return "";
}

// 主流程
// 处理所有 zh-*.json 文件（settings + commands）
const translationFiles = fs
	.readdirSync(LAN_DIR)
	.filter(f => f.startsWith("zh-") && f.endsWith(".json") && !f.startsWith("_"));

let totalTranslated = 0;
let totalRemaining = 0;
const remainingByFile: Record<string, string[]> = {};

for (const zhFile of translationFiles) {
	const enFile = zhFile.replace("zh-", "en-");
	const zhPath = path.join(LAN_DIR, zhFile);
	const enPath = path.join(LAN_DIR, enFile);

	if (!fs.existsSync(enPath)) continue;

	const zhData = JSON.parse(fs.readFileSync(zhPath, "utf-8")) as Record<string, string>;
	const enData = JSON.parse(fs.readFileSync(enPath, "utf-8")) as Record<string, string>;

	const remaining: string[] = [];

	for (const [key, zhValue] of Object.entries(zhData)) {
		if (zhValue !== "" && !zhValue.startsWith("（见")) continue;

		const enValue = enData[key];
		if (!enValue) continue;

		const translated = translate(enValue);
		if (translated) {
			zhData[key] = translated;
			totalTranslated++;
		} else {
			remaining.push(`${key}|${enValue}`);
			totalRemaining++;
		}
	}

	// 始终写回，即使没有新翻译（确保一致性）
	fs.writeFileSync(zhPath, `${JSON.stringify(zhData, null, 2)}\n`);

	if (remaining.length > 0) {
		remainingByFile[zhFile] = remaining;
	}
}

// 输出结果
console.log(`翻译完成: ${totalTranslated} 条`);
console.log(`剩余未翻译: ${totalRemaining} 条\n`);

for (const [file, items] of Object.entries(remainingByFile)) {
	console.log(`\n=== ${file} (${items.length} 条剩余) ===`);
	for (const item of items.slice(0, 5)) {
		const [key, enValue] = item.split("|");
		console.log(`  ${key}: ${enValue}`);
	}
	if (items.length > 5) console.log(`  ... 还有 ${items.length - 5} 条`);
}

// 生成剩余翻译的 JSON 文件供子代理使用
const remainingPath = path.join(LAN_DIR, "_remaining_translations.json");
const remainingData: Record<string, Record<string, string>> = {};
for (const [file, items] of Object.entries(remainingByFile)) {
	const fileMap: Record<string, string> = {};
	for (const item of items) {
		const [key, enValue] = item.split("|");
		fileMap[key] = enValue;
	}
	remainingData[file] = fileMap;
}
fs.writeFileSync(remainingPath, `${JSON.stringify(remainingData, null, 2)}\n`);
console.log(`\n剩余翻译已保存到: ${remainingPath}`);
