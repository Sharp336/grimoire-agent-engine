import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getShellConfig as getProcessShellConfig } from "@oh-my-pi/pi-utils/procmgr";
import {
	type InteractiveShellResult,
	resolveInteractiveShellPath,
	runInteractiveShell,
} from "../src/exec/interactive-shell";

interface CapturedSpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	stdin: "inherit";
	stdout: "inherit";
	stderr: "inherit";
}

const testRoots = new Set<string>();

async function makeTestRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-interactive-shell-test-"));
	testRoots.add(root);
	return root;
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function findRecordPath(zdotdir: string): Promise<string> {
	const entries = await fs.readdir(zdotdir);
	const record = entries.find(entry => entry !== ".zshenv");
	if (!record) throw new Error("cwd record was not created");
	return path.join(zdotdir, record);
}

async function runZshWithRecord(
	cwd: string,
	writeRecord: (recordPath: string) => Promise<void>,
): Promise<InteractiveShellResult> {
	return runInteractiveShell({
		shellPath: "/bin/zsh",
		cwd,
		env: { HOME: cwd, ZDOTDIR: path.join(cwd, "original-zdotdir") },
		spawn: (_command, options) => ({
			exited: (async () => {
				const recordPath = await findRecordPath(options.env.ZDOTDIR as string);
				await writeRecord(recordPath);
				return 0;
			})(),
		}),
	});
}

afterEach(async () => {
	await Promise.all([...testRoots].map(root => fs.rm(root, { recursive: true, force: true })));
	testRoots.clear();
});

describe("runInteractiveShell", () => {
	it.each([
		["/bin/zsh", ["/bin/zsh", "-il"]],
		["/opt/homebrew/bin/fish", ["/opt/homebrew/bin/fish", "-i"]],
		["/bin/bash", ["/bin/bash", "-l"]],
		["/bin/dash", ["/bin/dash", "-l"]],
		["C:\\Windows\\System32\\cmd.exe", ["C:\\Windows\\System32\\cmd.exe"]],
		["C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoLogo"]],
	] as const)("uses the native interactive argv policy for %s", async (shellPath, expectedCommand) => {
		let command: readonly string[] | undefined;
		await runInteractiveShell({
			shellPath,
			cwd: "/workspace",
			env: {},
			spawn: (spawnCommand, _options) => {
				command = spawnCommand;
				return { exited: Promise.resolve(0) };
			},
		});

		expect(command).toEqual(expectedCommand);
	});

	it("keeps zsh login-interactive and fish interactive when command-shell login is disabled", async () => {
		const commands: string[][] = [];
		for (const shellPath of ["/bin/zsh", "/usr/bin/fish"]) {
			await runInteractiveShell({
				shellPath,
				cwd: "/workspace",
				env: { PI_BASH_NO_LOGIN: "1" },
				spawn: (command, _options) => {
					commands.push(command);
					return { exited: Promise.resolve(0) };
				},
			});
		}

		expect(commands).toEqual([
			["/bin/zsh", "-il"],
			["/usr/bin/fish", "-i"],
		]);
	});

	it("launches the shell with direct inherited stdio", async () => {
		let launch: CapturedSpawnOptions | undefined;
		const result = await runInteractiveShell({
			shellPath: "/bin/bash",
			cwd: "/workspace",
			env: { HOME: "/home/test", SHELL: "/bin/sh" },
			spawn: (_command, options) => {
				launch = options;
				return { exited: Promise.resolve(23) };
			},
		});

		expect(launch).toEqual({
			cwd: "/workspace",
			env: { HOME: "/home/test", SHELL: "/bin/bash" },
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		expect(result).toEqual({ exitCode: 23 });
	});

	it("removes launch-cwd dotenv values while preserving launcher environment", async () => {
		const root = await makeTestRoot();
		await Bun.write(path.join(root, ".env"), "DOTENV_ONLY_SECRET=dotenv-secret\n");
		let launch: CapturedSpawnOptions | undefined;

		await runInteractiveShell({
			shellPath: "/bin/zsh",
			cwd: root,
			env: {
				DOTENV_ONLY_SECRET: "dotenv-secret",
				HOME: root,
				LAUNCHER_ONLY: "from-launcher",
			},
			spawn: (_command, options) => {
				launch = options;
				return { exited: Promise.resolve(0) };
			},
		});

		expect(launch?.env.DOTENV_ONLY_SECRET).toBeUndefined();
		expect(launch?.env.LAUNCHER_ONLY).toBe("from-launcher");
		expect(launch?.env.OMP_INTERACTIVE_SHELL_CWD_RECORD).toBeDefined();
	});

	it("removes launch-project dotenv values after the session cwd changes", async () => {
		const launchRoot = await makeTestRoot();
		const sessionRoot = await makeTestRoot();
		await Bun.write(
			path.join(launchRoot, ".env"),
			'OLD_PROJECT_SECRET=launch-project-secret\nMULTILINE_SECRET="first\nsecond"\n',
		);
		const modulePath = path.resolve(import.meta.dir, "../src/exec/interactive-shell.ts");
		// A subprocess import is required so the module captures launchRoot before the test changes cwd.
		const script = `
			const { runInteractiveShell } = await import(${JSON.stringify(modulePath)});
			const loadedSecret = process.env.OLD_PROJECT_SECRET;
			const loadedMultilineSecret = process.env.MULTILINE_SECRET;
			process.chdir(${JSON.stringify(sessionRoot)});
			let childEnv;
			await runInteractiveShell({
				shellPath: "/bin/bash",
				cwd: ${JSON.stringify(sessionRoot)},
				env: { ...process.env, LAUNCHER_ONLY: "from-launcher" },
				spawn: (_command, options) => {
					childEnv = options.env;
					return { exited: Promise.resolve(0) };
				},
			});
			console.log(JSON.stringify({
				loadedSecret,
				childSecret: childEnv?.OLD_PROJECT_SECRET,
				loadedMultilineSecret,
				childMultilineSecret: childEnv?.MULTILINE_SECRET,
				launcher: childEnv?.LAUNCHER_ONLY,
			}));
		`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: launchRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			loadedSecret: "launch-project-secret",
			loadedMultilineSecret: "first\nsecond",
			launcher: "from-launcher",
		});
	});

	it("creates a private zsh bootstrap that restores ZDOTDIR and sources the original .zshenv once", async () => {
		const root = await makeTestRoot();
		const originalZdotdir = path.join(root, "original-zdotdir");
		await fs.mkdir(originalZdotdir);
		const originalZshenv = path.join(originalZdotdir, ".zshenv");
		const originalContents = "typeset -g OMP_TEST_ZSHENV=loaded\n";
		await Bun.write(originalZshenv, originalContents);
		let temporaryZdotdir: string | undefined;

		await runInteractiveShell({
			shellPath: "/bin/zsh",
			cwd: root,
			env: { HOME: root, ZDOTDIR: originalZdotdir },
			spawn: (_command, options) => ({
				exited: (async () => {
					temporaryZdotdir = options.env.ZDOTDIR;
					expect(temporaryZdotdir).not.toBe(originalZdotdir);
					const recordPath = await findRecordPath(temporaryZdotdir as string);
					const bootstrapPath = path.join(temporaryZdotdir as string, ".zshenv");
					const [directoryStat, recordStat, bootstrapStat, bootstrap] = await Promise.all([
						fs.stat(temporaryZdotdir as string),
						fs.stat(recordPath),
						fs.stat(bootstrapPath),
						Bun.file(bootstrapPath).text(),
					]);
					if (process.platform !== "win32") {
						expect(directoryStat.mode & 0o777).toBe(0o700);
						expect(recordStat.mode & 0o777).toBe(0o600);
						expect(bootstrapStat.mode & 0o777).toBe(0o600);
					}
					expect(options.env.OMP_INTERACTIVE_SHELL_ORIGINAL_ZDOTDIR).toBe(originalZdotdir);
					expect(bootstrap.match(/builtin source/g)).toHaveLength(1);
					expect(bootstrap).toMatch(/add-zsh-hook chpwd _omp_chpwd_[a-f0-9]+/);
					expect(bootstrap).toMatch(/add-zsh-hook zshexit _omp_zshexit_[a-f0-9]+/);
					expect(bootstrap).toContain("export ZDOTDIR");
					return 0;
				})(),
			}),
		});

		expect(await Bun.file(originalZshenv).text()).toBe(originalContents);
		expect(temporaryZdotdir).toBeDefined();
		expect(await pathExists(temporaryZdotdir as string)).toBe(false);
	});

	it("preserves normal zsh alias and option behavior after bootstrap", async () => {
		if (!(await Bun.file("/bin/zsh").exists())) return;
		const root = await makeTestRoot();
		const originalZdotdir = path.join(root, "original-zdotdir");
		await fs.mkdir(originalZdotdir);
		await Bun.write(
			path.join(originalZdotdir, ".zshenv"),
			"setopt extendedglob\ntypeset OMP_TYPESET_VALUE=kept\nOMP_ASSIGN_VALUE=kept\n",
		);
		await Bun.write(
			path.join(originalZdotdir, ".zshrc"),
			[
				"alias omp_alias='print -r -- alias-ok'",
				`print -r -- "aliases=\${options[aliases]} localoptions=\${options[localoptions]}"`,
				`print -r -- "extendedglob=\${options[extendedglob]} typeset=\${OMP_TYPESET_VALUE-unset} assign=\${OMP_ASSIGN_VALUE-unset}"`,
				"omp_alias",
				"exit 0",
				"",
			].join("\n"),
		);
		let shellOutput = "";

		const result = await runInteractiveShell({
			shellPath: "/bin/zsh",
			cwd: root,
			env: { HOME: root, ZDOTDIR: originalZdotdir },
			spawn: (command, options) => ({
				exited: (async () => {
					const child = Bun.spawn(command, { ...options, stdout: "pipe", stderr: "pipe" });
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					shellOutput = stdout;
					expect(stderr).toBe("");
					return exitCode;
				})(),
			}),
		});

		expect(shellOutput).toContain("extendedglob=on typeset=kept assign=kept");
		expect(result.exitCode).toBe(0);
		expect(shellOutput).toContain("aliases=on localoptions=off");
		expect(shellOutput).toContain("alias-ok");
	});

	it("returns a validated final zsh working directory with ordinary non-ASCII characters", async () => {
		const root = await makeTestRoot();
		const finalCwd = path.join(root, "final-café-日本語");
		await fs.mkdir(finalCwd);

		const result = await runZshWithRecord(root, recordPath => Bun.write(recordPath, finalCwd).then(() => {}));

		expect(result).toEqual({ exitCode: 0, workingDir: finalCwd });
	});

	it.each([
		["C0 U+0001", "\u0001"],
		["C0 U+001F", "\u001f"],
		["DEL U+007F", "\u007f"],
		["C1 U+0080", "\u0080"],
		["C1 U+009F", "\u009f"],
	] as const)(
		"rejects an existing absolute zsh cwd containing %s before adoption",
		async (_name, controlCharacter) => {
			if (process.platform === "win32") return;
			const root = await makeTestRoot();
			const unsafeCwd = path.join(root, `unsafe-${controlCharacter}-directory`);
			await fs.mkdir(unsafeCwd);

			const result = await runZshWithRecord(root, recordPath => Bun.write(recordPath, unsafeCwd).then(() => {}));

			expect(result).toEqual({ exitCode: 0 });
		},
	);

	it("rejects a missing zsh cwd record", async () => {
		const root = await makeTestRoot();
		const result = await runZshWithRecord(root, recordPath => fs.rm(recordPath));
		expect(result).toEqual({ exitCode: 0 });
	});

	it("rejects a relative zsh cwd record", async () => {
		const root = await makeTestRoot();
		const result = await runZshWithRecord(root, recordPath => Bun.write(recordPath, "relative/path").then(() => {}));
		expect(result).toEqual({ exitCode: 0 });
	});

	it("rejects an oversized zsh cwd record", async () => {
		const root = await makeTestRoot();
		const result = await runZshWithRecord(root, recordPath =>
			Bun.write(recordPath, Buffer.alloc(4097, 0x61)).then(() => {}),
		);
		expect(result).toEqual({ exitCode: 0 });
	});

	it("rejects a zsh cwd record that names a non-directory", async () => {
		const root = await makeTestRoot();
		const regularFile = path.join(root, "regular-file");
		await Bun.write(regularFile, "content");
		const result = await runZshWithRecord(root, recordPath => Bun.write(recordPath, regularFile).then(() => {}));
		expect(result).toEqual({ exitCode: 0 });
	});

	it("removes zsh temporary files after a normal exit", async () => {
		const root = await makeTestRoot();
		let temporaryZdotdir: string | undefined;
		await runInteractiveShell({
			shellPath: "/bin/zsh",
			cwd: root,
			env: { HOME: root },
			spawn: (_command, options) => {
				temporaryZdotdir = options.env.ZDOTDIR;
				return { exited: Promise.resolve(0) };
			},
		});
		expect(await pathExists(temporaryZdotdir as string)).toBe(false);
	});

	it("removes zsh temporary files when spawning fails", async () => {
		const root = await makeTestRoot();
		let temporaryZdotdir: string | undefined;
		const result = runInteractiveShell({
			shellPath: "/bin/zsh",
			cwd: root,
			env: { HOME: root },
			spawn: (_command, options) => {
				temporaryZdotdir = options.env.ZDOTDIR;
				throw new Error("spawn failed");
			},
		});

		await expect(result).rejects.toThrow("spawn failed");
		expect(await pathExists(temporaryZdotdir as string)).toBe(false);
	});
});

describe("resolveInteractiveShellPath", () => {
	it("keeps the configured shellPath ahead of an executable SHELL", () => {
		const configuredShell = "/configured/custom-shell";
		const settings = {
			get: (_key: "shellPath") => configuredShell,
			getShellConfig: () => ({ shell: configuredShell, args: ["-l", "-c"], env: {}, prefix: undefined }),
		};

		expect(resolveInteractiveShellPath(settings, { SHELL: "/bin/zsh" })).toBe(configuredShell);
	});

	it.skipIf(process.platform === "win32")(
		"uses an executable supported SHELL when shellPath is not configured",
		async () => {
			const root = await makeTestRoot();
			const envShell = path.join(root, "fish");
			await Bun.write(envShell, "#!/bin/sh\nexit 0\n");
			await fs.chmod(envShell, 0o700);
			const settings = {
				get: (_key: "shellPath") => undefined,
				getShellConfig: (env?: Record<string, string | undefined>) => getProcessShellConfig(undefined, { env }),
			};

			expect(resolveInteractiveShellPath(settings, { SHELL: envShell })).toBe(envShell);
		},
	);

	it.skipIf(process.platform === "win32")("keeps the settings fallback when SHELL is not executable", async () => {
		const root = await makeTestRoot();
		const envShell = path.join(root, "zsh");
		await Bun.write(envShell, "not executable\n");
		await fs.chmod(envShell, 0o600);
		const settings = {
			get: (_key: "shellPath") => undefined,
			getShellConfig: (env?: Record<string, string | undefined>) => getProcessShellConfig(undefined, { env }),
		};

		expect(resolveInteractiveShellPath(settings, { SHELL: envShell })).toBe("/bin/bash");
	});

	it("does not resolve the shell from a launch-project dotenv PATH", async () => {
		if (process.platform === "win32") return;
		const launchRoot = await makeTestRoot();
		const binDir = path.join(launchRoot, "bin");
		await fs.mkdir(binDir);
		const attackerShell = path.join(launchRoot, "bash");
		await Bun.write(attackerShell, "#!/bin/sh\nexit 0\n");
		await fs.chmod(attackerShell, 0o700);
		await Bun.write(path.join(launchRoot, ".env"), `# ignored="\nPATH=${binDir}\nSHELL=${attackerShell}\n`);
		const modulePath = path.resolve(import.meta.dir, "../src/exec/interactive-shell.ts");
		const procmgrPath = path.resolve(import.meta.dir, "../../utils/src/procmgr.ts");
		const script = `
			const { resolveInteractiveShellPath } = await import(${JSON.stringify(modulePath)});
			const { getShellConfig } = await import(${JSON.stringify(procmgrPath)});
			const settings = {
				get: () => undefined,
				getShellConfig: env => getShellConfig(undefined, { env }),
			};
			console.log(resolveInteractiveShellPath(settings));
		`;
		const childEnv = { ...process.env };
		delete childEnv.PATH;
		delete childEnv.SHELL;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: launchRoot,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout.trim()).not.toBe(attackerShell);
		expect(stdout.trim()).toMatch(/^\/(?:usr\/)?bin\/(?:ba)?sh$/);
	});

	it("rejects multiline launch-project dotenv shell selection values", async () => {
		if (process.platform === "win32") return;
		const launchRoot = await makeTestRoot();
		const attackerShell = path.join(launchRoot, "bash\npayload");
		await Bun.write(attackerShell, "#!/bin/sh\nexit 0\n");
		await fs.chmod(attackerShell, 0o700);
		await Bun.write(path.join(launchRoot, ".env"), `SHELL="${attackerShell}"\nPATH="${launchRoot}\npayload"\n`);
		const modulePath = path.resolve(import.meta.dir, "../src/exec/interactive-shell.ts");
		const procmgrPath = path.resolve(import.meta.dir, "../../utils/src/procmgr.ts");
		const script = `
			const { resolveInteractiveShellPath } = await import(${JSON.stringify(modulePath)});
			const { getShellConfig } = await import(${JSON.stringify(procmgrPath)});
			const settings = {
				get: () => undefined,
				getShellConfig: env => getShellConfig(undefined, { env }),
			};
			console.log(resolveInteractiveShellPath(settings));
		`;
		const childEnv = { ...process.env };
		delete childEnv.PATH;
		delete childEnv.SHELL;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: launchRoot,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout.trim()).not.toBe(attackerShell);
		expect(stdout.trim()).toMatch(/^\/(?:usr\/)?bin\/(?:ba)?sh$/);
	});
});
