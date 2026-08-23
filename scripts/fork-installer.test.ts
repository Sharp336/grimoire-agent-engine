import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writeExecutable(directory: string, name: string, content: string): Promise<string> {
	const filePath = path.join(directory, name);
	await Bun.write(filePath, content);
	await fs.chmod(filePath, 0o755);
	return filePath;
}

describe("fork installer replacement", () => {
	it("replaces the PATH-prioritized official launcher with the latest fork binary", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-install-"));
		tempDirs.push(root);
		const binDir = path.join(root, "bin");
		await fs.mkdir(binDir);
		const existingPath = await writeExecutable(binDir, "omp", "#!/bin/sh\necho omp/17.0.0-official\n");
		const forkBinary = await writeExecutable(root, "fork-omp", "#!/bin/sh\necho omp/18.0.3\n");
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(
			binDir,
			"curl",
			`#!/bin/sh
case "$*" in
  *api.github.com*) printf '%s\n' '{"tag_name":"v18.0.3-fork.42"}' ;;
  *)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then cp "$OMP_TEST_FORK_BINARY" "$2"; exit 0; fi
      shift
    done
    exit 1
    ;;
esac
`,
		);

		const proc = Bun.spawn(["sh", "scripts/install.sh", "--binary"], {
			cwd: repoRoot,
			env: {
				...process.env,
				HOME: root,
				OMP_TEST_FORK_BINARY: forkBinary,
				PATH: `${binDir}:${process.env.PATH ?? ""}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain(`Replacing existing omp at ${existingPath}`);
		expect(await Bun.file(existingPath).text()).toBe("#!/bin/sh\necho omp/18.0.3\n");
	});
});
