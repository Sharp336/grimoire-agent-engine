import { afterEach, expect, it, spyOn } from "bun:test";
import { EngineRuntime } from "../src/engine/runtime";
import { EngineStore } from "../src/engine/store";
import * as storage from "../src/session/storage-client";
import { STORAGE_PROTOCOL_SCHEMA_HASH } from "../src/session/storage-protocol";

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});
const spies: Array<{ mockRestore(): void }> = [];

it("rejects malformed or unavailable native bindings without opening a legacy database", async () => {
	const legacy = spyOn(EngineStore, "open");
	spies.push(legacy);
	const binding = spyOn(storage, "readStorageBinding").mockImplementation(() => {
		throw new Error("Invalid ClientHost storage binding");
	});
	spies.push(binding);
	await expect(EngineRuntime.create({ databasePath: "must-not-be-created.sqlite" })).rejects.toThrow(
		"Invalid ClientHost",
	);
	expect(legacy).not.toHaveBeenCalled();
	binding.mockReturnValue({
		url: "http://127.0.0.1:12345",
		token: "0123456789012345",
		incarnation: 1,
		protocolHash: STORAGE_PROTOCOL_SCHEMA_HASH,
	});
	const unavailable = spyOn(storage.StorageClient.prototype, "runtimeQuery").mockRejectedValue(
		new Error("Owner unavailable"),
	);
	spies.push(unavailable);
	await expect(EngineRuntime.create({ databasePath: "must-not-be-created.sqlite" })).rejects.toThrow(
		"Owner unavailable",
	);
	expect(legacy).not.toHaveBeenCalled();
});
