import { afterEach, describe, expect, it, vi } from "bun:test";
import { createRequire } from "node:module";
import type {
	KernelExecuteResult,
	PreludeHelper,
	PythonKernel as PythonKernelInstance,
} from "@oh-my-pi/pi-coding-agent/ipy/kernel";
import { TempDir } from "@oh-my-pi/pi-utils";

const require = createRequire(import.meta.url);
const mockNativeBindings = {
	ChunkAnchorStyle: { Full: "full", Minimal: "minimal", None: "none" },
	ChunkEditOp: { Replace: "replace", Before: "before", After: "after", Prepend: "prepend", Append: "append" },
	ChunkReadStatus: { Ok: "ok", Missing: "missing", Binary: "binary", Error: "error" },
	ChunkState: {
		parse() {
			throw new Error("ChunkState.parse unavailable in test");
		},
	},
	Ellipsis: { Omit: "omit", ThreeDots: "threeDots" },
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
	detectMacOSAppearance: () => "light",
	encodeSixel: async () => "",
	executeShell: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	extractSegments: (text: string) => [text],
	formatAnchor: (name: string, checksum?: string) => (checksum ? `${name}#${checksum}` : name),
	fuzzyFind: async () => ({ matches: [] }),
	getDefaultTabWidth: () => 4,
	getIndentation: () => 4,
	getWorkProfile: () => null,
	glob: async () => [],
	grep: async () => ({ matches: [] }),
	highlightCode: (code: string) => code,
	htmlToMarkdown: (html: string) => html,
	invalidateFsScanCache: () => {},
	killTree: async () => {},
	matchesKey: () => false,
	parseKey: () => null,
	parseKittySequence: () => null,
	projfsOverlayProbe: async () => ({ available: false }),
	projfsOverlayStart: async () => ({ mountId: "mock" }),
	projfsOverlayStop: async () => {},
	sanitizeText: (text: string) => text,
	setDefaultTabWidth: () => {},
	sliceWithWidth: (text: string) => text,
	supportsLanguage: () => false,
	truncateToWidth: (text: string) => text,
	wrapTextWithAnsi: (text: string) => text,
};

vi.mock("@oh-my-pi/pi-natives", () => mockNativeBindings);

const executor = require("../../src/ipy/executor") as typeof import("../../src/ipy/executor");
const pythonKernel = require("../../src/ipy/kernel") as typeof import("../../src/ipy/kernel");

const {
	disposeAllKernelSessions,
	disposeKernelSessionsByOwner,
	executePython,
	resetPreludeDocsCache,
	warmPythonEnvironment,
} = executor;
const { PythonKernel } = pythonKernel;

const OK_RESULT: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

class FakeKernel {
	execute = vi.fn(async () => OK_RESULT);
	shutdown = vi.fn(async () => {});
	ping = vi.fn(async () => true);
	alive = true;

	isAlive(): boolean {
		return this.alive;
	}
}

afterEach(async () => {
	await disposeAllKernelSessions();
	resetPreludeDocsCache();
	vi.restoreAllMocks();
});

describe("python executor owner cleanup", () => {
	it("keeps shared retained kernels alive until the last owner is disposed", async () => {
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("2 + 2", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(2);

		await disposeKernelSessionsByOwner("owner-a");

		expect(kernel.shutdown).not.toHaveBeenCalled();

		await executePython("3 + 3", {
			cwd: "/tmp/shared-owner-kernel",
			sessionId: "shared-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(3);

		await disposeKernelSessionsByOwner("owner-b");

		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("disposes every retained kernel owned by one owner across session ids and cwd values", async () => {
		const kernelOne = new FakeKernel();
		const kernelTwo = new FakeKernel();
		const unrelatedKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(kernelOne as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(kernelTwo as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(unrelatedKernel as unknown as PythonKernelInstance);

		await executePython("print('one')", {
			cwd: "/tmp/owner-a-one",
			sessionId: "session-one",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('two')", {
			cwd: "/tmp/owner-a-two",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('other')", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);

		await disposeKernelSessionsByOwner("owner-a");

		expect(kernelOne.shutdown).toHaveBeenCalledTimes(1);
		expect(kernelTwo.shutdown).toHaveBeenCalledTimes(1);
		expect(unrelatedKernel.shutdown).not.toHaveBeenCalled();

		await executePython("print('still alive')", {
			cwd: "/tmp/owner-b-one",
			sessionId: "session-other",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);
		expect(unrelatedKernel.execute).toHaveBeenCalledTimes(2);
	});

	it("does not reattach a kernel after owner disposal has already claimed it", async () => {
		const disposingKernel = new FakeKernel();
		const replacementKernel = new FakeKernel();
		const shutdownDeferred = Promise.withResolvers<void>();
		disposingKernel.shutdown = vi.fn(() => shutdownDeferred.promise);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(disposingKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);

		await executePython("1 + 1", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});

		const disposal = disposeKernelSessionsByOwner("owner-a");
		await executePython("2 + 2", {
			cwd: "/tmp/disposal-race-kernel",
			sessionId: "race-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(disposingKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(disposingKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(replacementKernel.shutdown).not.toHaveBeenCalled();

		shutdownDeferred.resolve();
		await disposal;

		await disposeKernelSessionsByOwner("owner-b");
		expect(replacementKernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("attaches cached warmup sessions to newly provided owners", async () => {
		using tempDir = TempDir.createSync("@python-owner-warmup-");
		const docs: PreludeHelper[] = [
			{
				name: "read",
				signature: "(path)",
				docstring: "Read file contents.",
				category: "File I/O",
			},
		];
		const kernel = {
			introspectPrelude: vi.fn().mockResolvedValue(docs),
			execute: vi.fn(async () => OK_RESULT),
			ping: vi.fn(async () => true),
			isAlive: () => true,
			shutdown: vi.fn(async () => {}),
		};
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi.spyOn(PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const firstWarmup = await warmPythonEnvironment(tempDir.path(), "warm-session", true, undefined, "owner-a");
		expect(firstWarmup.ok).toBe(true);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);

		const cachedWarmup = await warmPythonEnvironment(tempDir.path(), "warm-session", true, undefined, "owner-b");
		expect(cachedWarmup.ok).toBe(true);
		expect(kernel.introspectPrelude).toHaveBeenCalledTimes(1);
		expect(startSpy).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-a");
		expect(kernel.shutdown).not.toHaveBeenCalled();

		await executePython("1 + 1", {
			cwd: tempDir.path(),
			sessionId: "warm-session",
			kernelMode: "session",
			kernelOwnerId: "owner-b",
		});

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.execute).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-b");
		expect(kernel.shutdown).toHaveBeenCalledTimes(1);
	});

	it("leaves per-call kernels out of owner-scoped retained cleanup and keeps global cleanup intact", async () => {
		const perCallKernel = new FakeKernel();
		const retainedKernel = new FakeKernel();
		const unownedRetainedKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(PythonKernel, "start")
			.mockResolvedValueOnce(perCallKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(retainedKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(unownedRetainedKernel as unknown as PythonKernelInstance);

		await executePython("print('per-call')", {
			cwd: "/tmp/per-call-owner",
			kernelMode: "per-call",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('retained')", {
			cwd: "/tmp/retained-owner",
			sessionId: "retained-session",
			kernelMode: "session",
			kernelOwnerId: "owner-a",
		});
		await executePython("print('unowned')", {
			cwd: "/tmp/unowned-retained",
			sessionId: "unowned-session",
			kernelMode: "session",
		});

		expect(startSpy).toHaveBeenCalledTimes(3);
		expect(perCallKernel.shutdown).toHaveBeenCalledTimes(1);

		await disposeKernelSessionsByOwner("owner-a");

		expect(perCallKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(retainedKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(unownedRetainedKernel.shutdown).not.toHaveBeenCalled();

		await disposeAllKernelSessions();

		expect(unownedRetainedKernel.shutdown).toHaveBeenCalledTimes(1);
	});
});
