import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const tempDirs: string[] = [];
const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : (Bun.which("sh") ?? undefined);

function shellPath(file: string): string {
	if (process.platform !== "win32") return file;
	return file.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function run(
	command: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

describe("musl release artifacts", () => {
	test("builds the requested x64 and arm64 musl asset names with Bun's musl targets", async () => {
		const result = await run([
			"bun",
			"scripts/ci-release-build-binaries.ts",
			"--dry-run",
			"--targets",
			"linux-musl-x64,linux-musl-arm64",
		]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(
			"Bun.build target=bun-linux-x64-musl-baseline outfile=packages/coding-agent/binaries/omp-linux-musl-x64",
		);
		expect(result.stdout).toContain(
			"Bun.build target=bun-linux-arm64-musl outfile=packages/coding-agent/binaries/omp-linux-musl-arm64",
		);
	});

	(shell ? test : test.skip)("selects the musl asset when the Linux host reports musl", async () => {
		if (!shell) return;
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-musl-install-"));
		tempDirs.push(dir);
		const binDir = path.join(dir, "bin");
		const installDir = path.join(dir, "install");
		await fs.mkdir(binDir);
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(binDir, "ldd", "#!/bin/sh\necho 'musl libc (x86_64)'\n");
		await writeExecutable(
			binDir,
			"curl",
			`#!/bin/sh
out=""
previous=""
for arg do
  if [ "$previous" = "-o" ]; then out="$arg"; fi
  previous="$arg"
done
case "$*" in
  *api.github.com*) echo '{"tag_name":"v1.0.0"}' ;;
  *SHA256SUMS.txt*)
    binary_file="$(find "$PI_INSTALL_DIR" -name '.omp-download.*' -print -quit)"
    digest="$(sha256sum "$binary_file" | awk '{print $1}')"
    printf '%s  omp-linux-musl-x64\n' "$digest" > "$out"
    ;;
  *) printf '%s\n' '#!/bin/sh' 'echo omp/1.0.0' > "$out" ;;
esac
`,
		);

		const result = await run([
			shell,
			"-c",
			'export PATH="$1:/usr/bin:/bin" HOME="$2" PI_INSTALL_DIR="$3"; shift 3; sh scripts/install.sh "$@"',
			"musl-release-test",
			shellPath(binDir),
			shellPath(dir),
			shellPath(installDir),
			"--binary",
		]);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Downloading omp-linux-musl-x64...");
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe("#!/bin/sh\necho omp/1.0.0\n");
	});
});
