import { describe, expect, test } from "bun:test";
import { rpcCommandMutatesSession } from "../src/modes/rpc/mutation-fence";
import type { RpcCommand } from "../src/modes/rpc/rpc-types";

describe("RPC mutation fencing", () => {
	test("keeps observation commands available while rejecting session mutations", () => {
		expect(rpcCommandMutatesSession({ type: "get_state" })).toBe(false);
		expect(rpcCommandMutatesSession({ type: "get_messages" })).toBe(false);
		expect(rpcCommandMutatesSession({ type: "prompt", message: "mutate" })).toBe(true);
		expect(rpcCommandMutatesSession({ type: "abort" })).toBe(true);
	});

	test("defaults newly added commands to mutation-fenced", () => {
		const futureCommand = { type: "future_command" } as unknown as RpcCommand;
		expect(rpcCommandMutatesSession(futureCommand)).toBe(true);
	});
});
