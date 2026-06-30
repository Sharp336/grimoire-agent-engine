import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SSHConnectionTarget } from "../../ssh/connection-manager";
import type { ToolSession } from "../../tools";
import * as sshHostResolution from "../../tools/ssh-host-resolution";
import { callSessionTool } from "../js/tool-bridge";

class CapturingTool {
	readonly calls: Array<{ id: string; args: unknown; signal?: AbortSignal }> = [];

	constructor(readonly name: string) {}

	async execute(id: string, args: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
		this.calls.push({ id, args, signal });
		return { content: [{ type: "text", text: `${this.name}:ok` }] };
	}
}

const DEFAULT_HOST: SSHConnectionTarget = {
	name: "alpha",
	host: "alpha.example",
	username: "pi",
};

const EXPLICIT_HOST: SSHConnectionTarget = {
	name: "beta",
	host: "beta.example",
};

function makeSession(tools: CapturingTool[]): ToolSession {
	const byName = new Map(tools.map(tool => [tool.name, tool]));
	return {
		cwd: "/local/workspace",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: { get: () => undefined },
		getToolByName: (name: string) => byName.get(name) as unknown as AgentTool | undefined,
	} as unknown as ToolSession;
}

function callArgs(tool: CapturingTool, index: number): Record<string, unknown> {
	const args = tool.calls[index]?.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		throw new Error(`Expected ${tool.name} call ${index} to receive object arguments`);
	}
	return args as Record<string, unknown>;
}

function oneCallArgs(tool: CapturingTool): Record<string, unknown> {
	expect(tool.calls).toHaveLength(1);
	return callArgs(tool, 0);
}

describe("callSessionTool remote invocation context", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("defaults bash bridge calls to the current SSH host and remote cwd", async () => {
		const bash = new CapturingTool("bash");
		const executeSpy = vi.spyOn(bash, "execute");
		const session = makeSession([bash]);
		const abort = new AbortController();

		const value = await callSessionTool(
			"bash",
			{ command: "pwd" },
			{
				session,
				signal: abort.signal,
				invocationContext: { defaultSshHost: DEFAULT_HOST, remoteCwd: "/srv/app" },
			},
		);

		expect(value).toBe("bash:ok");
		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(bash.calls[0]?.id).toMatch(/^js-bash-/);
		expect(bash.calls[0]?.signal).toBe(abort.signal);
		expect(oneCallArgs(bash)).toMatchObject({
			command: "pwd",
			host: "alpha",
			cwd: "/srv/app",
		});
	});

	it("defaults and trims ssh bridge host arguments while preserving the remote cwd", async () => {
		const ssh = new CapturingTool("ssh");
		const executeSpy = vi.spyOn(ssh, "execute");
		const session = makeSession([ssh]);
		const options = {
			session,
			invocationContext: { defaultSshHost: DEFAULT_HOST, remoteCwd: "/srv/app" },
		};
		const resolveSpy = vi.spyOn(sshHostResolution, "resolveSshHostByName").mockResolvedValue(EXPLICIT_HOST);

		await callSessionTool("ssh", { command: "pwd" }, options);
		await callSessionTool("ssh", { host: " beta ", command: "hostname" }, options);

		expect(executeSpy).toHaveBeenCalledTimes(2);
		expect(resolveSpy).toHaveBeenCalledTimes(1);
		expect(resolveSpy.mock.calls[0]?.[0]).toBe(session);
		expect(resolveSpy.mock.calls[0]?.[1]).toBe("beta");
		expect(callArgs(ssh, 0)).toMatchObject({
			command: "pwd",
			host: "alpha",
			cwd: "/srv/app",
		});
		expect(callArgs(ssh, 1)).toMatchObject({
			command: "hostname",
			host: "beta",
			cwd: "/srv/app",
		});
	});

	it("rewrites remote file-tool paths to ssh URLs before invoking the real tool boundary", async () => {
		const read = new CapturingTool("read");
		const write = new CapturingTool("write");
		const grep = new CapturingTool("grep");
		const session = makeSession([read, write, grep]);
		const options = {
			session,
			invocationContext: { defaultSshHost: DEFAULT_HOST, remoteCwd: "/srv/app" },
		};

		await callSessionTool("read", { path: "src/main.py:10-20" }, options);
		await callSessionTool("write", { path: "logs/out file.txt", content: "ok" }, options);
		await callSessionTool(
			"grep",
			{
				pattern: "TODO",
				paths: ["src", "/var/log/app.log:raw", "local://note.txt", "https://example.com/a"],
			},
			options,
		);

		const readArgs = oneCallArgs(read);
		expect(readArgs.path).toBe("ssh://alpha/srv/app/src/main.py:10-20");
		expect("host" in readArgs).toBe(false);
		expect("cwd" in readArgs).toBe(false);

		const writeArgs = oneCallArgs(write);
		expect(writeArgs.path).toBe("ssh://alpha/srv/app/logs/out%20file.txt");
		expect(writeArgs.content).toBe("ok");
		expect("host" in writeArgs).toBe(false);
		expect("cwd" in writeArgs).toBe(false);

		const grepArgs = oneCallArgs(grep);
		expect(grepArgs.paths).toEqual([
			"ssh://alpha/srv/app/src",
			"ssh://alpha/var/log/app.log:raw",
			"local://note.txt",
			"https://example.com/a",
		]);
		expect("host" in grepArgs).toBe(false);
		expect("cwd" in grepArgs).toBe(false);
	});

	it("resolves an explicit SSH host and explicit remote cwd instead of using the default context", async () => {
		const read = new CapturingTool("read");
		const session = makeSession([read]);
		const resolveSpy = vi.spyOn(sshHostResolution, "resolveSshHostByName").mockResolvedValue(EXPLICIT_HOST);

		await callSessionTool(
			"read",
			{ host: " beta ", cwd: "/opt/app", path: "data/config.json" },
			{
				session,
				invocationContext: { defaultSshHost: DEFAULT_HOST, remoteCwd: "/srv/app" },
			},
		);

		expect(resolveSpy).toHaveBeenCalledTimes(1);
		expect(resolveSpy.mock.calls[0]?.[0]).toBe(session);
		expect(resolveSpy.mock.calls[0]?.[1]).toBe("beta");
		const readArgs = oneCallArgs(read);
		expect(readArgs.path).toBe("ssh://beta/opt/app/data/config.json");
		expect("host" in readArgs).toBe(false);
		expect("cwd" in readArgs).toBe(false);
	});

	it("rejects unsupported workspace tools instead of running them locally under a remote default", async () => {
		const glob = new CapturingTool("glob");
		const executeSpy = vi.spyOn(glob, "execute");
		const session = makeSession([glob]);

		await expect(
			callSessionTool(
				"glob",
				{ pattern: "**/*" },
				{
					session,
					invocationContext: { defaultSshHost: DEFAULT_HOST, remoteCwd: "/srv/app" },
				},
			),
		).rejects.toThrow(/does not support default SSH execution/);
		expect(executeSpy).not.toHaveBeenCalled();
	});
});
