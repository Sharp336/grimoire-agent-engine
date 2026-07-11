import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { promptSecretLine } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";

class PromptInput extends PassThrough {
	isTTY: boolean;
	isRaw: boolean;
	readonly rawModeCalls: boolean[] = [];

	constructor(isTTY: boolean, isRaw = false) {
		super();
		this.isTTY = isTTY;
		this.isRaw = isRaw;
	}

	setRawMode(mode: boolean): this {
		this.rawModeCalls.push(mode);
		this.isRaw = mode;
		return this;
	}
}

class CapturedOutput extends Writable {
	#text = "";

	get text(): string {
		return this.#text;
	}

	_write(chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.#text += new TextDecoder().decode(chunk);
		callback();
	}
}

const QUESTION = "Paste refresh token: ";

describe("auth-broker secret OAuth prompt", () => {
	test("mutes TTY input without changing the pasted value and restores raw mode", async () => {
		const input = new PromptInput(true, true);
		const output = new CapturedOutput();
		const secret = "  SECRET-SENTINEL-refresh-token_+/= with spaces  ";

		const result = promptSecretLine(input, output, QUESTION);
		input.end(`${secret}\n`);

		await expect(result).resolves.toBe(secret);
		expect(output.text).toBe(QUESTION);
		expect(output.text).not.toContain(secret);
		expect(output.text).not.toContain("\u001b");
		expect(output.text).not.toContain("*");
		expect(input.rawModeCalls).toEqual([true, false, true]);
		expect(input.isRaw).toBe(true);
	});

	test("returns an empty result when the secret prompt receives blank EOF", async () => {
		const input = new PromptInput(true);
		const output = new CapturedOutput();

		const result = promptSecretLine(input, output, QUESTION);
		input.end();

		await expect(result).resolves.toBe("");
		expect(output.text).toBe(QUESTION);
		expect(input.isRaw).toBe(false);
		expect(input.rawModeCalls).toEqual([true, false]);
	});

	test("reads a secret from a non-TTY pipe without enabling raw mode", async () => {
		const input = new PromptInput(false);
		const output = new CapturedOutput();
		const result = promptSecretLine(input, output, QUESTION);

		input.end("piped-refresh-token\n");

		await expect(result).resolves.toBe("piped-refresh-token");
		expect(output.text).toBe(QUESTION);
		expect(input.rawModeCalls).toEqual([]);
	});

	for (const [name, controlByte] of [
		["Ctrl-C", "\u0003"],
		["Escape", "\u001b"],
	] as const) {
		test(`cancels on ${name} and restores raw mode`, async () => {
			const input = new PromptInput(true);
			const output = new CapturedOutput();
			const result = promptSecretLine(input, output, QUESTION);

			input.write(controlByte);

			await expect(result).rejects.toThrow("Login cancelled");
			input.end();
			expect(output.text).toBe(QUESTION);
			expect(input.isRaw).toBe(false);
		});
	}
});
