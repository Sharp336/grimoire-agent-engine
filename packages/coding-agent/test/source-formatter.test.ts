import { describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { createSourceFormatter } from "@oh-my-pi/pi-coding-agent/tools/source-formatter";

function streamFromText(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) throw new Error("Failed to create response stream.");
	return body;
}

type SpawnOptions = {
	readonly stdin: "pipe";
	readonly stdout: "pipe";
	readonly stderr: "pipe";
	readonly cwd: string;
};

type MockSubprocessStdin = {
	write(chunk: string | Uint8Array): number | Promise<number>;
	end(): number | undefined | Promise<number | undefined>;
};

type MockSubprocessResult = {
	readonly stdin: MockSubprocessStdin | null;
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exited: Promise<number | null>;
	exitCode: number | null;
	kill: (signal?: number | NodeJS.Signals) => void;
};

type SpawnCommand = (command: readonly string[], options: SpawnOptions) => MockSubprocessResult;

interface MockSubprocess {
	process: MockSubprocessResult;
	getWritten: () => string;
}

function createSubprocess(
	source: string,
	options: {
		exitCode?: number;
		stderr?: string;
		write?: MockSubprocessStdin["write"];
		end?: MockSubprocessStdin["end"];
		exited?: Promise<number | null>;
	} = {},
): MockSubprocess {
	const exit = Promise.withResolvers<number | null>();
	let written = "";
	const proc: MockSubprocessResult = {
		stdin: {
			write:
				options.write ??
				vi.fn((chunk: string | Uint8Array) => {
					const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
					written += text;
					return text.length;
				}),
			end:
				options.end ??
				vi.fn(() => {
					exit.resolve(options.exitCode ?? 0);
					return undefined;
				}),
		},
		stdout: streamFromText(source),
		stderr: streamFromText(options.stderr ?? ""),
		exited: options.exited ?? exit.promise,
		exitCode: null,
		kill: vi.fn(),
	};

	return { process: proc, getWritten: () => written };
}

const EXPECTED_FORMATTER_SPAWN_OPTIONS: SpawnOptions = {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	cwd: os.tmpdir(),
};

function neverSettlingPromise<T>(): Promise<T> {
	return Promise.withResolvers<T>().promise;
}

type SourceFormatterOutcome = Awaited<ReturnType<ReturnType<typeof createSourceFormatter>>>;

function expectFormatted(outcome: SourceFormatterOutcome): Record<string, unknown> & object {
	expect(outcome.status).toBe("formatted");
	if (outcome.status !== "formatted") {
		throw new Error(`Expected formatted outcome, got ${outcome.status}`);
	}
	return outcome.args;
}

function expectUnchanged(outcome: SourceFormatterOutcome): void {
	expect(outcome.status).toBe("unchanged");
	if (outcome.status !== "unchanged") {
		throw new Error(`Expected unchanged outcome, got ${outcome.status}`);
	}
}

function expectMissingExecutable(outcome: SourceFormatterOutcome, formatter: string): void {
	expect(outcome.status).toBe("missing");
	if (outcome.status !== "missing") {
		throw new Error(`Expected missing executable outcome, got ${outcome.status}`);
	}
	expect(outcome.formatter).toBe(formatter);
}

describe("createSourceFormatter", () => {
	it("formats eval JS code via prettier and replaces only code", async () => {
		const which = vi.fn().mockReturnValue("/tmp/prettier");
		const subprocess = createSubprocess("formatted-js\n");
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({
			runtime: { which, spawn },
		});

		const args = { language: "js", code: "const  x =1", keep: true, nested: { level: 1 } };
		const result = await formatter("eval", args, new AbortController().signal);
		const formatted = expectFormatted(result);

		expect(formatted).not.toBe(args);
		expect(formatted).toEqual({
			language: "js",
			code: "formatted-js\n",
			keep: true,
			nested: args.nested,
		});
		expect(formatted.nested).toBe(args.nested);
		expect(formatted.code).not.toBe(args.code);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith(
			["/tmp/prettier", "--no-config", "--stdin-filepath", "tool-call.js"],
			EXPECTED_FORMATTER_SPAWN_OPTIONS,
		);
		expect(subprocess.getWritten()).toBe(args.code);
		expect(which).toHaveBeenCalledTimes(1);
	});

	it("formats eval Python code via ruff", async () => {
		const which = vi.fn().mockReturnValue("/tmp/ruff");
		const subprocess = createSubprocess("formatted-py\n");
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({ runtime: { which, spawn } });

		const args = { language: "py", code: "print('raw')" };
		const formatted = expectFormatted(await formatter("eval", args, new AbortController().signal));

		expect(formatted).toEqual({
			language: "py",
			code: "formatted-py\n",
		});
		expect(spawn).toHaveBeenCalledWith(
			["/tmp/ruff", "format", "--isolated", "--stdin-filename", "tool-call.py", "-"],
			EXPECTED_FORMATTER_SPAWN_OPTIONS,
		);
	});

	it("formats bash commands via shfmt", async () => {
		const which = vi.fn().mockReturnValue("/tmp/shfmt");
		const subprocess = createSubprocess("formatted-bash\n");
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({ runtime: { which, spawn } });

		const args = { command: "echo  hi" };
		const formatted = expectFormatted(await formatter("bash", args, new AbortController().signal));

		expect(formatted).toEqual({
			command: "formatted-bash\n",
		});
		expect(spawn).toHaveBeenCalledWith(["/tmp/shfmt"], EXPECTED_FORMATTER_SPAWN_OPTIONS);
	});

	type WriteCase = {
		name: string;
		path: string;
		binary: string;
		args: string[];
	};

	const writeCases: WriteCase[] = [
		{
			name: "javascript",
			path: "/tmp/source.ts",
			binary: "prettier",
			args: ["--no-config", "--stdin-filepath", "/tmp/source.ts"],
		},
		{
			name: "python",
			path: "/tmp/source.py",
			binary: "ruff",
			args: ["format", "--isolated", "--stdin-filename", "/tmp/source.py", "-"],
		},
		{ name: "rust", path: "/tmp/source.rs", binary: "rustfmt", args: ["--emit", "stdout"] },
		{ name: "go", path: "/tmp/source.go", binary: "gofmt", args: [] },
		{ name: "shell", path: "/tmp/source.sh", binary: "shfmt", args: [] },
	];

	for (const writeCase of writeCases) {
		it(`formats write.${writeCase.name} content with ${writeCase.binary}` as const, async () => {
			const which = vi.fn().mockReturnValue(`/tmp/${writeCase.binary}`);
			const subprocess = createSubprocess(`formatted-write-${writeCase.name}`);
			const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
			const formatter = createSourceFormatter({ runtime: { which, spawn } });

			const args = { path: writeCase.path, content: `raw-${writeCase.name}` };
			const formatted = expectFormatted(await formatter("write", args, new AbortController().signal));

			expect(formatted).toEqual({
				path: writeCase.path,
				content: `formatted-write-${writeCase.name}`,
			});
			expect(spawn).toHaveBeenCalledWith(
				[`/tmp/${writeCase.binary}`, ...writeCase.args],
				EXPECTED_FORMATTER_SPAWN_OPTIONS,
			);
		});
	}

	it("does not format markdown write content (raw fallback)", async () => {
		const which = vi.fn().mockReturnValue("/tmp/prettier");
		const spawn = vi.fn<SpawnCommand>();
		const formatter = createSourceFormatter({ runtime: { which, spawn } });

		const args = { path: "README.md", content: "# heading" };
		const result = await formatter("write", args, new AbortController().signal);

		expectUnchanged(result);
		expect(spawn).not.toHaveBeenCalled();
		expect(which).not.toHaveBeenCalled();
	});

	it("falls back when formatter returns non-zero exit code", async () => {
		const which = vi.fn().mockReturnValue("/tmp/prettier");
		const subprocess = createSubprocess("formatted-js\n", { exitCode: 1 });
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({ runtime: { which, spawn } });

		const args = { language: "js", code: "const x = 1" };
		const result = await formatter("eval", args, new AbortController().signal);

		expectUnchanged(result);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("falls back when formatter spawn throws", async () => {
		const which = vi.fn().mockReturnValue("/tmp/prettier");
		const spawn = vi.fn<SpawnCommand>(() => {
			throw new Error("spawn should fail");
		});
		const formatter = createSourceFormatter({ runtime: { which, spawn } });

		const args = { language: "js", code: "const x = 1" };
		const result = await formatter("eval", args, new AbortController().signal);

		expectUnchanged(result);
		expect(which).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("reuses executable cache for missing formatter binaries", async () => {
		const which = vi.fn().mockReturnValue(undefined);
		const spawn = vi.fn<SpawnCommand>(() => {
			throw new Error("spawn should not be called");
		});
		const formatter = createSourceFormatter({ runtime: { which, spawn } });
		const args = { language: "js", code: "const x = 1" };

		const first = await formatter("eval", args, new AbortController().signal);
		const second = await formatter("eval", args, new AbortController().signal);

		expectMissingExecutable(first, "prettier");
		expectMissingExecutable(second, "prettier");
		expect(which).toHaveBeenCalledTimes(1);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("reuses successful formatted content cache", async () => {
		const which = vi.fn().mockReturnValue("/tmp/prettier");
		const subprocess = createSubprocess("cached\n");
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({ runtime: { which, spawn } });
		const args = { language: "js", code: "const x = 1" };

		const first = await formatter("eval", args, new AbortController().signal);
		const second = await formatter("eval", args, new AbortController().signal);

		expectFormatted(first);
		expectFormatted(second);
		expect(first).toEqual(second);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("falls back to raw on oversized input", async () => {
		const which = vi.fn().mockReturnValue("/tmp/prettier");
		const spawn = vi.fn<SpawnCommand>(() => {
			throw new Error("spawn should not be called");
		});
		const formatter = createSourceFormatter({
			runtime: { which, spawn },
			options: { maxInputBytes: 4 },
		});

		const args = { language: "js", code: "longer than four bytes" };
		const result = await formatter("eval", args, new AbortController().signal);

		expectUnchanged(result);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("falls back when formatter output exceeds configured bound", async () => {
		const which = vi.fn().mockReturnValue("/tmp/prettier");
		const subprocess = createSubprocess("this output is far too long");
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({
			runtime: { which, spawn },
			options: { maxOutputBytes: 4 },
		});

		const args = { language: "js", code: "x = 1" };
		const result = await formatter("eval", args, new AbortController().signal);

		expectUnchanged(result);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("falls back on non-positive timeout without invoking long-running process work", async () => {
		const which = vi.fn().mockReturnValue("/tmp/shfmt");
		const subprocess = createSubprocess("formatted", { exitCode: 0 });
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({
			runtime: { which, spawn },
			options: { timeoutMs: 0 },
		});

		const args = { command: "printf 'hello'" };
		const result = await formatter("bash", args, new AbortController().signal);

		expectUnchanged(result);
		expect(spawn).not.toHaveBeenCalled();
		expect(which).not.toHaveBeenCalled();
	});

	for (const stalledInput of ["write", "end"] as const) {
		it(`falls back when stdin.${stalledInput} and process exit never settle`, async () => {
			const which = vi.fn().mockReturnValue("/tmp/prettier");
			const subprocess = createSubprocess("formatted-js\n", {
				write: stalledInput === "write" ? () => neverSettlingPromise<number>() : undefined,
				end: stalledInput === "end" ? () => neverSettlingPromise<undefined>() : undefined,
				exited: neverSettlingPromise<number | null>(),
			});
			const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
			const formatter = createSourceFormatter({
				runtime: { which, spawn },
				options: { timeoutMs: 20, terminateGraceMs: 5 },
			});

			const result = await formatter(
				"eval",
				{ language: "js", code: "const value = 1;" },
				new AbortController().signal,
			);

			expectUnchanged(result);
			expect(subprocess.process.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
			expect(subprocess.process.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
		});
	}

	it("falls back when args are non-object", async () => {
		const which = vi.fn();
		const spawn = vi.fn<SpawnCommand>(() => {
			throw new Error("spawn should not be called");
		});
		const formatter = createSourceFormatter({
			runtime: { which, spawn },
		});

		const result = await formatter("eval", "not-an-object", new AbortController().signal);

		expectUnchanged(result);
		expect(spawn).not.toHaveBeenCalled();
		expect(which).not.toHaveBeenCalled();
	});

	it("falls back when no formatter is defined for the tool invocation", async () => {
		const which = vi.fn();
		const spawn = vi.fn<SpawnCommand>(() => {
			throw new Error("spawn should not be called");
		});
		const formatter = createSourceFormatter({
			runtime: { which, spawn },
		});

		const result = await formatter("unknown", { code: "console.log(1)" }, new AbortController().signal);

		expectUnchanged(result);
		expect(spawn).not.toHaveBeenCalled();
		expect(which).not.toHaveBeenCalled();
	});
});
