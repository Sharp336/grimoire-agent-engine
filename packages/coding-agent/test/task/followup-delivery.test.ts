import { describe, test } from "bun:test";

describe("async task follow-up delivery", () => {
	test.todo("completed task triggers deliverFollowUp with result summary", () => {});
	test.todo("failed task triggers deliverFollowUp with error", () => {});
	test.todo("cancelled task does not trigger deliverFollowUp", () => {});
	test.todo("deliverFollowUp not called when callback is undefined", () => {});
});
