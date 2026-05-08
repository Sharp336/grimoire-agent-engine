import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "../modes/theme/theme";
import type { EvolutionTopic, TopicStatus } from "./types";

const STATUS_LABELS: Record<TopicStatus, string> = {
	planned: "planned",
	"in-progress": "in-progr",
	review: "review",
	testing: "testing",
	shipped: "shipped",
	deferred: "deferred",
};

const STATUS_COLORS: Record<TopicStatus, string> = {
	planned: "dim",
	"in-progress": "warning",
	review: "accent",
	testing: "info",
	shipped: "success",
	deferred: "muted",
};

export function renderTopicList(topics: EvolutionTopic[], width: number, theme: Theme): string[] {
	if (topics.length === 0) {
		return [theme.fg("dim", "No topics found.")];
	}
	return topics.map(topic => {
		const status = STATUS_LABELS[topic.status];
		const statusColor = STATUS_COLORS[topic.status];
		const statusTag = theme.fg(statusColor as never, `[${status.padEnd(8)}]`);
		const name = truncateToWidth(topic.name, 20);
		const modules = topic.modules?.join(", ") ?? "";
		const progress = topic.progress !== undefined ? ` ${topic.progress}%` : "";
		const line = `${statusTag} ${name} 影响: ${modules}${progress}`;
		return truncateToWidth(line, width);
	});
}

export function renderTopicDetail(topic: EvolutionTopic, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	const statusColor = STATUS_COLORS[topic.status];

	lines.push(theme.fg("accent", topic.name));
	lines.push(
		theme.fg(
			statusColor as never,
			`Status: ${topic.status}${topic.progress !== undefined ? ` (${topic.progress}%)` : ""}`,
		),
	);

	if (topic.brief) {
		lines.push("");
		lines.push(theme.fg("muted", "Brief:"));
		lines.push(truncateToWidth(topic.brief, width));
	}

	if (topic.description) {
		lines.push("");
		lines.push(theme.fg("muted", "Description:"));
		for (const line of topic.description.split("\n")) {
			lines.push(truncateToWidth(replaceTabs(line), width));
		}
	}

	if (topic.modules && topic.modules.length > 0) {
		lines.push("");
		lines.push(theme.fg("muted", "Modules:"));
		lines.push(truncateToWidth(topic.modules.join(", "), width));
	}

	if (topic.design?.spec || topic.design?.plan) {
		lines.push("");
		lines.push(theme.fg("muted", "Design:"));
		if (topic.design.spec) lines.push(`  Spec: ${topic.design.spec}`);
		if (topic.design.plan) lines.push(`  Plan: ${topic.design.plan}`);
	}

	if (topic.references && topic.references.length > 0) {
		lines.push("");
		lines.push(theme.fg("muted", "References:"));
		for (const ref of topic.references) {
			lines.push(`  ${ref.name}: ${ref.url}`);
		}
	}

	if (topic.github?.issues || topic.github?.prs) {
		lines.push("");
		lines.push(theme.fg("muted", "GitHub:"));
		if (topic.github.issues) lines.push(`  Issues: ${topic.github.issues.join(", ")}`);
		if (topic.github.prs) lines.push(`  PRs: ${topic.github.prs.join(", ")}`);
	}

	if (topic.notes) {
		lines.push("");
		lines.push(theme.fg("muted", "Notes:"));
		for (const line of topic.notes.split("\n")) {
			lines.push(truncateToWidth(replaceTabs(line), width));
		}
	}

	if (topic.tags && topic.tags.length > 0) {
		lines.push("");
		lines.push(theme.fg("muted", `Tags: ${topic.tags.join(", ")}`));
	}

	return lines;
}
