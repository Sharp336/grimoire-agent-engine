import { describe, expect, test } from "bun:test";
import { normalizeNikoflowCommandArgs } from "@oh-my-pi/pi-coding-agent/cli/nikoflow-command";
import { isSubcommand } from "@oh-my-pi/pi-coding-agent/cli-commands";

describe("nikoflow command", () => {
	test("is registered as a top-level command", () => {
		expect(isSubcommand("nikoflow")).toBe(true);
		expect(isSubcommand("nflow")).toBe(true);
	});

	test("defaults to standard depth without changing launch args", () => {
		expect(normalizeNikoflowCommandArgs(["--model", "gpt", "fix"])).toEqual({
			depth: "standard",
			autonomous: false,
			argv: ["--model", "gpt", "fix"],
		});
	});

	test("accepts positional and flag depth forms", () => {
		expect(normalizeNikoflowCommandArgs(["tactical", "fix"])).toEqual({
			depth: "tactical",
			autonomous: false,
			argv: ["fix"],
		});
		expect(normalizeNikoflowCommandArgs(["--depth=deep", "-p", "audit"])).toEqual({
			depth: "deep",
			autonomous: false,
			argv: ["-p", "audit"],
		});
	});

	test("accepts batch before positional depth", () => {
		expect(normalizeNikoflowCommandArgs(["--batch", "deep", "fix"])).toEqual({
			depth: "deep",
			autonomous: true,
			argv: ["fix"],
		});
	});

	test("does not let prompt text override explicit depth", () => {
		expect(normalizeNikoflowCommandArgs(["--depth", "standard", "deep", "fix"])).toEqual({
			depth: "standard",
			autonomous: false,
			argv: ["deep", "fix"],
		});
		expect(normalizeNikoflowCommandArgs(["--depth=standard", "deep", "fix"])).toEqual({
			depth: "standard",
			autonomous: false,
			argv: ["deep", "fix"],
		});
	});

	test("maps nikoflow role flags onto launch model-role flags", () => {
		expect(
			normalizeNikoflowCommandArgs(["--exec=cheap", "--architect", "strong-plan", "--qa", "strong-qa", "fix"]),
		).toEqual({
			depth: "standard",
			autonomous: false,
			argv: ["--model", "cheap", "--plan", "strong-plan", "--nikoflow-qa", "strong-qa", "fix"],
		});
	});
});
