import { describe, expect, it } from "bun:test";
import { createEvolutionBoard } from "@oh-my-pi/pi-coding-agent/evolution-board/board";

const sampleYaml = `
topics:
  - id: feature-dashboard
    name: 功能进化看板
    brief: 在 TUI 中展示 omp 二次开发任务状态
    status: in-progress
    progress: 30
    modules:
      - coding-agent
      - pi-tui
    tags: [tui, developer-tool]
`;

describe("EvolutionBoard", () => {
	it("loads topics from YAML", () => {
		const board = createEvolutionBoard();
		board.load(sampleYaml);
		const topics = board.getTopics();
		expect(topics).toHaveLength(1);
		expect(topics[0].id).toBe("feature-dashboard");
		expect(topics[0].status).toBe("in-progress");
	});

	it("filters by status", () => {
		const board = createEvolutionBoard();
		board.load(sampleYaml);
		const inProgress = board.getByStatus("in-progress");
		expect(inProgress).toHaveLength(1);
		expect(inProgress[0].id).toBe("feature-dashboard");
	});

	it("filters by module", () => {
		const board = createEvolutionBoard();
		board.load(sampleYaml);
		const codingAgentTopics = board.getByModule("coding-agent");
		expect(codingAgentTopics).toHaveLength(1);
	});

	it("filters by tag", () => {
		const board = createEvolutionBoard();
		board.load(sampleYaml);
		const tuiTopics = board.getByTag("tui");
		expect(tuiTopics).toHaveLength(1);
	});

	it("returns undefined for unknown topic id", () => {
		const board = createEvolutionBoard();
		board.load(sampleYaml);
		expect(board.getTopic("nonexistent")).toBeUndefined();
	});
});
