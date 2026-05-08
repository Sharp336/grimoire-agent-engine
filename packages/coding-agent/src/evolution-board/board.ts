import { YAML } from "bun";
import type { EvolutionBoard, EvolutionTopic, TopicStatus } from "./types";

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
	};
}
