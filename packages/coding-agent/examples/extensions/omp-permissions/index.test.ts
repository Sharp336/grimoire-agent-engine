import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ompPermissions, {
	buildLogRecord,
	checkConfigProtection,
	classifyTool,
	DoomTracker,
	decide,
	decideBash,
	decideTargets,
	decomposeCommand,
	isEnabled,
	matchRule,
	mergeConfigs,
	type NormalizedConfig,
	normalizeCommand,
	type Outcome,
	parseConfig,
	resolveAction,
	resolveOutcome,
	type SessionIdentity,
	splitOnOperators,
} from "./index.ts";

const cfg = (obj: unknown): NormalizedConfig => parseConfig(JSON.stringify(obj));

describe("bash decomposition", () => {
	it("splits compound commands", () => {
		expect(decomposeCommand("git status && rm -rf /")).toEqual(["git status", "rm -rf /"]);
		expect(decomposeCommand("echo hi | grep h ; ls")).toEqual(["echo hi", "grep h", "ls"]);
	});
	it("does not split inside quotes", () => {
		expect(splitOnOperators('echo "a && b"')).toEqual(['echo "a && b"']);
	});
	it("extracts subshells and drops the standalone assignment", () => {
		expect(decomposeCommand("result=$(rm -rf x)")).toEqual(["rm -rf x"]);
	});
	it("strips heredoc bodies", () => {
		expect(decomposeCommand("cat <<EOF\nrm -rf /\nEOF")).toEqual(["cat"]);
	});
	it("strips env assignments and redirections", () => {
		expect(normalizeCommand("FOO=bar npm run build > out.log")).toBe("npm run build");
	});
});

describe("glob matching", () => {
	it("matches prefix rules and the bare prefix", () => {
		expect(matchRule("git status", "git *")).toBe(true);
		expect(matchRule("git", "git *")).toBe(true);
		expect(matchRule("github", "git *")).toBe(false);
	});
	it("resolves last-match-wins", () => {
		const rules = { "*": "deny", "git *": "allow" } as const;
		expect(resolveAction("git status", rules)).toBe("allow");
		expect(resolveAction("npm i", rules)).toBe("deny");
	});
	it("combines bash sub-commands with deny-first", () => {
		expect(decideBash("git status && rm x", { "*": "allow", "rm *": "deny" }).action).toBe("deny");
		expect(decideTargets(["a.ts"], { "*": "allow" }).action).toBe("allow");
	});
});

describe("tool classification (omp + serena)", () => {
	it("maps omp built-ins to categories", () => {
		expect(classifyTool("bash", { command: "ls" })?.category).toBe("bash");
		expect(classifyTool("write", { path: "a.ts" })?.category).toBe("edit");
		expect(classifyTool("find", { paths: ["src/**"] })?.category).toBe("glob");
		expect(classifyTool("search", { pattern: "foo" })?.category).toBe("grep");
	});
	it("maps serena tools", () => {
		expect(classifyTool("mcp__serena_execute_shell_command", { command: "rm x" })).toMatchObject({
			category: "bash",
			isShell: true,
		});
		expect(classifyTool("mcp__serena_create_text_file", { relative_path: "a.ts" })).toMatchObject({
			category: "edit",
			pathLike: true,
		});
		expect(classifyTool("mcp__serena_read_file", { relative_path: "a.ts" })?.category).toBe("read");
	});
	it("treats URL reads as webfetch", () => {
		const c = classifyTool("read", { path: "https://example.com/x" });
		expect(c?.category).toBe("webfetch");
		expect(c?.pathLike).toBe(false);
	});
	it("returns null for unknown tools", () => {
		expect(classifyTool("some_unknown_tool", {})).toBeNull();
	});
});

describe("decision pipeline", () => {
	it("denies a bash sub-command via the bash category", () => {
		const c = cfg({ permission: { bash: { "*": "allow", "rm *": "deny" } } });
		expect(decide("bash", { command: "echo ok && rm -rf /" }, "/work", c).action).toBe("deny");
	});
	it("applies edit rules to write/serena-edit paths", () => {
		const c = cfg({ permission: { edit: { "*": "allow", "*.env": "deny" } } });
		expect(decide("write", { path: "src/app.ts" }, "/work", c).action).toBe("allow");
		expect(decide("mcp__serena_create_text_file", { relative_path: ".env" }, "/work", c).action).toBe("deny");
	});
	it("routes URL reads through webfetch", () => {
		const c = cfg({ permission: { read: { "*": "deny" }, webfetch: { "*": "ask" } } });
		expect(decide("read", { path: "https://x.test" }, "/work", c).action).toBe("ask");
	});
	it("gates out-of-cwd paths via external_directory", () => {
		const c = cfg({ permission: { external_directory: { "*": "deny" } } });
		expect(decide("read", { path: "/etc/passwd" }, "/work", c).action).toBe("deny");
		expect(decide("read", { path: "inside.ts" }, "/work", c).action).toBeNull();
	});
	it("honors global default and string categories", () => {
		expect(decide("read", { path: "a.ts" }, "/work", cfg({ permission: { "*": "ask" } })).action).toBe("ask");
		expect(decide("write", { path: "a.ts" }, "/work", cfg({ permission: { edit: "deny" } })).action).toBe("deny");
	});
});

describe("resolveOutcome", () => {
	it("maps deny/allow/passthrough", async () => {
		expect((await resolveOutcome("deny", "r", "bash", undefined)).permission).toBe("blocked");
		expect((await resolveOutcome("allow", "r", "bash", undefined)).permission).toBe("allowed");
		expect((await resolveOutcome(null, "r", "bash", undefined)).block).toBe(false);
	});
	it("fails closed on ask without a UI", async () => {
		const o = await resolveOutcome("ask", "r", "bash", { hasUI: false });
		expect(o.block).toBe(true);
		expect(o.permission).toBe("blocked");
	});
	it("asks and honors the confirmation result", async () => {
		const yes = await resolveOutcome("ask", "r", "bash", { hasUI: true, ui: { confirm: async () => true } });
		expect(yes).toMatchObject({ permission: "asked", block: false, confirmed: true });
		const no = await resolveOutcome("ask", "r", "bash", { hasUI: true, ui: { confirm: async () => false } });
		expect(no).toMatchObject({ permission: "asked", block: true, confirmed: false });
	});
});

describe("configurable self-protection", () => {
	const work = "/work";

	it("always flags the config file for protection (edit / write / serena / bash)", () => {
		const c = cfg({ enabled: false, protect: { enabled: false } });
		expect(
			checkConfigProtection("edit", { input: "¶.omp/omp-permissions.json#0A3B\ndelete 1" }, work, c),
		).not.toBeNull();
		expect(checkConfigProtection("write", { path: "omp-permissions.json" }, work, c)).not.toBeNull();
		expect(
			checkConfigProtection("mcp__serena_replace_content", { relative_path: "omp-permissions.json" }, work, c),
		).not.toBeNull();
		expect(
			checkConfigProtection("bash", { command: "truncate -s0 ~/.omp/agent/omp-permissions.json" }, work, c),
		).not.toBeNull();
	});

	it("flags configured protect.paths globs for edit tools", () => {
		const c = cfg({ protect: { paths: ["**/.env", "~/.ssh/**"] } });
		expect(checkConfigProtection("write", { path: "app/.env" }, work, c)).not.toBeNull();
		expect(checkConfigProtection("write", { path: "app/main.ts" }, work, c)).toBeNull();
	});

	it("respects protect.enabled:false for extra paths but keeps the config file", () => {
		const c = cfg({ protect: { enabled: false, paths: ["**/.env"] } });
		expect(checkConfigProtection("write", { path: "app/.env" }, work, c)).toBeNull();
		expect(checkConfigProtection("write", { path: "omp-permissions.json" }, work, c)).not.toBeNull();
	});

	it("does not flag reads of the config", () => {
		expect(checkConfigProtection("read", { path: "omp-permissions.json" }, work, cfg({}))).toBeNull();
	});
});

describe("doom-loop tracker", () => {
	it("trips on the third identical call and resets on change", () => {
		const d = new DoomTracker();
		expect(d.tripped("bash", { command: "x" })).toBe(false);
		expect(d.tripped("bash", { command: "x" })).toBe(false);
		expect(d.tripped("bash", { command: "x" })).toBe(true);
		expect(d.tripped("bash", { command: "y" })).toBe(false);
	});
});

describe("logging record", () => {
	it("captures time, identity, tool, and decision", () => {
		const id: SessionIdentity = { pid: 42, session: "sess-1", sessionName: "demo", cwd: "/w" };
		const outcome: Outcome = { permission: "blocked", block: true, reason: "nope" };
		const rec = buildLogRecord(id, "bash", "bash", outcome);
		expect(typeof rec.ts).toBe("string");
		expect(rec.pid).toBe(42);
		expect(rec.session).toBe("sess-1");
		expect(rec.tool).toBe("bash");
		expect(rec.permission).toBe("blocked");
		expect(rec.blocked).toBe(true);
	});
});

describe("config parsing and merging", () => {
	it("parses enabled, global default, string categories", () => {
		expect(isEnabled(cfg({}))).toBe(true);
		expect(cfg({ permission: "allow" }).globalDefault).toBe("allow");
		expect(cfg({ permission: { edit: "deny" } }).categories.edit).toEqual({ "*": "deny" });
	});
	it("parses protect.action (default undefined -> ask at use)", () => {
		expect(cfg({}).protect.action).toBeUndefined();
		expect(cfg({ protect: { action: "deny" } }).protect.action).toBe("deny");
		expect(cfg({ protect: { action: "bogus" } }).protect.action).toBeUndefined();
	});
	it("parses the log flag (boolean or object)", () => {
		expect(cfg({ log: true }).log).toEqual({ enabled: true, path: undefined });
		expect(cfg({ log: { enabled: true, path: "/tmp/x.log" } }).log).toEqual({
			enabled: true,
			path: "/tmp/x.log",
		});
		expect(cfg({}).log).toEqual({ enabled: undefined, path: undefined });
	});
	it("merges later layers, including log and protect.action", () => {
		const merged = mergeConfigs(
			cfg({
				permission: { bash: { "*": "allow" } },
				protect: { action: "ask", paths: ["a"] },
				log: { enabled: true },
			}),
			cfg({
				permission: { bash: { "rm *": "deny" } },
				protect: { action: "deny", paths: ["b"] },
				log: { path: "/p" },
			}),
		);
		expect(merged.categories.bash).toEqual({ "*": "allow", "rm *": "deny" });
		expect(merged.protect.action).toBe("deny");
		expect(merged.protect.paths).toEqual(["a", "b"]);
		expect(merged.log).toEqual({ enabled: true, path: "/p" });
	});
});

describe("extension factory (end-to-end)", () => {
	type Result = { block?: boolean; reason?: string } | undefined;
	type Ctx = { cwd: string; hasUI?: boolean; ui?: { confirm?: (a: unknown) => Promise<unknown> } };
	type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: Ctx) => Promise<Result>;

	let dir: string;
	let configPath: string;
	let logPath: string;

	const writeConfig = (obj: unknown) => writeFileSync(configPath, JSON.stringify(obj));

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "omp-perms-"));
		configPath = join(dir, "omp-permissions.json");
		logPath = join(dir, "perm.log");
		process.env.OMP_PERMISSIONS_CONFIG = configPath;
	});
	afterAll(() => {
		delete process.env.OMP_PERMISSIONS_CONFIG;
		rmSync(dir, { recursive: true, force: true });
	});

	const build = () => {
		const handlers: Record<string, Handler> = {};
		const fakePi = {
			setLabel() {},
			logger: { warn() {}, error() {} },
			getSessionName: () => "test-session",
			on(event: string, handler: Handler) {
				handlers[event] = handler;
			},
		};
		ompPermissions(fakePi as unknown as Parameters<typeof ompPermissions>[0]);
		return handlers;
	};
	const start = async () => {
		const h = build();
		await h.session_start({ toolName: "", input: {} }, { cwd: dir });
		return h;
	};

	it("denies a denied bash sub-command (and serena shell)", async () => {
		writeConfig({ enabled: true, permission: { bash: { "*": "allow", "touch *": "deny" } } });
		const h = await start();
		expect(
			(await h.tool_call({ toolName: "bash", input: { command: "echo ok && touch x" } }, { cwd: dir }))?.block,
		).toBe(true);
		expect(
			(
				await h.tool_call(
					{ toolName: "mcp__serena_execute_shell_command", input: { command: "touch y" } },
					{ cwd: dir },
				)
			)?.block,
		).toBe(true);
	});

	it("self-protection ASKS by default: blocked headless, allowed on confirm", async () => {
		writeConfig({ enabled: true, permission: {}, protect: { paths: [] } });
		const h = await start();
		// headless -> ask fails closed -> blocked
		expect(
			(await h.tool_call({ toolName: "write", input: { path: configPath } }, { cwd: dir, hasUI: false }))?.block,
		).toBe(true);
		// with a UI that confirms -> allowed
		expect(
			await h.tool_call(
				{ toolName: "write", input: { path: configPath } },
				{ cwd: dir, hasUI: true, ui: { confirm: async () => true } },
			),
		).toBeUndefined();
	});

	it("self-protection action 'deny' blocks even with a UI", async () => {
		writeConfig({ enabled: true, permission: {}, protect: { action: "deny" } });
		const h = await start();
		expect(
			(
				await h.tool_call(
					{ toolName: "write", input: { path: configPath } },
					{ cwd: dir, hasUI: true, ui: { confirm: async () => true } },
				)
			)?.block,
		).toBe(true);
	});

	it("logs every tool call with time, identity and decision when log is enabled", async () => {
		writeConfig({
			enabled: true,
			permission: { bash: { "*": "allow", "touch *": "deny" } },
			log: { enabled: true, path: logPath },
		});
		const h = await start();
		await h.tool_call({ toolName: "bash", input: { command: "echo hi" } }, { cwd: dir });
		await h.tool_call({ toolName: "bash", input: { command: "touch z" } }, { cwd: dir });
		const lines = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map(l => JSON.parse(l));
		const allowed = lines.find(r => r.tool === "bash" && r.permission === "allowed");
		const blocked = lines.find(r => r.tool === "bash" && r.permission === "blocked");
		expect(allowed).toBeDefined();
		expect(blocked).toBeDefined();
		expect(typeof allowed.ts).toBe("string");
		expect(allowed.pid).toBe(process.pid);
		expect(allowed.sessionName).toBe("test-session");
	});
});
