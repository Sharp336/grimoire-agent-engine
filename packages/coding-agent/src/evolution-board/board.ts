import * as fs from "node:fs/promises";

import { YAML } from "bun";
import type { EvolutionBoard, EvolutionTopic, TopicStatus } from "./types";

export function generateTopicId(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.replace(/--+/g, "-");
}

export function createEvolutionBoard(): EvolutionBoard {
	let topics: EvolutionTopic[] = [];
	return {
		load(yamlContent: string): void {
			const parsed = YAML.parse(yamlContent) as { topics?: unknown[] };
			topics = (parsed.topics ?? []).map((raw: unknown) => raw as EvolutionTopic);
		},
		getTopics(): EvolutionTopic[] {
			return topics;
		},
		getTopic(id: string): EvolutionTopic | undefined {
			return topics.find(t => t.id === id);
		},
		getByStatus(status: TopicStatus): EvolutionTopic[] {
			return topics.filter(t => t.status === status);
		},
		getByModule(module: string): EvolutionTopic[] {
			return topics.filter(t => t.modules?.includes(module));
		},
		getByTag(tag: string): EvolutionTopic[] {
			return topics.filter(t => t.tags?.includes(tag));
		},
		addTopic(topic: EvolutionTopic): void {
			topics.push(topic);
		},
		async save(yamlPath: string): Promise<void> {
			const data = { topics };
			const yamlContent = YAML.stringify(data);
			await fs.writeFile(yamlPath, yamlContent, "utf-8");
		},
	};
}
