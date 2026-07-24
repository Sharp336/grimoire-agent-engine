import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	ToolExecutionComponent,
	type ToolExecutionOptions,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SourceFormatter, SourceFormatterOutcome } from "@oh-my-pi/pi-coding-agent/tools/source-formatter";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";

function createDeferred<T>() {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, resolve };
}

function makeTextRenderer(): {
	tool: AgentTool;
	getRenderedText: () => string | undefined;
} {
	let rendered = "" as string | undefined;
	const tool = {
		name: "eval",
		label: "MockEval",
		renderCall: (args: unknown) => {
			rendered = JSON.stringify(args);
			return new Text(rendered, 0, 0);
		},
	} as unknown as AgentTool;
	return { tool, getRenderedText: () => rendered };
}

function sourceFormatterOutcomeMissing(formatter: string): SourceFormatterOutcome {
	return { status: "missing", formatter };
}

function sourceFormatterOutcomeFormatted(args: Record<string, unknown>): SourceFormatterOutcome {
	return { status: "formatted", args };
}

function sourceFormatterOutcomeUnchanged(): SourceFormatterOutcome {
	return { status: "unchanged" };
}

function sourceFormatterOptions(formatter: SourceFormatter): ToolExecutionOptions {
	return { sourceFormatter: formatter };
}

describe("ToolExecutionComponent source formatting", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) {
			component.stopAnimation();
		}
		components.length = 0;
		vi.restoreAllMocks();
	});

	it("renders raw args before args are complete", async () => {
		const { tool, getRenderedText } = makeTextRenderer();
		const sourceFormatter = vi.fn(
			async (_toolName: string, callArgs: unknown, _signal: AbortSignal): Promise<SourceFormatterOutcome> => {
				if (typeof callArgs !== "object" || callArgs === null) {
					return sourceFormatterOutcomeUnchanged();
				}
				const argsRecord = callArgs as Record<string, unknown>;
				const { code } = argsRecord;
				return sourceFormatterOutcomeFormatted({
					...argsRecord,
					code: `formatted(${typeof code === "string" ? code : ""})`,
				});
			},
		);
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const args = { language: "js", code: "raw()" };
		const component = new ToolExecutionComponent("eval", args, sourceFormatterOptions(sourceFormatter), tool, ui);
		components.push(component);

		const before = Bun.stripANSI(component.render(100).join("\n"));
		expect(before).toContain("raw()");
		expect(getRenderedText()).toContain("raw()");
		expect(sourceFormatter).not.toHaveBeenCalled();
	});

	it("formats source args once after args are complete", async () => {
		const { tool, getRenderedText } = makeTextRenderer();
		const sourceFormatter = vi.fn(
			async (_toolName: string, callArgs: unknown, _signal: AbortSignal): Promise<SourceFormatterOutcome> => {
				if (typeof callArgs !== "object" || callArgs === null) {
					return sourceFormatterOutcomeUnchanged();
				}
				const argsRecord = callArgs as Record<string, unknown>;
				const { code } = argsRecord;
				return sourceFormatterOutcomeFormatted({
					...argsRecord,
					code: `formatted(${typeof code === "string" ? code : ""})`,
				});
			},
		);
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const args = { language: "js", code: "raw()" };
		const component = new ToolExecutionComponent("eval", args, sourceFormatterOptions(sourceFormatter), tool, ui);
		components.push(component);

		component.setArgsComplete();
		component.setArgsComplete();
		await Bun.sleep(0);
		await Bun.sleep(0);

		const after = Bun.stripANSI(component.render(100).join("\n"));
		expect(sourceFormatter).toHaveBeenCalledTimes(1);
		expect(after).toContain("formatted(raw())");
		expect(getRenderedText()).toContain("formatted(raw())");
	});

	it("uses the latest formatter result when args update before completion", async () => {
		const { tool, getRenderedText } = makeTextRenderer();
		const firstPass = createDeferred<SourceFormatterOutcome>();
		const secondPass = createDeferred<SourceFormatterOutcome>();
		const responses = [firstPass, secondPass];
		let responseIndex = 0;
		const sourceFormatter = vi.fn(async (_toolName: string, _callArgs: unknown, _signal: AbortSignal) => {
			const response = responses[responseIndex++];
			if (!response) throw new Error("Unexpected formatter call");
			return response.promise;
		});
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"eval",
			{ language: "js", code: "stale()" },
			sourceFormatterOptions(sourceFormatter),
			tool,
			ui,
		);
		components.push(component);

		component.setArgsComplete();
		component.updateArgs({ language: "js", code: "fresh()" });
		component.setArgsComplete();

		secondPass.resolve(sourceFormatterOutcomeFormatted({ language: "js", code: "formatted(fresh())" }));
		firstPass.resolve(sourceFormatterOutcomeFormatted({ language: "js", code: "formatted(stale())" }));

		await Bun.sleep(0);
		await Bun.sleep(0);

		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		expect(rendered).toContain("formatted(fresh())");
		expect(rendered).not.toContain("formatted(stale())");
		expect(sourceFormatter).toHaveBeenCalledTimes(2);
		expect(getRenderedText()).toContain("formatted(fresh())");
	});

	it("does not apply formatting after the block is sealed", async () => {
		const { tool, getRenderedText } = makeTextRenderer();
		const result = createDeferred<SourceFormatterOutcome>();
		const sourceFormatter = vi.fn(
			async (_toolName: string, _callArgs: unknown, _signal: AbortSignal) => result.promise,
		);
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const ui = { requestRender, requestComponentRender } as unknown as TUI;

		const args = { language: "js", code: "raw()" };
		const component = new ToolExecutionComponent("eval", args, sourceFormatterOptions(sourceFormatter), tool, ui);
		components.push(component);

		component.setArgsComplete();
		expect(component.isTranscriptBlockFinalized()).toBe(false);
		component.seal();
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		result.resolve(sourceFormatterOutcomeFormatted({ language: "js", code: "formatted(raw())" }));

		await Bun.sleep(0);
		await Bun.sleep(0);

		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		expect(requestRender).toHaveBeenCalled();
		expect(requestComponentRender).not.toHaveBeenCalled();
		expect(rendered).toContain("raw()");
		expect(getRenderedText()).toContain("raw()");
		expect(sourceFormatter).toHaveBeenCalledTimes(1);
	});

	it("falls back to raw args when formatter returns unchanged", async () => {
		const { tool, getRenderedText } = makeTextRenderer();
		const sourceFormatter = vi.fn(
			async (_toolName: string, _callArgs: unknown, _signal: AbortSignal): Promise<SourceFormatterOutcome> => {
				return sourceFormatterOutcomeUnchanged();
			},
		);
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const args = { language: "js", code: "leave-me-raw" };
		const component = new ToolExecutionComponent("eval", args, sourceFormatterOptions(sourceFormatter), tool, ui);
		components.push(component);

		component.setArgsComplete();
		await Bun.sleep(0);
		await Bun.sleep(0);

		const rendered = Bun.stripANSI(component.render(100).join("\n"));
		expect(rendered).toContain("leave-me-raw");
		expect(getRenderedText()).toContain("leave-me-raw");
		expect(sourceFormatter).toHaveBeenCalledWith("eval", args, expect.any(AbortSignal));
	});
	it("shows the missing formatter install note after args complete and finalization settles", async () => {
		const result = createDeferred<SourceFormatterOutcome>();
		const sourceFormatter = vi.fn(
			async (_toolName: string, _callArgs: unknown, _signal: AbortSignal) => result.promise,
		);
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const ui = { requestRender, requestComponentRender } as unknown as TUI;

		const args = { language: "python", code: 'import json\nprint(json.dumps({"a": 1}))' };
		const component = new ToolExecutionComponent(
			"eval",
			args,
			sourceFormatterOptions(sourceFormatter),
			undefined,
			ui,
		);
		components.push(component);

		component.setArgsComplete();
		const pending = Bun.stripANSI(component.render(120).join("\n"));
		expect(pending).toContain("import json");
		expect(pending).not.toContain("Install prettier for pretty formatting");

		result.resolve(sourceFormatterOutcomeMissing("prettier"));
		await Bun.sleep(0);
		await Bun.sleep(0);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("Install prettier for pretty formatting");
		expect(rendered).toContain("import json");
		expect(requestComponentRender).toHaveBeenCalled();
	});

	it("shows no install note when formatter outcome is unchanged", async () => {
		const sourceFormatter = vi.fn(async (_toolName: string, _callArgs: unknown, _signal: AbortSignal) => {
			return sourceFormatterOutcomeUnchanged();
		});
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const ui = { requestRender, requestComponentRender } as unknown as TUI;

		const args = { language: "python", code: "leave-me-raw" };
		const component = new ToolExecutionComponent(
			"eval",
			args,
			sourceFormatterOptions(sourceFormatter),
			undefined,
			ui,
		);
		components.push(component);

		component.setArgsComplete();
		await Bun.sleep(0);
		await Bun.sleep(0);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("leave-me-raw");
		expect(rendered).not.toContain("Install prettier for pretty formatting");
		expect(requestComponentRender).toHaveBeenCalled();
		expect(sourceFormatter).toHaveBeenCalledTimes(1);
	});

	it("clears a stale missing formatter note when a later arg generation settles unchanged", async () => {
		const firstPass = createDeferred<SourceFormatterOutcome>();
		const secondPass = createDeferred<SourceFormatterOutcome>();
		const responses = [firstPass, secondPass];
		let responseIndex = 0;
		const sourceFormatter = vi.fn(async (_toolName: string, _callArgs: unknown, _signal: AbortSignal) => {
			const response = responses[responseIndex++];
			if (!response) throw new Error("Unexpected formatter call");
			return response.promise;
		});
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const ui = { requestRender, requestComponentRender } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"eval",
			{ language: "js", code: "stale()" },
			sourceFormatterOptions(sourceFormatter),
			undefined,
			ui,
		);
		components.push(component);

		component.setArgsComplete();
		firstPass.resolve(sourceFormatterOutcomeMissing("prettier"));
		await Bun.sleep(0);
		await Bun.sleep(0);

		const staleHint = Bun.stripANSI(component.render(120).join("\n"));
		expect(staleHint).toContain("Install prettier for pretty formatting");
		expect(staleHint).toContain("stale()");

		component.updateArgs({ language: "js", code: "fresh()" });
		component.setArgsComplete();
		secondPass.resolve(sourceFormatterOutcomeUnchanged());
		await Bun.sleep(0);
		await Bun.sleep(0);

		const settled = Bun.stripANSI(component.render(120).join("\n"));
		expect(settled).not.toContain("Install prettier for pretty formatting");
		expect(settled).toContain("fresh()");
		expect(requestComponentRender).toHaveBeenCalled();
		expect(sourceFormatter).toHaveBeenCalledTimes(2);
	});
	it("uses formatted eval args for completed cell code once formatter resolves", async () => {
		const formatResult = createDeferred<SourceFormatterOutcome>();
		const sourceFormatter = vi.fn(async (_toolName: string, _callArgs: unknown, _signal: AbortSignal) => {
			return formatResult.promise;
		});
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const args = { language: "python", code: "raw()" };
		const component = new ToolExecutionComponent(
			"eval",
			args,
			sourceFormatterOptions(sourceFormatter),
			undefined,
			ui,
		);
		components.push(component);

		component.setArgsComplete();
		component.updateResult(
			{
				content: [{ type: "text", text: "final result text" }],
				details: {
					cells: [
						{
							index: 0,
							title: "Cell 0",
							code: "raw()",
							language: "python",
							output: "cell output text",
							status: "complete",
						},
					],
				},
			},
			false,
		);

		await Bun.sleep(0);

		const pendingRender = Bun.stripANSI(component.render(120).join("\n"));
		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(pendingRender).toContain("raw()");
		expect(pendingRender).toContain("cell output text");
		expect(pendingRender).not.toContain("formatted(");
		expect(pendingRender).not.toMatch(/\n│\s{2,}raw\(\)/);

		formatResult.resolve(
			sourceFormatterOutcomeFormatted({
				language: "python",
				code: "formatted(\n  raw()\n)",
			}),
		);
		await Bun.sleep(0);

		const completedRender = Bun.stripANSI(component.render(120).join("\n"));
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(completedRender).toContain("formatted(");
		expect(completedRender).toMatch(/\n│\s{2,}raw\(\)/);
		expect(completedRender).toContain("cell output text");
	});

	it("stays in live region while final result waits for source-format settlement", async () => {
		const { tool } = makeTextRenderer();
		const result = createDeferred<SourceFormatterOutcome>();
		const sourceFormatter = vi.fn(
			async (_toolName: string, _callArgs: unknown, _signal: AbortSignal) => result.promise,
		);
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const args = { language: "js", code: "raw()" };
		const component = new ToolExecutionComponent("eval", args, sourceFormatterOptions(sourceFormatter), tool, ui);
		components.push(component);

		component.setArgsComplete();
		component.updateResult({ content: [{ type: "text", text: "finalized" }] }, false);

		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("raw()");

		result.resolve(sourceFormatterOutcomeFormatted({ language: "js", code: "formatted(raw())" }));
		await Bun.sleep(0);

		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("formatted(raw())");
	});

	it("becomes finalizable when source formatting falls back on unchanged result", async () => {
		const { tool } = makeTextRenderer();
		const sourceFormatter = vi.fn(
			async (_toolName: string, _callArgs: unknown, _signal: AbortSignal): Promise<SourceFormatterOutcome> => {
				return sourceFormatterOutcomeUnchanged();
			},
		);
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const args = { language: "js", code: "raw()" };
		const component = new ToolExecutionComponent("eval", args, sourceFormatterOptions(sourceFormatter), tool, ui);
		components.push(component);

		component.setArgsComplete();
		component.updateResult({ content: [{ type: "text", text: "finalized" }] }, false);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		await Bun.sleep(0);

		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("raw()");
	});

	it("finalizes immediately when source formatting throws", async () => {
		const { tool } = makeTextRenderer();
		const sourceFormatter = vi.fn(
			async (_toolName: string, _callArgs: unknown, _signal: AbortSignal): Promise<SourceFormatterOutcome> => {
				throw new Error("format failed");
			},
		);
		const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const args = { language: "js", code: "raw()" };
		const component = new ToolExecutionComponent("eval", args, sourceFormatterOptions(sourceFormatter), tool, ui);
		components.push(component);

		component.setArgsComplete();
		component.updateResult({ content: [{ type: "text", text: "finalized" }] }, false);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		await Bun.sleep(0);

		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("raw()");
	});
});
