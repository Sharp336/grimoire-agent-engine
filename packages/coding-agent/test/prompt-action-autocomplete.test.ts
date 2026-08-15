import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	KeybindingsManager as AppKeybindingsManager,
	setKeyHintPlatform,
} from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-coding-agent/modes/prompt-action-autocomplete";
import { Editor, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { defaultEditorTheme } from "../../tui/test/test-themes.js";

function onceAutocompleteUpdate(editor: Editor): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const previous = editor.onAutocompleteUpdate;
	editor.onAutocompleteUpdate = () => {
		editor.onAutocompleteUpdate = previous;
		previous?.();
		resolve();
	};
	return promise;
}

describe("prompt action autocomplete", () => {
	beforeEach(() => {
		setKeybindings(
			new KeybindingsManager({
				"tui.editor.cursorLineStart": { defaultKeys: ["home", "f6"], description: "Move cursor to line start" },
				"tui.editor.cursorLineEnd": { defaultKeys: "f7", description: "Move cursor to line end" },
				"tui.editor.undo": { defaultKeys: "f8", description: "Undo" },
			}),
		);
		setKeyHintPlatform("linux");
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		setKeyHintPlatform(undefined);
	});

	it("shows prompt actions with configured shortcut hints", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory({
				"app.clipboard.copyLine": "ctrl+shift+l",
				"app.clipboard.copyPrompt": ["alt+shift+c", "ctrl+shift+c"],
			}),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["#"], 0, 1);
		expect(suggestions).not.toBeNull();
		expect(suggestions?.prefix).toBe("#");
		expect(suggestions?.items.map(item => item.label)).toEqual([
			"Copy current line",
			"Copy whole prompt",
			"Undo",
			"Move cursor to end of message",
			"Move cursor to beginning of message",
			"Move cursor to beginning of line",
			"Move cursor to end of line",
		]);
		expect(suggestions?.items.find(item => item.label === "Copy current line")?.description).toBe("Ctrl+Shift+L");
		expect(suggestions?.items.find(item => item.label === "Copy whole prompt")?.description).toBe(
			"Alt+Shift+C/Ctrl+Shift+C",
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to beginning of line")?.description).toBe(
			"Home/F6",
		);
		expect(suggestions?.items.find(item => item.label === "Move cursor to end of line")?.description).toBe("F7");
		expect(suggestions?.items.find(item => item.label === "Undo")?.description).toBe("F8");
	});

	it("passes the typed trigger to undo and leaves text removal to the editor", async () => {
		let undoCalls = 0;
		let undoPrefix = "";
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: prefix => {
				undoCalls += 1;
				undoPrefix = prefix;
			},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["hello #undo"], 0, 11);
		const item = suggestions?.items.find(entry => entry.label === "Undo");
		expect(item).toBeDefined();
		if (!item || !suggestions) {
			throw new Error("expected undo suggestion");
		}

		const result = provider.applyCompletion(["hello #undo"], 0, 11, item, suggestions.prefix);
		expect(result.lines).toEqual(["hello #undo"]);
		expect(result.cursorLine).toBe(0);
		expect(result.cursorCol).toBe(11);
		result.onApplied?.();
		expect(undoCalls).toBe(1);
		expect(undoPrefix).toBe("#undo");
	});

	it("falls back to normal typing for literal hashtags with no matching action", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const suggestions = await provider.getSuggestions(["release #v1"], 0, 11);
		expect(suggestions).toBeNull();
	});

	it("treats # prompt-action tokens as literal text inside slash command arguments without completions", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "rename", description: "Rename current session", allowArgs: true }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/rename repro #copy";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions).toBeNull();
	});

	it("returns # prompt-action completions for matched slash commands that reject arguments", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "settings", description: "Open settings", allowArgs: false }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/settings #copy";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions?.prefix).toBe("#copy");
		expect(suggestions?.items.map(item => item.label)).toEqual(["Copy current line", "Copy whole prompt"]);
	});

	it("returns slash command argument completions instead of # prompt actions when the command defines them", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [
				{
					name: "rename",
					description: "Rename current session",
					allowArgs: true,
					getArgumentCompletions: argumentPrefix =>
						argumentPrefix === "repro #copy"
							? [{ value: "repro #copy-title", label: "Keep #copy in the title" }]
							: null,
				},
			],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/rename repro #copy";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions).toEqual({
			prefix: "repro #copy",
			items: [{ value: "repro #copy-title", label: "Keep #copy in the title" }],
		});
	});

	it("falls through to internal-url completion for allowArgs commands without argument completions", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "btw", description: "By the way", allowArgs: true }],
			basePath: process.cwd(),
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/btw omp://";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions).not.toBeNull();
		expect(suggestions?.prefix).toBe("omp://");
		expect(suggestions?.items.length).toBeGreaterThan(0);
	});

	it("falls through to internal-url completion when getArgumentCompletions yields no match", async () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [
				{
					name: "mcp",
					description: "MCP",
					allowArgs: true,
					getArgumentCompletions: () => null,
				},
			],
			basePath: process.cwd(),
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const line = "/mcp omp://";
		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions).not.toBeNull();
		expect(suggestions?.prefix).toBe("omp://");
		expect(suggestions?.items.length).toBeGreaterThan(0);
	});

	it("delegates trySyncSlashCompletion to CombinedAutocompleteProvider", () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "model", description: "Switch AI model" }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		const result = provider.trySyncSlashCompletion("/mo");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toContain("model");
	});

	it("returns null from trySyncSlashCompletion for non-slash text", () => {
		const provider = createPromptActionAutocompleteProvider({
			commands: [{ name: "model", description: "Switch AI model" }],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		expect(provider.trySyncSlashCompletion("hello")).toBeNull();
	});

	describe("bang command completion", () => {
		let originalPath: string | undefined;
		let tempDir: string;
		let binDir: string;
		let duplicateBinDir: string;
		let executableName: string;

		beforeEach(() => {
			originalPath = process.env.PATH;
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-action-bang-autocomplete-"));
			binDir = path.join(tempDir, "bin");
			duplicateBinDir = path.join(tempDir, "duplicate-bin");
			fs.mkdirSync(binDir);
			fs.mkdirSync(duplicateBinDir);
			executableName = process.platform === "win32" ? "alpha-tool.cmd" : "alpha-tool";

			const sentinelPath = path.join(tempDir, "should-not-exist");
			for (const directory of [binDir, duplicateBinDir]) {
				const executablePath = path.join(directory, executableName);
				const executableBody =
					process.platform === "win32"
						? `@echo off\r\ntype nul > "${sentinelPath}"\r\n`
						: `#!/bin/sh\ntouch ${JSON.stringify(sentinelPath)}\n`;
				fs.writeFileSync(executablePath, executableBody);
				if (process.platform !== "win32") fs.chmodSync(executablePath, 0o755);
			}
			const otherExecutable = path.join(binDir, process.platform === "win32" ? "alpine-tool.cmd" : "alpine-tool");
			fs.writeFileSync(otherExecutable, "#!/bin/sh\nexit 0\n");
			if (process.platform !== "win32") fs.chmodSync(otherExecutable, 0o755);
			const nonExecutable = path.join(binDir, "alpha-disabled");
			fs.writeFileSync(nonExecutable, "#!/bin/sh\nexit 0\n");
			if (process.platform !== "win32") fs.chmodSync(nonExecutable, 0o644);
			process.env.PATH = [binDir, duplicateBinDir].join(path.delimiter);
		});

		afterEach(() => {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		function createProvider() {
			return createPromptActionAutocompleteProvider({
				commands: [],
				basePath: tempDir,
				keybindings: AppKeybindingsManager.inMemory(),
				copyCurrentLine: () => {},
				copyPrompt: () => {},
				undo: () => {},
				moveCursorToMessageEnd: () => {},
				moveCursorToMessageStart: () => {},
				moveCursorToLineStart: () => {},
				moveCursorToLineEnd: () => {},
			});
		}

		it("delegates forced file completion for bare arguments and path-like executable tokens", async () => {
			fs.writeFileSync(path.join(tempDir, "input.txt"), "content\n");
			fs.writeFileSync(path.join(tempDir, "script.sh"), "#!/bin/sh\nexit 0\n");
			const provider = createProvider();
			const cases = [
				{ line: "! cat inp", prefix: "inp", value: "input.txt" },
				{ line: "! ./scr", prefix: "./scr", value: "./script.sh" },
			];

			for (const { line, prefix, value } of cases) {
				expect(provider.shouldTriggerFileCompletion([line], 0, line.length)).toBe(true);
				const suggestions = await provider.getForceFileSuggestions([line], 0, line.length);
				expect(suggestions?.prefix).toBe(prefix);
				expect(suggestions?.items.map(item => item.value)).toContain(value);
			}

			const slashCommand = "/set";
			expect(provider.shouldTriggerFileCompletion([slashCommand], 0, slashCommand.length)).toBe(false);
		});

		it("opens filesystem candidates on first Tab and applies them on second Tab", async () => {
			fs.writeFileSync(path.join(tempDir, "input.txt"), "content\n");
			fs.writeFileSync(path.join(tempDir, "script.sh"), "#!/bin/sh\nexit 0\n");
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const cases = [
				{ line: "! cat inp", completed: "! cat input.txt" },
				{ line: "! ./scr", completed: "! ./script.sh" },
			];

			for (const { line, completed } of cases) {
				const editor = new Editor(defaultEditorTheme);
				editor.setAutocompleteProvider(createProvider());
				editor.setText(line);

				const autocompleteOpened = onceAutocompleteUpdate(editor);
				editor.handleInput("\t");
				await autocompleteOpened;
				expect(editor.isShowingAutocomplete()).toBe(true);
				expect(editor.getText()).toBe(line);

				editor.handleInput("\t");
				expect(editor.isShowingAutocomplete()).toBe(false);
				expect(editor.getText()).toBe(completed);
			}
		});

		it("applies a unique PATH executable after two Tab inputs through Editor", async () => {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
			const editor = new Editor(defaultEditorTheme);
			editor.setAutocompleteProvider(createProvider());
			const prefix = "alpha-t";
			editor.setText(`! ${prefix}`);

			const autocompleteOpened = onceAutocompleteUpdate(editor);
			editor.handleInput("\t");
			await autocompleteOpened;
			expect(editor.isShowingAutocomplete()).toBe(true);
			expect(editor.getText()).toBe(`! ${prefix}`);

			editor.handleInput("\t");
			expect(editor.isShowingAutocomplete()).toBe(false);
			expect(editor.getText()).toBe(`! ${executableName}`);
		});

		it("completes empty and partial first words for ! and !! from PATH without duplicates or execution", async () => {
			const provider = createProvider();

			for (const sigil of ["!", "!!"]) {
				const emptyLine = `${sigil} `;
				const emptySuggestions = await provider.getSuggestions([emptyLine], 0, emptyLine.length);
				expect(emptySuggestions?.prefix).toBe("");
				expect(emptySuggestions?.items.filter(item => item.value === executableName)).toHaveLength(1);

				const partialLine = `${sigil} alp`;
				const partialSuggestions = await provider.getSuggestions([partialLine], 0, partialLine.length);
				expect(partialSuggestions?.prefix).toBe("alp");
				expect(partialSuggestions?.items.map(item => item.value)).toEqual(
					process.platform === "win32" ? ["alpha-tool.cmd", "alpine-tool.cmd"] : ["alpha-tool", "alpine-tool"],
				);
				expect(partialSuggestions?.items.some(item => item.value === "alpha-disabled")).toBe(false);
			}

			expect(fs.existsSync(path.join(tempDir, "should-not-exist"))).toBe(false);
		});

		it("excludes executable names that would change shell syntax or terminal display", async () => {
			if (process.platform === "win32") return;
			const unsafeNames = [
				"safe$(touch pwn)",
				"safe;touch-pwn",
				"safe\nline",
				"safe\n",
				"safe\r",
				"safe\u001bescape",
			];
			for (const name of unsafeNames) {
				const executablePath = path.join(binDir, name);
				fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
				fs.chmodSync(executablePath, 0o755);
			}
			const provider = createProvider();
			const line = "! safe";
			const suggestions = await provider.getSuggestions([line], 0, line.length);

			expect(suggestions?.items.filter(item => unsafeNames.includes(item.value)) ?? []).toEqual([]);
		});

		it("does not expose executables from a launch-project dotenv PATH", async () => {
			if (process.platform === "win32") return;
			const launchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hostile-completion-env-"));
			const launchBin = path.join(launchRoot, "bin");
			fs.mkdirSync(launchBin);
			const attackerName = "project-pwn";
			const attackerPath = path.join(launchRoot, attackerName);
			fs.writeFileSync(attackerPath, "#!/bin/sh\nexit 0\n");
			fs.chmodSync(attackerPath, 0o755);
			fs.writeFileSync(path.join(launchRoot, ".env"), `PATH=${launchBin}\n`);
			const modulePath = path.resolve(import.meta.dir, "../src/modes/prompt-action-autocomplete.ts");
			const script = `
				const { PromptActionAutocompleteProvider } = await import(${JSON.stringify(modulePath)});
				const provider = new PromptActionAutocompleteProvider([], ${JSON.stringify(launchRoot)}, []);
				const line = "! project";
				const suggestions = await provider.getSuggestions([line], 0, line.length);
				console.log(JSON.stringify(suggestions?.items.map(item => item.value) ?? []));
			`;
			const childEnv = { ...process.env };
			delete childEnv.PATH;
			const child = Bun.spawn([process.execPath, "-e", script], {
				cwd: launchRoot,
				env: childEnv,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);

			try {
				expect(exitCode, stderr).toBe(0);
				expect(JSON.parse(stdout.trim())).toEqual([]);
			} finally {
				fs.rmSync(launchRoot, { recursive: true, force: true });
			}
		});

		it("reuses filesystem completion for later unquoted and quoted path tokens", async () => {
			fs.writeFileSync(path.join(tempDir, "input.ts"), "export {};\n");
			fs.writeFileSync(path.join(tempDir, "input file.txt"), "content\n");
			const provider = createProvider();

			const pathLine = `! ${executableName} ./inp`;
			const pathSuggestions = await provider.getSuggestions([pathLine], 0, pathLine.length);
			expect(pathSuggestions?.prefix).toBe("./inp");
			const pathItem = pathSuggestions?.items.find(item => item.value === "./input.ts");
			expect(pathItem).toBeDefined();
			if (!pathSuggestions || !pathItem) throw new Error("expected path suggestion");
			expect(
				provider.applyCompletion([pathLine], 0, pathLine.length, pathItem, pathSuggestions.prefix).lines,
			).toEqual([`! ${executableName} ./input.ts`]);

			const quotedLine = `!! ${executableName} "input f`;
			const quotedSuggestions = await provider.getSuggestions([quotedLine], 0, quotedLine.length);
			expect(quotedSuggestions?.prefix).toBe('"input f');
			const quotedItem = quotedSuggestions?.items.find(item => item.value === '"input file.txt"');
			expect(quotedItem).toBeDefined();
			if (!quotedSuggestions || !quotedItem) throw new Error("expected quoted path suggestion");
			expect(
				provider.applyCompletion([quotedLine], 0, quotedLine.length, quotedItem, quotedSuggestions.prefix).lines,
			).toEqual([`!! ${executableName} "input file.txt"`]);
		});

		it("replaces only the first command word at a cursor in the middle", async () => {
			const provider = createProvider();
			const line = "! alp --version";
			const cursorCol = "! alp".length;
			const suggestions = await provider.getSuggestions([line], 0, cursorCol);
			const item = suggestions?.items.find(entry => entry.value === executableName);
			expect(suggestions?.prefix).toBe("alp");
			expect(item).toBeDefined();
			if (!suggestions || !item) throw new Error("expected executable suggestion");

			const result = provider.applyCompletion([line], 0, cursorCol, item, suggestions.prefix);
			expect(result.lines).toEqual([`! ${executableName} --version`]);
			expect(result.cursorCol).toBe(`! ${executableName}`.length);
		});

		it("does not expose PATH executables to normal prompts or embedded bangs", async () => {
			const provider = createProvider();

			expect(await provider.getSuggestions(["alp"], 0, 3)).toBeNull();
			const prose = "please run ! alp";
			expect(await provider.getSuggestions([prose], 0, prose.length)).toBeNull();
		});
	});
});
