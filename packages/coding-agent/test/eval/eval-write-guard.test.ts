import { describe, expect, it } from "bun:test";
import type * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createEvalFsPathGuard,
	createGuardedBunNamespace,
	createGuardedCreateRequire,
	createGuardedFsModule,
	createGuardedRequire,
	guardedImportModuleNamespace,
	wrapBuiltinModuleForGuard,
} from "@oh-my-pi/pi-coding-agent/eval/eval-fs-guard";
import { guardProcessGetBuiltinModule } from "@oh-my-pi/pi-coding-agent/eval/eval-subprocess-guard";
import {
	EVAL_SOURCE_WRITE_BLOCKED_MESSAGE,
	isEvalArtifactWritePath,
} from "@oh-my-pi/pi-coding-agent/eval/eval-write-guard";
import { createHelpers } from "@oh-my-pi/pi-coding-agent/eval/js/shared/helpers";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

describe("eval write guard", () => {
	it("allows local:// writes when blocking project source", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-guard-"));
		const helpers = createHelpers({
			cwd: () => process.cwd(),
			env: new Map(),
			localRoots: () => ({ local: tmp }),
			blockProjectSourceWrites: true,
			emitStatus: () => {},
		});
		const target = path.join(tmp, "note.md");
		await helpers.writeFile("local://note.md", "ok");
		expect(fs.readFileSync(target, "utf8")).toBe("ok");
	});

	it("append to resolved local path when blocking project source", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-guard-"));
		const helpers = createHelpers({
			cwd: () => process.cwd(),
			env: new Map(),
			localRoots: () => ({ local: tmp }),
			blockProjectSourceWrites: true,
			emitStatus: () => {},
		});
		const written = await helpers.writeFile("local://note.md", "a");
		await helpers.append(written, "b");
		expect(fs.readFileSync(path.join(tmp, "note.md"), "utf8")).toBe("ab");
	});

	it("blocks plain-path write when blockProjectSourceWrites is set", async () => {
		const helpers = createHelpers({
			cwd: () => process.cwd(),
			env: new Map(),
			localRoots: () => ({}),
			blockProjectSourceWrites: true,
			emitStatus: () => {},
		});
		await expect(helpers.writeFile("src/foo.ts", "x")).rejects.toThrow(ToolError);
		await expect(helpers.append("src/foo.ts", "x")).rejects.toThrow(EVAL_SOURCE_WRITE_BLOCKED_MESSAGE);
	});

	it("allows plain-path write when guard is off", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-guard-"));
		const helpers = createHelpers({
			cwd: () => tmp,
			env: new Map(),
			localRoots: () => ({}),
			blockProjectSourceWrites: false,
			emitStatus: () => {},
		});
		await helpers.writeFile("a.txt", "z");
		expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf8")).toBe("z");
	});

	it("classifies local:// as artifact path", () => {
		expect(isEvalArtifactWritePath("local://x.md", { local: "/tmp" })).toBe(true);
		expect(isEvalArtifactWritePath("src/x.ts", { local: "/tmp" })).toBe(false);
	});

	it("blocks fs.writeFileSync when guard is on", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-fs-guard-"));
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard);
		const target = path.join(tmp, "blocked.ts");
		expect(() => gfs.writeFileSync(target, "x")).toThrow(ToolError);
	});
	it("blocks createRequire('fs') when guard is on", () => {
		const { createRequire: nodeCreateRequire } = require("node:module") as typeof import("node:module");
		const guard = createEvalFsPathGuard(true, {});
		const wrapped = createGuardedCreateRequire(nodeCreateRequire, guard, fs);
		const req = wrapped(import.meta.url);
		const gfs = req("fs") as ReturnType<typeof createGuardedFsModule>;
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-req-guard-"));
		const target = path.join(tmp, "blocked.ts");
		expect(() => gfs.writeFileSync(target, "x")).toThrow(ToolError);
	});

	it("blocks require('fs') via createGuardedRequire", () => {
		const { createRequire: nodeCreateRequire } = require("node:module") as typeof import("node:module");
		const guard = createEvalFsPathGuard(true, {});
		const base = nodeCreateRequire(import.meta.url);
		const req = createGuardedRequire(base, guard, fs);
		const gfs = req("node:fs") as ReturnType<typeof createGuardedFsModule>;
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-req-guard-"));
		expect(() => gfs.writeFileSync(path.join(tmp, "x.ts"), "x")).toThrow(ToolError);
	});
	it("guarded fs module default export is guarded", () => {
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard) as typeof fs & { default: typeof fs };
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-fs-default-"));
		const target = path.join(tmp, "blocked.ts");
		expect(() => gfs.default.writeFileSync(target, "x")).toThrow(ToolError);
	});

	it("guardedImportModuleNamespace default export blocks writes", async () => {
		const guard = createEvalFsPathGuard(true, {});
		const ns = (await guardedImportModuleNamespace(
			"node:fs",
			guard,
			fs,
			async target => await import(target),
		)) as typeof fs & { default: typeof fs };
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-import-default-"));
		const target = path.join(tmp, "blocked.ts");
		expect(() => ns.default.writeFileSync(target, "x")).toThrow(ToolError);
	});

	it("blocks openSync in write mode on project paths", () => {
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard);
		const target = path.join(process.cwd(), "src", "__eval_guard_open_sync_probe__.ts");
		expect(() => gfs.openSync(target, "w")).toThrow(ToolError);
	});

	it("blocks writeSync on unregistered fd when guard is on", () => {
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard);
		expect(() => gfs.writeSync(999_999, Buffer.from("x"))).toThrow(ToolError);
	});

	it("allows writeSync to stdio fd when guard is on", () => {
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard);
		expect(() => gfs.writeSync(1, Buffer.from("ok"))).not.toThrow();
	});

	it("allows writeFileSync to guarded open fd under local root", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-guard-"));
		const guard = createEvalFsPathGuard(true, { local: tmp });
		const gfs = createGuardedFsModule(fs, guard);
		const target = path.join(tmp, "out.txt");
		const fd = gfs.openSync(target, "w");
		gfs.writeFileSync(fd, "ok");
		gfs.closeSync(fd);
		expect(fs.readFileSync(target, "utf8")).toBe("ok");
	});

	it("allows writeSync after callback fs.open under local root", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-guard-"));
		const guard = createEvalFsPathGuard(true, { local: tmp });
		const gfs = createGuardedFsModule(fs, guard);
		const target = path.join(tmp, "cb.txt");
		await new Promise<void>((resolve, reject) => {
			gfs.open(target, "w", (err, fd) => {
				if (err) {
					reject(err);
					return;
				}
				try {
					gfs.writeSync(fd!, Buffer.from("cb"));
					gfs.closeSync(fd!);
					resolve();
				} catch (e) {
					reject(e);
				}
			});
		});
		expect(fs.readFileSync(target, "utf8")).toBe("cb");
	});

	it("blocks fs.writeFileSync with Buffer path", () => {
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard);
		const target = path.join(process.cwd(), "src", "__eval_guard_buf__.ts");
		expect(() => gfs.writeFileSync(Buffer.from(target), "x")).toThrow(ToolError);
	});

	it("blocks openSync with rs+ on project paths", () => {
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard);
		const target = path.join(process.cwd(), "src", "__eval_guard_rsp__.ts");
		expect(() => gfs.openSync(target, "rs+")).toThrow(ToolError);
	});

	it("guardedImportModuleNamespace sets promises default", async () => {
		const guard = createEvalFsPathGuard(true, {});
		const ns = (await guardedImportModuleNamespace(
			"node:fs/promises",
			guard,
			fs,
			async target => await import(target),
		)) as { default?: { readFile?: unknown } };
		expect(ns.default).toBeDefined();
		expect(typeof ns.default?.readFile).toBe("function");
	});
	it("blocks fs.writeFile callback API when guard is on", () => {
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard);
		const target = path.join(process.cwd(), "src", "__eval_guard_writefile_cb__.ts");
		expect(() => gfs.writeFile(target, "x", () => {})).toThrow(ToolError);
	});

	it("createGuardedBunNamespace allows Bun.file read on project paths", () => {
		if (typeof globalThis.Bun === "undefined") return;
		const guard = createEvalFsPathGuard(true, { local: os.tmpdir() });
		const proxy = createGuardedBunNamespace(guard) as typeof Bun;
		expect(proxy).toBeDefined();
		const f = proxy.file(path.join(process.cwd(), "package.json"));
		expect(f.size).toBeGreaterThan(0);
	});

	it("createGuardedBunNamespace blocks Bun.file writer on project paths", () => {
		if (typeof globalThis.Bun === "undefined") return;
		const guard = createEvalFsPathGuard(true, { local: os.tmpdir() });
		const proxy = createGuardedBunNamespace(guard) as typeof Bun;
		const target = path.join(process.cwd(), "src", "__eval_guard_bun_file_writer__.ts");
		const f = proxy.file(target);
		expect(() => f.writer()).toThrow(ToolError);
	});

	it("createGuardedBunNamespace blocks Bun.write on project paths", async () => {
		if (typeof globalThis.Bun === "undefined") return;
		const { createGuardedBunNamespace } = await import("@oh-my-pi/pi-coding-agent/eval/eval-fs-guard");
		const guard = createEvalFsPathGuard(true, {});
		const bun = createGuardedBunNamespace(guard) as { write: (d: unknown, d2: unknown) => Promise<unknown> };
		const target = path.join(process.cwd(), "src", "__eval_guard_bun_write__.ts");
		await expect(bun.write(target, "x")).rejects.toThrow(ToolError);
	});
	it("allows writes under eval localRoots filesystem paths", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-local-root-"));
		const guard = createEvalFsPathGuard(true, { local: tmp });
		const gfs = createGuardedFsModule(fs, guard);
		const target = path.join(tmp, "artifact.txt");
		gfs.writeFileSync(target, "ok");
		expect(fs.readFileSync(target, "utf8")).toBe("ok");
	});

	it("blocks fs.cpSync to project destination", () => {
		if (typeof fs.cpSync !== "function") return;
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard);
		const src = path.join(os.tmpdir(), `omp-eval-cp-src-${process.pid}.txt`);
		const dest = path.join(process.cwd(), "src", "__eval_guard_cp__.ts");
		fs.writeFileSync(src, "payload");
		try {
			expect(() => gfs.cpSync(src, dest)).toThrow(ToolError);
		} finally {
			try {
				fs.unlinkSync(src);
			} catch {
				/* ignore */
			}
		}
	});

	it("blocks openSync with O_TRUNC on project paths", () => {
		const guard = createEvalFsPathGuard(true, {});
		const gfs = createGuardedFsModule(fs, guard);
		const target = path.join(process.cwd(), "src", "__eval_guard_otrunc__.ts");
		expect(() => gfs.openSync(target, fs.constants.O_TRUNC)).toThrow(ToolError);
	});
	it("blocks child_process execFileSync when guard is on", () => {
		const { createRequire: nodeCreateRequire } = require("node:module") as typeof import("node:module");
		const guard = createEvalFsPathGuard(true, {});
		const req = createGuardedRequire(nodeCreateRequire(import.meta.url), guard, fs);
		const cp = req("node:child_process") as typeof childProcess;
		expect(() => cp.execFileSync("echo", ["hi"])).toThrow(ToolError);
	});
	it("guards process.getBuiltinModule fs when available", () => {
		const proc = globalThis.process as NodeJS.Process & {
			getBuiltinModule?: (id: string) => unknown;
		};
		if (typeof proc.getBuiltinModule !== "function") return;
		const guard = createEvalFsPathGuard(true, {});
		const wrapped = guardProcessGetBuiltinModule(proc, true, (specifier, mod) =>
			wrapBuiltinModuleForGuard(specifier, mod, guard, fs),
		);
		const gfs = wrapped.getBuiltinModule!("node:fs") as ReturnType<typeof createGuardedFsModule>;
		const target = path.join(process.cwd(), "src", "__eval_guard_builtin__.ts");
		expect(() => gfs.writeFileSync(target, "x")).toThrow(ToolError);
	});
	it("allows FileHandle writeFile under localRoots after guarded open", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-fh-"));
		const guard = createEvalFsPathGuard(true, { local: tmp });
		const gfs = createGuardedFsModule(fs, guard);
		const file = path.join(tmp, "out.txt");
		const fh = await gfs.promises.open(file, "w");
		await fh.writeFile("ok");
		await fh.close();
		expect(fs.readFileSync(file, "utf8")).toBe("ok");
	});
	it("blocks renameSync from project source even when dest is local root", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-rename-"));
		const guard = createEvalFsPathGuard(true, { local: tmp });
		const gfs = createGuardedFsModule(fs, guard);
		const src = path.join(process.cwd(), "src", "__eval_guard_rename_src__.ts");
		const dest = path.join(tmp, "moved.ts");
		fs.writeFileSync(src, "x");
		try {
			expect(() => gfs.renameSync(src, dest)).toThrow(ToolError);
		} finally {
			try {
				fs.unlinkSync(src);
			} catch {
				/* ignore */
			}
		}
	});

	it("guardedImportModuleNamespace wraps node:module createRequire", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-guard-"));
		const guard = createEvalFsPathGuard(true, { local: tmp });
		const mod = (await guardedImportModuleNamespace("node:module", guard, fs, target => import(target))) as {
			createRequire: typeof createGuardedCreateRequire extends (a: infer A) => unknown ? A : never;
		};
		const cr = (mod as { createRequire: ReturnType<typeof createGuardedCreateRequire> }).createRequire(
			import.meta.url,
		);
		const gfs = cr("fs") as typeof fs;
		expect(() => gfs.writeFileSync(path.join(process.cwd(), "package.json"), "x")).toThrow(
			EVAL_SOURCE_WRITE_BLOCKED_MESSAGE,
		);
	});

	it("blocks symlinkSync from project source into local root", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-eval-guard-"));
		const src = path.join(process.cwd(), "package.json");
		const dest = path.join(tmp, "alias.json");
		const guard = createEvalFsPathGuard(true, { local: tmp });
		const gfs = createGuardedFsModule(fs, guard);
		expect(() => gfs.symlinkSync(src, dest)).toThrow(EVAL_SOURCE_WRITE_BLOCKED_MESSAGE);
	});
});
