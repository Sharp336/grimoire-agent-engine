import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import type { AgentEvent, AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { type BlockState, handleServerMessage, type ToolCallState } from "@oh-my-pi/pi-ai/providers/cursor";
import { piTruncation } from "@oh-my-pi/pi-ai/providers/cursor/exec-modern";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	DeleteArgsSchema,
	ExecServerMessageSchema,
	McpArgsSchema,
	ReadArgsSchema,
	ShellArgsSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import {
	bridgeToolMap,
	createBridgeEditTool,
	createBridgeGrepFactory,
} from "@oh-my-pi/pi-coding-agent/cursor-bridge-tools";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { GrepTool, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import type { TruncationMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { AdviseTool } from "../src/advisor/advise-tool";

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

/**
 * An `ExtensionRunner` that intercepts nothing but records that it ran.
 *
 * The bridge's per-call tools must carry the same wrapper as registry tools;
 * seeing a name arrive here proves the wrapper is present, since an unwrapped
 * tool never announces.
 */
function passthroughRunner(seen: string[] = []): ExtensionRunner {
	return {
		hasHandlers: () => true,
		emitToolCall: async (event: { toolName: string }) => {
			seen.push(event.toolName);
			return undefined;
		},
		emitToolResult: async () => undefined,
	} as unknown as ExtensionRunner;
}

describe("CursorExecHandlers.grep bridge", () => {
	let cwd: string;
	let searchTool: GrepTool;
	let handlers: CursorExecHandlers;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-exec-test-"));
		await Bun.write(path.join(cwd, "sample.txt"), "Hello World\nhello world\n");
		searchTool = new GrepTool(createTestSession(cwd));
		handlers = new CursorExecHandlers({
			cwd,
			tools: new Map([["grep", searchTool as any]]),
		});
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("maps caseInsensitive parameter correctly through the grep bridge", async () => {
		// 1. By default/omitted caseInsensitive, should be case-sensitive (match count 1 for "hello")
		const defaultResult = await handlers.grep({
			toolCallId: "call-1",
			path: cwd,
			pattern: "hello",
		} as any);
		expect((defaultResult.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);

		// 2. If caseInsensitive: true, should be case-insensitive (match count 2 for "hello")
		const insensitiveResult = await handlers.grep({
			toolCallId: "call-2",
			path: cwd,
			pattern: "hello",
			caseInsensitive: true,
		} as any);
		expect((insensitiveResult.details as { matchCount?: number } | undefined)?.matchCount).toBe(2);

		// 3. If caseInsensitive: false, should be case-sensitive (match count 1 for "hello")
		const sensitiveResult = await handlers.grep({
			toolCallId: "call-3",
			path: cwd,
			pattern: "hello",
			caseInsensitive: false,
		} as any);
		expect((sensitiveResult.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);
	});

	it("honors pi_grep's requested match limit against real files", async () => {
		// The frame's `limit` caps total surfaced matches. The model-facing schema
		// has no such parameter, so without a per-call tool the cap is dropped and
		// the search returns everything it found.
		await Bun.write(path.join(cwd, "many.txt"), Array.from({ length: 10 }, (_, i) => `needle ${i}`).join("\n"));
		const scopedHandlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["grep", searchTool]]),
			createGrepTool: options => new GrepTool(createTestSession(cwd), options),
		});

		const capped = await scopedHandlers.piGrep({
			toolCallId: "c1",
			args: { pattern: "needle", path: cwd, limit: 3 },
		} as never);
		expect((capped.details as { matchCount?: number } | undefined)?.matchCount).toBe(3);

		const uncapped = await scopedHandlers.piGrep({
			toolCallId: "c2",
			args: { pattern: "needle", path: cwd },
		} as never);
		expect((uncapped.details as { matchCount?: number } | undefined)?.matchCount).toBe(10);
	});

	it("honors pi_grep's requested context width against real files", async () => {
		// `context` has no schema parameter either: the width is read from
		// settings fixed at tool construction, so the frame's value only lands
		// through a per-call instance.
		await Bun.write(path.join(cwd, "ctx.txt"), "before line\nneedle here\nafter line\n");
		const scopedHandlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>([["grep", searchTool]]),
			createGrepTool: options => new GrepTool(createTestSession(cwd), options),
		});

		const noContext = await scopedHandlers.piGrep({
			toolCallId: "c1",
			args: { pattern: "needle here", path: path.join(cwd, "ctx.txt"), context: 0 },
		} as never);
		const noContextText = noContext.content.map(c => (c.type === "text" ? c.text : "")).join("");
		expect(noContextText).not.toContain("before line");
		expect(noContextText).not.toContain("after line");

		const withContext = await scopedHandlers.piGrep({
			toolCallId: "c2",
			args: { pattern: "needle here", path: path.join(cwd, "ctx.txt"), context: 1 },
		} as never);
		const withContextText = withContext.content.map(c => (c.type === "text" ? c.text : "")).join("");
		expect(withContextText).toContain("before line");
		expect(withContextText).toContain("after line");
	});
});

describe("pi_bash truncation reaches the wire from a real BashTool result", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-pibash-trunc-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("translates the metadata BashTool actually emits, not a hand-built shape", async () => {
		// Producer/consumer contract. `piTruncation` lives in `pi-ai`, which
		// cannot import `BashTool`, so every test there must hand-build the
		// details bag — and a bag built from the same assumption as the code
		// stays green when `BashTool`'s real shape moves. This runs the actual
		// tool and feeds its actual output to the actual translator.
		const bash = new BashTool(createTestSession(cwd));
		const result = await bash.execute("t1", { command: "seq 1 200000" });

		// Guard the assumption the bridge encodes: Bash files truncation under
		// `details.meta.truncation`, and that record carries no `truncated`
		// flag. If either moves, this fails here rather than silently sending
		// clipped output to Cursor with no truncation notice.
		// `TruncationMeta` is the producer's own type: if a field this bridge
		// reads is renamed or dropped, this stops compiling.
		const details = result.details as { truncation?: unknown; meta?: { truncation?: TruncationMeta } };
		expect(details.truncation).toBeUndefined();
		expect(details.meta?.truncation).toBeDefined();
		expect(details.meta?.truncation).not.toHaveProperty("truncated");

		const wire = piTruncation({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: result.content,
			isError: false,
			timestamp: Date.now(),
			details: result.details,
		});

		expect(wire?.truncated).toBe(true);
		expect(wire?.totalLines).toBe(details.meta?.truncation?.totalLines);
		expect(wire?.outputBytes).toBe(details.meta?.truncation?.outputBytes);
		expect(wire?.truncatedBy).toBe(details.meta?.truncation?.truncatedBy);
	});

	it("sends no truncation summary for output that fit", async () => {
		const bash = new BashTool(createTestSession(cwd));
		const result = await bash.execute("t2", { command: "echo hi" });
		const wire = piTruncation({
			role: "toolResult",
			toolCallId: "t2",
			toolName: "bash",
			content: result.content,
			isError: false,
			timestamp: Date.now(),
			details: result.details,
		});
		expect(wire).toBeUndefined();
	});
});

describe("bridge tool resolution beyond the model-facing registry", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-bridge-resolve-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("edits a real file from a pi_edit frame when `edit` is withheld from the model", async () => {
		// For Cursor the session drops `edit` from the tool registry so the model
		// is steered to full-file `write`. The native `pi_edit` frame arrives
		// regardless of the advertised catalog, so the bridge must still reach a
		// real edit tool through the `getTool` fallback — otherwise every modern
		// edit answers "Tool \"edit\" not available" and the file is untouched.
		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		// Build it exactly as the session does. Both bridge callsites go through
		// this factory, so a regression in it — the wrong mode, a missing
		// approval wrapper — fails here rather than passing against a
		// hand-constructed stand-in.
		const editTool = createBridgeEditTool(createTestSession(cwd), passthroughRunner());

		const withheld = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>(),
			getTool: name => (name === "edit" ? editTool : undefined),
		});
		const result = await withheld.piEdit({
			toolCallId: "e1",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBeFalsy();
		expect(await Bun.file(target).text()).toBe("alpha\ngamma\n");
	});

	it("reports the failure instead of editing when no edit tool is reachable", async () => {
		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const unreachable = new CursorExecHandlers({ cwd, tools: new Map<string, Tool>() });
		const result = await unreachable.piEdit({
			toolCallId: "e2",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("alpha\nbeta\n");
	});

	it("substitutes a replace-mode edit into a granted advisor tool map", async () => {
		// The advisor roster hands the bridge the instances it built for the
		// advisor's own loop — default `hashline` mode, whose schema is a single
		// `input` string. A `pi_edit` frame's `old_text`/`new_text` pairs fail
		// validation against it, so the file goes unmodified. This is the
		// substitution the advisor path applies before constructing handlers.
		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const session = createTestSession(cwd);
		const advisorEdit = new EditTool(session);
		expect(advisorEdit.mode).not.toBe("replace");
		const granted = new Map<string, Tool>([["edit", advisorEdit]]);

		const bridged = bridgeToolMap(granted, () => createBridgeEditTool(session, passthroughRunner()));
		const handlers = new CursorExecHandlers({ cwd, tools: bridged });
		const result = await handlers.piEdit({
			toolCallId: "e3",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBeFalsy();
		expect(await Bun.file(target).text()).toBe("alpha\ngamma\n");
		// The advisor's own loop must keep the exact instance it was handed.
		expect(granted.get("edit")).toBe(advisorEdit);
	});

	it("leaves an ungranted tool map without an edit tool", async () => {
		// The bridge tool is constructed, not looked up, so substituting for a
		// roster that was never granted `edit` would hand a read-only advisor a
		// mutating tool (issue #5680). The frame must fail instead.
		const target = path.join(cwd, "sample.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const session = createTestSession(cwd);
		let built = 0;
		const withheld = bridgeToolMap(new Map<string, Tool>(), () => {
			built++;
			return createBridgeEditTool(session, passthroughRunner());
		});
		expect(withheld.has("edit")).toBe(false);
		expect(built).toBe(0);

		const handlers = new CursorExecHandlers({ cwd, tools: withheld });
		const result = await handlers.piEdit({
			toolCallId: "e4",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("alpha\nbeta\n");
	});

	it("refuses a scoped pi_grep when no grep tool was granted", async () => {
		// The factory builds a fresh tool and `executeTool` prefers that override
		// over the registry, so a session that withheld `grep` must not install
		// one — otherwise a frame carrying `context`/`limit` searches anyway.
		await Bun.write(path.join(cwd, "hit.txt"), "needle\n");
		const denied = new CursorExecHandlers({ cwd, tools: new Map<string, Tool>() });
		const result = await denied.piGrep({
			toolCallId: "g0",
			args: { pattern: "needle", path: cwd, limit: 5 },
		} as never);

		expect(result.isError).toBe(true);
		expect(result.content.map(c => (c.type === "text" ? c.text : "")).join("")).toContain("not available");
	});

	it("denies a native pi_edit frame the user's policy blocks", async () => {
		// The bridge's `edit` is wrapped, but `ExtensionToolWrapper` reads the
		// approval mode and per-tool policies only from the execute-time
		// context — with none it resolves as `yolo` with empty policies and the
		// frame edits the file regardless of what the user configured.
		const target = path.join(cwd, "denied.txt");
		await Bun.write(target, "alpha\nbeta\n");
		const settings = Settings.isolated({ "tools.approval": { edit: "deny" } });
		const session = createTestSession(cwd, { settings });
		const handlers = new CursorExecHandlers({
			cwd,
			tools: bridgeToolMap(new Map<string, Tool>([["edit", new EditTool(session)]]), () =>
				createBridgeEditTool(session, passthroughRunner()),
			),
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.piEdit({
			toolCallId: "e5",
			args: { path: target, edits: [{ oldText: "beta", newText: "gamma" }] },
		} as never);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).text()).toBe("alpha\nbeta\n");
	});

	it("denies a scoped pi_grep frame the user's policy blocks", async () => {
		// Same gate on the other bridge-only tool: the per-call `grep` the
		// factory builds for a frame carrying `context`/`limit` must answer to
		// `tools.approval.grep` like every registry call.
		await Bun.write(path.join(cwd, "hit.txt"), "needle\n");
		const settings = Settings.isolated({ "tools.approval": { grep: "deny" } });
		const session = createTestSession(cwd, { settings });
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>(),
			createGrepTool: createBridgeGrepFactory(session, passthroughRunner()),
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.piGrep({
			toolCallId: "g2",
			args: { pattern: "needle", path: cwd, context: 1, limit: 5 },
		} as never);

		expect(result.isError).toBe(true);
		expect(result.content.map(c => (c.type === "text" ? c.text : "")).join("")).toContain("blocked by user policy");
	});

	it("wraps the per-call grep the real bridge factory builds", async () => {
		// The reviewed bypass was in the factory the session hands the bridge,
		// not in the bridge: a raw `new GrepTool(...)` there skips the approval
		// gate every registry tool goes through. Exercise the shared factory
		// both callsites use, so a regression in it fails here.
		await Bun.write(path.join(cwd, "hit.txt"), "needle\n");
		const intercepted: string[] = [];
		const factory = createBridgeGrepFactory(createTestSession(cwd), passthroughRunner(intercepted));
		const built = factory({ context: 0, totalMatchLimit: 5 });
		expect(built).toBeInstanceOf(ExtensionToolWrapper);

		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map<string, Tool>(),
			createGrepTool: factory,
		});
		const result = await handlers.piGrep({
			toolCallId: "g1",
			args: { pattern: "needle", path: cwd, limit: 5 },
		} as never);

		// The wrapper ran (its extension hook fired) and the frame's cap still
		// reached the underlying tool.
		expect(intercepted).toEqual(["grep"]);
		expect((result.details as { matchCount?: number } | undefined)?.matchCount).toBe(1);
	});
});

describe("pi_bash timeout presence", () => {
	let cwd: string;
	let handlers: CursorExecHandlers;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-pibash-timeout-"));
		const bash: Tool = new BashTool(createTestSession(cwd));
		handlers = new CursorExecHandlers({ cwd, tools: new Map<string, Tool>([["bash", bash]]) });
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("disables the deadline for an explicit zero instead of applying the default", async () => {
		// `timeout` is `optional int32` and `bash` documents `0` as "disables
		// the command deadline". Folding a supplied `0` into `undefined` applies
		// the 300s default, killing the long-running command that asked not to
		// be killed.
		const disabled = await handlers.piBash({
			toolCallId: "b1",
			args: { command: "echo hi", timeout: 0 },
		} as never);
		const disabledDetails = disabled.details as { timeoutDisabled?: boolean; timeoutSeconds?: number };
		expect(disabledDetails.timeoutDisabled).toBe(true);
		expect(disabledDetails.timeoutSeconds).toBeUndefined();

		const defaulted = await handlers.piBash({
			toolCallId: "b2",
			args: { command: "echo hi" },
		} as never);
		const defaultedDetails = defaulted.details as { timeoutDisabled?: boolean; timeoutSeconds?: number };
		expect(defaultedDetails.timeoutDisabled).toBeUndefined();
		expect(defaultedDetails.timeoutSeconds).toBeGreaterThan(0);
	});

	it("passes a positive timeout through", async () => {
		const result = await handlers.piBash({
			toolCallId: "b3",
			args: { command: "echo hi", timeout: 42 },
		} as never);
		expect((result.details as { timeoutSeconds?: number }).timeoutSeconds).toBe(42);
	});

	it("falls back to the default for a negative timeout", async () => {
		// A negative has no local meaning. Passed through, `bash` clamps it to
		// its 1s floor — a command that dies almost immediately. Dropping it to
		// the default is the only sane reading, so assert the default rather
		// than merely "positive", which the clamp also satisfies.
		const negative = await handlers.piBash({
			toolCallId: "b4",
			args: { command: "echo hi", timeout: -5 },
		} as never);
		const omitted = await handlers.piBash({
			toolCallId: "b5",
			args: { command: "echo hi" },
		} as never);
		const negativeDetails = negative.details as { timeoutDisabled?: boolean; timeoutSeconds?: number };
		expect(negativeDetails.timeoutDisabled).toBeUndefined();
		expect(negativeDetails.timeoutSeconds).toBe((omitted.details as { timeoutSeconds?: number }).timeoutSeconds);
	});
});

describe("CursorExecHandlers error results", () => {
	const rewrittenErrorTool = (name: string): AgentTool => ({
		name,
		label: name,
		description: "returns a rewritten tool failure",
		parameters: type({}),
		execute: async () => ({
			content: [{ type: "text", text: "Enriched recovery guidance" }],
			details: { enriched: true },
			isError: true,
		}),
	});

	it("propagates returned isError through the standard exec bridge", async () => {
		const events: AgentEvent[] = [];
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["read", rewrittenErrorTool("read")]]),
			emitEvent: event => events.push(event),
		});

		const result = await handlers.read(create(ReadArgsSchema, { toolCallId: "call-read", path: "ignored" }));
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Enriched recovery guidance" }]);
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.isError).toBe(true);
	});

	it("propagates returned isError through the shell stream bridge", async () => {
		const events: AgentEvent[] = [];
		const stdout: string[] = [];
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["bash", rewrittenErrorTool("bash")]]),
			emitEvent: event => events.push(event),
		});

		const result = await handlers.shellStream(
			create(ShellArgsSchema, { toolCallId: "call-shell", command: "ignored" }),
			{
				onStdout: data => stdout.push(data),
				onStderr: () => {},
			},
		);
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "Enriched recovery guidance" }]);
		expect(stdout).toEqual(["Enriched recovery guidance"]);
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.isError).toBe(true);
	});
});

describe("CursorExecHandlers mounted tool bridge", () => {
	it("executes MCP tools resolved from the xd:// registry", async () => {
		const mountedTool: AgentTool = {
			name: "mcp__fixture_report",
			label: "Fixture Report",
			description: "reports a fixture result",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "reported" }], details: {} };
			},
		};
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			getTool: name => (name === mountedTool.name ? mountedTool : undefined),
		});

		const result = await handlers.mcp({
			name: mountedTool.name,
			providerIdentifier: "pi-agent",
			toolName: mountedTool.name,
			toolCallId: "call-mounted",
			args: {},
			rawArgs: {},
		});

		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "reported" }]);
	});

	it("routes wrapped mounted devices through the approval gate", async () => {
		let executed = false;
		const device: AgentTool = {
			name: "ast_edit",
			label: "AST Edit",
			description: "structural edit device",
			parameters: type({}),
			async execute() {
				executed = true;
				return { content: [{ type: "text", text: "edited" }], details: {} };
			},
		};
		// The deny path throws inside resolveApproval before the runner is touched,
		// so a bare runner stub suffices to prove the gate runs.
		const wrapped = new ExtensionToolWrapper(device, {} as unknown as ExtensionRunner);
		const settings = Settings.isolated({ "tools.approval": { ast_edit: "deny" } });
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			getTool: name => (name === device.name ? (wrapped as unknown as AgentTool) : undefined),
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.mcp({
			name: device.name,
			providerIdentifier: "pi-agent",
			toolName: device.name,
			toolCallId: "call-denied",
			args: {},
			rawArgs: {},
		});

		expect(result.isError).toBe(true);
		expect(executed).toBe(false);
		expect(result.content.find(block => block.type === "text")?.text).toContain("blocked by user policy");
	});

	it("lists resources from the session's live MCP servers", async () => {
		// The provider used to answer an empty catalog unconditionally, hiding
		// resources the session holds live connections to. Every entry must
		// carry the server name, since that is how Cursor addresses the read.
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			mcpResources: {
				serverNames: () => ["docs", "issues"],
				getServerResources: name =>
					name === "docs"
						? { resources: [{ uri: "docs://readme", name: "README", mimeType: "text/markdown" }] }
						: { resources: [{ uri: "issues://open" }] },
				readServerResource: async () => undefined,
			},
		});

		expect(await handlers.listMcpResources({})).toEqual([
			{ uri: "docs://readme", name: "README", description: undefined, mimeType: "text/markdown", server: "docs" },
			{ uri: "issues://open", name: undefined, description: undefined, mimeType: undefined, server: "issues" },
		]);
		// A server filter narrows to that server alone.
		expect((await handlers.listMcpResources({ server: "issues" })).map(r => r.uri)).toEqual(["issues://open"]);
	});

	it("reads a resource and decodes a blob payload into wire bytes", async () => {
		// MCP hands back a list of content items with base64 blobs; the wire
		// carries one text or one byte payload.
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map(),
			mcpResources: {
				serverNames: () => ["files"],
				getServerResources: () => undefined,
				readServerResource: async (name, uri) =>
					name === "files" && uri === "files://logo"
						? { contents: [{ uri, mimeType: "image/png", blob: Buffer.from("PNG").toString("base64") }] }
						: undefined,
			},
		});

		const read = await handlers.readMcpResource({ server: "files", uri: "files://logo" });
		expect(read?.mimeType).toBe("image/png");
		expect(read?.blob && Buffer.from(read.blob).toString()).toBe("PNG");
		// An unknown uri is genuinely not found, not an error.
		expect(await handlers.readMcpResource({ server: "files", uri: "files://missing" })).toBeNull();
	});

	it("answers nothing when the session has no MCP manager", async () => {
		// A host without MCP must still answer truthfully rather than throwing:
		// an empty catalog and `not_found` are the honest responses.
		const handlers = new CursorExecHandlers({ cwd: ".", tools: new Map() });
		expect(await handlers.listMcpResources({})).toEqual([]);
		expect(await handlers.readMcpResource({ server: "docs", uri: "docs://x" })).toBeNull();
	});
});

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "gpt-5.6-sol-medium",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function newBlockState(): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		openToolCalls: new Map<string, ToolCallState>(),
		resolvedMcpToolCallIds: new Set<string>(),
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
	};
}

// Regression for issue #5680: the advisor's own tools run through the same
// Cursor exec bridge the primary agent uses. Without a bridge wired into the
// advisor Agent, the server's `mcpArgs` dispatch for `advise` comes back
// `toolNotFound` and no advice is ever routed. This drives the real provider
// dispatch to prove a bridge built over the advisor's tool set executes the
// `advise` MCP call and returns a success frame.
describe("CursorExecHandlers advise routing (issue #5680)", () => {
	function adviseServerMessage(note: string) {
		return create(AgentServerMessageSchema, {
			message: {
				case: "execServerMessage",
				value: create(ExecServerMessageSchema, {
					id: 1,
					execId: "exec-advise-1",
					message: {
						case: "mcpArgs",
						value: create(McpArgsSchema, {
							name: "advise",
							toolName: "advise",
							toolCallId: "call-advise-1",
							providerIdentifier: "pi-agent",
							args: { note: new TextEncoder().encode(JSON.stringify(note)) },
						}),
					},
				}),
			},
		});
	}

	function decodeMcpResultCase(chunk: unknown): string | undefined {
		const buf = chunk as Buffer;
		const client = fromBinary(AgentClientMessageSchema, buf.subarray(5));
		if (client.message.case !== "execClientMessage") return undefined;
		const exec = client.message.value;
		return exec.message.case === "mcpResult" ? exec.message.value.result.case : undefined;
	}

	it("executes the advise MCP call through the bridge and routes the note", async () => {
		const advised: Array<{ note: string; severity?: string }> = [];
		const adviseTool = new AdviseTool((note, severity) => advised.push({ note, severity }));
		const handlers = new CursorExecHandlers({
			cwd: ".",
			tools: new Map([["advise", adviseTool as unknown as AgentTool]]),
		});

		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const written: unknown[] = [];
		const h2Request = {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as Parameters<typeof handleServerMessage>[5];

		await handleServerMessage(
			adviseServerMessage("Consider the empty-input edge case"),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			handlers,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		expect(advised).toEqual([{ note: "Consider the empty-input edge case", severity: undefined }]);
		expect(written.length).toBe(1);
		expect(decodeMcpResultCase(written[0])).toBe("success");
	});

	it("returns toolNotFound when no bridge is wired (the unfixed advisor path)", async () => {
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const state = newBlockState();
		const written: unknown[] = [];
		const h2Request = {
			write: (chunk: unknown) => {
				written.push(chunk);
				return true;
			},
		} as unknown as Parameters<typeof handleServerMessage>[5];

		await handleServerMessage(
			adviseServerMessage("never delivered"),
			output,
			stream,
			state,
			new Map(),
			h2Request,
			undefined,
			undefined,
			{ sawTokenDelta: false },
			[],
		);

		expect(written.length).toBe(1);
		expect(decodeMcpResultCase(written[0])).toBe("toolNotFound");
	});
});

// Regression for the #5686 review: Cursor's native `delete` frame removes files
// directly (bypassing the tool map), so a read-only advisor that was granted no
// mutating tool must not be able to delete workspace files.
describe("CursorExecHandlers native delete gating (issue #5680)", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-delete-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("rejects native delete and preserves the file when allowNativeDelete is false", async () => {
		const target = path.join(cwd, "victim.txt");
		await Bun.write(target, "keep me");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowNativeDelete: false,
		});

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del", path: target }));

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: 'Tool "delete" not available' }]);
		expect(await Bun.file(target).exists()).toBe(true);
	});

	it("performs native delete when allowNativeDelete is true", async () => {
		const target = path.join(cwd, "victim.txt");
		await Bun.write(target, "remove me");
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowNativeDelete: true,
		});

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del", path: target }));

		expect(result.isError).toBe(false);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("resolves native deletes through the live cwd resolver", async () => {
		const movedCwd = path.join(cwd, "moved");
		await fs.mkdir(movedCwd);
		const originalTarget = path.join(cwd, "obsolete.txt");
		const movedTarget = path.join(movedCwd, "obsolete.txt");
		await Bun.write(originalTarget, "preserve me");
		await Bun.write(movedTarget, "remove me");
		let currentCwd = cwd;
		const handlers = new CursorExecHandlers({
			cwd,
			getCwd: () => currentCwd,
			tools: new Map(),
			allowNativeDelete: true,
		});

		currentCwd = movedCwd;
		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-del", path: "obsolete.txt" }));

		expect(result.isError).toBe(false);
		expect(await Bun.file(originalTarget).exists()).toBe(true);
		expect(await Bun.file(movedTarget).exists()).toBe(false);
	});

	it("refuses a native delete the user's policy blocks", async () => {
		// `allowNativeDelete` answers "was a mutating tool granted", not "does
		// policy allow this call". The frame removes the file with `fs.rmSync`
		// instead of running a registry tool, so no approval wrapper sits in
		// front of it — a configured `deny` still lost the file.
		const target = path.join(cwd, "protected.txt");
		await Bun.write(target, "keep me\n");
		const settings = Settings.isolated({ "tools.approval": { delete: "deny" } });
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowNativeDelete: true,
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.delete(
			create(DeleteArgsSchema, { toolCallId: "call-deny", path: "protected.txt" }),
		);

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).exists()).toBe(true);
	});

	it("refuses a native delete in always-ask mode, which has no prompt channel", async () => {
		// The exec channel cannot raise an interactive approval, so a mode that
		// demands one must fail closed rather than silently auto-approving.
		const target = path.join(cwd, "asked.txt");
		await Bun.write(target, "keep me\n");
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
		const handlers = new CursorExecHandlers({
			cwd,
			tools: new Map(),
			allowNativeDelete: true,
			getToolContext: () => ({ settings }) as AgentToolContext,
		});

		const result = await handlers.delete(create(DeleteArgsSchema, { toolCallId: "call-ask", path: "asked.txt" }));

		expect(result.isError).toBe(true);
		expect(await Bun.file(target).exists()).toBe(true);
	});
});

// The Pi frames (`ExecServerMessage` 45-51) are a separate wire family from the
// legacy `read`/`shell`/`grep` args, with different field names and different
// semantics. Each bridge handler therefore performs a real translation, and a
// wrong one silently searches the wrong thing instead of failing.
describe("CursorExecHandlers Pi frame translation", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-pi-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	/** Captures the args one local tool was invoked with. */
	function recordingHandlers(toolName: string): { handlers: CursorExecHandlers; calls: unknown[] } {
		const calls: unknown[] = [];
		const tool: AgentTool = {
			name: toolName,
			label: toolName,
			description: "records its args",
			parameters: type({}),
			execute: async (_toolCallId: string, params: unknown) => {
				calls.push(params);
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		const handlers = new CursorExecHandlers({ cwd, tools: new Map([[toolName, tool]]) });
		return { handlers, calls };
	}

	it("inverts pi_grep's ignore_case into the local tool's case-sensitivity flag", async () => {
		// `ignore_case` and `case` are opposites. Passing the frame's value
		// straight through would flip every search's matching.
		const { handlers, calls } = recordingHandlers("grep");

		await handlers.piGrep({ toolCallId: "c1", args: { pattern: "x", ignoreCase: true } } as never);
		await handlers.piGrep({ toolCallId: "c2", args: { pattern: "x", ignoreCase: false } } as never);

		expect(calls).toEqual([
			{ pattern: "x", path: ".", case: false },
			// Case-sensitive is the local default, so `false` maps to "unset",
			// not to `case: true`.
			{ pattern: "x", path: ".", case: undefined },
		]);
	});

	it("folds pi_grep's separate glob onto the local tool's single path spec", async () => {
		const { handlers, calls } = recordingHandlers("grep");

		await handlers.piGrep({ toolCallId: "c1", args: { pattern: "x", path: "src", glob: "**/*.ts" } } as never);
		await handlers.piGrep({ toolCallId: "c2", args: { pattern: "x", glob: "**/*.ts" } } as never);
		await handlers.piGrep({ toolCallId: "c3", args: { pattern: "x", path: ".", glob: "**/*.ts" } } as never);
		await handlers.piGrep({ toolCallId: "c4", args: { pattern: "x", path: "src", glob: "/abs/**/*.ts" } } as never);

		expect((calls[0] as { path: string }).path).toBe("src/**/*.ts");
		// An absent or "." path leaves the glob standing alone: a "./"-prefixed
		// spec is a needlessly different path expression for the same scope.
		expect((calls[1] as { path: string }).path).toBe("**/*.ts");
		expect((calls[2] as { path: string }).path).toBe("**/*.ts");
		// An absolute glob ignores the frame's path entirely.
		expect((calls[3] as { path: string }).path).toBe("/abs/**/*.ts");
	});

	it("composes pi_read's offset/limit onto the path as the read tool's range selector", async () => {
		// `read` takes no range kwargs, so a dropped offset/limit silently returns
		// the whole file. `offset` is a 1-indexed start and `limit` a line count,
		// which is exactly the `:N+K` selector.
		const { handlers, calls } = recordingHandlers("read");

		await handlers.piRead({ toolCallId: "c1", args: { path: "a.ts", offset: 5, limit: 20 } } as never);
		await handlers.piRead({ toolCallId: "c2", args: { path: "a.ts", offset: 5 } } as never);
		await handlers.piRead({ toolCallId: "c3", args: { path: "a.ts", limit: 20 } } as never);
		await handlers.piRead({ toolCallId: "c4", args: { path: "a.ts" } } as never);
		// `optional int32`: a present 0 offset is not "unset". The reference
		// clamps it to the first line rather than falling back to no range.
		await handlers.piRead({ toolCallId: "c5", args: { path: "a.ts", offset: 0, limit: 20 } } as never);

		expect(calls).toEqual([
			{ path: "a.ts:5+20" },
			{ path: "a.ts:5-" },
			{ path: "a.ts:1+20" },
			{ path: "a.ts" },
			{ path: "a.ts:1+20" },
		]);
	});

	it("answers a present pi_read limit of zero with empty output instead of the whole file", async () => {
		// `limit: 0` is present, not unset: the reference slices zero lines. No
		// `read` selector expresses an empty range, so treating it as unset would
		// return the entire file — the opposite of what was asked.
		const { handlers, calls } = recordingHandlers("read");

		const result = await handlers.piRead({ toolCallId: "c1", args: { path: "a.ts", limit: 0 } } as never);

		expect(calls).toEqual([]);
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "" }]);
	});

	it("escapes pi_grep's pattern when the frame asks for a literal search", async () => {
		// The local tool is regex-only, so an unescaped literal turns regex
		// metacharacters into operators and matches the wrong lines.
		const { handlers, calls } = recordingHandlers("grep");

		await handlers.piGrep({ toolCallId: "c1", args: { pattern: "a.b(c)", literal: true } } as never);
		await handlers.piGrep({ toolCallId: "c2", args: { pattern: "a.b(c)" } } as never);

		expect((calls[0] as { pattern: string }).pattern).toBe("a\\.b\\(c\\)");
		expect((calls[1] as { pattern: string }).pattern).toBe("a.b(c)");
	});

	it("routes pi_find to glob, not grep, joining its pattern onto the path", async () => {
		// `pi_find` searches filenames. Routing it to `grep` would search file
		// contents for the glob text and return nothing.
		const { handlers, calls } = recordingHandlers("glob");

		await handlers.piFind({ toolCallId: "c1", args: { pattern: "*.ts", path: "src", limit: 10 } } as never);
		await handlers.piFind({ toolCallId: "c2", args: { pattern: "*.ts", limit: 0 } } as never);
		await handlers.piFind({ toolCallId: "c3", args: { pattern: "*.ts" } } as never);

		expect(calls).toEqual([
			{ path: "src/*.ts", limit: 10 },
			// `optional int32`: a present 0 is clamped to 1 (as the reference
			// does), not silently widened to the tool's default.
			{ path: "*.ts", limit: 1 },
			// Genuinely unset leaves the local tool's own default in place.
			{ path: "*.ts", limit: undefined },
		]);
	});

	it("renames pi_edit's camelCase replacements to the local tool's snake_case pairs", async () => {
		const { handlers, calls } = recordingHandlers("edit");

		await handlers.piEdit({
			toolCallId: "c1",
			args: { path: "a.ts", edits: [{ oldText: "before", newText: "after" }] },
		} as never);

		expect(calls[0]).toEqual({ path: "a.ts", edits: [{ old_text: "before", new_text: "after" }] });
	});

	it("lists directories for pi_ls through read, defaulting an empty path to cwd", async () => {
		const { handlers, calls } = recordingHandlers("read");

		await handlers.piLs({ toolCallId: "c1", args: { path: "" } } as never);

		expect(calls[0]).toEqual({ path: "." });
	});
});
