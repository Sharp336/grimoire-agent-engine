/**
 * Regression for issue #5764: re-registering an essential built-in (read /
 * write / bash / edit / glob) without an explicit `loadMode` must NOT demote it
 * to `discoverable`, which — with `tools.xdev` on — unmounts it from the
 * top-level schema and breaks the `xd://` transport (transport IS `read xd://`
 * / `write xd://<tool>`).
 *
 * Also tests that a plain {@link ToolDefinition} composed via
 * {@link composeToolDefinition} executes with the correct arg order
 * `(toolCallId, params, signal, onUpdate, ctx)` — the bug fixed by splitting
 * `composeCustomTool` (CustomTool only) from `composeToolDefinition`.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	composeAgentTool,
	composeCustomTool,
	composeToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/compose-tool";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	defaultLoadModeForToolName,
	ESSENTIAL_BUILTIN_TOOL_NAMES,
} from "@oh-my-pi/pi-coding-agent/tools/essential-tools";
import { isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

const emptySchema = type({});
const noopExecute = async () => ({ content: [{ type: "text" as const, text: "" }] });
const stubRunner = { createContext: () => ({}) as ExtensionContext } as ExtensionRunner;
// A runner stub complete enough for ExtensionToolWrapper.execute to pass through:
// no handlers to emit, no tool-call marker consumed, yolo approval (no context settings).
// Built via Object.assign so the cast through the single-method stub type stays valid.
const execRunner = Object.assign(stubRunner, {
	hasHandlers: () => false,
	consumeToolCallEmitted: () => false,
}) as ExtensionRunner;

describe("issue #5764: registerTool loadMode default", () => {
	it("never mounts the read/write transport tools under xdev, even when mislabeled discoverable", () => {
		expect(isMountableUnderXdev({ name: "read", loadMode: "discoverable" })).toBe(false);
		expect(isMountableUnderXdev({ name: "write", loadMode: "discoverable" })).toBe(false);
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" })).toBe(true);
	});

	it("defaults omitted loadMode to essential for essential built-in names, discoverable otherwise", () => {
		expect(defaultLoadModeForToolName("read")).toBe("essential");
		expect(defaultLoadModeForToolName("bash")).toBe("essential");
		expect(defaultLoadModeForToolName("edit")).toBe("essential");
		expect(defaultLoadModeForToolName("glob")).toBe("essential");
		expect(defaultLoadModeForToolName("some_extension_tool")).toBe("discoverable");
		expect(defaultLoadModeForToolName("read", "discoverable")).toBe("discoverable");
		expect(defaultLoadModeForToolName("some_extension_tool", "essential")).toBe("essential");
	});

	it("composeCustomTool defaults a re-registered essential built-in (CustomTool) to essential and not mountable", () => {
		const customTool: CustomTool = {
			name: "bash",
			label: "Bash",
			description: "wrapped bash",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeCustomTool(customTool, stubRunner);
		expect(tool.loadMode).toBe("essential");
		expect(isMountableUnderXdev(tool)).toBe(false);
	});

	it("composeToolDefinition defaults a re-registered essential built-in to essential and not mountable", () => {
		const definition: ToolDefinition = {
			name: "read",
			label: "Read",
			description: "wrapped read",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeToolDefinition(definition, stubRunner);
		expect(tool.loadMode).toBe("essential");
		expect(isMountableUnderXdev(tool)).toBe(false);
	});

	it("composeCustomTool still defaults a novel extension CustomTool to discoverable", () => {
		const customTool: CustomTool = {
			name: "my_ext_tool",
			label: "My Ext Tool",
			description: "novel tool",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeCustomTool(customTool, stubRunner);
		expect(tool.loadMode).toBe("discoverable");
		expect(isMountableUnderXdev(tool)).toBe(true);
	});

	it("composeToolDefinition still defaults a novel extension ToolDefinition to discoverable", () => {
		const definition: ToolDefinition = {
			name: "my_ext_tool",
			label: "My Ext Tool",
			description: "novel tool",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeToolDefinition(definition, stubRunner);
		expect(tool.loadMode).toBe("discoverable");
		expect(isMountableUnderXdev(tool)).toBe(true);
	});

	it("composeAgentTool preserves an essential built-in AgentTool's loadMode and keeps it unmountable", async () => {
		const session = makeSession();
		const builtIn = await BUILTIN_TOOLS.bash(session);
		if (!builtIn) {
			expect.unreachable("bash built-in should be available");
			return;
		}
		const tool = composeAgentTool(builtIn, stubRunner);
		expect(tool.loadMode).toBe("essential");
		expect(isMountableUnderXdev(tool)).toBe(false);
	});

	it("composeToolDefinition respects an explicit opts.loadMode override", () => {
		const definition: ToolDefinition = {
			name: "some_extension_tool",
			label: "Some Tool",
			description: "test",
			parameters: emptySchema,
			execute: noopExecute,
		};
		const tool = composeToolDefinition(definition, stubRunner, { loadMode: "essential" });
		expect(tool.loadMode).toBe("essential");
		expect(isMountableUnderXdev(tool)).toBe(false);
	});

	it("keeps ESSENTIAL_BUILTIN_TOOL_NAMES in sync with the tool classes that declare loadMode essential", async () => {
		const session = makeSession();
		for (const name in ESSENTIAL_BUILTIN_TOOL_NAMES) {
			const factory = BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS];
			expect(factory, `${name} must be a built-in factory`).toBeDefined();
			const tool = await factory(session);
			if (!tool) continue;
			expect(tool.loadMode, `${name} must declare loadMode "essential"`).toBe("essential");
		}
	});
});

describe("composeToolDefinition execution arg order", () => {
	it("receives (signal, onUpdate, ctx) in the ToolDefinition slots, not the CustomTool slots", async () => {
		const sentinelSignal = new AbortController().signal;
		const sentinelOnUpdate = () => {};

		let captured: { signal?: unknown; onUpdate?: unknown; ctx?: unknown } = {};

		const definition: ToolDefinition = {
			name: "arg_order_probe",
			label: "Arg Order Probe",
			description: "captures the execute arg slots",
			parameters: emptySchema,
			async execute(_toolCallId, _params, signal, onUpdate, ctx) {
				captured = { signal, onUpdate, ctx };
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};

		// With a stub runner, RegisteredToolAdapter builds the extension context
		// via runner.createContext and passes it as the ctx slot.
		const tool = composeToolDefinition(definition, execRunner);
		await tool.execute("call-1", {}, sentinelSignal, sentinelOnUpdate, undefined);

		// ToolDefinition.execute signature: (toolCallId, params, signal, onUpdate, ctx)
		// The definition must receive the original signal at slot 3, onUpdate at
		// slot 4, and ctx at slot 5 — NOT shuffled into CustomTool order
		// (onUpdate, ctx, signal).
		expect(captured.signal).toBe(sentinelSignal);
		expect(captured.onUpdate).toBe(sentinelOnUpdate);
		expect(captured.ctx).toEqual({}); // stubRunner.createContext returns {}
	});
});

describe("class-based ToolDefinition composition (prototype methods preserved)", () => {
	it("executes a class-based ToolDefinition whose execute is a prototype method and loadMode is omitted", async () => {
		class CounterTool implements ToolDefinition {
			readonly name = "class_counter";
			readonly label = "Class Counter";
			readonly description = "increments an instance counter on each call";
			readonly parameters = emptySchema;
			#count = 0;

			async execute(
				_toolCallId: string,
				_params: Record<string, never>,
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				_ctx: ExtensionContext,
			) {
				this.#count++;
				return { content: [{ type: "text" as const, text: `count:${this.#count}` }] };
			}
		}

		const tool = composeToolDefinition(new CounterTool(), execRunner);
		const result = await tool.execute("call-1", {}, undefined, undefined, undefined);
		expect(result.content[0]).toEqual({ type: "text", text: "count:1" });

		// Second call proves instance state survives — the definition object
		// identity was preserved, not spread into a plain object.
		const result2 = await tool.execute("call-2", {}, undefined, undefined, undefined);
		expect(result2.content[0]).toEqual({ type: "text", text: "count:2" });
	});
});

describe("class-based CustomTool renderCall receiver (private field)", () => {
	it("renderCall reads a #private field through the composed tool without throwing", () => {
		class LabeledTool implements CustomTool {
			readonly name = "class_labeled";
			readonly label = "Class Labeled";
			readonly description = "renderCall reads a private label";
			readonly parameters = emptySchema;
			#label = "private-label-value";

			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }] };
			}

			renderCall() {
				return { render: () => [this.#label] };
			}
		}

		const tool = composeCustomTool(new LabeledTool(), execRunner);
		// renderCall is forwarded through RegisteredToolAdapter; if the method
		// is copied bare (without binding), `this` is wrong and `this.#label`
		// throws a TypeError: Cannot read private member from an object whose
		// private brand does not match.
		const component = tool.renderCall?.({}, { expanded: false, isPartial: false }, {} as never);
		const rows =
			typeof component === "object" && component !== null && "render" in component
				? (component as { render: (width: number) => readonly string[] }).render(80)
				: undefined;
		expect(rows).toEqual(["private-label-value"]);
	});
});

describe("class-based CustomTool metadata getters stay live after composition", () => {
	it("description and hidden reflect mutated state when read from the composed definition", () => {
		class StatefulTool implements CustomTool {
			readonly name = "stateful_metadata";
			readonly parameters = emptySchema;
			#description = "initial-description";
			#hidden = false;

			get label(): string {
				return `label-for-${this.#description}`;
			}
			get description(): string {
				return this.#description;
			}
			get hidden(): boolean {
				return this.#hidden;
			}

			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }] };
			}

			setDescription(value: string): void {
				this.#description = value;
			}
			setHidden(value: boolean): void {
				this.#hidden = value;
			}
		}

		const instance = new StatefulTool();
		// composeCustomTool calls customToolToDefinition, which produces the
		// ToolDefinition the RegisteredToolAdapter wraps. We read the adapter's
		// forwarded properties — they must reflect live state, not a snapshot.
		const tool = composeCustomTool(instance, execRunner);

		// Initial state — snapshot would capture these values.
		expect(tool.description).toBe("initial-description");
		expect(tool.hidden).toBe(false);
		expect(tool.label).toBe("label-for-initial-description");

		// Mutate the backing state. A snapshot taken at composition time would
		// still report the old values; live getters report the new ones.
		instance.setDescription("updated-description");
		instance.setHidden(true);

		expect(tool.description).toBe("updated-description");
		expect(tool.hidden).toBe(true);
		expect(tool.label).toBe("label-for-updated-description");
	});
});
