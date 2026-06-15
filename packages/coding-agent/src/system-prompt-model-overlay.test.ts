import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "./system-prompt";

/**
 * The model-family overlay (resolveModelOverlay) is unit-tested in
 * prompts/model-overlay; this guards the integration wiring: buildSystemPrompt
 * must append the matched family's section to block 0 when modelOverlay is on
 * and the active model matches, and append nothing otherwise. Discovery is
 * stubbed via provided skills/contextFiles/workspaceTree so the build stays fast.
 */
const baseOpts = {
	toolNames: ["read"],
	skills: [],
	contextFiles: [],
	workspaceTree: {
		rootPath: process.cwd(),
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [] as string[],
	},
};

describe("buildSystemPrompt model overlay", () => {
	it("appends the matching family overlay to block 0 in auto mode", async () => {
		const { systemPrompt } = await buildSystemPrompt({ ...baseOpts, model: "openai/gpt-5.5", modelOverlay: "auto" });
		expect(systemPrompt[0]).toContain("## Model overlay: GPT-5");
	});

	it("omits the overlay when disabled", async () => {
		const { systemPrompt } = await buildSystemPrompt({ ...baseOpts, model: "openai/gpt-5.5", modelOverlay: "off" });
		expect(systemPrompt[0]).not.toContain("## Model overlay");
	});

	it("omits the overlay for an unmatched model in auto mode", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			...baseOpts,
			model: "anthropic/claude-sonnet-4-6",
			modelOverlay: "auto",
		});
		expect(systemPrompt[0]).not.toContain("## Model overlay");
	});

	it("forces a family overlay regardless of the active model", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			...baseOpts,
			model: "anthropic/claude-sonnet-4-6",
			modelOverlay: "kimi-k2",
		});
		expect(systemPrompt[0]).toContain("## Model overlay: Kimi K2");
	});
});
