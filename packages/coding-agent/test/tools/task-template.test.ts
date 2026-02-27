import { describe, expect, test } from "bun:test";
import { sectionSeparator } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { renderTemplate } from "@oh-my-pi/pi-coding-agent/task/template";

describe("renderTemplate", () => {
	test("returns assignment as task when no context", () => {
		const result = renderTemplate(undefined, {
			id: "Test",
			description: "Short label",
			assignment: "Do the thing in detail.\nStep 1: read file.\nStep 2: edit it.",
		});
		expect(result.task).toBe("Do the thing in detail.\nStep 1: read file.\nStep 2: edit it.");
		expect(result.id).toBe("Test");
		expect(result.description).toBe("Short label");
	});

	test("prepends context with separator when provided", () => {
		const result = renderTemplate("Shared constraints here", {
			id: "TaskA",
			description: "First task",
			assignment: "Full instructions for the agent.\nWith multiple lines.",
		});
		expect(result.task).toContain("Shared constraints here");
		expect(result.task).toContain(sectionSeparator("Background").trimStart());
		expect(result.task).toContain("Full instructions for the agent.\nWith multiple lines.");
	});

	test("trims context whitespace", () => {
		const result = renderTemplate("  \n  context  \n  ", {
			id: "X",
			description: "label",
			assignment: "the real work",
		});
		expect(result.task).toStartWith(`${sectionSeparator("Background").trimStart()}\n<context>\ncontext`);
		expect(result.task).toContain("the real work");
	});

	test("empty context treated as absent", () => {
		const result = renderTemplate("   ", {
			id: "X",
			description: "label",
			assignment: "just the assignment",
		});
		expect(result.task).toBe("just the assignment");
	});

	test("passes through skills", () => {
		const result = renderTemplate(undefined, {
			id: "X",
			description: "label",
			assignment: "do stuff",
			skills: ["react", "postgres"],
		});
		expect(result.skills).toEqual(["react", "postgres"]);
	});

	describe("model field preservation", () => {
		test("passes through model when context and assignment both present", () => {
			const result = renderTemplate("Shared context", {
				id: "T",
				description: "label",
				assignment: "do work",
				model: "anthropic/claude-haiku-4-5",
			});
			expect(result.model).toBe("anthropic/claude-haiku-4-5");
		});

		test("passes through model when no context", () => {
			const result = renderTemplate(undefined, {
				id: "T",
				description: "label",
				assignment: "do work",
				model: "openai/gpt-4o",
			});
			expect(result.model).toBe("openai/gpt-4o");
		});

		test("passes through model when no assignment (context-only path)", () => {
			const result = renderTemplate("only context here", {
				id: "T",
				description: "label",
				assignment: "",
				model: "litellm/my-model",
			});
			expect(result.model).toBe("litellm/my-model");
		});

		test("model is undefined when not set on task", () => {
			const result = renderTemplate("context", {
				id: "T",
				description: "label",
				assignment: "do work",
			});
			expect(result.model).toBeUndefined();
		});

		test("model preserved alongside skills", () => {
			const result = renderTemplate(undefined, {
				id: "T",
				description: "label",
				assignment: "do work",
				skills: ["react"],
				model: "anthropic/claude-sonnet-4-5",
			});
			expect(result.model).toBe("anthropic/claude-sonnet-4-5");
			expect(result.skills).toEqual(["react"]);
		});
	});
});
