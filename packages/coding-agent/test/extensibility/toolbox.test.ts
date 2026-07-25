/**
 * Toolbox tools — real-executable contract tests.
 *
 * Shelling out IS the contract: fixtures are `#!/bin/sh` scripts written to a
 * temp dir and chmod'd executable. Spawn is never mocked.
 *
 * Deadline note: `DESCRIBE_DEADLINE_MS` (5s) is a private const in toolbox.ts
 * with no export or injection seam, so the "describe exceeds 5s deadline"
 * failure mode is not exercised here (would require sleeping a real 5s).
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomTool as CustomToolDescriptor } from "@oh-my-pi/pi-coding-agent/capability/tool";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadCustomTools } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/loader";
import { loadToolboxTool, TOOLBOX_PROVIDER_ID } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/toolbox";
import type { CustomTool, CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

const TOOLBOX_SOURCE = {
	provider: TOOLBOX_PROVIDER_ID,
	providerName: "Toolbox",
	level: "project" as const,
};

/** Minimal context — toolbox execute ignores session state. */
const STUB_CTX = {} as CustomToolContext;

const tempRoots: string[] = [];
const homedirSpies: Array<ReturnType<typeof spyOn>> = [];

afterEach(async () => {
	while (homedirSpies.length > 0) {
		homedirSpies.pop()?.mockRestore();
	}
	while (tempRoots.length > 0) {
		const dir = tempRoots.pop();
		if (dir) await removeWithRetries(dir);
	}
});

async function makeTemp(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

async function writeScript(dir: string, fileName: string, body: string, mode = 0o755): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, fileName);
	await fs.writeFile(filePath, body, { encoding: "utf8" });
	await fs.chmod(filePath, mode);
	return filePath;
}

/** Good fixture: JSON schema on describe, echo stdin on execute. */
function goodFixture(describeJson: string): string {
	return [
		"#!/bin/sh",
		'if [ "$OMP_TOOLBOX_ACTION" = "describe" ]; then',
		`\tprintf '%s\\n' '${describeJson.replace(/'/g, `'\\''`)}'`,
		"\texit 0",
		"fi",
		'if [ "$OMP_TOOLBOX_ACTION" = "execute" ]; then',
		"\tcat",
		"\texit 0",
		"fi",
		"exit 1",
		"",
	].join("\n");
}

function isolateHomedir(home: string): void {
	homedirSpies.push(spyOn(os, "homedir").mockReturnValue(home));
}

async function discoverToolboxDescriptors(cwd: string, home: string): Promise<CustomToolDescriptor[]> {
	isolateHomedir(home);
	const result = await loadCapability<CustomToolDescriptor>("tools", {
		cwd,
		providers: [TOOLBOX_PROVIDER_ID],
	});
	return result.items;
}

/**
 * First element, presence checked. Every call site asserts the length first, so an
 * empty list here is a genuine test failure and deserves a named error rather than
 * a `!` that would surface as an opaque "cannot read property of undefined".
 */
function first<T>(items: readonly T[]): T {
	const [head] = items;
	if (head === undefined) throw new Error("expected at least one element, got none");
	return head;
}

describe("toolbox tools", () => {
	it("loads a valid executable with declared name, description, and parameters", async () => {
		const dir = await makeTemp("omp-toolbox-valid-");
		const describeJson = JSON.stringify({
			name: "roundtrip_tool",
			description: "Echoes arguments as JSON",
			parameters: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
			},
		});
		const scriptPath = await writeScript(dir, "roundtrip.sh", goodFixture(describeJson));

		const result = await loadToolboxTool(scriptPath, TOOLBOX_SOURCE);
		expect(result.errors).toEqual([]);
		expect(result.tools).toHaveLength(1);

		const tool = first(result.tools).tool;
		expect(tool.name).toBe("roundtrip_tool");
		expect(tool.description).toBe("Echoes arguments as JSON");
		expect(tool.parameters).toBeDefined();
		expect(typeof tool.execute).toBe("function");
	});

	it("defaults tool name to basename without extension when describe omits name", async () => {
		const dir = await makeTemp("omp-toolbox-default-name-");
		const describeJson = JSON.stringify({
			description: "Named from basename",
			parameters: { type: "object", properties: {} },
		});
		const scriptPath = await writeScript(dir, "from_basename.sh", goodFixture(describeJson));

		const result = await loadToolboxTool(scriptPath, TOOLBOX_SOURCE);
		expect(result.errors).toEqual([]);
		expect(result.tools).toHaveLength(1);
		expect(first(result.tools).tool.name).toBe("from_basename");
	});

	it("round-trips execute: JSON args on stdin, stdout as result (via loader dispatch)", async () => {
		const dir = await makeTemp("omp-toolbox-exec-");
		const describeJson = JSON.stringify({
			name: "echo_args",
			description: "Echo stdin",
			parameters: {
				type: "object",
				properties: { msg: { type: "string" }, n: { type: "number" } },
				required: ["msg"],
			},
		});
		const scriptPath = await writeScript(dir, "echo_args.sh", goodFixture(describeJson));

		const loaded = await loadCustomTools([{ path: scriptPath, source: TOOLBOX_SOURCE }], dir, []);
		expect(loaded.errors).toEqual([]);
		expect(loaded.tools).toHaveLength(1);

		const tool = first(loaded.tools).tool as CustomTool;
		const args = { msg: "hello", n: 42 };
		const execResult = await tool.execute("call-1", args, undefined, STUB_CTX);

		expect(execResult.isError).toBeUndefined();
		const text = execResult.content.find(c => c.type === "text");
		expect(text?.type).toBe("text");
		if (text?.type === "text") {
			expect(JSON.parse(text.text)).toEqual(args);
		}
	});

	it("silently ignores files without the owner-execute bit during discovery", async () => {
		const project = await makeTemp("omp-toolbox-project-");
		const home = await makeTemp("omp-toolbox-home-");
		const toolboxDir = path.join(project, ".omp", "toolbox");

		await writeScript(
			toolboxDir,
			"kept.sh",
			goodFixture(
				JSON.stringify({
					name: "kept",
					description: "executable",
					parameters: { type: "object", properties: {} },
				}),
			),
			0o755,
		);
		await writeScript(
			toolboxDir,
			"ignored.sh",
			goodFixture(
				JSON.stringify({
					name: "ignored",
					description: "not executable",
					parameters: { type: "object", properties: {} },
				}),
			),
			0o644,
		);

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const items = await discoverToolboxDescriptors(project, home);
			const names = items.map(i => i.name).sort();
			expect(names).toEqual(["kept"]);
			expect(items.every(i => !i.path.endsWith("ignored.sh"))).toBe(true);
			// Silent: no warn for the non-executable file.
			expect(warn.mock.calls.some(c => String(c[0]).includes("ignored"))).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});

	it("skips describe non-zero exit with one warning and never throws", async () => {
		const dir = await makeTemp("omp-toolbox-describe-nz-");
		const scriptPath = await writeScript(
			dir,
			"fail_describe.sh",
			["#!/bin/sh", 'if [ "$OMP_TOOLBOX_ACTION" = "describe" ]; then', "\texit 7", "fi", "exit 0", ""].join("\n"),
		);

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await loadToolboxTool(scriptPath, TOOLBOX_SOURCE);
			expect(result.tools).toEqual([]);
			expect(result.errors).toHaveLength(1);
			expect(first(result.errors).error).toContain("describe exited with code 7");
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(first(warn.mock.calls)[0])).toContain("Toolbox tool skipped");
		} finally {
			warn.mockRestore();
		}
	});

	it("skips describe unparsable JSON with one warning and never throws", async () => {
		const dir = await makeTemp("omp-toolbox-bad-json-");
		const scriptPath = await writeScript(
			dir,
			"bad_json.sh",
			[
				"#!/bin/sh",
				'if [ "$OMP_TOOLBOX_ACTION" = "describe" ]; then',
				"\techo 'not-json-at-all'",
				"\texit 0",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await loadToolboxTool(scriptPath, TOOLBOX_SOURCE);
			expect(result.tools).toEqual([]);
			expect(result.errors).toHaveLength(1);
			expect(first(result.errors).error).toContain("unparsable JSON");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("surfaces non-zero execute exit as a tool error carrying stderr (not a crash)", async () => {
		const dir = await makeTemp("omp-toolbox-exec-err-");
		const scriptPath = await writeScript(
			dir,
			"fail_exec.sh",
			[
				"#!/bin/sh",
				'if [ "$OMP_TOOLBOX_ACTION" = "describe" ]; then',
				`\tprintf '%s\\n' '{"name":"fail_exec","description":"fails on execute","parameters":{"type":"object","properties":{}}}'`,
				"\texit 0",
				"fi",
				'if [ "$OMP_TOOLBOX_ACTION" = "execute" ]; then',
				'\techo "kaboom from stderr" >&2',
				"\texit 3",
				"fi",
				"exit 1",
				"",
			].join("\n"),
		);

		const result = await loadToolboxTool(scriptPath, TOOLBOX_SOURCE);
		expect(result.errors).toEqual([]);
		const tool = first(result.tools).tool;

		const execResult = await tool.execute("call-err", {}, undefined, STUB_CTX);
		expect(execResult.isError).toBe(true);
		const text = execResult.content.find(c => c.type === "text");
		expect(text?.type).toBe("text");
		if (text?.type === "text") {
			expect(text.text).toContain("kaboom from stderr");
		}
	});

	it("lets project .omp/toolbox/ shadow user ~/.omp/toolbox/ for the same tool name", async () => {
		const project = await makeTemp("omp-toolbox-shadow-project-");
		const home = await makeTemp("omp-toolbox-shadow-home-");

		await writeScript(
			path.join(project, ".omp", "toolbox"),
			"shared.sh",
			goodFixture(
				JSON.stringify({
					name: "shared",
					description: "project copy",
					parameters: { type: "object", properties: {} },
				}),
			),
		);
		await writeScript(
			path.join(home, ".omp", "toolbox"),
			"shared.sh",
			goodFixture(
				JSON.stringify({
					name: "shared",
					description: "user copy",
					parameters: { type: "object", properties: {} },
				}),
			),
		);

		const items = await discoverToolboxDescriptors(project, home);
		const shared = items.filter(i => i.name === "shared");
		expect(shared).toHaveLength(1);
		expect(first(shared).level).toBe("project");
		expect(first(shared).path).toBe(path.join(project, ".omp", "toolbox", "shared.sh"));

		// Full load path: project executable wins; describe description confirms which binary ran.
		const loaded = await loadCustomTools(
			[{ path: first(shared).path, source: { ...TOOLBOX_SOURCE, level: "project" } }],
			project,
			[],
		);
		expect(loaded.errors).toEqual([]);
		expect(loaded.tools).toHaveLength(1);
		expect(first(loaded.tools).tool.description).toBe("project copy");
	});

	it("skips a tool whose describe exceeds the deadline, without throwing", async () => {
		const dir = await makeTemp("omp-toolbox-deadline-");
		const scriptPath = path.join(dir, "slowpoke.sh");
		await Bun.write(scriptPath, "#!/bin/sh\nsleep 30\n");
		await fs.chmod(scriptPath, 0o755);

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await loadToolboxTool(scriptPath, TOOLBOX_SOURCE, { describeTimeoutMs: 100 });
			expect(result.tools).toEqual([]);
			expect(result.errors).toHaveLength(1);
			// Reported distinctly from a clean non-zero exit.
			expect(first(result.errors).error).toMatch(/timed out|deadline/i);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});
