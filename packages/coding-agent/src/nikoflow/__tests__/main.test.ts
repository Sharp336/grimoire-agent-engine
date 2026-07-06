import { describe, expect, test } from "bun:test";
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
});
