import { describe, expect, it } from "bun:test";
import { AbortError, abortableSleep } from "../src/abortable";

describe("abortableSleep", () => {
	it("uses the ordinary sleep path without a signal", async () => {
		await abortableSleep(0);
	});

	it("releases a pending sleep when aborted", async () => {
		const controller = new AbortController();
		const sleeping = abortableSleep(60_000, controller.signal);
		controller.abort("cancelled");

		await expect(sleeping).rejects.toBeInstanceOf(AbortError);
	});
});
