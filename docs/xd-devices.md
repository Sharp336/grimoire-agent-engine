# `xd://` tool devices

`xd://` is a virtual **tool-device** transport. When `tools.xdev` is enabled
(default), discoverable tools are unmounted from the request's top-level tool
schema and re-exposed as internal URLs driven through the `read` and `write`
tools the model already carries. Implementation lives in
`packages/coding-agent/src/tools/xdev.ts` and
`packages/coding-agent/src/internal-urls/xd-protocol.ts`.

```text
read  xd://          → mounted tool listing (discovery)
read  xd://<tool>    → tool docs + JSON parameter schema
write xd://<tool>    → execute: `content` is the JSON args object
```

Writing an empty body, `?`, or `help` to `xd://<tool>` returns that device's
docs instead of executing it.

## Why it exists

A large MCP/custom-tool catalog previously shipped every tool's schema at the
top level of every request, bloating the wire schema. Mounting discoverable
tools under `xd://` keeps one wire schema per tool (no per-dispatcher-branch
duplication) while collapsing the top-level tool count to the essentials plus
`read`/`write`. Full docs + schema for every mounted device are still inlined
into the system prompt (`XdevRegistry.docsAll()`, subject to a char budget), so
no discovery `read` is required before first use; `read xd://<tool>` remains for
on-demand re-fetch.

## When a tool is a device vs. first-class

`isMountableUnderXdev(tool)` (in `xdev.ts`) decides. A tool is mounted under
`xd://` when **all** hold:

- The `xd://` transport is active for the session (a session-owned
  `XdevRegistry` exists — gated on `tools.xdev` and the `read` transport being
  available).
- `tool.loadMode === "discoverable"`. `essential` tools are never mounted.
- The tool is not pinned top-level. Pinned names are the transport tools
  themselves (`read`, `write` — `XDEV_TRANSPORT_TOOLS`) and
  `todo`/`ask`/`grep` (`XDEV_KEEP_TOP_LEVEL`, which retain harness
  integrations), plus any tool the caller explicitly requested by name.

So MCP tools, SDK/extension custom tools, and discoverable built-ins (e.g.
`generate_image`) surface as `xd://<tool>` devices; the always-loaded built-ins
stay first-class.

The resolution devices (`xd://resolve`, `xd://reject`, `xd://propose`) and
`xd://report_issue` are a related but separate mechanism — they finalize a
staged preview or file a grievance rather than wrapping a mounted tool. See
[`resolve-tool-runtime.md`](./resolve-tool-runtime.md).

## Hook / extension observability

This is the part that matters when writing a `tool_call` / `tool_result` hook
or extension handler that targets a tool reachable through `xd://`.

**Only the outer `write` call is wrapped.** Every tool in the registry is
wrapped once by `ExtensionToolWrapper`
(`extensibility/extensions/wrapper.ts`), which is the sole place `tool_call`
and `tool_result` events are emitted. A device dispatch runs *inside*
`WriteTool.execute()`: the write tool calls `XdevRegistry.dispatch(name, …)`,
which invokes the mounted tool's `execute()` on the **raw, unwrapped**
instance. The mounted tool is not separately wrapped, so its execution emits no
event of its own.

Concretely, for `write({ path: "xd://mytool", content: "{…}" })`:

- Exactly **one** `tool_call` and **one** `tool_result` fire.
- `event.toolName === "write"` — **not** `"mytool"`.
- `event.input` is the write tool's params: `input.path === "xd://mytool"` and
  `input.content` is the device's JSON args **as a string**.
- `event.content` is the mounted tool's own result content (text/image blocks),
  and `event.details.xdev` carries the dispatch envelope:
  `{ tool: "mytool", mode: "execute", args: <validated inner args>, inner: <mounted tool's details> }`.

So a hook **cannot** filter by `event.toolName === "mytool"` and **cannot**
intercept the inner dispatch as its own event. Interception is still possible,
but it must key off the outer `write` call:

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { parseXdUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/xd-protocol";

export default function (pi: HookAPI): void {
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "write" || event.isError) return;

    const target = parseXdUrl(String(event.input.path ?? ""));
    if (target?.name !== "mytool") return;

    // event.content is mytool's output; event.details.xdev.inner is its details.
    const redacted = event.content.map((chunk) =>
      chunk.type === "text"
        ? { ...chunk, text: chunk.text.replaceAll(/SECRET=\S+/g, "SECRET=[REDACTED]") }
        : chunk,
    );
    return { content: redacted };
  });
}
```

Because the override returned from `tool_result` replaces the `write` call's
`content` (and optionally `details`), rewriting device output this way reaches
the model exactly as it would for a native tool result.

To match the *raw* args instead of the URL, read
`event.details.xdev.args` (the validated inner object) rather than re-parsing
`event.input.content`.

## Interaction with `tools.xdev: false`

Disabling `tools.xdev` restores the pre-device behavior: discoverable tools are
advertised top-level again and are called directly, so `event.toolName` is the
tool's own name and hooks that filter by it fire as expected. Extensions that
want to be robust across both configurations should match both the direct tool
name and the `write` + `xd://<name>` shape.

## Related

- [`hooks.md`](./hooks.md) — hook subsystem, event surfaces, and the
  `tool_call`/`tool_result` interception model.
- [`resolve-tool-runtime.md`](./resolve-tool-runtime.md) — the resolution
  devices (`xd://resolve`/`reject`/`propose`).
- [`custom-tools.md`](./custom-tools.md) — authoring tools that surface as
  devices.
- [`mcp-runtime-lifecycle.md`](./mcp-runtime-lifecycle.md) — how MCP tools enter
  the registry that feeds `xd://` mounts.
