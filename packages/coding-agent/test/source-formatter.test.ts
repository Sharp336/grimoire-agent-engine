import { describe, expect, it, vi } from "bun:test";
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
};

type MockSubprocessStdin = {
	write(chunk: string | Uint8Array): number | Promise<number>;
	end(chunk?: string | Uint8Array): void | Promise<void>;
	flush?: () => void;
};

type MockSubprocessResult = {
	readonly stdin: MockSubprocessStdin | null;
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exited: Promise<number | null>;
	exitCode: number | null;
	kill: (signal?: Parameters<Bun.Subprocess["kill"]>[0]) => void;
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
	} = {},
): MockSubprocess {
	let written = "";
	const proc: MockSubprocessResult = {
		stdin: {
			write: vi.fn((chunk: string | Uint8Array) => {
				const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				written += text;
				return text.length;
			}),
			end: vi.fn(),
			flush: vi.fn(),
		},
		stdout: streamFromText(source),
		stderr: streamFromText(options.stderr ?? ""),
		exited: Promise.resolve(options.exitCode ?? 0),
		exitCode: null,
		kill: vi.fn(),
	};

	return { process: proc, getWritten: () => written };
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
		const formatted = await formatter("eval", args, new AbortController().signal);

		expect(formatted).toBeDefined();
		expect(formatted).not.toBe(args);
		expect(formatted).toEqual({
			language: "js",
			code: "formatted-js\n",
			keep: true,
			nested: args.nested,
		});
		expect(formatted!.nested).toBe(args.nested);
		expect(formatted!.code).not.toBe(args.code);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith(["/tmp/prettier", "--no-config", "--stdin-filepath", "tool-call.js"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(subprocess.getWritten()).toBe(args.code);
		expect(which).toHaveBeenCalledTimes(1);
	});

	it("formats eval Python code via ruff", async () => {
		const which = vi.fn().mockReturnValue("/tmp/ruff");
		const subprocess = createSubprocess("formatted-py\n");
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({ runtime: { which, spawn } });

		const args = { language: "py", code: "print('raw')" };
		const formatted = await formatter("eval", args, new AbortController().signal);

		expect(formatted).toEqual({
			language: "py",
			code: "formatted-py\n",
		});
		expect(spawn).toHaveBeenCalledWith(
			["/tmp/ruff", "format", "--stdin-filename", "tool-call.py", "-"],
			expect.anything(),
		);
	});

	it("formats bash commands via shfmt", async () => {
		const which = vi.fn().mockReturnValue("/tmp/shfmt");
		const subprocess = createSubprocess("formatted-bash\n");
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({ runtime: { which, spawn } });

		const args = { command: "echo  hi" };
		const formatted = await formatter("bash", args, new AbortController().signal);

		expect(formatted).toEqual({
			command: "formatted-bash\n",
		});
		expect(spawn).toHaveBeenCalledWith(["/tmp/shfmt"], expect.anything());
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
			args: ["format", "--stdin-filename", "/tmp/source.py", "-"],
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
			const formatted = await formatter("write", args, new AbortController().signal);

			expect(formatted).toEqual({
				path: writeCase.path,
				content: `formatted-write-${writeCase.name}`,
			});
			expect(spawn).toHaveBeenCalledWith([`/tmp/${writeCase.binary}`, ...writeCase.args], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		});
	}

	it("does not format markdown write content (raw fallback)", async () => {
		const which = vi.fn().mockReturnValue("/tmp/prettier");
		const spawn = vi.fn<SpawnCommand>();
		const formatter = createSourceFormatter({ runtime: { which, spawn } });

		const args = { path: "README.md", content: "# heading" };
		const formatted = await formatter("write", args, new AbortController().signal);

		expect(formatted).toBeUndefined();
		expect(spawn).not.toHaveBeenCalled();
		expect(which).not.toHaveBeenCalled();
	});

	it("falls back when formatter returns non-zero exit code", async () => {
		const which = vi.fn().mockReturnValue("/tmp/prettier");
		const subprocess = createSubprocess("formatted-js\n", { exitCode: 1 });
		const spawn = vi.fn<SpawnCommand>(() => subprocess.process);
		const formatter = createSourceFormatter({ runtime: { which, spawn } });

		const args = { language: "js", code: "const x = 1" };
		const formatted = await formatter("eval", args, new AbortController().signal);

		expect(formatted).toBeUndefined();
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("reuses executable cache for missing formatter binaries", async () => {
		const which = vi.fn().mockReturnValue(undefined);
		const spawn = vi.fn<SpawnCommand>(() => {
			throw new Error("spawn should not be called");
		});
		const formatter = createSourceFormatter({ runtime: { which, spawn } });
		const args = { language: "js", code: "const x = 1" };

		await formatter("eval", args, new AbortController().signal);
		await formatter("eval", args, new AbortController().signal);

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
		const formatted = await formatter("eval", args, new AbortController().signal);

		expect(formatted).toBeUndefined();
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
		const formatted = await formatter("eval", args, new AbortController().signal);

		expect(formatted).toBeUndefined();
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
		const formatted = await formatter("bash", args, new AbortController().signal);

		expect(formatted).toBeUndefined();
		expect(spawn).not.toHaveBeenCalled();
		expect(which).not.toHaveBeenCalled();
	});

	it("falls back when args are non-object", async () => {
		const which = vi.fn();
		const spawn = vi.fn<SpawnCommand>(() => {
			throw new Error("spawn should not be called");
		});
		const formatter = createSourceFormatter({
			runtime: { which, spawn },
		});

		const formatted = await formatter("eval", "not-an-object" as unknown, new AbortController().signal);

		expect(formatted).toBeUndefined();
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

		const formatted = await formatter("unknown", { code: "console.log(1)" }, new AbortController().signal);

		expect(formatted).toBeUndefined();
		expect(spawn).not.toHaveBeenCalled();
		expect(which).not.toHaveBeenCalled();
	});
});
