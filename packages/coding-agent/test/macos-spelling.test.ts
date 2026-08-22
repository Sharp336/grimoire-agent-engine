import { describe, expect, it, mock } from "bun:test";
import {
	MacOSSpellingProvider,
	type SpellingBackend,
	type SpellingDecorationContext,
} from "../src/modes/macos-spelling";

function backend(overrides: Partial<SpellingBackend>): SpellingBackend {
	return {
		isAvailable: () => true,
		checkSpelling: () => [],
		completeWord: () => [],
		autocorrectWord: () => null,
		spellingGuesses: () => [],
		...overrides,
	};
}

function decorationContext(editorText: string, line: number = 0, startCol: number = 0): SpellingDecorationContext {
	return { editorText, lines: editorText.split("\n"), line, startCol };
}

describe("macOS spelling feature gates", () => {
	it("enables typo detection without enabling autocomplete or autocorrect", () => {
		const completeWord = mock(() => ["received"]);
		const autocorrectWord = mock(() => "received");
		const spellingGuesses = mock(() => ["received", "relieved"]);
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: () => [{ start: 0, length: 8 }],
				completeWord,
				autocorrectWord,
				spellingGuesses,
			}),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: false, autocorrect: false });

		expect(provider.decorateTypos("recieved", decorationContext("recieved"))).toBe(
			"\x1b[4:3m\x1b[58:2::255:95:95mrecieved\x1b[4:0m\x1b[59m",
		);
		expect(provider.getWordCompletion(["recieved"], 0, 8)).toBeNull();
		expect(provider.tryAutocorrect(["recieved "], 0, 9)).toBeNull();
		expect(provider.getWordReplacements(["recieved "], 0, 9)).toEqual({
			line: 0,
			startCol: 0,
			endCol: 8,
			items: ["received", "relieved"],
		});
		expect(completeWord).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
	});

	it("enables word autocomplete without enabling typo detection or autocorrect", () => {
		const checkSpelling = mock(() => [{ start: 4, length: 5 }]);
		const autocorrectWord = mock(() => "weather");
		const spellingGuesses = mock(() => ["weather"]);
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling, completeWord: () => ["weather"], autocorrectWord, spellingGuesses }),
		);
		provider.setFeatures({ typoDetection: false, autocomplete: true, autocorrect: false });

		expect(provider.decorateTypos("The weath", decorationContext("The weath"))).toBe("The weath");
		expect(provider.getWordCompletion(["The weath"], 0, 9)).toBe("er");
		expect(provider.tryAutocorrect(["weath "], 0, 6)).toBeNull();
		expect(provider.getWordReplacements(["The weath"], 0, 6)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});

	it("enables autocorrect without enabling typo detection or autocomplete", () => {
		const checkSpelling = mock(() => [{ start: 0, length: 10 }]);
		const completeWord = mock(() => ["definitely"]);
		const spellingGuesses = mock(() => ["definitely"]);
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling, completeWord, autocorrectWord: () => "definitely", spellingGuesses }),
		);
		provider.setFeatures({ typoDetection: false, autocomplete: false, autocorrect: true });

		expect(provider.decorateTypos("definately", decorationContext("definately"))).toBe("definately");
		expect(provider.getWordCompletion(["definately"], 0, 10)).toBeNull();
		expect(provider.tryAutocorrect(["definately "], 0, 11)).toEqual({ replaceLen: 11, insert: "definitely " });
		expect(provider.getWordReplacements(["definately"], 0, 5)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(completeWord).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});

	it("skips paths, slash commands, and inline code", () => {
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: text => [
					{ start: text.indexOf("recieved"), length: 8 },
					{ start: text.lastIndexOf("recieved"), length: 8 },
				],
				completeWord: () => ["received"],
				autocorrectWord: () => "received",
			}),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: true });

		expect(provider.decorateTypos("`recieved` /tmp/recieved", decorationContext("`recieved` /tmp/recieved"))).toBe(
			"`recieved` /tmp/recieved",
		);
		expect(provider.getWordCompletion(["/move reciev"], 0, 12)).toBeNull();
		expect(provider.tryAutocorrect(["/tmp/recieved "], 0, 14)).toBeNull();
	});
	it("skips fenced code while retaining typo detection in surrounding prose", () => {
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: () => [{ start: 0, length: 8 }],
				completeWord: () => ["received"],
				autocorrectWord: () => "received",
				spellingGuesses: () => ["received"],
			}),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: true });
		const fencedText = "outside\n```text\nrecieved\n```";
		const fencedLines = fencedText.split("\n");

		expect(provider.decorateTypos("recieved", decorationContext(fencedText, 2))).toBe("recieved");
		expect(provider.getWordCompletion(["outside", "```text", "reciev", "```"], 2, 6)).toBeNull();
		expect(provider.tryAutocorrect(["```text", "recieved ", "```"], 1, 9)).toBeNull();
		expect(provider.getWordReplacements(fencedLines, 2, 4)).toBeNull();
		expect(provider.decorateTypos("recieved", decorationContext("recieved"))).toContain("\x1b[4:3m");
	});

	it("does no spelling work for huge editor buffers", () => {
		const checkSpelling = mock(() => [{ start: 0, length: 8 }]);
		const completeWord = mock(() => ["received"]);
		const autocorrectWord = mock(() => "received");
		const spellingGuesses = mock(() => ["received"]);
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling, completeWord, autocorrectWord, spellingGuesses }),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: true });
		const lines = ["x".repeat(20_001), "recieved "];
		const editorText = lines.join("\n");

		expect(provider.decorateTypos("recieved", decorationContext(editorText, 1))).toBe("recieved");
		expect(provider.getWordCompletion(["x".repeat(20_001), "reciev"], 1, 6)).toBeNull();
		expect(provider.tryAutocorrect(lines, 1, 9)).toBeNull();
		expect(provider.getWordReplacements(lines, 1, 4)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(completeWord).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});
});
