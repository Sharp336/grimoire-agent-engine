/**
 * Regression for issue #5764: re-registering an essential built-in (read /
 * write / bash / edit / glob) without an explicit `loadMode` must NOT demote it
 * to `discoverable`, which — with `tools.xdev` on — unmounts it from the
 * top-level schema and breaks the `xd://` transport (transport IS `read xd://`
 * / `write xd://<tool>`).
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomToolAdapter } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/wrapper";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { RegisteredToolAdapter } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	defaultLoadModeForToolName,
	ESSENTIAL_BUILTIN_TOOL_NAMES,
} from "@oh-my-pi/pi-coding-agent/tools/essential-tools";
import { compileXdevPromoteSet, isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

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

describe("issue #5764: registerTool loadMode default", () => {
	it("never mounts the read/write transport tools under xdev, even when mislabeled discoverable", () => {
		// A UI-only re-register could carry loadMode "discoverable"; the transport
		// invariant must still keep read/write top-level.
		expect(isMountableUnderXdev({ name: "read", loadMode: "discoverable" })).toBe(false);
		expect(isMountableUnderXdev({ name: "write", loadMode: "discoverable" })).toBe(false);
		// A genuinely discoverable tool still mounts.
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" })).toBe(true);
	});

	it("promotion keeps a discoverable tool top-level without touching pinned names", () => {
		// Promoted discoverable tools never mount; unpromoted ones still do.
		expect(isMountableUnderXdev({ name: "ast_edit", loadMode: "discoverable" }, new Set(["ast_edit"]))).toBe(false);
		expect(isMountableUnderXdev({ name: "ast_grep", loadMode: "discoverable" }, new Set(["ast_edit"]))).toBe(true);
		// Promotion cannot override transport/pinned names: read and write stay
		// top-level regardless, and todo/grep stay pinned even when promoted.
		expect(isMountableUnderXdev({ name: "write", loadMode: "discoverable" }, new Set(["write"]))).toBe(false);
		expect(isMountableUnderXdev({ name: "todo", loadMode: "discoverable" }, new Set(["todo"]))).toBe(false);
	});

	it("tolerates malformed tools.xdevPromote config values", () => {
		// A hand-edited scalar (`tools.xdevPromote: lsp`) promotes that single
		// tool instead of crashing mounting; objects/numbers are dropped.
		expect(compileXdevPromoteSet("lsp" as unknown as string[])).toEqual(new Set(["lsp"]));
		expect(compileXdevPromoteSet("LSP, ast_grep" as unknown as string[])).toEqual(new Set(["lsp", "ast_grep"]));
		expect(compileXdevPromoteSet({ lsp: true } as unknown as string[])).toBeUndefined();
		expect(compileXdevPromoteSet([42] as unknown as string[])).toBeUndefined();
		// Mixed lists keep the valid names, normalized case-insensitively.
		expect(compileXdevPromoteSet(["LSP", 42])).toEqual(new Set(["lsp"]));
		expect(compileXdevPromoteSet([])).toBeUndefined();
		expect(compileXdevPromoteSet(undefined)).toBeUndefined();
	});

	it("defaults omitted loadMode to essential for essential built-in names, discoverable otherwise", () => {
		expect(defaultLoadModeForToolName("read")).toBe("essential");
		expect(defaultLoadModeForToolName("bash")).toBe("essential");
		expect(defaultLoadModeForToolName("edit")).toBe("essential");
		expect(defaultLoadModeForToolName("glob")).toBe("essential");
		expect(defaultLoadModeForToolName("some_extension_tool")).toBe("discoverable");
		// An explicit mode always wins.
		expect(defaultLoadModeForToolName("read", "discoverable")).toBe("discoverable");
		expect(defaultLoadModeForToolName("some_extension_tool", "essential")).toBe("essential");
	});

	it("RegisteredToolAdapter keeps a re-registered essential built-in essential (not mountable)", () => {
		const runner = {} as ExtensionRunner;
		const adapter = new RegisteredToolAdapter(
			{
				definition: {
					name: "read",
					label: "Read",
					description: "wrapped read",
					parameters: emptySchema,
					// NO loadMode — the exact footgun from the issue.
					execute: noopExecute,
				},
				extensionPath: "<test>",
			},
			runner,
		);
		expect(adapter.loadMode).toBe("essential");
		expect(isMountableUnderXdev(adapter)).toBe(false);
	});

	it("RegisteredToolAdapter still defaults a novel extension tool to discoverable", () => {
		const runner = {} as ExtensionRunner;
		const adapter = new RegisteredToolAdapter(
			{
				definition: {
					name: "my_ext_tool",
					label: "My Ext Tool",
					description: "novel tool",
					parameters: emptySchema,
					execute: noopExecute,
				},
				extensionPath: "<test>",
			},
			runner,
		);
		expect(adapter.loadMode).toBe("discoverable");
		expect(isMountableUnderXdev(adapter)).toBe(true);
	});

	it("CustomToolAdapter keeps a re-registered essential built-in essential", () => {
		const adapter = new CustomToolAdapter(
			{
				name: "bash",
				label: "Bash",
				description: "wrapped bash",
				parameters: emptySchema,
				execute: noopExecute,
			},
			() => ({}) as never,
		);
		expect(adapter.loadMode).toBe("essential");
		expect(isMountableUnderXdev(adapter)).toBe(false);
	});

	it("keeps ESSENTIAL_BUILTIN_TOOL_NAMES in sync with the tool classes that declare loadMode essential", async () => {
		const session = makeSession();
		for (const name in ESSENTIAL_BUILTIN_TOOL_NAMES) {
			const factory = BUILTIN_TOOLS[name as keyof typeof BUILTIN_TOOLS];
			expect(factory, `${name} must be a built-in factory`).toBeDefined();
			// learn/manage_skill are conditional (need an autolearn backend) and
			// return null in a default session; their essential loadMode is covered
			// by autolearn-tools-gating.test.ts. Assert the rest build as essential.
			const tool = await factory(session);
			if (!tool) continue;
			expect(tool.loadMode, `${name} must declare loadMode "essential"`).toBe("essential");
		}
	});
});
