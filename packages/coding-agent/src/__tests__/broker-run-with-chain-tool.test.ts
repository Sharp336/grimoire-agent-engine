import { describe, expect, it } from "bun:test";
import { z } from "zod/v4";
import type { ExtensionContext, ToolDefinition } from "../extensibility/extensions/types";
import { SecretBroker } from "../secrets/broker/broker";
import type { ChainStep } from "../secrets/broker/chain";
import { createRunWithChainTool } from "../secrets/broker/run-with-chain-tool";
import type { SecretHandle, SecretValue, VaultProvider } from "../secrets/broker/types";

/**
 * Tier-3 Task 3: `run_with_chain` extension tool.
 *
 * The tool is the agent's interface to the cross-provider chaining capability.
 * It takes an ordered array of steps, calls `runWithChain()`, and returns the
 * final step's scrubbed ExecResult as JSON text. The agent sees only the final
 * step's scrubbed output — intermediate steps' stdout never leaves the broker.
 * Fail-closed (R2): a chain failure yields an error ExecResult, never a throw.
 *
 * These tests exercise the tool end-to-end with a real {@link SecretBroker} +
 * mock provider (the tool is a thin forwarder over `runWithChain`, which calls
 * `broker.getProvider()`; a broker stub without `getProvider` would not
 * exercise the real chain path).
 */

/** A mock provider whose resolved value is fixed at construction time. */
class MockProvider implements VaultProvider {
	readonly name: string;
	readonly #value: string;
	constructor(name: string, value: string) {
		this.name = name;
		this.#value = value;
	}
	async resolve(handle: SecretHandle): Promise<SecretValue> {
		return { handle, value: this.#value };
	}
	async isAvailable(): Promise<boolean> {
		return true;
	}
}

/** Build a broker with one mock provider that resolves to `secretValue`. */
function brokerWithProvider(name: string, secretValue: string): SecretBroker {
	const broker = new SecretBroker();
	broker.registerProvider(new MockProvider(name, secretValue));
	return broker;
}

/** Narrow a content block to a text block and return its text. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	if (block?.type !== "text" || typeof block?.text !== "string") {
		throw new Error("expected a text content block");
	}
	return block.text;
}

describe("Tier-3 Task 3: run_with_chain tool", () => {
	it("the tool definition has the correct name, approval tier, and label", () => {
		const tool = createRunWithChainTool(new SecretBroker());
		const def: ToolDefinition = tool;
		expect(def.name).toBe("run_with_chain");
		expect(def.label).toBe("Run with Chain");
		expect(def.approval).toBe("exec");
	});

	it("the parameter schema is a zod object with a steps array (1..5) of step objects", () => {
		const tool = createRunWithChainTool(new SecretBroker());
		expect(tool.parameters).toBeInstanceOf(z.ZodObject);
		const shape = (tool.parameters as z.ZodObject).shape;
		expect(shape.steps).toBeDefined();
		const stepsSchema = shape.steps as z.ZodArray;
		expect(stepsSchema).toBeInstanceOf(z.ZodArray);
		const elementShape = (stepsSchema.element as z.ZodObject).shape;
		expect(elementShape.handle).toBeDefined();
		expect(elementShape.command).toBeDefined();
		expect(elementShape.args).toBeDefined();
		expect(elementShape.envKey).toBeDefined();
		expect(elementShape.cwd).toBeDefined();
		expect(elementShape.timeoutMs).toBeDefined();
		expect(elementShape.outputKey).toBeDefined();
		const handleShape = (elementShape.handle as z.ZodObject).shape;
		expect(handleShape.provider).toBeDefined();
		expect(handleShape.itemId).toBeDefined();
		expect(handleShape.field).toBeDefined();
	});

	it("execute() calls runWithChain() and returns JSON-serialized ExecResult (last step scrubbed)", async () => {
		const broker = brokerWithProvider("provider-a", "alpha-secret-1234");
		const tool = createRunWithChainTool(broker);

		const steps: ChainStep[] = [
			{
				handle: { provider: "provider-a", itemId: "item-1" },
				command: "printenv",
				args: ["SECRET_A"],
				envKey: "SECRET_A",
			},
		];

		const result = await tool.execute("call-1", { steps }, undefined, undefined, {} as ExtensionContext);

		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
		const parsed = JSON.parse(textOf(result)) as { exitCode: number; stdout: string; stderr: string };
		expect(parsed.exitCode).toBe(0);
		// The resolved secret is scrubbed from the returned stdout.
		expect(parsed.stdout).not.toContain("alpha-secret-1234");
		expect(parsed.stdout).toContain("[REDACTED]");
		expect(parsed.stderr).toBe("");
	});

	it("execute() returns an error ExecResult (does NOT throw) on chain failure — fail-closed", async () => {
		// No providers registered → runWithChain returns an error ExecResult.
		const tool = createRunWithChainTool(new SecretBroker());

		const steps: ChainStep[] = [
			{
				handle: { provider: "ghost", itemId: "item-1" },
				command: "echo",
				args: ["should-not-run"],
				envKey: "SECRET_A",
			},
		];

		// Must not throw; the agent always gets a structured JSON result.
		const result = await tool.execute("call-2", { steps }, undefined, undefined, {} as ExtensionContext);

		const parsed = JSON.parse(textOf(result)) as { exitCode: number; stdout: string; stderr: string };
		expect(parsed.exitCode).toBe(-1);
		expect(parsed.stderr).toContain("[CHAIN]");
		expect(parsed.stdout).toBe("");
		// A synthetic raw secret value must not appear anywhere in the result.
		const blob = JSON.stringify(result);
		expect(blob).not.toContain("super-secret-value");
	});

	it("the description explains the multi-step chain and that the agent sees only the final scrubbed output", () => {
		const tool = createRunWithChainTool(new SecretBroker());
		expect(tool.description.toLowerCase()).toContain("chain");
		expect(tool.description).toMatch(/final|scrubbed|last step/i);
	});
});
