import { afterEach, describe, expect, it, vi } from "bun:test";

import type { SSHHost } from "../../capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../capability/types";
import * as discovery from "../../discovery";
import * as sshConnection from "../../ssh/connection-manager";
import * as remotePosix from "../../ssh/remote-posix";
import { resolveRemoteStdioSpawnCommand, resolveStdioSpawnCommand } from "./stdio";

describe("resolveStdioSpawnCommand", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hides Windows executable MCP servers when the host has no console", async () => {
		// Hidden so a console-app child does not allocate a visible window when
		// OMP is launched without a terminal console (#3536).
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32", hostHasInheritableConsole: false },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: true,
			detached: false,
		});
	});

	it("inherits an attached Windows console instead of forcing CREATE_NO_WINDOW", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32", hostHasInheritableConsole: true },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: false,
			detached: false,
		});
	});

	it("detaches off-Windows MCP servers so terminal job-control signals cannot stop them", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "linux" },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			detached: true,
		});
	});

	it("builds remote stdio servers as ssh piped commands with stdin preserved", async () => {
		const source: SourceMeta = {
			provider: "test",
			providerName: "Test",
			path: "/tmp/ssh.json",
			level: "project",
		};
		const hosts: CapabilityResult<SSHHost> = {
			items: [
				{
					name: "pi",
					host: "pi.example",
					username: "robot",
					port: 2222,
					_source: source,
				},
			],
			all: [],
			warnings: [],
			providers: ["test"],
		};
		vi.spyOn(discovery, "loadCapability").mockResolvedValue(hosts);
		vi.spyOn(remotePosix, "ensureRemotePosixShell").mockResolvedValue("bash");
		vi.spyOn(remotePosix, "resolveRemoteCwd").mockResolvedValue("/srv/app");
		const buildRemoteSpy = vi
			.spyOn(sshConnection, "buildRemoteCommand")
			.mockResolvedValue(["-T", "robot@pi.example", "bash -c remote"]);

		const result = await resolveRemoteStdioSpawnCommand(
			{
				type: "stdio",
				host: "pi",
				command: "node",
				args: ["server.js", "--flag value"],
				env: { TOKEN: "secret value" },
				cwd: "relative app",
			},
			{ cwd: "/local/project" },
		);

		expect(discovery.loadCapability).toHaveBeenCalledWith("ssh", { cwd: "/local/project" });
		expect(remotePosix.ensureRemotePosixShell).toHaveBeenCalledWith(
			expect.objectContaining({ name: "pi", host: "pi.example", username: "robot", port: 2222 }),
			"Remote MCP stdio",
		);
		expect(remotePosix.resolveRemoteCwd).toHaveBeenCalledWith(
			expect.objectContaining({ name: "pi" }),
			"relative app",
		);
		expect(buildRemoteSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "pi" }), expect.any(String), {
			allowStdin: true,
			controlMaster: false,
			extraArgs: ["-T"],
		});
		const remoteCommand = buildRemoteSpy.mock.calls[0]?.[1] ?? "";
		expect(remoteCommand).toContain("bash -c");
		expect(remoteCommand).toContain("srv/app");
		expect(remoteCommand).toContain("TOKEN");
		expect(remoteCommand).toContain("secret value");
		expect(remoteCommand).toContain("node");
		expect(remoteCommand).toContain("--flag value");
		expect(result).toEqual({
			cmd: ["ssh", "-T", "robot@pi.example", "bash -c remote"],
			detached: false,
			remoteCwd: "/srv/app",
		});
	});
});
