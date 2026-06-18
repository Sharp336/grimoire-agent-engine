import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SymbolTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";

let dir: string;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-tool-"));
	await fs.writeFile(
		path.join(dir, "shapes.ts"),
		[
			"export class Shape {",
			"  area() { return 0; }",
			"}",
			"export function makeShape() { return new Shape(); }",
			"const scale = (n: number) => n * 2;",
			"function Shapeless() {}",
			"",
		].join("\n"),
	);
	await fs.writeFile(
		path.join(dir, "geo.rs"),
		["struct Point { x: u32 }", "impl Point {", "    fn norm(&self) -> u32 { self.x }", "}", "fn helper() {}", ""].join(
			"\n",
		),
	);
	// Unsupported file whose text contains a symbol name — must be excluded from
	// both overview enumeration and find candidates.
	await fs.writeFile(path.join(dir, "notes.md"), "# notes\nmakeShape and Shape mentioned here\n");
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
	resetSettingsForTest();
});

function symbolTool(): SymbolTool {
	return new SymbolTool({ cwd: dir, settings: Settings.isolated() } as unknown as ToolSession);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.find(content => content.type === "text")?.text ?? "";
}

describe("symbol overview", () => {
	it("outlines a TypeScript file with nesting, arrow-const, and kinds", async () => {
		const result = await symbolTool().execute("t", { action: "overview", path: path.join(dir, "shapes.ts") });
		const text = textOf(result);
		expect(text).toContain("class Shape");
		// `area` is nested under the class, so it is indented and tagged `method`.
		expect(text).toMatch(/\n\s+method area/);
		expect(text).toContain("function makeShape");
		// Arrow assigned to a const is reported as a function, not a variable.
		expect(text).toContain("function scale");
		expect(text).toContain("function Shapeless");
	});

	it("outlines a Rust file including a struct field and impl method", async () => {
		const result = await symbolTool().execute("t", { action: "overview", path: path.join(dir, "geo.rs") });
		const text = textOf(result);
		expect(text).toContain("struct Point");
		expect(text).toMatch(/\n\s+field x/);
		expect(text).toContain("method norm");
		expect(text).toContain("function helper");
	});

	it("outlines a newly-supported language (Kotlin) through the native gate", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-kt-"));
		try {
			const kt = path.join(tmp, "demo.kt");
			await fs.writeFile(
				kt,
				["class Greeter {", '\tfun greet(): String = "hi"', "}", "fun topLevel() {}", ""].join("\n"),
			);
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "overview", path: kt }));
			expect(text).toContain("class Greeter");
			expect(text).toMatch(/\n\s+method greet/);
			expect(text).toContain("function topLevel");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("accepts an extensionless shell rc file via the native path gate", async () => {
		// `.bashrc` has no extension, so an extension-only gate would reject it;
		// the native resolver maps the special-name file to Bash.
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-rc-"));
		try {
			const rc = path.join(tmp, ".bashrc");
			await fs.writeFile(rc, ["greet() {", "\techo hi", "}", ""].join("\n"));
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "overview", path: rc }));
			expect(text).toContain("function greet");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("outlines a DSL/schema language (GraphQL) through the native gate", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-gql-"));
		try {
			const gql = path.join(tmp, "schema.graphql");
			await fs.writeFile(
				gql,
				["type Person {", "  id: ID!", "  name: String!", "}", "", "enum Status {", "  ACTIVE", "  INACTIVE", "}", ""].join("\n"),
			);
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "overview", path: gql }));
			expect(text).toContain("struct Person");
			expect(text).toContain("enum Status");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("discovers a canonically-named build file (Dockerfile) in a directory scan", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-docker-"));
		try {
			// Extensionless `Dockerfile` is surfaced by the name-based scan glob
			// (not only the per-file gate), and its named stage is outlined.
			await fs.writeFile(
				path.join(tmp, "Dockerfile"),
				["FROM ubuntu:22.04 AS builder", "RUN echo hi", ""].join("\n"),
			);
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "overview", path: tmp }));
			expect(text).toContain("Dockerfile");
			expect(text).toContain("builder");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("groups a directory scope and excludes unsupported files", async () => {
		const result = await symbolTool().execute("t", { action: "overview", path: dir });
		const text = textOf(result);
		expect(text).toContain("shapes.ts");
		expect(text).toContain("geo.rs");
		// notes.md is unsupported: it is never enumerated, so its header never appears.
		expect(text).not.toContain("notes.md");
	});

	it("rejects an overview scope larger than the file cap", async () => {
		// Isolated temp dir so the oversized tree never pollutes the shared `dir`
		// scope used by the find tests below.
		const big = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-big-"));
		try {
			await Promise.all(
				Array.from({ length: 51 }, (_, index) =>
					fs.writeFile(path.join(big, `f${index}.ts`), `export function f${index}() {}\n`),
				),
			);
			const tool = new SymbolTool({ cwd: big, settings: Settings.isolated() } as unknown as ToolSession);
			await expect(tool.execute("t", { action: "overview", path: big })).rejects.toThrow(/too large/);
		} finally {
			await fs.rm(big, { recursive: true, force: true });
		}
	});
});

describe("symbol find", () => {
	it("locates a symbol by exact name with its file and line", async () => {
		const result = await symbolTool().execute("t", { action: "find", name: "makeShape", path: dir });
		const text = textOf(result);
		expect(text).toContain('Found 1 symbol(s) matching "makeShape":');
		expect(text).toContain("function makeShape @ shapes.ts:4");
	});

	it("prefers exact matches over substring matches", async () => {
		// `Shape` (the class) is an exact hit; `makeShape`/`Shapeless` are substring
		// hits. The exact hit must win and suppress the substring noise.
		const result = await symbolTool().execute("t", { action: "find", name: "Shape", path: dir });
		const text = textOf(result);
		expect(text).toContain('Found 1 symbol(s) matching "Shape":');
		expect(text).toContain("class Shape");
		expect(text).not.toContain("makeShape");
		expect(text).not.toContain("Shapeless");
	});

	it("falls back to case-insensitive substring when no symbol matches exactly", async () => {
		const result = await symbolTool().execute("t", { action: "find", name: "shapel", path: dir });
		const text = textOf(result);
		expect(text).toContain("Shapeless");
	});

	it("attributes a Rust impl method to its container type", async () => {
		const result = await symbolTool().execute("t", { action: "find", name: "norm", path: dir });
		const text = textOf(result);
		expect(text).toContain("method norm (Point) @ geo.rs:3");
	});

	it("restricts a multi-file scope to the named files", async () => {
		const result = await symbolTool().execute("t", {
			action: "find",
			name: "helper",
			path: [path.join(dir, "shapes.ts"), path.join(dir, "geo.rs")],
		});
		const text = textOf(result);
		expect(text).toContain('Found 1 symbol(s) matching "helper":');
		expect(text).toContain("function helper @ geo.rs:5");
	});

	it("reports no match instead of erroring", async () => {
		const result = await symbolTool().execute("t", { action: "find", name: "DefinitelyMissing", path: dir });
		expect(textOf(result)).toContain("No symbols found.");
	});
});

interface InvokedToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

interface ManipulateHarness {
	tool: SymbolTool;
	queue: ToolChoiceQueue;
}

function manipulateHarness(cwd: string, overrides: Partial<ToolSession> = {}): ManipulateHarness {
	const queue = new ToolChoiceQueue();
	const tool = new SymbolTool({
		cwd,
		enableLsp: false,
		settings: Settings.isolated(),
		getToolChoiceQueue: () => queue,
		buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
		steer: () => {},
		...overrides,
	} as unknown as ToolSession);
	return { tool, queue };
}

describe("symbol manipulate", () => {
	it("previews without writing, then applies the replacement on resolve", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-"));
		try {
			const file = path.join(tmp, "greet.ts");
			const original = "function greet(name: string) {\n  return name;\n}\nconst keep = 1;\n";
			await fs.writeFile(file, original);
			const { tool, queue } = manipulateHarness(tmp);

			const preview = await tool.execute("m", {
				action: "manipulate",
				path: file,
				name: "greet",
				op: "replace",
				text: "function greet(name: string) {\n  return `hi ${name}`;\n}",
			});
			// Preview stages a resolve but must not touch disk.
			expect(await fs.readFile(file, "utf8")).toBe(original);
			expect(textOf(preview)).toContain("greet");

			queue.nextToolChoice();
			const invoker = queue.peekInFlightInvoker();
			expect(invoker).toBeDefined();
			const applied = (await invoker!({ action: "apply", reason: "apply symbol replace" })) as InvokedToolResult;
			expect(applied.isError).toBeUndefined();

			const updated = await fs.readFile(file, "utf8");
			expect(updated).toContain("return `hi ${name}`;");
			expect(updated).not.toContain("return name;");
			// Neighboring statement untouched.
			expect(updated).toContain("const keep = 1;");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("rejects an ambiguous name with a candidate list", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-amb-"));
		try {
			const file = path.join(tmp, "dup.ts");
			await fs.writeFile(file, "function dup() {}\nclass C { dup() {} }\n");
			const { tool } = manipulateHarness(tmp);
			await expect(tool.execute("m", { action: "manipulate", path: file, name: "dup", op: "delete" })).rejects.toThrow(
				/matches 2 symbols/,
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("rejects an unknown symbol name", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-nf-"));
		try {
			const file = path.join(tmp, "x.ts");
			await fs.writeFile(file, "function present() {}\n");
			const { tool } = manipulateHarness(tmp);
			await expect(
				tool.execute("m", { action: "manipulate", path: file, name: "absent", op: "delete" }),
			).rejects.toThrow(/No symbol named 'absent'/);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("blocks the staged apply in plan mode and leaves the file unchanged", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-plan-"));
		try {
			const file = path.join(tmp, "p.ts");
			const original = "function p() {}\n";
			await fs.writeFile(file, original);
			const { tool, queue } = manipulateHarness(tmp, {
				getPlanModeState: () => ({ enabled: true, planFilePath: path.join(tmp, "plan.md") }),
			} as Partial<ToolSession>);
			await tool.execute("m", {
				action: "manipulate",
				path: file,
				name: "p",
				op: "replace",
				text: "function p() { return 1; }",
			});
			queue.nextToolChoice();
			const invoker = queue.peekInFlightInvoker();
			expect(invoker).toBeDefined();
			let message = "";
			try {
				const result = (await invoker!({ action: "apply", reason: "apply in plan mode" })) as InvokedToolResult;
				message = result.isError ? (result.content.find(c => c.type === "text")?.text ?? "") : "";
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			// Must be rejected by the plan-mode guard specifically, not any error.
			expect(message).toMatch(/read-only/);
			// Working tree is read-only in plan mode: the file is untouched.
			expect(await fs.readFile(file, "utf8")).toBe(original);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	const applyOps: Array<{
		title: string;
		source: string;
		params: { name: string; op: "delete" | "insert_before" | "insert_after"; text?: string };
		assert: (updated: string) => void;
	}> = [
		{
			title: "applies delete by removing the symbol",
			source: "function keep() {}\nfunction drop() {}\nfunction last() {}\n",
			params: { name: "drop", op: "delete" },
			assert: updated => {
				expect(updated).not.toContain("function drop()");
				expect(updated).toContain("function keep()");
				expect(updated).toContain("function last()");
			},
		},
		{
			title: "applies insert_before above the symbol",
			source: "function target() {}\n",
			params: { name: "target", op: "insert_before", text: "const before = 1;" },
			assert: updated => {
				expect(updated).toContain("const before = 1;");
				expect(updated.indexOf("const before = 1;")).toBeLessThan(updated.indexOf("function target()"));
			},
		},
		{
			title: "applies insert_after below the symbol",
			source: "function target() {}\n",
			params: { name: "target", op: "insert_after", text: "const after = 2;" },
			assert: updated => {
				expect(updated).toContain("const after = 2;");
				expect(updated.indexOf("function target()")).toBeLessThan(updated.indexOf("const after = 2;"));
			},
		},
	];
	for (const opCase of applyOps) {
		it(opCase.title, async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-op-"));
			try {
				const file = path.join(tmp, "f.ts");
				await fs.writeFile(file, opCase.source);
				const { tool, queue } = manipulateHarness(tmp);
				await tool.execute("m", { action: "manipulate", path: file, ...opCase.params });
				queue.nextToolChoice();
				const invoker = queue.peekInFlightInvoker();
				expect(invoker).toBeDefined();
				const applied = (await invoker!({ action: "apply", reason: "apply" })) as InvokedToolResult;
				expect(applied.isError).toBeUndefined();
				opCase.assert(await fs.readFile(file, "utf8"));
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});
	}

	it("rejects apply when the symbol body changed since the preview", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-stale-"));
		try {
			const file = path.join(tmp, "s.ts");
			await fs.writeFile(file, "function g() {\n  return 1;\n}\n");
			const { tool, queue } = manipulateHarness(tmp);
			await tool.execute("m", {
				action: "manipulate",
				path: file,
				name: "g",
				op: "replace",
				text: "function g() {\n  return 99;\n}",
			});
			// Concurrent edit to the body between preview and apply, same line count
			// (so the range-equality guard alone would pass).
			const mutated = "function g() {\n  return 2;\n}\n";
			await fs.writeFile(file, mutated);
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({ action: "apply", reason: "stale" })) as InvokedToolResult;
			expect(applied.isError).toBe(true);
			expect(applied.content.find(c => c.type === "text")?.text ?? "").toMatch(/changed since the preview/);
			// The stale payload was NOT applied; the concurrent edit is preserved.
			expect(await fs.readFile(file, "utf8")).toBe(mutated);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("refuses to manipulate a symbol that shares a line with a sibling", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-sib-"));
		try {
			const file = path.join(tmp, "m.ts");
			await fs.writeFile(file, "const a = 1, b = 2;\n");
			const { tool } = manipulateHarness(tmp);
			await expect(
				tool.execute("m", { action: "manipulate", path: file, name: "a", op: "delete" }),
			).rejects.toThrow(/shares a line/);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("rejects `text` supplied with op delete", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-deltext-"));
		try {
			const file = path.join(tmp, "d.ts");
			await fs.writeFile(file, "function gone() {}\n");
			const { tool } = manipulateHarness(tmp);
			await expect(
				tool.execute("m", { action: "manipulate", path: file, name: "gone", op: "delete", text: "oops" }),
			).rejects.toThrow(/not allowed for op 'delete'/);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("does not add a trailing blank line when replacement text ends in a newline", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-nl-"));
		try {
			const file = path.join(tmp, "n.ts");
			await fs.writeFile(file, "function f() {}\nconst tail = 1;\n");
			const { tool, queue } = manipulateHarness(tmp);
			await tool.execute("m", {
				action: "manipulate",
				path: file,
				name: "f",
				op: "replace",
				text: "function f() { return 0; }\n",
			});
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({ action: "apply", reason: "apply" })) as InvokedToolResult;
			expect(applied.isError).toBeUndefined();
			// The trailing newline in `text` must not insert a blank line between the
			// replaced function and the following statement.
			expect(await fs.readFile(file, "utf8")).toBe("function f() { return 0; }\nconst tail = 1;\n");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("disambiguates duplicate names by line and edits only the targeted symbol", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-disambig-"));
		try {
			const file = path.join(tmp, "dup.ts");
			await fs.writeFile(file, "function dup() {\n  return 1;\n}\nfunction dup() {\n  return 2;\n}\n");
			const { tool, queue } = manipulateHarness(tmp);
			// Two `dup` functions; the second's name is on line 4 — `line` selects it.
			await tool.execute("m", {
				action: "manipulate",
				path: file,
				name: "dup",
				op: "replace",
				line: 4,
				text: "function dup() {\n  return 22;\n}",
			});
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({ action: "apply", reason: "apply" })) as InvokedToolResult;
			expect(applied.isError).toBeUndefined();
			const updated = await fs.readFile(file, "utf8");
			expect(updated).toContain("return 22;");
			expect(updated).toContain("return 1;");
			expect(updated).not.toContain("return 2;");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("refuses to manipulate a symbol nested on a one-line container", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-oneliner-"));
		try {
			const file = path.join(tmp, "o.ts");
			const original = "class C { m() { return 1; } }\n";
			await fs.writeFile(file, original);
			const { tool } = manipulateHarness(tmp);
			// `m` shares its whole line with its ancestor `class C { ... }`; a
			// whole-line edit would clobber the class wrapper, so it is refused.
			await expect(
				tool.execute("m", { action: "manipulate", path: file, name: "m", op: "replace", text: "m() { return 2; }" }),
			).rejects.toThrow(/not isolated on its own line/);
			expect(await fs.readFile(file, "utf8")).toBe(original);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
