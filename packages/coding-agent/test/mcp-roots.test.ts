/**
 * Unit tests for MCP roots helpers and MCPManager.setCwd/getCwd.
 *
 * Contract under test:
 *  - `buildRootsList(cwd)` returns a single-root response keyed off the dir name.
 *  - `notifyRootsChanged(connections)` fans out `notifications/roots/list_changed`
 *    to every connected transport and survives per-connection failures.
 *  - `MCPManager.setCwd(newCwd)` updates `getCwd()` after path resolution.
 *  - `MCPManager.setCwd(samePath)` is a no-op (same resolved path → no churn).
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { MCPManager } from "../src/mcp/manager";
import { buildRootsList, notifyRootsChanged } from "../src/mcp/roots";
import { MCPNotificationMethods, type MCPServerConnection, type MCPTransport } from "../src/mcp/types";

interface NotifySpy {
	calls: Array<{ method: string; params?: Record<string, unknown> }>;
	transport: MCPTransport;
}

function spyTransport(opts?: { connected?: boolean; throwOn?: string }): NotifySpy {
	const calls: NotifySpy["calls"] = [];
	const transport: MCPTransport = {
		connected: opts?.connected ?? true,
		async request() {
			throw new Error("not implemented");
		},
		async notify(method, params) {
			calls.push({ method, params });
			if (opts?.throwOn === method) {
				throw new Error(`forced failure on ${method}`);
			}
		},
		async close() {},
	};
	return { calls, transport };
}

function fakeConnection(name: string, transport: MCPTransport): MCPServerConnection {
	return {
		name,
		config: { type: "stdio" as const, command: "echo" },
		transport,
		serverInfo: { name, version: "1.0" },
		capabilities: {},
	};
}

describe("buildRootsList", () => {
	it("returns a single root with file:// URI and basename derived from cwd", () => {
		const cwd = path.resolve("/tmp/some-project");
		const result = buildRootsList(cwd);

		expect(result.roots).toHaveLength(1);
		expect(result.roots[0].uri).toBe(url.pathToFileURL(cwd).href);
		expect(result.roots[0].name).toBe(path.basename(cwd));
	});

	it("encodes spaces in URI", () => {
		const result = buildRootsList(path.resolve("/tmp/has space"));
		expect(result.roots[0].uri).toContain("has%20space");
		expect(result.roots[0].name).toBe("has space");
	});
});

describe("notifyRootsChanged", () => {
	it("sends notifications/roots/list_changed to every connected transport", async () => {
		const a = spyTransport();
		const b = spyTransport();

		await notifyRootsChanged([fakeConnection("a", a.transport), fakeConnection("b", b.transport)]);

		expect(a.calls).toEqual([{ method: MCPNotificationMethods.ROOTS_LIST_CHANGED, params: undefined }]);
		expect(b.calls).toEqual([{ method: MCPNotificationMethods.ROOTS_LIST_CHANGED, params: undefined }]);
	});

	it("skips transports whose connected flag is false", async () => {
		const live = spyTransport();
		const dead = spyTransport({ connected: false });

		await notifyRootsChanged([fakeConnection("live", live.transport), fakeConnection("dead", dead.transport)]);

		expect(live.calls.length).toBe(1);
		expect(dead.calls.length).toBe(0);
	});

	it("does not abort the broadcast when a single transport throws", async () => {
		const failing = spyTransport({ throwOn: MCPNotificationMethods.ROOTS_LIST_CHANGED });
		const ok = spyTransport();

		await expect(
			notifyRootsChanged([fakeConnection("bad", failing.transport), fakeConnection("good", ok.transport)]),
		).resolves.toBeUndefined();

		// Both still received the call attempt — bad threw, good completed.
		expect(failing.calls.length).toBe(1);
		expect(ok.calls.length).toBe(1);
	});

	it("emits no method other than roots/list_changed", async () => {
		const spy = spyTransport();
		await notifyRootsChanged([fakeConnection("only", spy.transport)]);
		expect(spy.calls.every(c => c.method === "notifications/roots/list_changed")).toBe(true);
	});
});

describe("MCPManager.setCwd / getCwd", () => {
	it("returns the constructor cwd by default", () => {
		const mgr = new MCPManager(path.resolve("/tmp/initial"));
		expect(mgr.getCwd()).toBe(path.resolve("/tmp/initial"));
	});

	it("updates getCwd after setCwd to a different absolute path", () => {
		const mgr = new MCPManager(path.resolve("/tmp/before"));
		mgr.setCwd(path.resolve("/tmp/after"));
		expect(mgr.getCwd()).toBe(path.resolve("/tmp/after"));
	});

	it("resolves relative paths against process.cwd before storing", () => {
		const mgr = new MCPManager(path.resolve("/tmp/initial"));
		const relative = "some-relative-target";
		mgr.setCwd(relative);
		expect(mgr.getCwd()).toBe(path.resolve(relative));
	});

	it("is a no-op when newCwd resolves to the current cwd (same value preserved)", () => {
		const initial = path.resolve("/tmp/stable");
		const mgr = new MCPManager(initial);
		mgr.setCwd(initial);
		expect(mgr.getCwd()).toBe(initial);
	});
});
