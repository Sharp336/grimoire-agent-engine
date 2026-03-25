import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const astEditMock = vi.fn();
const astGrepMock = vi.fn();
const globMock = vi.fn();
const grepMock = vi.fn();

mock.module("@oh-my-pi/pi-natives", () => ({
	embeddedAddon: null,
	native: {},
	astEdit: astEditMock,
	astGrep: astGrepMock,
	copyToClipboard: vi.fn(),
	detectMacOSAppearance: vi.fn(() => "dark"),
	encodeSixel: vi.fn(),
	executeShell: vi.fn(),
	extractSegments: vi.fn(() => []),
	Ellipsis: { None: 0, Left: 1, Right: 2, Middle: 3 },
	FileType: {
		File: 1,
		Dir: 2,
	},
	fuzzyFind: vi.fn(async () => ({ matches: [] })),
	getSupportedLanguages: vi.fn(() => []),
	getWorkProfile: vi.fn(),
	glob: globMock,
	grep: grepMock,
	hasMatch: vi.fn(() => false),
	highlightCode: vi.fn(() => ""),
	htmlToMarkdown: vi.fn(),
	ImageFormat: { Png: "png", Jpeg: "jpeg", Webp: "webp" },
	invalidateFsScanCache: vi.fn(),
	killTree: vi.fn(),
	listDescendants: vi.fn(() => []),
	matchesKey: vi.fn(() => false),
	matchesKittySequence: vi.fn(() => false),
	matchesLegacySequence: vi.fn(() => false),
	parseKey: vi.fn(() => null),
	parseKittySequence: vi.fn(() => null),
	PhotonImage: class {},
	projfsOverlayProbe: vi.fn(),
	projfsOverlayStart: vi.fn(),
	projfsOverlayStop: vi.fn(),
	PtySession: class {},
	readImageFromClipboard: vi.fn(),
	sanitizeText: vi.fn((text: string) => text),
	SamplingFilter: { Nearest: "nearest" },
	searchContent: vi.fn(() => ({ matches: [] })),
	Shell: class {},
	sliceWithWidth: vi.fn((text: string) => text),
	startMacAppearanceObserver: vi.fn(() => ({ stop() {} })),
	supportsLanguage: vi.fn(() => true),
	truncateToWidth: vi.fn((text: string) => text),
	visibleWidth: vi.fn((text: string) => text.length),
	wrapTextWithAnsi: vi.fn((text: string) => [text]),
}));

const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
const { AstEditTool } = await import("@oh-my-pi/pi-coding-agent/tools/ast-edit");
const { AstGrepTool } = await import("@oh-my-pi/pi-coding-agent/tools/ast-grep");
const { FindTool } = await import("@oh-my-pi/pi-coding-agent/tools/find");
const { GrepTool } = await import("@oh-my-pi/pi-coding-agent/tools/grep");
const { PendingActionStore } = await import("@oh-my-pi/pi-coding-agent/tools/pending-action");
const { ReadTool } = await import("@oh-my-pi/pi-coding-agent/tools/read");
const { ToolAbortError, ToolTimeoutError, toolErrorToResult } = await import(
	"@oh-my-pi/pi-coding-agent/tools/tool-errors"
);

function createSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const onAbort = () => reject(new ToolAbortError());
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	astEditMock.mockReset();
	astGrepMock.mockReset();
	globMock.mockReset();
	grepMock.mockReset();
});

describe("built-in tool timeouts", () => {
	it("surfaces find timeouts with readable messages and timeout metadata", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "find-timeout-"));
		try {
			const timeoutMsSeen: number[] = [];
			const tool = new FindTool(createSession(tempDir), {
				operations: {
					exists: () => true,
					stat: () => ({ isFile: () => false, isDirectory: () => true }),
					glob: async (_pattern: string, _cwd: string, options: { signal?: AbortSignal; timeoutMs?: number }) => {
						timeoutMsSeen.push(options.timeoutMs ?? 0);
						await waitForAbort(options.signal);
						return [];
					},
				},
			});

			const error = await tool.execute("find-timeout", { pattern: "**/*.ts", timeout: 1 }).catch(error => error);

			expect(error).toBeInstanceOf(ToolTimeoutError);
			expect((error as Error).message).toContain("find timed out after 1 seconds");
			expect(timeoutMsSeen).toEqual([1000]);
			expect((error as InstanceType<typeof ToolTimeoutError>).details).toMatchObject({
				errorType: "timeout",
				timeout: {
					toolName: "find",
					durationSeconds: 1,
					durationMs: 1000,
				},
			});

			const result = toolErrorToResult(error);
			expect(result.content).toEqual([{ type: "text", text: "find timed out after 1 seconds" }]);
			expect(result.details).toMatchObject({
				error: "find timed out after 1 seconds",
				errorType: "timeout",
				timeout: {
					toolName: "find",
					durationSeconds: 1,
					durationMs: 1000,
				},
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("surfaces find preflight timeouts before custom glob runs", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "find-preflight-timeout-"));
		try {
			const timeoutMsSeen: number[] = [];
			const globCalls: number[] = [];
			const tool = new FindTool(createSession(tempDir), {
				operations: {
					exists: async (_path: string, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
						timeoutMsSeen.push(options?.timeoutMs ?? 0);
						await waitForAbort(options?.signal);
						return false;
					},
					glob: async () => {
						globCalls.push(Date.now());
						return [];
					},
				},
			});

			const error = await tool
				.execute("find-preflight-timeout", { pattern: "**/*.ts", timeout: 1 })
				.catch(error => error);

			expect(error).toBeInstanceOf(ToolTimeoutError);
			expect((error as Error).message).toContain("find timed out after 1 seconds");
			expect(timeoutMsSeen).toEqual([1000]);
			expect(globCalls).toHaveLength(0);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("aborts read internal URL resolution when the direct signal is cancelled", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-internal-abort-"));
		try {
			let resolveCalls = 0;
			const tool = new ReadTool(
				createSession(tempDir, {
					internalRouter: {
						canHandle: (input: string) => input === "artifact://slow",
						resolve: async () => {
							resolveCalls += 1;
							await new Promise(() => {});
							throw new Error("unreachable");
						},
					} as unknown as ToolSession["internalRouter"],
				}),
			);
			const controller = new AbortController();
			const execution = tool
				.execute("read-internal-abort", { path: "artifact://slow", timeout: 10 }, controller.signal)
				.catch(error => error);
			controller.abort();

			const error = await execution;
			expect(error).toBeInstanceOf(ToolAbortError);
			expect(resolveCalls).toBe(1);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("surfaces read suffix-resolution timeouts with timeout metadata", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-timeout-"));
		try {
			const tool = new ReadTool(createSession(tempDir));
			const timeoutMsSeen: number[] = [];
			globMock.mockImplementation(async (input: { signal?: AbortSignal; timeoutMs?: number }) => {
				timeoutMsSeen.push(input.timeoutMs ?? 0);
				await waitForAbort(input.signal);
				throw new Error("unreachable");
			});

			const error = await tool.execute("read-timeout", { path: "missing.txt", timeout: 1 }).catch(error => error);

			expect(error).toBeInstanceOf(ToolTimeoutError);
			expect((error as Error).message).toContain("Read timed out after 1 seconds");
			expect(timeoutMsSeen).toEqual([1000]);
			expect((error as InstanceType<typeof ToolTimeoutError>).details).toMatchObject({
				errorType: "timeout",
				timeout: {
					toolName: "read",
					durationSeconds: 1,
					durationMs: 1000,
				},
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("surfaces grep timeouts with timeout metadata", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-timeout-"));
		try {
			const filePath = path.join(tempDir, "haystack.txt");
			await Bun.write(filePath, "needle\n");
			const tool = new GrepTool(createSession(tempDir));
			const timeoutMsSeen: number[] = [];
			grepMock.mockImplementation(async (input: { signal?: AbortSignal; timeoutMs?: number }) => {
				timeoutMsSeen.push(input.timeoutMs ?? 0);
				await new Promise((_, reject) => {
					const onAbort = () => reject(new Error("Aborted: Timeout"));
					if (input.signal?.aborted) {
						onAbort();
						return;
					}
					input.signal?.addEventListener("abort", onAbort, { once: true });
				});
				throw new Error("unreachable");
			});

			const error = await tool
				.execute("grep-timeout", { pattern: "needle", path: filePath, timeout: 1 })
				.catch(error => error);

			expect(error).toBeInstanceOf(ToolTimeoutError);
			expect((error as Error).message).toContain("grep timed out after 1 seconds");
			expect(timeoutMsSeen).toEqual([1000]);
			expect((error as InstanceType<typeof ToolTimeoutError>).details).toMatchObject({
				errorType: "timeout",
				timeout: {
					toolName: "grep",
					durationSeconds: 1,
					durationMs: 1000,
				},
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps grep native abort classification distinct from timeout", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-abort-"));
		try {
			const filePath = path.join(tempDir, "haystack.txt");
			await Bun.write(filePath, "needle\n");
			const tool = new GrepTool(createSession(tempDir));

			grepMock.mockImplementation(async () => {
				throw new Error("Aborted: Signal");
			});

			const error = await tool
				.execute("grep-abort", { pattern: "needle", path: filePath, timeout: 10 })
				.catch(error => error);
			expect(error).toBeInstanceOf(ToolAbortError);
			expect(error).not.toBeInstanceOf(ToolTimeoutError);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("surfaces ast_grep internal URL resolution timeouts with timeout metadata", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-grep-timeout-"));
		try {
			const tool = new AstGrepTool(
				createSession(tempDir, {
					internalRouter: {
						canHandle: (input: string) => input === "artifact://slow",
						resolve: async () => {
							await new Promise(() => {});
							throw new Error("unreachable");
						},
					} as unknown as ToolSession["internalRouter"],
				}),
			);

			const error = await tool
				.execute("ast-grep-timeout", { pat: ["needle"], path: "artifact://slow", timeout: 1 })
				.catch(error => error);

			expect(error).toBeInstanceOf(ToolTimeoutError);
			expect((error as Error).message).toContain("ast_grep timed out after 1 seconds");
			expect((error as InstanceType<typeof ToolTimeoutError>).details).toMatchObject({
				errorType: "timeout",
				timeout: {
					toolName: "ast_grep",
					durationSeconds: 1,
					durationMs: 1000,
				},
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps ast_edit pending apply path timeout-aware", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-timeout-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const pendingActionStore = new PendingActionStore();
			const tool = new AstEditTool(createSession(tempDir, { pendingActionStore }));

			let callCount = 0;
			astEditMock.mockImplementation(async (input: { signal?: AbortSignal }) => {
				callCount += 1;
				if (callCount === 1) {
					return {
						totalReplacements: 1,
						filesTouched: 1,
						filesSearched: 1,
						applied: false,
						limitReached: false,
						parseErrors: [],
						fileChanges: [{ path: filePath, count: 1 }],
						changes: [
							{
								path: filePath,
								startLine: 1,
								startColumn: 1,
								endLine: 1,
								endColumn: 21,
								before: "legacyWrap(x, value)",
								after: "modernWrap(x, value)",
							},
						],
					};
				}
				await waitForAbort(input.signal);
				throw new Error("unreachable");
			});

			const preview = await tool.execute("ast-edit-preview", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				lang: "typescript",
				path: filePath,
				timeout: 1,
			});
			expect(preview.details).toMatchObject({ applied: false, totalReplacements: 1 });

			const pending = pendingActionStore.peek();
			expect(pending).not.toBeNull();
			if (!pending) throw new Error("Expected pending action");

			const error = await pending.apply("apply previewed change").catch(reason => reason);
			expect(error).toBeInstanceOf(ToolTimeoutError);
			expect((error as Error).message).toContain("ast_edit timed out after 1 seconds");
			expect((error as InstanceType<typeof ToolTimeoutError>).details).toMatchObject({
				errorType: "timeout",
				timeout: {
					toolName: "ast_edit",
					durationSeconds: 1,
					durationMs: 1000,
				},
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
