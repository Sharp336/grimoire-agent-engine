import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import type { SSHHost } from "../../capability/ssh";
import type { ToolSession } from "../../tools";
import type { KernelExecuteOptions, KernelExecuteResult } from "../kernel-base";
import pythonBackend from "../py";
import { disposeAllKernelSessions, executePython, type PythonExecutorOptions } from "../py/executor";
import { buildRemotePythonInitScript, RemotePythonKernel } from "../py/remote-kernel";
import { disposePyToolBridge } from "../py/tool-bridge";

interface RemotePythonExecutorOptions extends PythonExecutorOptions {
	sshHost: SSHHost;
}

interface RemoteKernelStartSnapshot {
	sshHost?: SSHHost;
	cwd?: string;
	interpreter?: string;
}

class FakeRemoteKernel {
	readonly executedCode: string[] = [];
	readonly bridgeUrls: string[] = [];
	#alive = true;

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executedCode.push(code);
		const bridgeUrl = options?.env?.PI_TOOL_BRIDGE_URL;
		if (typeof bridgeUrl === "string") {
			this.bridgeUrls.push(bridgeUrl);
		}
		return {
			status: "ok",
			cancelled: false,
			timedOut: false,
			stdinRequested: false,
		};
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async shutdown(): Promise<{ confirmed: boolean }> {
		this.#alive = false;
		return { confirmed: true };
	}
}

function sshHost(name: string): SSHHost {
	return {
		name,
		host: `${name}.example`,
		_source: {
			provider: "test",
			providerName: "Test",
			path: "/tmp/ssh.json",
			level: "project",
		},
	};
}

function makeToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: { get: () => undefined },
	} as unknown as ToolSession;
}

function remoteOptions(overrides: Omit<RemotePythonExecutorOptions, "kernelMode">): RemotePythonExecutorOptions {
	return {
		kernelMode: "session",
		...overrides,
	};
}

function spyRemoteStarts(): { kernels: FakeRemoteKernel[]; starts: RemoteKernelStartSnapshot[] } {
	const kernels: FakeRemoteKernel[] = [];
	const starts: RemoteKernelStartSnapshot[] = [];
	vi.spyOn(RemotePythonKernel, "start").mockImplementation(async options => {
		starts.push(options as unknown as RemoteKernelStartSnapshot);
		const kernel = new FakeRemoteKernel();
		kernels.push(kernel);
		return kernel as unknown as RemotePythonKernel;
	});
	return { kernels, starts };
}

describe("remote Python init script", () => {
	it("adds the resolved remote cwd to sys.path after a relative chdir", async () => {
		const python = $which("python3") ?? $which("python");
		if (!python) return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-python-cwd-"));
		const cwd = path.join(root, "src");
		await fs.mkdir(cwd);
		await Bun.write(path.join(cwd, "remote_probe.py"), "VALUE = 'from-remote-cwd'\n");
		try {
			const script = `${buildRemotePythonInitScript("src")}\nimport json, remote_probe\nprint(json.dumps({"cwd": os.getcwd(), "path0": sys.path[0], "value": remote_probe.VALUE}))`;
			const proc = Bun.spawn([python, "-c", script], {
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;

			expect(exitCode, stderr).toBe(0);
			const payload = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
				cwd?: string;
				path0?: string;
				value?: string;
			};
			expect(payload.cwd).toBe(cwd);
			expect(payload.path0).toBe(cwd);
			expect(payload.value).toBe("from-remote-cwd");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("executePython remote session reuse", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
		await disposePyToolBridge();
		vi.restoreAllMocks();
	});

	it("keys persistent Python kernels by SSH host as well as session, cwd, and interpreter", async () => {
		const { kernels, starts } = spyRemoteStarts();
		const common = {
			cwd: "/srv/app",
			sessionId: "remote-key-test",
			interpreter: "/opt/py/bin/python",
		};

		await executePython("alpha_one = 1", remoteOptions({ ...common, sshHost: sshHost("alpha") }));
		await executePython("beta_one = 1", remoteOptions({ ...common, sshHost: sshHost("beta") }));
		await executePython("alpha_two = 2", remoteOptions({ ...common, sshHost: sshHost("alpha") }));

		expect(kernels).toHaveLength(2);
		expect(starts.map(start => start.sshHost?.name)).toEqual(["alpha", "beta"]);
		expect(kernels[0]?.executedCode).toEqual(["alpha_one = 1", "alpha_two = 2"]);
		expect(kernels[1]?.executedCode).toEqual(["beta_one = 1"]);
	});

	it("does not apply the local python.interpreter setting to SSH-backed backend execution", async () => {
		const { starts } = spyRemoteStarts();
		const session = {
			...makeToolSession("/local/project"),
			settings: {
				get: (key: string) => (key === "python.interpreter" ? "/local/project/.venv/bin/python" : undefined),
			},
		} as ToolSession;

		await pythonBackend.execute("remote_value = 1", {
			cwd: "/srv/app",
			sshHost: sshHost("interpreterbox"),
			sessionId: "remote-interpreter-setting-test",
			sessionFile: undefined,
			kernelOwnerId: undefined,
			session,
			idleTimeoutMs: 1000,
			reset: false,
			onChunk: () => {},
		});

		expect(starts).toHaveLength(1);
		expect(starts[0]?.interpreter).toBeUndefined();
	});

	it("keeps the remote loopback bridge URL stable across reused same-host session cells", async () => {
		const { kernels } = spyRemoteStarts();
		const host = sshHost("bridgebox");
		const common = {
			cwd: "/srv/app",
			sessionId: "remote-bridge-test",
			interpreter: "/opt/py/bin/python",
			sshHost: host,
			toolSession: makeToolSession("/local/project"),
		};

		await executePython("first = tool", remoteOptions(common));
		await executePython("second = tool", remoteOptions(common));

		expect(kernels).toHaveLength(1);
		expect(kernels[0]?.bridgeUrls).toHaveLength(2);
		const [firstUrl, secondUrl] = kernels[0]?.bridgeUrls ?? [];
		expect(firstUrl).toBeDefined();
		expect(firstUrl).toBe(secondUrl);
		expect(firstUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
	});
});
