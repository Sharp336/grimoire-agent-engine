import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { normalizePathForComparison, removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	bindProfileToFolder,
	listProfileBindings,
	resolveProfileBinding,
	unbindProfileFromFolder,
} from "../src/cli/profile-bindings";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-bindings-"));
	tempRoots.push(root);
	return root;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

async function runCliCommand(
	args: string[],
	home: string,
	cwd: string,
	envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1", ...envOverrides };
	if (!("OMP_PROFILE" in envOverrides)) delete env.OMP_PROFILE;
	if (!("PI_PROFILE" in envOverrides)) delete env.PI_PROFILE;
	delete env.PI_CODING_AGENT_DIR;
	const processHandle = Bun.spawn([process.execPath, cliEntry, ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readStream(processHandle.stdout as ReadableStream<Uint8Array>),
		readStream(processHandle.stderr as ReadableStream<Uint8Array>),
		processHandle.exited,
	]);
	if (exitCode !== 0) throw new Error(`omp ${args.join(" ")} failed (${exitCode}): ${stderr}`);
	return { stdout, stderr };
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => removeWithRetries(root)));
});

describe("folder profile bindings", () => {
	it("selects the bound profile from a nested directory and removes it through the same public commands", async () => {
		const root = await makeTempRoot();
		const folder = path.join(root, "workspace");
		const nested = path.join(folder, "packages", "api");
		const bindingsPath = path.join(root, "config", "profile-bindings.json");
		await fs.mkdir(nested, { recursive: true });

		const binding = await bindProfileToFolder("default", folder, bindingsPath);
		const resolved = await resolveProfileBinding(nested, bindingsPath);

		expect(binding).toEqual({ kind: "directory", path: normalizePathForComparison(folder), profile: "default" });
		expect(resolved?.binding).toEqual(binding);
		expect(resolved?.profile).toBeUndefined();
		expect(await listProfileBindings(bindingsPath)).toEqual([binding]);
		expect(await unbindProfileFromFolder(nested, bindingsPath)).toEqual(binding);
		expect(await resolveProfileBinding(nested, bindingsPath)).toBeNull();
	});

	it("uses one binding for a repository and its linked worktrees", async () => {
		const root = await makeTempRoot();
		const repository = path.join(root, "repository");
		const worktree = path.join(root, "linked-worktree");
		const bindingsPath = path.join(root, "config", "profile-bindings.json");
		const boundFolder = path.join(repository, "packages", "work");
		const siblingFolder = path.join(repository, "packages", "personal");
		await fs.mkdir(boundFolder, { recursive: true });
		await fs.mkdir(siblingFolder, { recursive: true });
		await Bun.write(path.join(boundFolder, "README.md"), "work\n");
		await Bun.write(path.join(siblingFolder, "README.md"), "personal\n");
		await $`git init -q ${repository}`.quiet();
		await $`git -C ${repository} config user.email test@example.com`.quiet();
		await $`git -C ${repository} config user.name Test`.quiet();
		await $`git -C ${repository} add .`.quiet();
		await $`git -C ${repository} commit -qm initial`.quiet();
		await $`git -C ${repository} worktree add -q ${worktree}`.quiet();

		const binding = await bindProfileToFolder("default", boundFolder, bindingsPath);
		const resolved = await resolveProfileBinding(path.join(worktree, "packages", "work"), bindingsPath);

		expect(binding.kind).toBe("git-common-dir");
		expect(binding.subpath).toBe(path.join("packages", "work"));
		expect(resolved?.binding).toEqual(binding);
		expect(await resolveProfileBinding(siblingFolder, bindingsPath)).toBeNull();
	});

	it("inherits an outer repository binding inside a nested repository", async () => {
		const root = await makeTempRoot();
		const outer = path.join(root, "outer");
		const inner = path.join(outer, "packages", "inner");
		const bindingsPath = path.join(root, "config", "profile-bindings.json");
		await fs.mkdir(inner, { recursive: true });
		await $`git init -q ${outer}`.quiet();
		const binding = await bindProfileToFolder("default", outer, bindingsPath);
		await $`git init -q ${inner}`.quiet();

		expect((await resolveProfileBinding(inner, bindingsPath))?.binding).toEqual(binding);
	});

	it("binds a symlinked external folder without widening to the containing repository", async () => {
		if (process.platform === "win32") return;
		const root = await makeTempRoot();
		const repository = path.join(root, "repository");
		const external = path.join(root, "external");
		const link = path.join(repository, "external-link");
		const sibling = path.join(repository, "sibling");
		const bindingsPath = path.join(root, "config", "profile-bindings.json");
		await fs.mkdir(external, { recursive: true });
		await fs.mkdir(sibling, { recursive: true });
		await $`git init -q ${repository}`.quiet();
		await fs.symlink(external, link, "dir");

		const binding = await bindProfileToFolder("default", link, bindingsPath);
		expect(binding).toEqual({ kind: "directory", path: normalizePathForComparison(external), profile: "default" });
		expect(await resolveProfileBinding(sibling, bindingsPath)).toBeNull();
	});

	it("fails clearly when the bindings file is malformed", async () => {
		const root = await makeTempRoot();
		const bindingsPath = path.join(root, "profile-bindings.json");
		await Bun.write(bindingsPath, "not-json");

		await expect(resolveProfileBinding(root, bindingsPath)).rejects.toThrow("Invalid JSON in profile bindings file");
	});

	it.each(["../outside", "..\\outside", "nested/../../outside"])(
		"rejects a Git binding subpath that escapes its checkout: %s",
		async subpath => {
			const root = await makeTempRoot();
			const bindingsPath = path.join(root, "profile-bindings.json");
			await Bun.write(
				bindingsPath,
				JSON.stringify({
					version: 1,
					bindings: [{ kind: "git-common-dir", path: root, profile: "default", subpath }],
				}),
			);

			await expect(resolveProfileBinding(root, bindingsPath)).rejects.toThrow("Invalid profile bindings file");
		},
	);
});

describe("profile binding commands", () => {
	it("binds, shows, lists, and removes a folder through the CLI", async () => {
		const root = await makeTempRoot();
		const home = path.join(root, "home");
		const repository = path.join(root, "repository");
		await fs.mkdir(path.join(home, ".omp", "profiles", "work", "agent"), { recursive: true });
		await fs.mkdir(path.join(home, ".omp", "profiles", "personal", "agent"), { recursive: true });
		await fs.mkdir(repository, { recursive: true });
		await $`git init -q ${repository}`.quiet();

		await runCliCommand(["profile", "bind", "work", repository], home, root);
		const shown = await runCliCommand(["profile", "show", repository, "--json"], home, root);
		const listed = await runCliCommand(["profile", "list", "--json"], home, root);
		const cliOverride = await runCliCommand(
			["--profile", "personal", "profile", "show", repository, "--json"],
			home,
			root,
		);
		const envOverride = await runCliCommand(["profile", "show", repository, "--json"], home, root, {
			OMP_PROFILE: "personal",
			PI_PROFILE: "work",
		});
		const legacyEnvOverride = await runCliCommand(["profile", "show", repository, "--json"], home, root, {
			PI_PROFILE: "personal",
		});
		expect(JSON.parse(shown.stdout)).toMatchObject({ profile: "work", selectedBy: "folder-binding" });
		expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ profile: "work" })]);
		expect(JSON.parse(cliOverride.stdout)).toEqual({ profile: "personal", selectedBy: "cli" });
		expect(JSON.parse(envOverride.stdout)).toEqual({ profile: "personal", selectedBy: "environment" });
		expect(JSON.parse(legacyEnvOverride.stdout)).toEqual({ profile: "personal", selectedBy: "environment" });

		await runCliCommand(["--cwd", repository, "profile", "unbind"], home, root);
		const after = await runCliCommand(["profile", "show", repository, "--json"], home, root);
		expect(JSON.parse(after.stdout)).toEqual({ profile: "default", selectedBy: "default" });
	}, 30_000);

	it("rejects positional arguments for profile list", async () => {
		const root = await makeTempRoot();
		await expect(runCliCommand(["profile", "list", "unexpected"], path.join(root, "home"), root)).rejects.toThrow(
			"Too many arguments for omp profile list",
		);
	});

	it("does not use a folder binding to satisfy --alias", async () => {
		const root = await makeTempRoot();
		const home = path.join(root, "home");
		const bindingsPath = path.join(home, ".omp", "profile-bindings.json");
		await fs.mkdir(path.dirname(bindingsPath), { recursive: true });
		await Bun.write(
			bindingsPath,
			JSON.stringify({
				version: 1,
				bindings: [{ kind: "directory", path: root, profile: "missing" }],
			}),
		);

		await expect(runCliCommand(["--alias", "foo"], home, root)).rejects.toThrow(
			"--alias requires --profile <name> or OMP_PROFILE",
		);
	});
});

describe("profile binding bootstrap", () => {
	it("loads the profile bound to --cwd before profile-scoped environment imports", async () => {
		const root = await makeTempRoot();
		const home = path.join(root, "home");
		const repository = path.join(root, "repository");
		const profileRoot = path.join(home, ".omp", "profiles", "work");
		await fs.mkdir(repository, { recursive: true });
		await fs.mkdir(path.join(home, ".omp", "agent"), { recursive: true });
		await fs.mkdir(path.join(profileRoot, "agent"), { recursive: true });
		await $`git init -q ${repository}`.quiet();
		const commonDir = (await $`git -C ${repository} rev-parse --path-format=absolute --git-common-dir`.text()).trim();
		await Bun.write(
			path.join(home, ".omp", "profile-bindings.json"),
			JSON.stringify({
				version: 1,
				bindings: [{ kind: "git-common-dir", path: commonDir, profile: "work" }],
			}),
		);
		await Bun.write(path.join(home, ".omp", "agent", ".env"), "OMP_FOLDER_PROFILE_SENTINEL=default\n");
		await Bun.write(path.join(profileRoot, "agent", ".env"), "OMP_FOLDER_PROFILE_SENTINEL=work\n");

		const probePath = path.join(root, "probe.ts");
		await Bun.write(
			probePath,
			[
				`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
				`await runCli(["--cwd", ${JSON.stringify(repository)}, "--help"]);`,
				`process.stdout.write("SENTINEL=" + (Bun.env.OMP_FOLDER_PROFILE_SENTINEL ?? ""));`,
			].join("\n"),
		);
		const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
		delete childEnv.OMP_PROFILE;
		delete childEnv.PI_PROFILE;
		delete childEnv.PI_CODING_AGENT_DIR;
		delete childEnv.OMP_FOLDER_PROFILE_SENTINEL;
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: repoRoot,
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			readStream(proc.stdout as ReadableStream<Uint8Array>),
			readStream(proc.stderr as ReadableStream<Uint8Array>),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain("SENTINEL=work");
		expect(stdout).not.toContain("SENTINEL=default");

		const explicitDefault = Bun.spawn([process.execPath, probePath], {
			cwd: repoRoot,
			env: { ...childEnv, OMP_PROFILE: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [defaultStdout, defaultStderr, defaultExitCode] = await Promise.all([
			readStream(explicitDefault.stdout as ReadableStream<Uint8Array>),
			readStream(explicitDefault.stderr as ReadableStream<Uint8Array>),
			explicitDefault.exited,
		]);
		expect(defaultExitCode, defaultStderr).toBe(0);
		expect(defaultStdout).toContain("SENTINEL=default");
		expect(defaultStdout).not.toContain("SENTINEL=work");
	}, 30_000);

	it.each([
		{ name: "--profile default", parentArgs: ["--profile", "default", "--version"], env: {} },
		{ name: 'OMP_PROFILE=""', parentArgs: ["--version"], env: { OMP_PROFILE: "" } },
	])(
		"preserves explicit default selection when a CLI process re-enters: $name",
		async ({ parentArgs, env }) => {
			const root = await makeTempRoot();
			const home = path.join(root, "home");
			const repository = path.join(root, "repository");
			const profileRoot = path.join(home, ".omp", "profiles", "work");
			await fs.mkdir(repository, { recursive: true });
			await fs.mkdir(path.join(home, ".omp", "agent"), { recursive: true });
			await fs.mkdir(path.join(profileRoot, "agent"), { recursive: true });
			await $`git init -q ${repository}`.quiet();
			const commonDir = (
				await $`git -C ${repository} rev-parse --path-format=absolute --git-common-dir`.text()
			).trim();
			await Bun.write(
				path.join(home, ".omp", "profile-bindings.json"),
				JSON.stringify({ version: 1, bindings: [{ kind: "git-common-dir", path: commonDir, profile: "work" }] }),
			);
			await Bun.write(path.join(home, ".omp", "agent", ".env"), "OMP_REENTRY_SENTINEL=default\n");
			await Bun.write(path.join(profileRoot, "agent", ".env"), "OMP_REENTRY_SENTINEL=work\n");

			const probePath = path.join(root, "reentry-probe.ts");
			await Bun.write(
				probePath,
				[
					`import { runCli } from ${JSON.stringify(url.pathToFileURL(cliEntry).href)};`,
					`const repository = ${JSON.stringify(repository)};`,
					`if (Bun.env.OMP_REENTRY_CHILD === "1") {`,
					`  delete Bun.env.OMP_REENTRY_SENTINEL;`,
					`  await runCli(["--cwd", repository, "--help"]);`,
					`  process.stdout.write("SENTINEL=" + (Bun.env.OMP_REENTRY_SENTINEL ?? ""));`,
					`} else {`,
					`  await runCli(JSON.parse(Bun.env.OMP_REENTRY_PARENT_ARGS ?? "[]"));`,
					`  const child = Bun.spawn([process.execPath, import.meta.path], {`,
					`    cwd: repository, env: { ...process.env, OMP_REENTRY_CHILD: "1" }, stdout: "pipe", stderr: "pipe"`,
					`  });`,
					`  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);`,
					`  process.stdout.write(stdout); process.stderr.write(stderr); if (exitCode !== 0) process.exitCode = exitCode;`,
					`}`,
				].join("\n"),
			);
			const childEnv: Record<string, string | undefined> = {
				...process.env,
				HOME: home,
				NO_COLOR: "1",
				OMP_REENTRY_PARENT_ARGS: JSON.stringify(parentArgs),
				...env,
			};
			if (!("OMP_PROFILE" in env)) delete childEnv.OMP_PROFILE;
			delete childEnv.PI_PROFILE;
			delete childEnv.PI_CODING_AGENT_DIR;
			delete childEnv.OMP_REENTRY_SENTINEL;
			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: repository,
				env: childEnv,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toContain("SENTINEL=default");
			expect(stdout).not.toContain("SENTINEL=work");
		},
		30_000,
	);
});
