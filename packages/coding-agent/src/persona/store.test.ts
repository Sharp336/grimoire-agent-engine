import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import { FilePersonaStore } from "./store";
import { createEmptyPersona } from "./types";

describe("FilePersonaStore", () => {
	const tmpPath = path.join(os.tmpdir(), `test-persona-${Date.now()}.json`);
	let store: FilePersonaStore;

	beforeEach(() => {
		store = new FilePersonaStore(tmpPath);
	});

	afterEach(async () => {
		try {
			await Bun.file(tmpPath).delete();
		} catch {}
	});

	it("returns undefined when file does not exist", async () => {
		const result = await store.load();
		expect(result).toBeUndefined();
	});

	it("round-trips persona data", async () => {
		const persona = createEmptyPersona();
		persona.basics.mbti = "INTJ";
		await store.save(persona);
		const loaded = await store.load();
		expect(loaded?.basics.mbti).toBe("INTJ");
	});
});
