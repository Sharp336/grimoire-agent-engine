export type TopicStatus = "planned" | "in-progress" | "review" | "testing" | "shipped" | "deferred";

export interface EvolutionTopic {
	id: string;
	name: string;
	brief: string;
	description?: string;
	status: TopicStatus;
	progress?: number;
	started?: string;
	target?: string;
	modules?: string[];
	design?: { spec?: string; plan?: string };
	references?: { name: string; url: string; note?: string }[];
	github?: { issues?: string[]; prs?: string[] };
	notes?: string;
	tags?: string[];
}

export interface EvolutionBoard {
	getTopics(): EvolutionTopic[];
	getTopic(id: string): EvolutionTopic | undefined;
	getByStatus(status: TopicStatus): EvolutionTopic[];
	getByModule(module: string): EvolutionTopic[];
	getByTag(tag: string): EvolutionTopic[];
	addTopic(topic: EvolutionTopic): void;
	load(yamlContent: string): void;
	save(yamlPath: string): Promise<void>;
}
