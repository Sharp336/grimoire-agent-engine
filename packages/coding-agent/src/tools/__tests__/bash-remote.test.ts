import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SSHConnectionTarget } from "../../ssh/connection-manager";
import * as remotePosix from "../../ssh/remote-posix";
import * as sshExecutor from "../../ssh/ssh-executor";
import type { ToolSession } from "..";
import { BashTool } from "../bash";
import * as hostResolution from "../ssh-host-resolution";

const REMOTE_HOST: SSHConnectionTarget = {
	name: "pi",
	host: "pi.example",
	username: "robot",
	port: 2222,
};

function makeSession(): ToolSession {
	return {
		cwd: "/local/workspace",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "bash-remote-test-session",
		settings: {
			get: (key: string) => {
				switch (key) {
					case "async.enabled":
					case "bash.autoBackground.enabled":
					case "bash.stripTrailingHeadTail":
					case "bashInterceptor.enabled":
						return false;
					default:
						return undefined;
				}
			},
			getBashInterceptorRules: () => [],
		},
	} as unknown as ToolSession;
}

describe("BashTool SSH execution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("executes remote commands through the resolved host and a POSIX shell command carrying cwd, env, and command", async () => {
		const session = makeSession();
		const resolveSpy = vi.spyOn(hostResolution, "resolveSshHostByName").mockResolvedValue(REMOTE_HOST);
		const shellSpy = vi.spyOn(remotePosix, "ensureRemotePosixShell").mockResolvedValue("bash");
		const sshSpy = vi.spyOn(sshExecutor, "executeSSH").mockResolvedValue({
			output: "remote ok\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 10,
			outputLines: 1,
			outputBytes: 10,
		});

		const result = await new BashTool(session).execute("bash-call", {
			command: "printf $TARGET",
			host: "pi",
			cwd: "/srv/remote app",
			env: { TARGET: "remote value", ALPHA: "first value" },
			timeout: 7,
		});

		expect(resolveSpy).toHaveBeenCalledTimes(1);
		expect(resolveSpy.mock.calls[0]?.[0]).toBe(session);
		expect(resolveSpy.mock.calls[0]?.[1]).toBe("pi");
		expect(shellSpy).toHaveBeenCalledTimes(1);
		expect(shellSpy.mock.calls[0]?.[0]).toBe(REMOTE_HOST);
		expect(shellSpy.mock.calls[0]?.[1]).toBe("Remote bash");
		expect(sshSpy).toHaveBeenCalledTimes(1);
		const sshCall = sshSpy.mock.calls[0];
		if (!sshCall) throw new Error("executeSSH was not called");
		const [host, remoteCommand, options] = sshCall;
		expect(host).toBe(REMOTE_HOST);
		expect(remoteCommand).toContain("bash -c ");
		expect(remoteCommand).toContain("cd --");
		expect(remoteCommand).toContain("/srv/remote app");
		expect(remoteCommand).toContain("env");
		expect(remoteCommand).toContain("ALPHA=");
		expect(remoteCommand).toContain("first value");
		expect(remoteCommand).toContain("TARGET=");
		expect(remoteCommand).toContain("remote value");
		expect(remoteCommand).toContain("printf $TARGET");
		expect(options?.timeout).toBe(7000);

		const text = result.content.find((block): block is { type: "text"; text: string } => block.type === "text")?.text;
		expect(text).toContain("remote ok");
	});
});
