import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type } from "arktype";

/**
 * Regression: llama.cpp (and any grammar-constrained sampler reached via the
 * openai-completions encoder — lm-studio, vllm, loopback) rejects bare boolean
 * JSON Schema subschemas with HTTP 400 "Unrecognized schema: true".
 *
 * `toolWireSchema` intentionally emits `true` for unconstrained fields (issue
 * #1179, so grammar samplers don't read `{}` as "generate an empty object"),
 * and `supportsStrictMode === false` for these hosts so the raw `baseParameters`
 * ship unchanged. An essential tool exposing an `unknown`-typed field — the
 * `task` tool's `outputSchema?: "unknown"` added 2026-07-17 — therefore sent
 * `properties.outputSchema: true` to llama.cpp and 400'd on every request.
 *
 * `compat.sanitizeToolSchemaForGrammar` widens those subschemas (issue #4488
 * Ollama analog) before they reach the sampler.
 */

interface SerializedTool {
	function?: { name?: string; parameters?: Record<string, unknown> };
}
interface ChatCompletionsPayload {
	tools?: SerializedTool[];
}

// ArkType `"unknown"` compiles to `{}` → `normalizeEmptySchemas` rewrites it to
// bare `true` — the exact shape that regressed against llama.cpp.
const toolWithOpenField = {
	name: "spawn",
	description: "spawn a subagent with a caller-supplied output schema",
	parameters: type({
		task: "string",
		"outputSchema?": "unknown",
	}),
} as unknown as Tool;

const context: Context = {
	messages: [{ role: "user", content: "run it", timestamp: 0 }],
	tools: [toolWithOpenField],
};

function llamaCppModel(overrides: Partial<ModelSpec<"openai-completions">>): Model<"openai-completions"> {
	return buildModel({
		id: "qwen-3.6-27b",
		name: "Qwen 3.6 27B",
		api: "openai-completions",
		provider: "llama.cpp",
		baseUrl: "http://localhost:8080/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
		...overrides,
	} satisfies ModelSpec<"openai-completions">);
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capturePayload(target: Model<"openai-completions">): Promise<ChatCompletionsPayload> {
	const { promise, resolve } = Promise.withResolvers<ChatCompletionsPayload>();
	streamOpenAICompletions(target, context, {
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as ChatCompletionsPayload),
	});
	return promise;
}

const SCHEMA_VALUE_KEYS: Record<string, true> = {
	items: true,
	additionalItems: true,
	unevaluatedItems: true,
	additionalProperties: true,
	unevaluatedProperties: true,
	not: true,
	if: true,
	// biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable
	then: true,
	else: true,
	contains: true,
	propertyNames: true,
	contentSchema: true,
};
const SCHEMA_MAP_KEYS: Record<string, true> = {
	properties: true,
	patternProperties: true,
	$defs: true,
	definitions: true,
	dependentSchemas: true,
};
const SCHEMA_ARRAY_KEYS: Record<string, true> = {
	anyOf: true,
	oneOf: true,
	allOf: true,
	prefixItems: true,
};

/** Collect every bare boolean (`true`/`false`) sitting in a schema-value slot. */
function collectBooleanSubschemas(node: unknown, path: string, out: string[]): void {
	if (node === true || node === false) {
		out.push(`${path} = ${node}`);
		return;
	}
	if (Array.isArray(node)) {
		node.forEach((child, i) => {
			collectBooleanSubschemas(child, `${path}[${i}]`, out);
		});
		return;
	}
	if (!node || typeof node !== "object") return;
	for (const [key, value] of Object.entries(node)) {
		if (key in SCHEMA_MAP_KEYS && value && typeof value === "object" && !Array.isArray(value)) {
			for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
				collectBooleanSubschemas(propSchema, `${path}.${key}.${propName}`, out);
			}
		} else if (key in SCHEMA_ARRAY_KEYS && Array.isArray(value)) {
			value.forEach((branch, i) => {
				collectBooleanSubschemas(branch, `${path}.${key}[${i}]`, out);
			});
		} else if (key in SCHEMA_VALUE_KEYS) {
			if (value === true || value === false) out.push(`${path}.${key} = ${value}`);
			else collectBooleanSubschemas(value, `${path}.${key}`, out);
		}
	}
}

describe("openai-completions tool schema — grammar-constrained sampler compatibility", () => {
	it("widens boolean subschemas for llama.cpp so no `true` reaches the grammar generator", async () => {
		const payload = await capturePayload(llamaCppModel({}));
		const parameters = payload.tools?.[0]?.function?.parameters;
		if (!parameters) throw new Error("expected serialized tool parameters");

		const booleanHits: string[] = [];
		collectBooleanSubschemas(parameters, "parameters", booleanHits);
		expect(booleanHits).toEqual([]);

		// The previously-bare-`true` open field is now a value-widening union.
		const outputSchema = (parameters.properties as Record<string, unknown>).outputSchema as Record<string, unknown>;
		expect(outputSchema).not.toBe(true);
		expect(outputSchema.anyOf).toEqual([
			{ type: "string" },
			{ type: "number" },
			{ type: "boolean" },
			{ type: "object" },
			{ type: "array" },
			{ type: "null" },
		]);
	});

	it("applies the same widening to lm-studio and loopback OpenAI-compatible servers", async () => {
		const lmStudio = await capturePayload(
			llamaCppModel({ provider: "lm-studio", baseUrl: "http://127.0.0.1:1234/v1" }),
		);
		const hits: string[] = [];
		collectBooleanSubschemas(lmStudio.tools?.[0]?.function?.parameters, "parameters", hits);
		expect(hits).toEqual([]);
	});

	it("leaves boolean subschemas intact for non-grammar OpenAI hosts", async () => {
		// OpenAI's tool parser accepts bare `true` (valid JSON Schema draft 2020-12),
		// so the sanitizer must NOT fire for cloud hosts — only for local
		// grammar-constrained backends.
		const openai = await capturePayload(
			llamaCppModel({
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				id: "gpt-4o-mini",
				name: "GPT-4o mini",
			}),
		);
		const outputSchema = ((openai.tools?.[0]?.function?.parameters?.properties ?? {}) as Record<string, unknown>)
			.outputSchema;
		expect(outputSchema).toBe(true);
	});
});
