import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createLspWritethrough, type FileDiagnosticsResult, LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspServers from "@oh-my-pi/pi-coding-agent/lsp/servers";
import type { LspClient, LspToolDetails, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";

const { configCache, fileConfigCache, resolveFileLspServers } = lspServers;

import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as piUtils from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";

const lspTestSettings = Settings.isolated();

/** Minimal LSP tool session: production always supplies `settings`; these tests only need cwd + a default settings stub. */
function makeLspSession(cwd: string): ToolSession {
	return { cwd, settings: lspTestSettings } as ToolSession;
}

/**
 * Build an independent clone fixture: a real git work-tree root (`.git`
 * directory) with root markers at the ceiling (`package.json`) and at a
 * nested `api/` workspace (`package.json` + `tsconfig.json`), plus one .ts
 * file. `binAtRoot` installs a REAL typescript-language-server binary inside
 * the clone (node_modules/.bin), so binary resolution must come from the
 * clone — never $PATH.
 */
function makeClone(
	base: TempDir,
	options: { binAtRoot?: boolean; nodeModulesSymlinkTo?: string } = {},
): { root: string; api: string; file: string } {
	const root = path.join(base.path(), "repo");
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(path.join(root, "api", "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "repo" }));
	fs.writeFileSync(path.join(root, "api", "package.json"), JSON.stringify({ name: "api" }));
	fs.writeFileSync(path.join(root, "api", "tsconfig.json"), "{}");
	const file = path.join(root, "api", "src", "main.ts");
	fs.writeFileSync(file, "export const value = 1;\n");
	if (options.binAtRoot) {
		const binDir = path.join(root, "node_modules", ".bin");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(binDir, "typescript-language-server"), "#!/bin/sh\nexit 0\n");
		fs.chmodSync(path.join(binDir, "typescript-language-server"), 0o755);
	}
	if (options.nodeModulesSymlinkTo) {
		fs.symlinkSync(options.nodeModulesSymlinkTo, path.join(root, "node_modules"), "dir");
	}
	return { root, api: path.join(root, "api"), file };
}

function textResult(result: AgentToolResult<LspToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/**
 * Stub client for mocked-client tool flows: pre-opened file at the workspace
 * uri and a publish-on-first-poll so `waitForDiagnostics` resolves to a clean
 * OK without any real transport.
 */
function stubClient(cwd: string, config: ServerConfig, uri: string): LspClient {
	return {
		name: `${config.command}:${cwd}`,
		cwd,
		config,
		proc: {
			stdin: { write() {}, flush: async () => {} },
		} as unknown as LspClient["proc"],
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 1,
		openFiles: new Map([[uri, { version: 1, languageId: "typescript" }]]),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	} as unknown as LspClient;
}

interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
}

/**
 * Minimal in-process JSON-RPC transport fake: replies to initialize, shutdown
 * and exit so a REAL `getOrCreateClient` handshake completes, letting tests
 * assert the initialize params (rootUri, workspaceFolders) verbatim.
 */
function installFakeLspTransport(): { received: RpcMessage[] } {
	const encoder = new TextEncoder();
	const received: RpcMessage[] = [];
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let exitCode: number | null = null;
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();
	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const frame = (message: RpcMessage): Uint8Array => {
		const content = JSON.stringify(message);
		return encoder.encode(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
	};
	let pendingBytes = Buffer.alloc(0);
	let chain: Promise<void> = Promise.resolve();
	const feed = (raw: string | Uint8Array): void => {
		const chunk = typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw);
		pendingBytes = pendingBytes.length === 0 ? chunk : Buffer.concat([pendingBytes, chunk]);
		chain = chain.then(async () => {
			while (true) {
				const headerEnd = pendingBytes.indexOf("\r\n\r\n");
				if (headerEnd === -1) break;
				const match = /Content-Length: (\d+)/i.exec(pendingBytes.toString("utf-8", 0, headerEnd));
				if (!match) break;
				const start = headerEnd + 4;
				const end = start + Number(match[1]);
				if (pendingBytes.length < end) break;
				const message = JSON.parse(pendingBytes.toString("utf-8", start, end)) as RpcMessage;
				pendingBytes = pendingBytes.subarray(end);
				received.push(message);
				if (message.method === "initialize") {
					controller?.enqueue(frame({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } }));
				} else if (message.method === "shutdown") {
					controller?.enqueue(frame({ jsonrpc: "2.0", id: message.id, result: null }));
				} else if (message.method === "exit") {
					exitCode = 0;
					controller?.close();
					resolveExited(0);
				}
			}
		});
	};
	const proc = {
		get exited() {
			return exited;
		},
		get exitCode() {
			return exitCode;
		},
		stdin: {
			write(chunk: string | Uint8Array) {
				feed(chunk);
				return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf-8") : chunk.byteLength;
			},
			flush: async () => 0,
			end: async () => 0,
		},
		stdout,
		peekStderr: () => "",
		kill() {
			if (exitCode === null) {
				exitCode = 0;
				controller?.close();
				resolveExited(0);
			}
		},
	} as unknown as LspClient["proc"];
	vi.spyOn(piUtils.ptree, "spawn").mockReturnValue(proc as unknown as piUtils.ptree.ChildProcess<"pipe">);
	return { received };
}

/**
 * `loadConfig` walks the user config directories (~/.omp/agent, ~/.pi/agent,
 * ~/.claude), which resolve from os.homedir(). Point HOME at an empty
 * directory so every case sees a pristine environment and clone resolution
 * stays on the auto-detect path.
 */
let lspHomeOverride: string | undefined;
let lspOriginalHome: string | undefined;

beforeEach(() => {
	lspOriginalHome = process.env.HOME;
	lspHomeOverride = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lsp-clone-test-home-"));
	process.env.HOME = lspHomeOverride;
	vi.spyOn(os, "homedir").mockReturnValue(lspHomeOverride);
});

afterEach(() => {
	if (lspOriginalHome === undefined) delete process.env.HOME;
	else process.env.HOME = lspOriginalHome;
	if (lspHomeOverride) fs.rmSync(lspHomeOverride, { recursive: true, force: true });
	lspHomeOverride = undefined;
});

describe("clone-local LSP roots", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		configCache.clear();
		fileConfigCache.clear();
		await lspClient.shutdownAll();
	});

	it("resolves a clone file to the nearest marker workspace root inside the git ceiling", async () => {
		await initTheme();
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const cloneBase = TempDir.createSync("@omp-lsp-clone-repo-");
		try {
			// The binary lives at the CLONE ROOT node_modules, while the markers
			// (package.json + tsconfig.json) live in api/ — the workspace root
			// must be api/, and the binary must resolve from the ceiling root.
			const clone = makeClone(cloneBase, { binAtRoot: true });
			const resolution = resolveFileLspServers(clone.file, session.path());

			expect(resolution.ceiling.kind).toBe("git");
			expect(resolution.ceiling.path).toBe(clone.root);
			expect(resolution.ceiling.escaped).toBe(false);
			expect(resolution.servers.length).toBeGreaterThan(0);

			const ts = resolution.servers.find(s => s.name === "typescript-language-server");
			expect(ts).toBeDefined();
			expect(ts!.missingBinary).toBe(false);
			expect(ts!.workspaceRoot).toBe(clone.api);
			expect(ts!.workspaceRootReal).toBe(fs.realpathSync(clone.api));
			expect(ts!.config.resolvedCommand).toBe(
				path.join(clone.root, "node_modules", ".bin", "typescript-language-server"),
			);
		} finally {
			session.removeSync();
			cloneBase.removeSync();
		}
	});

	it("routes the diagnostics client to the clone workspace root, never the session cwd", async () => {
		await initTheme();
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const cloneBase = TempDir.createSync("@omp-lsp-clone-repo-");
		try {
			const clone = makeClone(cloneBase, { binAtRoot: true });
			const uri = fileToUri(clone.file);
			const client = stubClient(
				fs.realpathSync(clone.api),
				{
					command: "typescript-language-server",
					fileTypes: ["ts"],
					rootMarkers: [],
				},
				uri,
			);
			const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(Bun, "sleep").mockImplementation(async () => {
				client.diagnosticsVersion += 1;
				client.diagnostics.set(uri, {
					diagnostics: [],
					version: client.openFiles.get(uri)?.version ?? 2,
				});
			});

			const tool = new LspTool(makeLspSession(session.path()));
			const result = await tool.execute("clone-diag", { action: "diagnostics", file: clone.file, timeout: 5 });

			expect(textResult(result)).toBe("OK");
			const calls = getOrCreate.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			for (const call of calls) {
				// Client identity/mux/rootUri all derive from this cwd.
				expect(call[1]).toBe(fs.realpathSync(clone.api));
				expect(call[1]).not.toBe(session.path());
			}
		} finally {
			session.removeSync();
			cloneBase.removeSync();
		}
	});

	it("initializes the clone client with the workspace root as rootUri and workspace folder", async () => {
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const cloneBase = TempDir.createSync("@omp-lsp-clone-repo-");
		try {
			const clone = makeClone(cloneBase, { binAtRoot: true });
			const resolution = resolveFileLspServers(clone.file, session.path());
			const ts = resolution.servers.find(s => s.name === "typescript-language-server")!;
			expect(ts).toBeDefined();

			const transport = installFakeLspTransport();
			const client = await lspClient.getOrCreateClient(ts.config, ts.workspaceRootReal, 2_000);

			const init = transport.received.find(m => m.method === "initialize");
			const params = init?.params as { rootUri?: string; rootPath?: string; workspaceFolders?: unknown };
			expect(params.rootUri).toBe(fileToUri(ts.workspaceRootReal));
			expect(params.rootPath).toBe(ts.workspaceRootReal);
			expect(params.workspaceFolders).toEqual([
				{ uri: fileToUri(ts.workspaceRootReal), name: path.basename(ts.workspaceRootReal) },
			]);
			expect(client.cwd).toBe(ts.workspaceRootReal);
		} finally {
			session.removeSync();
			cloneBase.removeSync();
		}
	});

	it("reports a structured miss for a missing clone-local binary and never uses PATH or founder", async () => {
		await initTheme();
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const cloneBase = TempDir.createSync("@omp-lsp-clone-repo-");
		try {
			const clone = makeClone(cloneBase); // markers present, no binary anywhere in the clone
			const whichSpy = vi
				.spyOn(piUtils, "$which")
				.mockImplementation(command =>
					command === "typescript-language-server"
						? "/founder/node_modules/.bin/typescript-language-server"
						: null,
				);
			const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient");

			const resolution = resolveFileLspServers(clone.file, session.path());
			const ts = resolution.servers.find(s => s.name === "typescript-language-server");
			expect(ts).toBeDefined();
			expect(ts!.missingBinary).toBe(true);
			expect(ts!.config.resolvedCommand).toBeUndefined();

			const tool = new LspTool(makeLspSession(session.path()));
			const result = await tool.execute("clone-missing", { action: "diagnostics", file: clone.file, timeout: 5 });

			const output = textResult(result);
			expect(output).toContain("not installed in clone");
			expect(output).toContain(clone.root);
			expect(output).toContain("typescript-language-server");
			expect(output).toContain("Not using PATH or founder");
			expect(result.details?.success).toBe(false);
			expect(getOrCreate).not.toHaveBeenCalled();
			expect(whichSpy).not.toHaveBeenCalledWith("typescript-language-server");
		} finally {
			session.removeSync();
			cloneBase.removeSync();
		}
	});

	it("gives sibling clones independent workspace identities", async () => {
		await initTheme();
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const cloneBaseA = TempDir.createSync("@omp-lsp-clone-a-");
		const cloneBaseB = TempDir.createSync("@omp-lsp-clone-b-");
		try {
			const cloneA = makeClone(cloneBaseA, { binAtRoot: true });
			const cloneB = makeClone(cloneBaseB, { binAtRoot: true });
			expect(cloneA.api).not.toBe(cloneB.api);

			const resA = resolveFileLspServers(cloneA.file, session.path());
			const resB = resolveFileLspServers(cloneB.file, session.path());
			const tsA = resA.servers.find(s => s.name === "typescript-language-server")!;
			const tsB = resB.servers.find(s => s.name === "typescript-language-server")!;
			expect(tsA.workspaceRootReal).toBe(fs.realpathSync(cloneA.api));
			expect(tsB.workspaceRootReal).toBe(fs.realpathSync(cloneB.api));
			expect(tsA.workspaceRootReal).not.toBe(tsB.workspaceRootReal);

			// A file in B must not attach to A's client identity.
			const uriB = fileToUri(cloneB.file);
			const clientB = stubClient(tsB.workspaceRootReal, tsB.config, uriB);
			const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(clientB);
			vi.spyOn(Bun, "sleep").mockImplementation(async () => {
				clientB.diagnosticsVersion += 1;
				clientB.diagnostics.set(uriB, {
					diagnostics: [],
					version: clientB.openFiles.get(uriB)?.version ?? 2,
				});
			});
			const tool = new LspTool(makeLspSession(session.path()));
			const result = await tool.execute("sibling-diag", { action: "diagnostics", file: cloneB.file, timeout: 5 });
			expect(textResult(result)).toBe("OK");
			for (const call of getOrCreate.mock.calls) {
				expect(call[1]).toBe(fs.realpathSync(cloneB.api));
				expect(call[1]).not.toBe(fs.realpathSync(cloneA.api));
			}
		} finally {
			session.removeSync();
			cloneBaseA.removeSync();
			cloneBaseB.removeSync();
		}
	});

	it("fails closed when node_modules symlinks into a sibling clone", async () => {
		await initTheme();
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const cloneBaseA = TempDir.createSync("@omp-lsp-clone-a-");
		const cloneBaseB = TempDir.createSync("@omp-lsp-clone-b-");
		try {
			const sibling = makeClone(cloneBaseB, { binAtRoot: true });
			const clone = makeClone(cloneBaseA, { nodeModulesSymlinkTo: sibling.root });
			const whichSpy = vi
				.spyOn(piUtils, "$which")
				.mockImplementation(command =>
					command === "typescript-language-server"
						? "/founder/node_modules/.bin/typescript-language-server"
						: null,
				);

			const resolution = resolveFileLspServers(clone.file, session.path());
			const ts = resolution.servers.find(s => s.name === "typescript-language-server");
			expect(ts).toBeDefined();
			expect(ts!.missingBinary).toBe(true);

			const tool = new LspTool(makeLspSession(session.path()));
			const result = await tool.execute("clone-symlink-bin", {
				action: "diagnostics",
				file: clone.file,
				timeout: 5,
			});
			const output = textResult(result);
			expect(output).toContain("not installed in clone");
			expect(output).toContain("Not using PATH or founder");
			expect(whichSpy).not.toHaveBeenCalledWith("typescript-language-server");
		} finally {
			session.removeSync();
			cloneBaseA.removeSync();
			cloneBaseB.removeSync();
		}
	});

	it("refuses a file symlink that escapes the clone ceiling", async () => {
		await initTheme();
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const cloneBase = TempDir.createSync("@omp-lsp-clone-repo-");
		const outsideBase = TempDir.createSync("@omp-lsp-clone-outside-");
		try {
			const clone = makeClone(cloneBase, { binAtRoot: true });
			const outsideFile = path.join(outsideBase.path(), "escape.ts");
			fs.writeFileSync(outsideFile, "export const escaped = true;\n");
			const escapeLink = path.join(clone.api, "src", "escape.ts");
			fs.symlinkSync(outsideFile, escapeLink);

			const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient");
			const tool = new LspTool(makeLspSession(session.path()));
			const result = await tool.execute("clone-escape", { action: "diagnostics", file: escapeLink, timeout: 5 });

			expect(textResult(result)).toContain("refused");
			expect(textResult(result)).toContain(clone.root);
			expect(result.details?.success).toBe(false);
			expect(getOrCreate).not.toHaveBeenCalled();
		} finally {
			session.removeSync();
			cloneBase.removeSync();
			outsideBase.removeSync();
		}
	});

	it("never adopts a sibling clone through a symlinked directory prefix", async () => {
		await initTheme();
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const cloneBase = TempDir.createSync("@omp-lsp-clone-repo-");
		const aliasBase = TempDir.createSync("@omp-lsp-clone-alias-");
		try {
			// The real sibling clone has markers and a clone-local binary.
			const real = makeClone(cloneBase, { binAtRoot: true });
			// An alias directory points at that sibling clone.
			const alias = path.join(aliasBase.path(), "alias");
			fs.symlinkSync(real.root, alias, "dir");
			const aliasFile = path.join(alias, "api", "src", "main.ts");

			// The symlinked prefix must fail closed: no git-ceiling adoption,
			// no server attached to the sibling's canonical root.
			const resolution = resolveFileLspServers(aliasFile, session.path());
			expect(resolution.ceiling.kind).toBe("file");
			expect(resolution.ceiling.escaped).toBe(true);
			expect(resolution.servers).toEqual([]);

			const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient");
			const tool = new LspTool(makeLspSession(session.path()));
			const result = await tool.execute("alias-diag", { action: "diagnostics", file: aliasFile, timeout: 5 });
			expect(textResult(result)).toContain("refused");
			expect(result.details?.success).toBe(false);
			expect(getOrCreate).not.toHaveBeenCalled();
		} finally {
			session.removeSync();
			cloneBase.removeSync();
			aliasBase.removeSync();
		}
	});

	it("distinguishes no-marker nonproject files from missing binaries", async () => {
		await initTheme();
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const strayBase = TempDir.createSync("@omp-lsp-clone-stray-");
		const bareRepoBase = TempDir.createSync("@omp-lsp-clone-bare-");
		try {
			// Stray file: outside the session, no git ceiling — discovery is
			// bounded to the file's own directory, which has no markers.
			const strayFile = path.join(strayBase.path(), "scratch.ts");
			fs.writeFileSync(strayFile, "export const scratch = 1;\n");
			const tool = new LspTool(makeLspSession(session.path()));
			const stray = await tool.execute("stray-diag", { action: "diagnostics", file: strayFile, timeout: 5 });
			const strayOutput = textResult(stray);
			expect(strayOutput).toContain("No language server found");
			expect(strayOutput).toContain(`no project markers inside ${strayBase.path()}`);
			expect(stray.details?.success).toBe(false);

			// A git clone whose work tree has no project markers at all.
			const bareRepo = path.join(bareRepoBase.path(), "repo");
			fs.mkdirSync(path.join(bareRepo, ".git"), { recursive: true });
			fs.mkdirSync(path.join(bareRepo, "src"), { recursive: true });
			const bareFile = path.join(bareRepo, "src", "main.ts");
			fs.writeFileSync(bareFile, "export const bare = 1;\n");
			const bare = await tool.execute("bare-diag", { action: "diagnostics", file: bareFile, timeout: 5 });
			const bareOutput = textResult(bare);
			expect(bareOutput).toContain("No language server found");
			expect(bareOutput).toContain(`no project markers inside ${bareRepo}`);

			// Session-owned file without markers keeps the plain session message.
			const sessionFile = path.join(session.path(), "notes.ts");
			fs.writeFileSync(sessionFile, "export const notes = 1;\n");
			const inSession = await tool.execute("session-diag", { action: "diagnostics", file: sessionFile, timeout: 5 });
			expect(textResult(inSession)).toBe("No language server found");
		} finally {
			session.removeSync();
			strayBase.removeSync();
			bareRepoBase.removeSync();
		}
	});

	it("reload * clears every config cache and atomically stops clone clients; single-file reload keeps other clones", async () => {
		await initTheme();
		const session = TempDir.createSync("@omp-lsp-clone-session-");
		const cloneBaseA = TempDir.createSync("@omp-lsp-clone-a-");
		const cloneBaseB = TempDir.createSync("@omp-lsp-clone-b-");
		try {
			const cloneA = makeClone(cloneBaseA, { binAtRoot: true });
			const cloneB = makeClone(cloneBaseB, { binAtRoot: true });
			// Prime the file-scoped config cache for both clones and a session entry.
			const resolutionA = resolveFileLspServers(cloneA.file, session.path());
			resolveFileLspServers(cloneB.file, session.path());
			configCache.set(session.path(), { servers: {}, idleTimeoutMs: undefined });
			expect(fileConfigCache.size).toBeGreaterThan(0);
			expect(configCache.has(session.path())).toBe(true);
			const tsA = resolutionA.servers.find(entry => entry.name === "typescript-language-server");
			if (!tsA) throw new Error("missing clone A TypeScript server");
			const getOrCreate = vi
				.spyOn(lspClient, "getOrCreateClient")
				.mockResolvedValue(stubClient(tsA.workspaceRootReal, tsA.config, fileToUri(cloneA.file)));
			const shutdownStale = vi.spyOn(lspClient, "shutdownStaleClients").mockResolvedValue([]);
			const sendNotification = vi.spyOn(lspClient, "sendNotification").mockResolvedValue();

			// reload <file> must invalidate the file's ceiling BEFORE resolution
			// (retrying a previously-missing binary even when every entry is a
			// miss); a fresh resolution then re-caches the now-resolved config.
			const invalidateSpy = vi.spyOn(lspServers, "invalidateFileConfigs");
			const tool = new LspTool(makeLspSession(session.path()));

			// Single-file reload: the file's ceiling cache is invalidated before
			// resolution (retrying a previously-missing binary), clone B's
			// entries survive, and no global shutdown happens.
			const fileReload = await tool.execute("reload-a", { action: "reload", file: cloneA.file });
			expect(textResult(fileReload)).toContain("Reloaded");
			expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ path: cloneA.root, kind: "git" }));
			expect(shutdownStale).not.toHaveBeenCalled();
			expect([...fileConfigCache.keys()].some(key => key.includes(cloneB.root))).toBe(true);
			expect(sendNotification).toHaveBeenCalled();

			// reload * drops every file config and tears down each cached clone
			// root through identity-aware stale-client shutdown.
			await tool.execute("reload-star", { action: "reload", file: "*" });
			expect(shutdownStale).toHaveBeenCalled();
			expect(fileConfigCache.size).toBe(0);
			// reload * then re-reads the session config into the cache
			// immediately (the refresh contract), so the entry is present
			// again — empty here because the session dir has no markers.
			expect(configCache.has(session.path())).toBe(true);
			// The refreshed session config (no markers in the session dir) has no
			// servers, so nothing is (re)started after the teardown.
			expect(getOrCreate.mock.calls.length).toBe(1);
		} finally {
			session.removeSync();
			cloneBaseA.removeSync();
			cloneBaseB.removeSync();
		}
	});
});

describe("writethrough clone-local roots", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		configCache.clear();
		fileConfigCache.clear();
		await lspClient.shutdownAll();
	});

	it("attaches post-write LSP to the clone workspace root, never the session cwd", async () => {
		const session = TempDir.createSync("@omp-wt-session-");
		const cloneBase = TempDir.createSync("@omp-wt-clone-");
		try {
			const clone = makeClone(cloneBase, { binAtRoot: true });
			const uri = fileToUri(clone.file);
			const root = fs.realpathSync(clone.api);
			const config: ServerConfig = {
				command: "typescript-language-server",
				fileTypes: ["ts"],
				rootMarkers: [],
				resolvedCommand: path.join(clone.root, "node_modules", ".bin", "typescript-language-server"),
			};
			const client = stubClient(root, config, uri);
			const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "syncContent").mockImplementation(async mockClient => {
				mockClient.openFiles.set(uri, { version: 1, languageId: "typescript" });
			});
			vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
				mockClient.diagnostics.set(uri, { diagnostics: [], version: 1 });
				mockClient.diagnosticsVersion += 1;
			});
			vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

			const writethrough = createLspWritethrough(session.path(), {
				enableFormat: false,
				enableDiagnostics: true,
			});
			const result = (await writethrough(clone.file, "export const value = 2;\n")) as
				| FileDiagnosticsResult
				| undefined;

			expect(result?.summary).toBe("OK");
			expect(await Bun.file(clone.file).text()).toBe("export const value = 2;\n");
			const calls = getOrCreate.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			for (const call of calls) {
				expect(call[1]).toBe(root);
				expect(call[1]).not.toBe(session.path());
			}
		} finally {
			session.removeSync();
			cloneBase.removeSync();
		}
	});

	it("skips clone-local LSP entirely when the binary is missing, without PATH or founder fallback", async () => {
		const session = TempDir.createSync("@omp-wt-session-");
		const cloneBase = TempDir.createSync("@omp-wt-clone-");
		try {
			const clone = makeClone(cloneBase); // markers present, no binary
			const whichSpy = vi
				.spyOn(piUtils, "$which")
				.mockImplementation(command =>
					command === "typescript-language-server"
						? "/founder/node_modules/.bin/typescript-language-server"
						: null,
				);
			const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient");
			const notify = vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

			const writethrough = createLspWritethrough(session.path(), {
				enableFormat: true,
				enableDiagnostics: true,
			});
			const result = await writethrough(clone.file, "export const value = 3;\n");

			expect(result).toBeUndefined();
			expect(await Bun.file(clone.file).text()).toBe("export const value = 3;\n");
			expect(getOrCreate).not.toHaveBeenCalled();
			expect(whichSpy).not.toHaveBeenCalledWith("typescript-language-server");
			// The watched-file announce targets the clone work tree, never the
			// unrelated session root.
			expect(notify).toHaveBeenCalledWith(
				fs.realpathSync(clone.root),
				[{ filePath: clone.file, type: lspClient.FileChangeType.Changed }],
				undefined,
			);
		} finally {
			session.removeSync();
			cloneBase.removeSync();
		}
	});

	it("writes through an escaped directory symlink without attaching or notifying a session server", async () => {
		const session = TempDir.createSync("@omp-wt-session-");
		const siblingBase = TempDir.createSync("@omp-wt-sibling-");
		const aliasBase = TempDir.createSync("@omp-wt-alias-");
		try {
			fs.writeFileSync(path.join(session.path(), "package.json"), JSON.stringify({ name: "session" }));
			fs.writeFileSync(path.join(session.path(), "tsconfig.json"), "{}");
			const sessionBin = path.join(session.path(), "node_modules", ".bin");
			fs.mkdirSync(sessionBin, { recursive: true });
			const sessionServer = path.join(sessionBin, "typescript-language-server");
			fs.writeFileSync(sessionServer, "#!/bin/sh\nexit 0\n");
			fs.chmodSync(sessionServer, 0o755);

			const sibling = makeClone(siblingBase, { binAtRoot: true });
			const alias = path.join(aliasBase.path(), "sibling-link");
			fs.symlinkSync(sibling.root, alias, "dir");
			const aliasFile = path.join(alias, "api", "src", "main.ts");
			const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient");
			const notify = vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

			const writethrough = createLspWritethrough(session.path(), {
				enableFormat: true,
				enableDiagnostics: true,
			});
			const result = await writethrough(aliasFile, "export const escaped = true;\n");

			expect(result).toBeUndefined();
			expect(await Bun.file(sibling.file).text()).toBe("export const escaped = true;\n");
			expect(getOrCreate).not.toHaveBeenCalled();
			expect(notify).not.toHaveBeenCalled();
		} finally {
			session.removeSync();
			siblingBase.removeSync();
			aliasBase.removeSync();
		}
	});

	it("writes each sibling clone through its own workspace root", async () => {
		const session = TempDir.createSync("@omp-wt-session-");
		const cloneBaseA = TempDir.createSync("@omp-wt-clone-a-");
		const cloneBaseB = TempDir.createSync("@omp-wt-clone-b-");
		try {
			const cloneA = makeClone(cloneBaseA, { binAtRoot: true });
			const cloneB = makeClone(cloneBaseB, { binAtRoot: true });
			const uriB = fileToUri(cloneB.file);
			const rootB = fs.realpathSync(cloneB.api);
			const config: ServerConfig = {
				command: "typescript-language-server",
				fileTypes: ["ts"],
				rootMarkers: [],
				resolvedCommand: path.join(cloneB.root, "node_modules", ".bin", "typescript-language-server"),
			};
			const clientB = stubClient(rootB, config, uriB);
			const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(clientB);
			vi.spyOn(lspClient, "syncContent").mockImplementation(async mockClient => {
				mockClient.openFiles.set(uriB, { version: 1, languageId: "typescript" });
			});
			vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
				mockClient.diagnostics.set(uriB, { diagnostics: [], version: 1 });
				mockClient.diagnosticsVersion += 1;
			});
			vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

			const writethrough = createLspWritethrough(session.path(), {
				enableFormat: false,
				enableDiagnostics: true,
			});
			await writethrough(cloneB.file, "export const value = 4;\n");

			const calls = getOrCreate.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			for (const call of calls) {
				expect(call[1]).toBe(rootB);
				expect(call[1]).not.toBe(fs.realpathSync(cloneA.api));
				expect(call[1]).not.toBe(session.path());
			}
		} finally {
			session.removeSync();
			cloneBaseA.removeSync();
			cloneBaseB.removeSync();
		}
	});
});
