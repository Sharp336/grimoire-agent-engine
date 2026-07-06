import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../cli/args";
import { normalizeNikoflowCommandArgs } from "../../cli/nikoflow-command";
import { rejectNikoflowInNonInteractiveMode } from "../../main";

describe("nikoflow CLI activation guard", () => {
	test("rejects nikoflow in print or non-interactive mode", () => {
		expect(() => rejectNikoflowInNonInteractiveMode("niko flow:standard do it")).toThrow(
			"Nikoflow requires interactive mode",
		);
		expect(() => rejectNikoflowInNonInteractiveMode(undefined, "tactical")).toThrow(
			"Nikoflow requires interactive mode",
		);
		expect(() => rejectNikoflowInNonInteractiveMode("plain prompt")).not.toThrow();
	});

	test("allows nikoflow in non-interactive batch mode", () => {
		expect(() => rejectNikoflowInNonInteractiveMode("niko flow:standard do it", undefined, true)).not.toThrow();
	});

	test("parses the nikoflow batch flag into root args", () => {
		expect(normalizeNikoflowCommandArgs(["--batch", "deep", "ship it"])).toEqual({
			depth: "deep",
			autonomous: true,
			argv: ["ship it"],
		});

		const parsed = parseArgs(["--nikoflow-depth", "standard", "--nikoflow-batch", "ship it"]);
		expect(parsed.nikoflowDepth).toBe("standard");
		expect(parsed.nikoflowBatch).toBe(true);
		expect(parsed.messages).toEqual(["ship it"]);
	});
});
