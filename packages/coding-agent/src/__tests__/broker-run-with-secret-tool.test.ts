import { describe, expect, it } from "bun:test";
import { z } from "zod/v4";
import type { ExtensionContext, ToolDefinition } from "../extensibility/extensions/types";
import type { SecretBroker } from "../secrets/broker/broker";
import { createRunWithSecretTool } from "../secrets/broker/run-with-secret-tool";
import type { ExecResult } from "../secrets/broker/types";

/**
 * Tier-2 Task 6: `run_with_secret` extension tool.
 *
 * The tool is the agent's ONLY interface to the broker. It takes a secret
 * handle, a command, and an env-key, calls `broker.runWithSecret()`, and
 * returns the scrubbed {@link ExecResult} as JSON text. The raw secret value
 * never appears in the return type. Fail-closed (R2): a broker failure yields
 * an error {@link ExecResult} (exitCode -1), never a throw — the agent always
 * gets a structured result.
 */

/** Minimal broker stub: only `runWithSecret` is exercised by the tool. */
function brokerStub(runWithSecret: SecretBroker["runWithSecret"]): SecretBroker {
	return { runWithSecret } as unknown as SecretBroker;
}

const okResult: ExecResult = { exitCode: 0, stdout: "MY_SECRET=[REDACTED]\nPATH=/usr/bin", stderr: "" };
const errorResult: ExecResult = { exitCode: -1, stdout: "", stderr: "[BROKER] Unknown provider: ghost" };

const sampleParams = {
	handle: { provider: "bitwarden", itemId: "abc-123", field: "password" },
	command: "env",
	args: [] as string[],
	envKey: "MY_SECRET",
};

/** Narrow a content block to a text block and return its text. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content[0];
	if (block?.type !== "text" || typeof block?.text !== "string") {
		throw new Error("expected a text content block");
	}
	return block.text;
}

describe("Tier-2 Task 6: run_with_secret tool", () => {
	it("the tool definition has the correct name, approval tier, and label", () => {
		const tool = createRunWithSecretTool(brokerStub(async () => okResult));
		const def: ToolDefinition = tool;
		expect(def.name).toBe("run_with_secret");
		expect(def.label).toBe("Run with Secret");
		expect(def.approval).toBe("exec");
	});

	it("the parameter schema is a zod object with the required fields", () => {
		const tool = createRunWithSecretTool(brokerStub(async () => okResult));
		expect(tool.parameters).toBeInstanceOf(z.ZodObject);
		const shape = (tool.parameters as z.ZodObject).shape;
		expect(shape.handle).toBeDefined();
		expect(shape.command).toBeDefined();
		expect(shape.args).toBeDefined();
		expect(shape.envKey).toBeDefined();
		expect(shape.cwd).toBeDefined();
		expect(shape.timeoutMs).toBeDefined();
		// handle is itself a zod object with provider/itemId/field.
		const handleShape = (shape.handle as z.ZodObject).shape;
		expect(handleShape.provider).toBeDefined();
		expect(handleShape.itemId).toBeDefined();
		expect(handleShape.field).toBeDefined();
	});

	it("execute() calls broker.runWithSecret() with the forwarded params and returns JSON-serialized ExecResult", async () => {
		let captured: Record<string, unknown> | undefined;
		const tool = createRunWithSecretTool(
			brokerStub(async params => {
				captured = params as Record<string, unknown>;
				return okResult;
			}),
		);

		const result = await tool.execute("call-1", sampleParams, undefined, undefined, {} as ExtensionContext);

		// The broker received exactly the params the tool was given (plus a
		// default timeoutMs when none was supplied).
		expect(captured).toBeDefined();
		expect(captured?.handle).toEqual(sampleParams.handle);
		expect(captured?.command).toBe("env");
		expect(captured?.args).toEqual([]);
		expect(captured?.envKey).toBe("MY_SECRET");
		expect(captured?.timeoutMs).toBe(30000);

		// The return is a single text content block carrying the JSON ExecResult.
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
		const parsed = JSON.parse(textOf(result)) as ExecResult;
		expect(parsed.exitCode).toBe(0);
		expect(parsed.stdout).toContain("[REDACTED]");
		expect(parsed.stderr).toBe("");
	});

	it("execute() forwards an explicit timeoutMs when provided", async () => {
		let captured: Record<string, unknown> | undefined;
		const tool = createRunWithSecretTool(
			brokerStub(async params => {
				captured = params as Record<string, unknown>;
				return okResult;
			}),
		);

		await tool.execute("call-2", { ...sampleParams, timeoutMs: 5000 }, undefined, undefined, {} as ExtensionContext);

		expect(captured?.timeoutMs).toBe(5000);
	});

	it("execute() returns an error ExecResult (does NOT throw) when the broker fails — fail-closed", async () => {
		const tool = createRunWithSecretTool(brokerStub(async () => errorResult));

		// Must not throw; the agent always gets a structured result.
		const result = await tool.execute("call-3", sampleParams, undefined, undefined, {} as ExtensionContext);

		const parsed = JSON.parse(textOf(result)) as ExecResult;
		expect(parsed.exitCode).toBe(-1);
		expect(parsed.stderr).toContain("Unknown provider");
		expect(parsed.stdout).toBe("");
		// The raw secret value must not be present anywhere in the result.
		const blob = JSON.stringify(result);
		expect(blob).not.toContain("super-secret-value");
	});

	it("the description tells the agent the secret is never visible", () => {
		const tool = createRunWithSecretTool(brokerStub(async () => okResult));
		expect(tool.description).toMatch(/never visible|scrubbed/i);
		expect(tool.description.toLowerCase()).toContain("secret");
	});
});
