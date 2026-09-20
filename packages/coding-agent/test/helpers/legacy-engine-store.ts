import type { EngineRuntime } from "../../src/engine/runtime";
import { EngineStore } from "../../src/engine/store";

/** These fixtures intentionally inspect legacy JSONL/SQLite persistence. */
export function legacyEngineStore(runtime: EngineRuntime): EngineStore {
	if (!(runtime.store instanceof EngineStore)) throw new Error("This fixture requires the explicit legacy backend");
	return runtime.store;
}
