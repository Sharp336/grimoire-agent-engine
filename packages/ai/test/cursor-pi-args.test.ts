import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	cursorEditOwnedReadPath,
	cursorRawReadPath,
	cursorWriteDisplayContent,
	cursorWritePayload,
	omitUndefinedArgs,
	piGrepSkip,
	piReadPath,
} from "../src/providers/cursor-pi-args";

import type { Tool } from "../src/types";
import { validateToolArguments } from "../src/utils/validation";

describe("cursorWritePayload", () => {
	it("prefers non-empty file_bytes over empty proto3 file_text", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const payload = cursorWritePayload({ fileText: "", fileBytes: png });
		expect(payload).toEqual({ mode: "bytes", bytes: png });
		expect(cursorWriteDisplayContent(payload)).toBe("[binary 8 bytes]");
	});

	it("uses file_text when file_bytes is empty", () => {
		expect(cursorWritePayload({ fileText: "hello", fileBytes: new Uint8Array() })).toEqual({
			mode: "text",
			text: "hello",
		});
	});

	it("decodes JSON/base64 file_bytes that have no byteLength", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const b64 = Buffer.from(png).toString("base64");
		expect(cursorWritePayload({ fileText: "", fileBytes: b64 })).toEqual({ mode: "bytes", bytes: png });
		expect(cursorWritePayload({ fileText: "", fileBytes: { type: "Buffer", data: Array.from(png) } })).toEqual({
			mode: "bytes",
			bytes: png,
		});
	});

	it("decodes file_text when encoding_hint is base64", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const payload = cursorWritePayload({
			fileText: Buffer.from(png).toString("base64"),
			fileBytes: new Uint8Array(),
			encodingHint: "base64",
		});
		expect(payload).toEqual({ mode: "bytes", bytes: png });
	});

	it("keeps non-base64 file_text when encoding_hint is base64", () => {
		expect(cursorWritePayload({ fileText: "not-valid-base64!!!", encodingHint: "base64" })).toEqual({
			mode: "text",
			text: "not-valid-base64!!!",
		});
	});

	it("ignores { data: number[] } objects that are not Node Buffers", () => {
		expect(cursorWritePayload({ fileText: "hello", fileBytes: { data: [1, 2, 3] } })).toEqual({
			mode: "text",
			text: "hello",
		});
	});
});

describe("omitUndefinedArgs", () => {
	it("drops keys whose value is undefined and keeps defined optionals", () => {
		expect(
			omitUndefinedArgs({
				command: "pwd",
				cwd: undefined,
				timeout: 30,
			}),
		).toEqual({ command: "pwd", timeout: 30 });
		expect(
			omitUndefinedArgs({
				pattern: "needle",
				path: ".",
				case: false,
				skip: piGrepSkip(undefined),
			}),
		).toEqual({ pattern: "needle", path: ".", case: false });
	});

	it("makes Cursor-style bash/grep frames pass ArkType optional-field validation", () => {
		const bashTool: Tool = {
			name: "bash",
			description: "",
			parameters: type({
				command: type("string").describe("command to execute"),
				"timeout?": type("number").describe("timeout"),
				"cwd?": type("string").describe("working directory"),
			}),
		};
		const grepTool: Tool = {
			name: "grep",
			description: "",
			parameters: type({
				pattern: type("string").describe("regex pattern"),
				"path?": type("string").describe("path"),
				"case?": type("boolean").describe("case-sensitive search"),
				"skip?": type("number").or("null").describe("files to skip"),
			}),
		};

		// Mirrors the Cursor bridge: empty workingDirectory → `cwd: undefined`.
		const workingDirectory = "";
		const rawBash = {
			command: "git status",
			cwd: workingDirectory || undefined,
			timeout: 30,
		};
		expect(() =>
			validateToolArguments(bashTool, { type: "toolCall", id: "b1", name: "bash", arguments: rawBash }),
		).toThrow(/cwd must be working directory \(was undefined\)/);
		expect(
			validateToolArguments(bashTool, {
				type: "toolCall",
				id: "b2",
				name: "bash",
				arguments: omitUndefinedArgs(rawBash),
			}),
		).toEqual({ command: "git status", timeout: 30 });

		// Mirrors the Cursor bridge: caseInsensitive unset → `case: undefined`.
		const caseInsensitive: boolean | undefined = undefined;
		const rawGrep = {
			pattern: "needle",
			path: ".",
			case: caseInsensitive === true ? false : undefined,
			skip: piGrepSkip(undefined),
		};
		expect(() =>
			validateToolArguments(grepTool, { type: "toolCall", id: "g1", name: "grep", arguments: rawGrep }),
		).toThrow(/case must be case-sensitive search \(was undefined\)/);
		expect(
			validateToolArguments(grepTool, {
				type: "toolCall",
				id: "g2",
				name: "grep",
				arguments: omitUndefinedArgs(rawGrep),
			}),
		).toEqual({ pattern: "needle", path: "." });
	});
});

describe("cursorRawReadPath", () => {
	it("appends :raw to a whole-file path so hashline markup is not returned", () => {
		expect(cursorRawReadPath("/tmp/note.txt")).toBe("/tmp/note.txt:raw");
	});

	it("inserts raw before an existing line range instead of dropping the range", () => {
		expect(cursorRawReadPath("/tmp/note.txt:10-20")).toBe("/tmp/note.txt:raw:10-20");
	});

	it("leaves a path that already carries raw alone", () => {
		expect(cursorRawReadPath("/tmp/note.txt:raw")).toBe("/tmp/note.txt:raw");
		expect(cursorRawReadPath("/tmp/note.txt:raw:2+3")).toBe("/tmp/note.txt:raw:2+3");
	});

	it("does not stack a second :raw when a range is composed onto a raw path", () => {
		expect(piReadPath("/tmp/note.txt:raw", 2, 1)).toBe("/tmp/note.txt:raw:2+1");
		expect(cursorEditOwnedReadPath("/tmp/note.txt", 2, 1)).toBe("/tmp/note.txt:raw:2+1");
	});
});
