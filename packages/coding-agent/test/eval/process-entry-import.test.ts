import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ComputerSessionSnapshot, ComputerWorkerOutbound } from "../../src/tools/computer/protocol";
import { COMPUTER_PROCESS_ARG } from "../../src/tools/computer/protocol";
import { spawnComputerSubprocess } from "../../src/tools/computer/supervisor";

it("imports the CLI entry graph without loading dotenv before profile bootstrap", async () => {
	using tempDir = TempDir.createSync("@omp-js-process-import-");
	await Bun.write(path.join(tempDir.path(), ".env"), "OMP_PROCESS_ENTRY_ENV_PROBE=loaded-too-early\n");
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	delete env.OMP_PROCESS_ENTRY_ENV_PROBE;
	env.HOME = tempDir.path();
	const fixture = path.resolve(import.meta.dir, "../fixtures/js-process-entry-import.ts");
	const proc = Bun.spawn([process.execPath, fixture], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode).toBe(0);
	expect(stdout).toBe("");
	expect(stderr).toBe("");
});

async function pingComputerSubprocess(id: string): Promise<unknown> {
	const worker = spawnComputerSubprocess();
	const response = Promise.withResolvers<unknown>();
	const closed = Promise.withResolvers<void>();
	const unsubscribeMessage = worker.onMessage(message => {
		if (message.type === "pong" && message.id === id) response.resolve(message);
		if (message.type === "closed") closed.resolve();
	});
	const unsubscribeError = worker.onError(error => response.reject(error));
	worker.send({ type: "ping", id });
	try {
		const result = await response.promise;
		worker.send({ type: "close" });
		await closed.promise;
		return result;
	} finally {
		unsubscribeMessage();
		unsubscribeError();
		await worker.terminate();
	}
}

it("starts ordinary CLI paths without loading the native computer addon", async () => {
	const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");
	for (const args of [
		["--no-addons", cliPath, "--version"],
		[cliPath, "--help"],
	]) {
		const proc = Bun.spawn([process.execPath, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(exitCode, `${args.at(-1)}: ${stderr}`).toBe(0);
	}
	// Two cold CLI spawns (`--version`, `--help`) per run; the assertion is the exit
	// code, not the wall time.
}, 30_000);

it("dispatches the computer worker through the CLI host selector in a child process", async () => {
	const fixture = path.resolve(import.meta.dir, "../fixtures/computer-worker-cli-selector.ts");
	const proc = Bun.spawn([process.execPath, fixture], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe('{"type":"pong","id":"computer-cli-selector"}\n');
});

it("loads and cleanly closes the computer subprocess", async () => {
	const response = await pingComputerSubprocess("computer-source-process");
	expect(response).toEqual({ type: "pong", id: "computer-source-process" });
});

it("keeps computer runtime state after an IPC serialization failure", async () => {
	const preload = path.resolve(import.meta.dir, "fixtures/computer-ipc-serialization-preload.ts");
	const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
	const messages: ComputerWorkerOutbound[] = [];
	const waiters = new Set<{
		predicate: (message: ComputerWorkerOutbound) => boolean;
		resolve(message: ComputerWorkerOutbound): void;
		reject(error: Error): void;
	}>();
	const proc = Bun.spawn({
		cmd: [process.execPath, "--preload", preload, cli, COMPUTER_PROCESS_ARG],
		stdout: "ignore",
		stderr: "pipe",
		serialization: "advanced",
		ipc(value) {
			const message = value as ComputerWorkerOutbound;
			messages.push(message);
			for (const waiter of waiters) {
				if (!waiter.predicate(message)) continue;
				waiters.delete(waiter);
				waiter.resolve(message);
			}
		},
	});
	const exited = proc.exited.then(async code => {
		const stderr = await new Response(proc.stderr).text();
		const error = new Error(`Computer child exited with ${code}: ${stderr}`);
		for (const waiter of waiters) waiter.reject(error);
		waiters.clear();
	});
	const waitFor = (predicate: (message: ComputerWorkerOutbound) => boolean): Promise<ComputerWorkerOutbound> => {
		const buffered = messages.find(predicate);
		if (buffered) return Promise.resolve(buffered);
		const result = Promise.withResolvers<ComputerWorkerOutbound>();
		waiters.add({ predicate, resolve: result.resolve, reject: result.reject });
		return result.promise;
	};
	const session: ComputerSessionSnapshot = {
		cwd: import.meta.dir,
		sessionId: crypto.randomUUID(),
		captureMaxWidth: 1280,
		captureMaxHeight: 896,
		display: "all",
		readOnly: true,
	};
	try {
		await waitFor(message => message.type === "ready");
		const failedRun = waitFor(message => message.type === "result" && message.id === "bad-ipc");
		proc.send({
			type: "run",
			id: "bad-ipc",
			code: 'globalThis.ipcMarker = "retained"; await tool.echo({ bad: true })',
			timeoutMs: 5_000,
			session,
		});
		const failed = await failedRun;
		expect(failed).toMatchObject({ type: "result", id: "bad-ipc", ok: false });

		const retainedRun = waitFor(message => message.type === "result" && message.id === "retained-state");
		proc.send({
			type: "run",
			id: "retained-state",
			code: "throw new Error(globalThis.ipcMarker)",
			timeoutMs: 5_000,
			session,
		});
		const retained = await retainedRun;
		expect(retained).toMatchObject({
			type: "result",
			id: "retained-state",
			ok: false,
			error: { message: "retained" },
		});

		const pong = waitFor(message => message.type === "pong" && message.id === "after-bad-ipc");
		proc.send({ type: "ping", id: "after-bad-ipc" });
		expect(await pong).toEqual({ type: "pong", id: "after-bad-ipc" });
	} finally {
		proc.kill("SIGKILL");
		await exited;
	}
});

it("dispatches the computer worker from a single npm-style host bundle", async () => {
	const packageDir = path.resolve(import.meta.dir, "../..");
	const outDir = fs.mkdtempSync(path.join(packageDir, ".computer-worker-bundle-"));
	try {
		const output = await Bun.build({
			entrypoints: [path.join(packageDir, "test/fixtures/computer-worker-bundled-host.ts")],
			outdir: outDir,
			naming: "cli.js",
			target: "bun",
			external: ["@oh-my-pi/pi-natives"],
			define: { "process.env.PI_BUNDLED": JSON.stringify("true") },
			throw: false,
		});
		expect(output.logs).toEqual([]);
		expect(output.outputs.map(file => path.basename(file.path))).toEqual(["cli.js"]);
		const proc = Bun.spawn([process.execPath, output.outputs[0]!.path], { stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe('{"type":"pong","id":"computer-npm-bundle"}\n');
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
});

it("keeps non-computer selectors isolated in a compiled single-entry worker host", async () => {
	using tempDir = TempDir.createSync("@omp-compiled-worker-selector-");
	const packageDir = path.resolve(import.meta.dir, "../..");
	const outfile = path.join(tempDir.path(), process.platform === "win32" ? "worker-host.exe" : "worker-host");
	const build = Bun.spawn(
		[
			process.execPath,
			"build",
			"--compile",
			"--target=bun",
			`--outfile=${outfile}`,
			path.join(packageDir, "test/fixtures/compiled-worker-selector-host.ts"),
		],
		{ cwd: packageDir, stdout: "pipe", stderr: "pipe" },
	);
	const [buildExitCode, buildStderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
	expect(buildExitCode, buildStderr).toBe(0);
	const proc = Bun.spawn([outfile], {
		cwd: packageDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe('{"ok":true,"kind":"pong"}\n');
	// Compiles a standalone binary with `bun build --compile` before running it, so
	// this needs the same headroom as the other compile-backed tests.
}, 60_000);
