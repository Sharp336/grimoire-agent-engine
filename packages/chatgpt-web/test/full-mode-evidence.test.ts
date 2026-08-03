import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const evidenceSchema = {
	type: "object",
	additionalProperties: false,
	required: ["schemaVersion", "mode", "runtime", "checks"],
	properties: {
		schemaVersion: { const: 1 },
		mode: { const: "full" },
		runtime: {
			type: "object",
			additionalProperties: false,
			required: ["brokerBeforeTunnel", "epochMatched"],
			properties: {
				brokerBeforeTunnel: { type: "boolean" },
				epochMatched: { type: "boolean" },
			},
		},
		checks: {
			type: "array",
			minItems: 8,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["name", "status"],
				properties: {
					name: {
						enum: [
							"read",
							"write-approved",
							"write-denied",
							"tool-error",
							"cancel-pending",
							"continuation",
							"replay-rejected",
							"pro-rejected",
						],
					},
					status: { enum: ["passed", "blocked"] },
				},
			},
		},
	},
} as const;

const forbiddenKeys: Readonly<Record<string, true>> = {
	account: true,
	cookie: true,
	cookies: true,
	dom: true,
	header: true,
	headers: true,
	profilepath: true,
	prompt: true,
	prompts: true,
	rawchildoutput: true,
	runtimekey: true,
	secret: true,
	token: true,
	tunnelsecret: true,
};

function assertRedacted(value: unknown): void {
	const pending: unknown[] = [value];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== "object" || visited.has(current)) continue;
		visited.add(current);
		for (const [key, child] of Object.entries(current)) {
			const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
			if (forbiddenKeys[normalized]) throw new Error(`forbidden evidence field: ${key}`);
			pending.push(child);
		}
	}
}

describe("full-mode evidence", () => {
	test("writes only schema-valid redacted acceptance outcomes", () => {
		const evidence = {
			schemaVersion: 1,
			mode: "full",
			runtime: { brokerBeforeTunnel: true, epochMatched: true },
			checks: [
				{ name: "read", status: "passed" },
				{ name: "write-approved", status: "passed" },
				{ name: "write-denied", status: "passed" },
				{ name: "tool-error", status: "passed" },
				{ name: "cancel-pending", status: "passed" },
				{ name: "continuation", status: "passed" },
				{ name: "replay-rejected", status: "passed" },
				{ name: "pro-rejected", status: "passed" },
			],
		} as const;
		const validator = new AjvJsonSchemaValidator().getValidator(evidenceSchema);
		expect(validator(evidence).valid).toBe(true);
		expect(() => assertRedacted(evidence)).not.toThrow();

		const root = mkdtempSync(join(tmpdir(), "chatgpt-web-local-evidence-"));
		try {
			const file = join(root, "full-mode.json");
			writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
			const bytes = readFileSync(file, "utf8");
			expect(JSON.parse(bytes)).toEqual(evidence);
			for (const canary of [
				"account-canary",
				"cookie-canary",
				"profile-path-canary",
				"prompt-canary",
				"raw-child-canary",
				"tunnel-secret-canary",
			]) {
				expect(bytes).not.toContain(canary);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects forbidden evidence fields even when nested", () => {
		expect(() => assertRedacted({ checks: [{ status: "passed", rawChildOutput: "canary" }] })).toThrow(
			/forbidden evidence field/,
		);
	});
});
