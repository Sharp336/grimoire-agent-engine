import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { PYTHON_PRELUDE } from "../prelude";

const pythonPath = Bun.env.PYTHON ?? "python3";

async function runPrelude(
	code: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
	);
	const script = `${prelude}\n${code}`;
	const proc = Bun.spawn([pythonPath, "-c", script], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("python prelude", () => {
	it("accepts positional read options at runtime", async () => {
		using tempDir = TempDir.createSync("@omp-py-prelude-read-");
		const file = path.join(tempDir.path(), "sample.txt");
		await fs.writeFile(file, "first\nsecond\nthird\n");

		const { exitCode, stderr, stdout } = await runPrelude(
			[
				`positional = read(${JSON.stringify(file)}, 2, 1)`,
				`keyword = read(${JSON.stringify(file)}, offset=3, limit=1)`,
				'print(json.dumps({"positional": positional, "keyword": keyword}))',
			].join("\n"),
			{},
		);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ positional: "second\n", keyword: "third\n" });
	});

	it("appends line selectors to delegated URI paths", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({
					ok: true,
					value: { text: "resource contents", details: { resolvedPath: "/tmp/resource.txt" } },
				});
			},
		});

		try {
			const result = await runPrelude(
				[`print(read("artifact://21", 3, 2))`, `print(read("mcp://server/resource", 10, 5))`].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: server.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(result).toEqual({
				stdout: "resource contents\nresource contents\n",
				stderr: "",
				exitCode: 0,
			});
			expect(requests).toEqual([
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "artifact://21:3-4" },
				},
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "mcp://server/resource:10-14" },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	it("returns unstructured agent output when schema is omitted", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({
					ok: true,
					value: { text: "unstructured output", details: { agent: "task", id: "py-plain" } },
				});
			},
		});

		try {
			const { exitCode, stderr, stdout } = await runPrelude(
				['result = agent("classify")', "print(result)"].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: server.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(stdout).toBe("unstructured output\n");
			expect(requests).toEqual([
				{
					session: "test-session",
					run: null,
					name: "__agent__",
					args: { prompt: "classify", agent: "task" },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	it("forwards caller-supplied schemas and returns parsed structured data", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({
					ok: true,
					value: {
						text: '{"accepted":false,"zero":0}',
						details: { agent: "task", id: "py-strict", structured: true },
					},
				});
			},
		});

		try {
			const { exitCode, stderr, stdout } = await runPrelude(
				[
					'result = agent("classify", schema={"type": "object"})',
					'print(json.dumps(result))',
				].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: server.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(JSON.parse(stdout)).toEqual({ accepted: false, zero: 0 });
			expect(requests).toEqual([
				{
					session: "test-session",
					run: null,
					name: "__agent__",
					args: { prompt: "classify", agent: "task", schema: { type: "object" } },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	it("maps returned schema violations to AgentSchemaValidationError", async () => {
		const violation = {
			error: "schema_violation",
			message: "result.data.answer must be string",
			missingRequired: [],
			data: '{"answer":7}',
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ ok: true, value: { schemaViolation: violation } }),
		});

		try {
			const { exitCode, stderr, stdout } = await runPrelude(
				[
					"try:",
					'    agent("classify", schema={"type": "object"}, handle=True)',
					"except AgentSchemaValidationError as error:",
					'    print(json.dumps({"type": type(error).__name__, "code": error.code, "message": str(error), "details": error.details}))',
				].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: server.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(JSON.parse(stdout)).toEqual({
				type: "AgentSchemaValidationError",
				code: "schema_violation",
				message: violation.message,
				details: violation,
			});
		} finally {
			server.stop(true);
		}
	});

	it("exposes isolation artifacts on the agent() handle node", () => {
		// agent(..., handle=True) is the only escape hatch for
		// recovering apply=False patch/branch/nested artifacts (the bare
		// schema return is just the parsed object), so the helper MUST
		// translate the bridge's camelCase details onto the node — otherwise
		// an isolated apply=False workflow loses captured nested patches.
		expect(PYTHON_PRELUDE).toContain('("patchPath", "patch_path")');
		expect(PYTHON_PRELUDE).toContain('("branchName", "branch_name")');
		expect(PYTHON_PRELUDE).toContain('("nestedPatches", "nested_patches")');
		expect(PYTHON_PRELUDE).toContain('("changesApplied", "changes_applied")');
		expect(PYTHON_PRELUDE).toContain('("isolationSummary", "isolation_summary")');
	});
});
