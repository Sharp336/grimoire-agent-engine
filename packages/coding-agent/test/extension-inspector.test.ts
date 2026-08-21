import { beforeAll, describe, expect, test } from "bun:test";
import { ExtensionList } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-list";
import { InspectorPanel } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/inspector-panel";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

function source(): Extension["source"] {
	return { provider: "native", providerName: "OMP (Project)", level: "project" };
}

function systemdExtension(): Extension {
	return {
		id: "tool:systemd",
		kind: "tool",
		name: "systemd",
		displayName: "systemd",
		description: "systemd custom tool",
		path: "/home/sf/worlds/base/tools/systemd.ts",
		source: source(),
		state: "active",
		raw: {
			name: "systemd",
			description: "systemd custom tool",
			path: "/home/sf/worlds/base/tools/systemd.ts",
		},
	};
}

function systemdFactory() {
	return [
		{
			name: "systemd_inspect",
			label: "systemd inspect",
			description: "Read systemd state. Inspect first.",
			parameters: {
				type: "object",
				required: ["action"],
				properties: { action: { type: "string" } },
			},
			loadMode: "discoverable" as const,
		},
		{
			name: "systemd_control",
			label: "systemd control",
			description: "Mutate running or enablement state of write-prefix units.",
			parameters: {
				type: "object",
				required: ["action"],
				properties: { action: { type: "string" } },
			},
		},
		{
			name: "systemd_author",
			label: "systemd author",
			description: "Create, update, or retire MCP-managed definitions.",
			parameters: {
				type: "object",
				required: ["action"],
				properties: { action: { type: "string" } },
			},
		},
	];
}

function systemdSource() {
	const tools = systemdFactory();
	return {
		getLiveTool: (name: string) => tools.find(tool => tool.name === name),
		listLiveTools: () => tools,
	};
}

function toolExtension(): Extension {
	return {
		id: "tool:gmail_send",
		kind: "tool",
		name: "gmail_send",
		displayName: "gmail_send",
		description: "gmail_send custom tool",
		path: "/home/sf/worlds/personal/.omp/tools/gmail_send.ts",
		source: source(),
		state: "active",
		raw: {
			name: "gmail_send",
			description: "gmail_send custom tool",
			path: "/home/sf/worlds/personal/.omp/tools/gmail_send.ts",
		},
	};
}

function ruleExtension(): Extension {
	return {
		id: "rule:orchestration",
		kind: "rule",
		name: "orchestration",
		displayName: "orchestration",
		description: undefined,
		trigger: "always",
		path: "/home/sf/worlds/base/rules/orchestration.md",
		source: source(),
		state: "active",
		raw: {
			name: "orchestration",
			alwaysApply: true,
			content: "# asynchronous coordination\n\nnever block a reasoning turn merely waiting for another agent.",
		},
	};
}

function commandExtension(): Extension {
	return {
		id: "slash-command:triage",
		kind: "slash-command",
		name: "triage",
		displayName: "triage",
		trigger: "/triage",
		path: "/home/sf/worlds/_template/.omp/commands/triage.md",
		source: source(),
		state: "active",
		raw: {
			name: "triage",
			content:
				'---\ndescription: "Triage current world; smallest next actions."\n---\n\nInspect the current state relevant to: $ARGUMENTS\n',
		},
	};
}

function skillExtension(): Extension {
	return {
		id: "skill:hcom",
		kind: "skill",
		name: "hcom",
		displayName: "hcom",
		description: "Named agent sessions that mail, wake, and resume across processes.",
		path: "/home/sf/worlds/base/skills/hcom/SKILL.md",
		source: source(),
		state: "active",
		raw: {
			name: "hcom",
			content: "# hcom\n\na 4-letter name is a session you can come back to.",
			frontmatter: {
				name: "hcom",
				description: "Named agent sessions that mail, wake, and resume across processes.",
				hide: true,
			},
		},
	};
}

function render(panel: InspectorPanel): string {
	return Bun.stripANSI(panel.render(72).join("\n"));
}

describe("shared inspector chrome", () => {
	test("puts enablement before origin and drops Type:", () => {
		const panel = new InspectorPanel();
		panel.setExtension(ruleExtension());
		const text = render(panel);
		expect(text).toContain("orchestration");
		expect(text).toContain("Active");
		expect(text).toContain("Origin:");
		expect(text.indexOf("Active")).toBeLessThan(text.indexOf("Origin:"));
		expect(text).not.toContain("Type:");
		expect(text).not.toMatch(/Status:\s+/);
	});
});

describe("tool inspector", () => {
	test("joins live schema and description instead of the discovery placeholder", () => {
		const panel = new InspectorPanel();
		panel.setToolSource({
			getLiveTool: () => ({
				name: "gmail_send",
				label: "Gmail Send",
				description: "Send an email via gog for an authorized personal Gmail account.",
				parameters: {
					type: "object",
					required: ["to", "subject", "body"],
					properties: {
						to: { type: "string", description: "Recipients, comma-separated" },
						subject: { type: "string" },
						body: { type: "string" },
						dry_run: { type: "boolean", description: "If true, only print intended send" },
					},
				},
				hidden: true,
			}),
		});
		panel.setExtension(toolExtension());
		const text = render(panel);
		expect(text).toContain("gmail_send");
		expect(text).toContain("Gmail Send");
		expect(text).toContain("Send an email via gog");
		expect(text).toContain("Arguments");
		expect(text).toContain("to");
		expect(text).toContain("Required");
		expect(text).toContain("dry_run");
		expect(text).toContain("Optional");
		expect(text).not.toContain("gmail_send custom tool");
		expect(text.indexOf("Active")).toBeLessThan(text.indexOf("Arguments"));
	});

	test("list hint uses live hidden/discoverable over a placeholder trigger", () => {
		const list = new ExtensionList([toolExtension()], {
			toolSource: {
				getLiveTool: () => ({
					name: "gmail_send",
					hidden: true,
					parameters: { type: "object", properties: { to: { type: "string" } } },
				}),
			},
		});
		list.setFocused(true);
		const text = Bun.stripANSI(list.render(80).join("\n"));
		expect(text).toContain("gmail_send");
		expect(text).toContain("hidden");
	});

	test("joins a multi-export factory by filename prefix without authoring changes", () => {
		const panel = new InspectorPanel();
		panel.setToolSource(systemdSource());
		panel.setExtension(systemdExtension());
		const text = render(panel);
		expect(text).toContain("systemd_inspect");
		expect(text).toContain("systemd_control");
		expect(text).toContain("systemd_author");
		expect(text).toContain("Read systemd state");
		expect(text).not.toContain("systemd custom tool");
		expect(text).not.toContain("(no arguments)");

		const list = new ExtensionList([systemdExtension()], { toolSource: systemdSource() });
		list.setFocused(true);
		expect(Bun.stripANSI(list.render(80).join("\n"))).toContain("3 tools");
	});
});

describe("rule inspector", () => {
	test("shows apply-when then the rule body", () => {
		const panel = new InspectorPanel();
		panel.setExtension(ruleExtension());
		const text = render(panel);
		expect(text).toContain("Applies");
		expect(text).toContain("always");
		expect(text).toContain("Rule");
		expect(text).toContain("asynchronous coordination");
		expect(text.indexOf("Applies")).toBeLessThan(text.indexOf("asynchronous coordination"));
	});
});

describe("command inspector", () => {
	test("parses frontmatter description and keeps the template body", () => {
		const panel = new InspectorPanel();
		panel.setExtension(commandExtension());
		const text = render(panel);
		expect(text).toContain("Triage current world; smallest next actions.");
		expect(text).toContain("/triage");
		expect(text).toContain("accepts $ARGUMENTS");
		expect(text).toContain("Inspect the current state relevant to: $ARGUMENTS");
		expect(text).not.toContain("description:");
		expect(text.indexOf("Active")).toBeLessThan(text.indexOf("Template"));
	});
});

describe("skill inspector", () => {
	test("surfaces opt-in discovery and instruction preview", () => {
		const panel = new InspectorPanel();
		panel.setExtension(skillExtension());
		const text = render(panel);
		expect(text).toContain("Named agent sessions");
		expect(text).toContain("opt-in");
		expect(text).toContain("Instruction");
		expect(text).toContain("4-letter name");
	});
});

describe("inspector wrap and fill", () => {
	test("wraps long rule lines instead of ellipsizing them", () => {
		const panel = new InspectorPanel();
		panel.setExtension({
			...ruleExtension(),
			path: "builtin-defaults:ts-redundant-clear-guard",
			raw: {
				name: "ts-redundant-clear-guard",
				alwaysApply: false,
				astCondition: ["if ($X) clearTimeout($X)", "if ($X) { clearTimeout($X) }", "if ($X) clearInterval($X)"],
				scope: "tool:edit(*.{ts,tsx,js,jsx}), tool:write(*.{ts,tsx,js,jsx})",
				interruptMode: "never",
				content:
					"**Do not guard `clearTimeout` / `clearInterval` / `clearImmediate` with truthiness or `null`/`undefined` checks.** Per WHATWG/Node timers spec, calls no-op for `null`.",
			},
		});
		const text = Bun.stripANSI(panel.render(42).join("\n"));
		expect(text.split("\n").some(line => line.includes("…") || line.endsWith("..."))).toBe(false);
		expect(text).toContain("clearTimeout");
		expect(text).toContain("interrupt");
		expect(text).toContain("never");
		expect(text).toContain("tool:edit");
		expect(text).toContain("tool:write");
		expect(text).toContain("builtin-defaults:");
		expect(text).toMatch(/clear-gua/);
		expect(text).toMatch(/Origin:[\s\S]*Applies/);
		const origin = text.slice(text.indexOf("Origin:"), text.indexOf("Applies"));
		expect(origin.split("\n").length).toBeGreaterThan(3);
	});

	test("compacts long apply lists so leftover viewport can show the rule body", () => {
		const panel = new InspectorPanel();
		panel.setHeight(28);
		panel.setExtension({
			...ruleExtension(),
			raw: {
				name: "ts-redundant-clear-guard",
				alwaysApply: false,
				astCondition: Array.from({ length: 30 }, (_, i) => `if ($X) clearTimeout($X) // ${i + 1}`),
				interruptMode: "never",
				content: "do not guard timers\nline 2\nline 3\nline 4",
			},
		});
		const collapsed = Bun.stripANSI(panel.render(42).join("\n"));
		expect(collapsed).toContain("30 patterns");
		expect(collapsed).toMatch(/more \(.* to expand\)/);
		expect(collapsed).toContain("Rule");
		expect(collapsed).toContain("do not guard timers");
		expect(collapsed).not.toContain("clearTimeout($X) // 30");
	});

	test("fills leftover viewport before advertising truncation", () => {
		const longBody = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		const panel = new InspectorPanel();
		panel.setHeight(40);
		panel.setExtension({
			...commandExtension(),
			raw: {
				name: "triage",
				content: `---\ndescription: "long template"\n---\n\n${longBody}\n`,
			},
		});
		const collapsed = render(panel);
		expect(collapsed).toContain("line 1");
		expect(collapsed).toContain("line 20");
		expect(collapsed).not.toContain("line 40");
		expect(collapsed).toMatch(/more \(.* to expand\)/);
	});
});

describe("inspector expand", () => {
	test("truncated command templates advertise ctrl+o and expand in place", () => {
		const longBody = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		const panel = new InspectorPanel();
		panel.setExtension({
			...commandExtension(),
			raw: {
				name: "triage",
				content: `---\ndescription: "long template"\n---\n\n${longBody}\n`,
			},
		});
		const collapsed = render(panel);
		expect(collapsed).toContain("line 1");
		expect(collapsed).not.toContain("line 20");
		expect(collapsed).toMatch(/more \(.* to expand\)/);

		panel.toggleExpanded();
		const expanded = render(panel);
		expect(expanded).toContain("line 20");
		expect(expanded).not.toMatch(/more \(.* to expand\)/);
	});
});
