import { describe, test } from "bun:test";

describe("TaskTool async execution", () => {
	test.todo("async: true returns immediately with task ID", () => {});
	test.todo("async: true registers task in registry", () => {});
	test.todo("async: false still blocks until completion", () => {});
	test.todo("async + isolated returns error", () => {});
	test.todo("async respects maxAsyncTasks limit", () => {});
});
