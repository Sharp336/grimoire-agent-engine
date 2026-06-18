import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, type ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { SymbolTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

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
		[
			"struct Point { x: u32 }",
			"impl Point {",
			"    fn norm(&self) -> u32 { self.x }",
			"}",
			"fn helper() {}",
			"",
		].join("\n"),
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
				[
					"type Person {",
					"  id: ID!",
					"  name: String!",
					"}",
					"",
					"enum Status {",
					"  ACTIVE",
					"  INACTIVE",
					"}",
					"",
				].join("\n"),
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
				// biome-ignore lint/suspicious/noTemplateCurlyInString: replacement payload intentionally contains a template placeholder.
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
			// biome-ignore lint/suspicious/noTemplateCurlyInString: assertion checks the literal replacement payload.
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
			await expect(
				tool.execute("m", { action: "manipulate", path: file, name: "dup", op: "delete" }),
			).rejects.toThrow(/matches 2 symbols/);
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

	it("rejects delimited multi-target name-mode paths even when one target is missing", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-delim-"));
		try {
			const file = path.join(tmp, "one.ts");
			const missing = path.join(tmp, "missing.ts");
			const original = "function one() {}\n";
			await fs.writeFile(file, original);
			const { tool } = manipulateHarness(tmp);
			await expect(
				tool.execute("m", {
					action: "manipulate",
					path: `${file},${missing}`,
					name: "one",
					op: "delete",
				}),
			).rejects.toThrow(/single existing target file/);
			expect(await fs.readFile(file, "utf8")).toBe(original);
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
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "stale",
			})) as InvokedToolResult;
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
			await expect(tool.execute("m", { action: "manipulate", path: file, name: "a", op: "delete" })).rejects.toThrow(
				/shares a line/,
			);
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
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "apply",
			})) as InvokedToolResult;
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
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "apply",
			})) as InvokedToolResult;
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
				tool.execute("m", {
					action: "manipulate",
					path: file,
					name: "m",
					op: "replace",
					text: "m() { return 2; }",
				}),
			).rejects.toThrow(/not isolated on its own line/);
			expect(await fs.readFile(file, "utf8")).toBe(original);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

describe("symbol lang override on a non-auto-detected file (FIX 1)", () => {
	// A `.txt` file is not an outline-supported extension, so without an
	// explicit `lang` it is rejected at the path-extension gate. With a
	// supported `lang`, the file reaches `outlineCode` which honors `lang`
	// over path inference.
	it("outlines a .txt file as rust with an explicit lang", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-lang-ovr-"));
		try {
			const file = path.join(tmp, "code.txt");
			await fs.writeFile(
				file,
				[
					"struct Point { x: u32 }",
					"impl Point {",
					"    fn norm(&self) -> u32 { self.x }",
					"}",
					"fn helper() {}",
					"",
				].join("\n"),
			);
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "overview", path: file, lang: "rust" }));
			expect(text).toContain("struct Point");
			expect(text).toContain("method norm");
			expect(text).toContain("function helper");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it('accepts a non-extension alias lang (e.g. "c++") via the native resolver', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-lang-alias-"));
		try {
			const file = path.join(tmp, "code.txt");
			await fs.writeFile(file, ["struct Point { int x; };", "void helper() {}", ""].join("\n"));
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			// `c++` is a from_alias alias but NOT a file extension, so it resolves
			// ONLY through the native predicate — proving the gate uses the
			// authoritative resolver, not a names∪extensions approximation.
			const text = textOf(await tool.execute("t", { action: "overview", path: file, lang: "c++" }));
			expect(text).toContain("Point");
			expect(text).toContain("helper");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("rejects the same .txt file without an explicit lang (unsupported language)", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-lang-nolang-"));
		try {
			const file = path.join(tmp, "code.txt");
			await fs.writeFile(file, "struct Point { x: u32 }\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "overview", path: file }));
			expect(text).toContain("No files in scope.");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("finds a symbol by name on a .txt file with an explicit lang (exact-file find path)", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-lang-find-"));
		try {
			const file = path.join(tmp, "code.txt");
			await fs.writeFile(
				file,
				[
					"struct Point { x: u32 }",
					"impl Point {",
					"    fn norm(&self) -> u32 { self.x }",
					"}",
					"fn helper() {}",
					"",
				].join("\n"),
			);
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "find", name: "helper", path: file, lang: "rust" }));
			expect(text).toContain('Found 1 symbol(s) matching "helper":');
			expect(text).toContain("function helper @ code.txt:5");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("manipulates a symbol on a .txt file with an explicit lang", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-lang-manip-"));
		try {
			const file = path.join(tmp, "code.txt");
			const original = ["function greet() {", "  return 1;", "}", ""].join("\n");
			await fs.writeFile(file, original);
			const { tool, queue } = manipulateHarness(tmp);
			await tool.execute("m", {
				action: "manipulate",
				path: file,
				name: "greet",
				op: "replace",
				lang: "javascript",
				text: "function greet() {\n  return 99;\n}",
			});
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "apply lang override",
			})) as InvokedToolResult;
			expect(applied.isError).toBeUndefined();
			const updated = await fs.readFile(file, "utf8");
			expect(updated).toContain("return 99;");
			expect(updated).not.toContain("return 1;");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("does not broaden the lang override to a multi-path scope", async () => {
		// A multi-path input where neither file's extension auto-resolves must
		// NOT be accepted as rust via the lang override — the bypass is scoped
		// to a SINGLE explicit file only.
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-lang-multipath-"));
		try {
			const a = path.join(tmp, "a.txt");
			const b = path.join(tmp, "b.txt");
			await fs.writeFile(a, "struct A {}\n");
			await fs.writeFile(b, "struct B {}\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "overview", path: [a, b], lang: "rust" }));
			expect(text).toContain("No files in scope.");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("rejects a bogus lang even on a single explicit file", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-lang-bogus-"));
		try {
			const file = path.join(tmp, "code.txt");
			await fs.writeFile(file, "struct Point {}\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "overview", path: file, lang: "not-a-language" }));
			expect(text).toContain("No files in scope.");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

describe("symbol manipulate rejects multi-path input (FIX 2)", () => {
	it("throws when path is a 2-element array, before scope resolution", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-manip-multipath-"));
		try {
			const a = path.join(tmp, "a.ts");
			const missing = path.join(tmp, "missing.ts");
			await fs.writeFile(a, "function keep() {}\n");
			const { tool } = manipulateHarness(tmp);
			await expect(
				tool.execute("m", {
					action: "manipulate",
					path: [a, missing],
					name: "keep",
					op: "delete",
				}),
			).rejects.toThrow(/manipulate requires a single target file/);
			// The existing file is left untouched (no silent collapse to it).
			expect(await fs.readFile(a, "utf8")).toBe("function keep() {}\n");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

describe("symbol manipulate stale-apply identity guard (FIX 3a)", () => {
	it("rejects apply when the symbol was DELETED between preview and apply", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-stale-del-"));
		try {
			const file = path.join(tmp, "s.ts");
			const original = "function keep() {}\nfunction drop() {}\n";
			await fs.writeFile(file, original);
			const { tool, queue } = manipulateHarness(tmp);
			await tool.execute("m", {
				action: "manipulate",
				path: file,
				name: "drop",
				op: "replace",
				text: "function drop() { return 1; }",
			});
			// Delete the symbol entirely between preview and apply — it no
			// longer resolves, so the re-resolve identity guard (not the
			// previewRangeText path) must reject the apply.
			const mutated = "function keep() {}\n";
			await fs.writeFile(file, mutated);
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "stale delete",
			})) as InvokedToolResult;
			expect(applied.isError).toBe(true);
			expect(applied.content.find(c => c.type === "text")?.text ?? "").toMatch(/no longer uniquely resolves/);
			expect(await fs.readFile(file, "utf8")).toBe(mutated);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("rejects apply when the symbol became AMBIGUOUS between preview and apply", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-stale-amb-"));
		try {
			const file = path.join(tmp, "s.ts");
			const original = "function target() {\n  return 1;\n}\n";
			await fs.writeFile(file, original);
			const { tool, queue } = manipulateHarness(tmp);
			await tool.execute("m", {
				action: "manipulate",
				path: file,
				name: "target",
				op: "replace",
				text: "function target() {\n  return 2;\n}",
			});
			// Add a second `target` so the symbol is no longer unique. Same
			// line count for the original, so only the re-resolve guard catches
			// the ambiguity (previewRangeText would still match).
			const mutated = "function target() {\n  return 1;\n}\nfunction target() {\n  return 3;\n}\n";
			await fs.writeFile(file, mutated);
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "stale ambiguous",
			})) as InvokedToolResult;
			expect(applied.isError).toBe(true);
			expect(applied.content.find(c => c.type === "text")?.text ?? "").toMatch(/no longer uniquely resolves/);
			expect(await fs.readFile(file, "utf8")).toBe(mutated);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

describe("symbol empty supported file is not unsupported (FIX 3b)", () => {
	it("overview shows an empty .ts file with zero symbols (not 'unsupported language')", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-empty-"));
		try {
			const file = path.join(tmp, "empty.ts");
			await fs.writeFile(file, "");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "overview", path: file }));
			// The empty supported file is enumerated (not rejected as
			// unsupported) and shows zero symbols.
			expect(text).toContain("empty.ts");
			expect(text).toContain("no symbols");
			expect(text).not.toContain("unsupported language");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("find returns the no-symbols message for an empty supported file", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-empty-find-"));
		try {
			const file = path.join(tmp, "empty.ts");
			await fs.writeFile(file, "");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const text = textOf(await tool.execute("t", { action: "find", name: "anything", path: file }));
			// An empty supported file is in scope (not "unsupported language"),
			// so find reports no symbols found.
			expect(text).toContain("No symbols found.");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

// ── helpers shared by U1/U3/U4 tests ──────────────────────────────────────

function validationTool(): SymbolTool {
	return new SymbolTool({ cwd: dir, settings: Settings.isolated() } as unknown as ToolSession);
}

function validateSymbolArgs(args: Record<string, unknown>): Record<string, unknown> {
	return validateToolArguments(validationTool(), {
		type: "toolCall",
		id: "t",
		name: "symbol",
		arguments: args,
	}) as Record<string, unknown>;
}

function validSelectorForValidation(): string {
	const payload = { a: "sample.ts", p: "sample.ts", n: "f", k: "function", f: "fingerprint", o: 0, l: 1 };
	return `sym:v1:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

/** Extract the first `sym:v1:<…>` selector token from tool output text. */
function extractSelector(text: string): string {
	const match = text.match(/sym:v1:\S+/);
	if (!match) throw new Error(`No selector found in output:\n${text}`);
	return match[0];
}

// ── U1. Validation contract (validateToolArguments) ────────────────────────

describe("symbol validation (U1)", () => {
	it("rejects find without name", () => {
		expect(() => validateSymbolArgs({ action: "find", path: dir })).toThrow(/name/);
	});

	it("rejects name-mode manipulate without path", () => {
		expect(() => validateSymbolArgs({ action: "manipulate", name: "f", op: "delete" })).toThrow(/path/);
	});

	it("rejects name-mode manipulate with empty name", () => {
		expect(() => validateSymbolArgs({ action: "manipulate", path: "/x", name: "", op: "delete" })).toThrow(/name/);
	});

	it("rejects selector combined with path", () => {
		expect(() =>
			validateSymbolArgs({ action: "manipulate", selector: "sym:v1:abc", path: "/x", op: "delete" }),
		).toThrow(/path/);
	});

	it("rejects selector combined with name", () => {
		expect(() =>
			validateSymbolArgs({ action: "manipulate", selector: "sym:v1:abc", name: "f", op: "delete" }),
		).toThrow(/name/);
	});

	it("rejects selector combined with kind, container, or line", () => {
		for (const extra of [{ kind: "function" }, { container: "Point" }, { line: 5 }] as const) {
			expect(() =>
				validateSymbolArgs({ action: "manipulate", selector: "sym:v1:abc", op: "delete", ...extra }),
			).toThrow(/kind.*container.*line|container.*line|kind.*container/);
		}
	});

	it("rejects malformed selector payloads", () => {
		const missingDiagnostics = `sym:v1:${Buffer.from(
			JSON.stringify({ a: "sample.ts", p: "sample.ts", n: "f", k: "function", f: "fingerprint" }),
			"utf8",
		).toString("base64url")}`;
		for (const selector of ["bogus", "sym:v1:", "sym:v1:abc", missingDiagnostics]) {
			expect(() => validateSymbolArgs({ action: "manipulate", selector, op: "delete" })).toThrow(/selector/);
		}
	});

	it("rejects manipulate replace/insert without text", () => {
		expect(() => validateSymbolArgs({ action: "manipulate", path: "/x", name: "f", op: "replace" })).toThrow(/text/);
	});

	it("rejects delete with text, even when empty", () => {
		for (const text of ["nope", ""]) {
			expect(() => validateSymbolArgs({ action: "manipulate", path: "/x", name: "f", op: "delete", text })).toThrow(
				/delete/,
			);
		}
	});

	it("rejects name-mode manipulate with zero or multiple path entries", () => {
		for (const pathArg of [[], ["/x.ts", "/y.ts"]] as const) {
			expect(() => validateSymbolArgs({ action: "manipulate", path: pathArg, name: "f", op: "delete" })).toThrow(
				/exactly one `path`/,
			);
		}
	});

	it("rejects invalid action-scoped fields for overview", () => {
		for (const extra of [
			{ name: "x" },
			{ selector: validSelectorForValidation() },
			{ op: "delete" },
			{ text: "x" },
			{ skip: 1 },
			{ limit: 5 },
		] as const) {
			expect(() => validateSymbolArgs({ action: "overview", ...extra })).toThrow(/overview/);
		}
	});

	it("rejects invalid action-scoped fields for find", () => {
		for (const extra of [{ op: "delete" }, { text: "x" }, { line: 5 }] as const) {
			expect(() => validateSymbolArgs({ action: "find", name: "x", path: dir, ...extra })).toThrow(/find/);
		}
	});

	it("rejects selector for find (action-scoped rejection, not malformed-selector rejection)", () => {
		expect(() => validateSymbolArgs({ action: "find", selector: validSelectorForValidation() })).toThrow(/find/);
	});

	it("accepts find with kind and container filters", () => {
		const args = validateSymbolArgs({ action: "find", name: "norm", path: dir, kind: "method", container: "Point" });
		expect(args.kind).toBe("method");
		expect(args.container).toBe("Point");
	});
});

// ── U3. Selector handoff from actual find/overview output ──────────────────

describe("symbol selector handoff (U3)", () => {
	it("selector-only manipulate decodes source without explicit path", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sel-handoff-"));
		try {
			await fs.writeFile(path.join(tmp, "greet.ts"), "function greet() {\n  return 1;\n}\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const overview = textOf(await tool.execute("t", { action: "overview", path: path.join(tmp, "greet.ts") }));
			const selector = extractSelector(overview);
			const { tool: mTool, queue } = manipulateHarness(tmp);
			await mTool.execute("m", {
				action: "manipulate",
				selector,
				op: "replace",
				text: "function greet() {\n  return 99;\n}",
			});
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "selector handoff",
			})) as InvokedToolResult;
			expect(applied.isError).toBeUndefined();
			expect(await fs.readFile(path.join(tmp, "greet.ts"), "utf8")).toContain("return 99;");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("selector-only manipulate preserves explicit lang context and rejects contradictory lang", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sel-lang-"));
		try {
			const file = path.join(tmp, "code.txt");
			await fs.writeFile(file, "fn helper() -> u32 {\n    1\n}\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const found = textOf(await tool.execute("t", { action: "find", name: "helper", path: file, lang: "rust" }));
			const selector = extractSelector(found);
			const { tool: mTool, queue } = manipulateHarness(tmp);
			await expect(
				mTool.execute("bad-lang", { action: "manipulate", selector, op: "delete", lang: "javascript" }),
			).rejects.toThrow(/contradicts explicit `lang`/);
			await mTool.execute("m", {
				action: "manipulate",
				selector,
				op: "replace",
				text: "fn helper() -> u32 {\n    2\n}\n",
			});
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "selector lang",
			})) as InvokedToolResult;
			expect(applied.isError).toBeUndefined();
			expect(await fs.readFile(file, "utf8")).toContain("2");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("selector mode rejects stale fingerprint before preview", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sel-stale-"));
		try {
			await fs.writeFile(path.join(tmp, "f.ts"), "function target() {\n  return 1;\n}\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const result = textOf(await tool.execute("t", { action: "find", name: "target", path: tmp }));
			const selector = extractSelector(result);
			await fs.writeFile(path.join(tmp, "f.ts"), "function target() {\n  return 999;\n}\n");
			const { tool: mTool } = manipulateHarness(tmp);
			await expect(mTool.execute("m", { action: "manipulate", selector, op: "delete" })).rejects.toThrow(
				/did not match any current symbol/,
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("selector mode rejects missing symbol before preview", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sel-missing-"));
		try {
			await fs.writeFile(path.join(tmp, "f.ts"), "function target() {\n  return 1;\n}\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const result = textOf(await tool.execute("t", { action: "find", name: "target", path: tmp }));
			const selector = extractSelector(result);
			await fs.writeFile(path.join(tmp, "f.ts"), "function other() {\n  return 1;\n}\n");
			const { tool: mTool } = manipulateHarness(tmp);
			await expect(mTool.execute("m", { action: "manipulate", selector, op: "delete" })).rejects.toThrow(
				/did not match any current symbol/,
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("selector mode rejects ambiguous byte-identical candidates before preview", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sel-amb-"));
		try {
			await fs.writeFile(path.join(tmp, "f.ts"), "function dup() {\n  return 1;\n}\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const result = textOf(await tool.execute("t", { action: "find", name: "dup", path: tmp }));
			const selector = extractSelector(result);
			await fs.writeFile(
				path.join(tmp, "f.ts"),
				"function dup() {\n  return 1;\n}\nfunction dup() {\n  return 1;\n}\n",
			);
			const { tool: mTool } = manipulateHarness(tmp);
			await expect(mTool.execute("m", { action: "manipulate", selector, op: "delete" })).rejects.toThrow(
				/ambiguous/,
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("pure line drift still works when structural fields and fingerprint remain unique", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sel-drift-"));
		try {
			await fs.writeFile(path.join(tmp, "f.ts"), "function stable() {\n  return 1;\n}\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const result = textOf(await tool.execute("t", { action: "find", name: "stable", path: tmp }));
			const selector = extractSelector(result);
			await fs.writeFile(path.join(tmp, "f.ts"), "// inserted above\nfunction stable() {\n  return 1;\n}\n");
			const { tool: mTool, queue } = manipulateHarness(tmp);
			await mTool.execute("m", {
				action: "manipulate",
				selector,
				op: "replace",
				text: "function stable() {\n  return 2;\n}",
			});
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "line drift",
			})) as InvokedToolResult;
			expect(applied.isError).toBeUndefined();
			expect(await fs.readFile(path.join(tmp, "f.ts"), "utf8")).toContain("return 2;");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("selector never uses selectionLine as the target key", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sel-noline-"));
		try {
			await fs.writeFile(path.join(tmp, "f.ts"), "function target() {\n  return 1;\n}\n");
			const tool = new SymbolTool({ cwd: tmp, settings: Settings.isolated() } as unknown as ToolSession);
			const overview = textOf(await tool.execute("t", { action: "overview", path: path.join(tmp, "f.ts") }));
			const selector = extractSelector(overview);
			const lineMatch = overview.match(/:(\d+)/);
			const originalLine = lineMatch ? Number(lineMatch[1]) : 0;
			await fs.writeFile(
				path.join(tmp, "f.ts"),
				"// line 1\n// line 2\n// line 3\nfunction target() {\n  return 1;\n}\n",
			);
			const { tool: mTool, queue } = manipulateHarness(tmp);
			await mTool.execute("m", {
				action: "manipulate",
				selector,
				op: "replace",
				text: "function target() {\n  return 2;\n}",
			});
			queue.nextToolChoice();
			const applied = (await queue.peekInFlightInvoker()!({
				action: "apply",
				reason: "line shift",
			})) as InvokedToolResult;
			expect(applied.isError).toBeUndefined();
			const updated = await fs.readFile(path.join(tmp, "f.ts"), "utf8");
			expect(updated).toContain("return 2;");
			// The symbol moved down by 3 lines; the selector resolved by
			// structural fields + fingerprint, NOT by the emitted line number.
			expect(updated).toContain("// line 3");
			if (originalLine > 0) {
				const newLine = updated.split("\n").findIndex(l => l.includes("function target()")) + 1;
				expect(newLine).toBeGreaterThan(originalLine);
			}
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

// ── U4. Find kind/container filters ───────────────────────────────────────

describe("symbol find kind/container filters (U4)", () => {
	it("kind=function excludes class or method with the same name", async () => {
		const result = await symbolTool().execute("t", {
			action: "find",
			name: "norm",
			path: dir,
			kind: "function",
		});
		expect(textOf(result)).toContain("No symbols found.");
	});

	it("kind=method matches a Rust impl method via resolved container", async () => {
		const result = await symbolTool().execute("t", {
			action: "find",
			name: "norm",
			path: dir,
			kind: "method",
		});
		const text = textOf(result);
		expect(text).toContain("method norm (Point)");
	});

	it("container=Point matches a Rust impl method via resolved container semantics", async () => {
		const result = await symbolTool().execute("t", {
			action: "find",
			name: "norm",
			path: dir,
			container: "Point",
		});
		expect(textOf(result)).toContain("method norm (Point)");
	});

	it("both kind and container required together", async () => {
		const result = await symbolTool().execute("t", {
			action: "find",
			name: "norm",
			path: dir,
			kind: "method",
			container: "Point",
		});
		const text = textOf(result);
		expect(text).toContain('Found 1 symbol(s) matching "norm":');
		expect(text).toContain("method norm (Point)");
	});

	it("wrong filter returns No symbols found", async () => {
		const result = await symbolTool().execute("t", {
			action: "find",
			name: "norm",
			path: dir,
			kind: "function",
		});
		expect(textOf(result)).toContain("No symbols found.");
	});

	it("substring fallback still works after filters", async () => {
		const result = await symbolTool().execute("t", {
			action: "find",
			name: "shapel",
			path: dir,
			kind: "function",
		});
		expect(textOf(result)).toContain("Shapeless");
	});
});

// ── AE7. Selector provenance bypass guard ──────────────────────────────────

describe("selector provenance — internal URL not downgraded to filesystem path (AE7)", () => {
	let ae7Tmp: string;
	let ae7DirTmp: string;

	beforeAll(async () => {
		// Single-file-backed immutable source
		ae7Tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ae7-prov-"));
		await fs.writeFile(
			path.join(ae7Tmp, "target.ts"),
			"export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n",
		);

		// Directory-backed immutable source (tests descendant suppression)
		ae7DirTmp = await fs.mkdtemp(path.join(os.tmpdir(), "ae7-dir-"));
		await fs.mkdir(path.join(ae7DirTmp, "sub"));
		await fs.writeFile(path.join(ae7DirTmp, "sub", "child.ts"), "export function childFn() {\n  return 42;\n}\n");
	});

	afterAll(async () => {
		await fs.rm(ae7Tmp, { recursive: true, force: true });
		await fs.rm(ae7DirTmp, { recursive: true, force: true });
	});

	/** Register a test handler that resolves ae7test:// to a specific file. */
	function registerImmutableFileHandler(filePath: string): void {
		const handler: ProtocolHandler = {
			scheme: "ae7test",
			immutable: true,
			async resolve(url) {
				const content = await Bun.file(filePath).text();
				return {
					url: url.href,
					content,
					contentType: "text/plain",
					sourcePath: filePath,
				};
			},
		};
		InternalUrlRouter.instance().register(handler);
	}

	/** Register a test handler that resolves ae7dir:// to a directory. */
	function registerImmutableDirHandler(dirPath: string): void {
		const handler: ProtocolHandler = {
			scheme: "ae7dir",
			immutable: true,
			async resolve(url) {
				// Return directory listing content; sourcePath points to the dir root.
				const entries = await fs.readdir(dirPath, { recursive: true });
				return {
					url: url.href,
					content: entries.join("\n"),
					contentType: "text/plain",
					sourcePath: dirPath,
				};
			},
		};
		InternalUrlRouter.instance().register(handler);
	}

	afterEach(() => {
		InternalUrlRouter.resetForTests();
	});

	it("selector from immutable single-file source carries internal URL, not filesystem path", async () => {
		const targetFile = path.join(ae7Tmp, "target.ts");
		registerImmutableFileHandler(targetFile);

		const tool = new SymbolTool({
			cwd: ae7Tmp,
			settings: Settings.isolated(),
		} as unknown as ToolSession);

		// overview via internal URL
		const overview = textOf(await tool.execute("t", { action: "overview", path: "ae7test://immutable" }));
		expect(overview).toContain("alpha");
		expect(overview).toContain("beta");

		// Extract a selector and verify it contains the internal URL, not the
		// filesystem path.  Decoding the base64url payload is the ground truth.
		const selector = extractSelector(overview);
		const b64 = selector.replace(/^sym:v1:/, "");
		const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
		expect(payload.a).toBe("ae7test://immutable");

		// The selector is valid and the symbol tool can decode it for manipulate.
		// The key assertion: when the selector's `a` is an internal URL, manipulate
		// re-resolves through the internal URL router, which enforces immutability.
		// With the OLD behavior, `a` would be the filesystem path and manipulate
		// would succeed — bypassing the immutable-source guard entirely.
		const { tool: mTool } = manipulateHarness(ae7Tmp);
		await expect(
			mTool.execute("m", {
				action: "manipulate",
				selector,
				op: "replace",
				text: "export function alpha() {\n  return 99;\n}\n",
			}),
		).rejects.toThrow(/read-only/);
	});

	it("selector from directory-backed internal source is suppressed (non-copyable marker)", async () => {
		registerImmutableDirHandler(ae7DirTmp);

		const tool = new SymbolTool({
			cwd: ae7DirTmp,
			settings: Settings.isolated(),
		} as unknown as ToolSession);

		// overview via directory-backed internal URL
		const overview = textOf(await tool.execute("t", { action: "overview", path: "ae7dir://scoped" }));
		expect(overview).toContain("childFn");

		// The child file is a descendant of the internal-URL-backed directory.
		// Its selector must be suppressed with the non-copyable marker, NOT a
		// valid sym:v1:… selector that would downgrade provenance to a filesystem path.
		expect(overview).toContain("selector=internal");
		expect(overview).not.toMatch(/child\.ts.*selector=sym:v1:/);
	});
});
