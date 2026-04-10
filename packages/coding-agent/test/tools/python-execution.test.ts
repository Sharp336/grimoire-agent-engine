import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const mockNativeBindings = {
	ChunkAnchorStyle: { Full: "full", Minimal: "minimal", None: "none" },
	ChunkEditOp: { Replace: "replace", Before: "before", After: "after", Prepend: "prepend", Append: "append" },
	ChunkReadStatus: { Ok: "ok", Missing: "missing", Binary: "binary", Error: "error" },
	ChunkState: {
		parse() {
			throw new Error("ChunkState.parse unavailable in test");
		},
	},
	FileType: { File: 1, Dir: 2, Symlink: 3, Other: 4 },
	GrepOutputMode: { Paths: "paths", FilesWithMatches: "files_with_matches", Count: "count", Content: "content" },
	ImageFormat: { Png: "png", Jpeg: "jpeg", Webp: "webp" },
	MacAppearanceObserver: class {},
	MacOSPowerAssertion: { start: () => ({ stop: () => {} }) },
	PhotonImage: class {},
	PtySession: class {},
	SamplingFilter: { Nearest: "nearest", Triangle: "triangle" },
	SearchDb: class {},
	Shell: class {},
	astEdit: async () => ({ replacements: [] }),
	astGrep: async () => ({ matches: [] }),
	fuzzyFind: async () => ({ matches: [] }),
	detectMacOSAppearance: () => "light",
	encodeSixel: async () => "",
	Ellipsis: { Omit: "omit", ThreeDots: "threeDots" },
	extractSegments: (text: string) => [text],
	executeShell: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	formatAnchor: (name: string, checksum?: string) => (checksum ? `${name}#${checksum}` : name),
	getDefaultTabWidth: () => 4,
	getIndentation: () => 4,
	getWorkProfile: () => null,
	glob: async () => [],
	grep: async () => ({ matches: [] }),
	highlightCode: (code: string) => code,
	htmlToMarkdown: (html: string) => html,
	invalidateFsScanCache: () => {},
	killTree: async () => {},
	projfsOverlayProbe: async () => ({ available: false }),
	projfsOverlayStart: async () => ({ mountId: "mock" }),
	projfsOverlayStop: async () => {},
	sanitizeText: (text: string) => text,
	matchesKey: () => false,
	parseKey: () => null,
	parseKittySequence: () => null,
	sliceWithWidth: (text: string) => text,
	setDefaultTabWidth: () => {},
	supportsLanguage: () => false,
	truncateToWidth: (text: string) => text,
	wrapTextWithAnsi: (text: string) => text,
};

vi.mock("@oh-my-pi/pi-natives", () => mockNativeBindings);

const { Settings } = require("../../src/config/settings") as typeof import("../../src/config/settings");
const pythonExecutor = require("../../src/ipy/executor") as typeof import("../../src/ipy/executor");
const { PythonTool } = require("../../src/tools/python") as typeof import("../../src/tools/python");

function createSession(cwd: string, kernelOwnerId?: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => `${cwd}/session-file.jsonl`,
		getSessionSpawns: () => "*",
		getPythonKernelOwnerId: () => kernelOwnerId ?? null,
		settings: Settings.isolated({
			"lsp.formatOnWrite": true,
			"bashInterceptor.enabled": true,
			"python.toolMode": "ipy-only",
			"python.kernelMode": "per-call",
		}),
	};
}

describe("python tool execution", () => {
	afterEach(() => {
		pythonExecutor.resetPreludeDocsCache();
		vi.restoreAllMocks();
	});

	it("passes kernel owner and kernel options from settings and args", async () => {
		const tempDir = TempDir.createSync("@python-tool-");
		vi.spyOn(pythonExecutor, "getPreludeDocs").mockReturnValue([]);
		const warmupSpy = vi.spyOn(pythonExecutor, "warmPythonEnvironment").mockResolvedValue({ ok: true, docs: [] });
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "ok",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 2,
			outputLines: 1,
			outputBytes: 2,
			displayOutputs: [],
			stdinRequested: false,
		});

		const kernelOwnerId = "owner-123";
		const tool = new PythonTool(createSession(tempDir.path(), kernelOwnerId));
		const result = await tool.execute(
			"call-id",
			{ cells: [{ code: "print('hi')" }], timeout: 5, cwd: tempDir.path(), reset: true },
			undefined,
			undefined,
			undefined,
		);

		expect(warmupSpy).toHaveBeenCalledWith(
			tempDir.path(),
			`session:${tempDir.path()}/session-file.jsonl:cwd:${tempDir.path()}`,
			true,
			`${tempDir.path()}/session-file.jsonl`,
			kernelOwnerId,
		);
		expect(executeSpy).toHaveBeenCalledWith(
			"print('hi')",
			expect.objectContaining({
				cwd: tempDir.path(),
				deadlineMs: expect.any(Number),
				signal: expect.any(AbortSignal),
				sessionFile: `${tempDir.path()}/session-file.jsonl`,
				sessionId: `session:${tempDir.path()}/session-file.jsonl:cwd:${tempDir.path()}`,
				kernelOwnerId,
				kernelMode: "per-call",
				useSharedGateway: true,
				reset: true,
			}),
		);
		const text = result.content.find(item => item.type === "text")?.text;
		expect(text).toBe("ok");

		tempDir.removeSync();
	});
});
