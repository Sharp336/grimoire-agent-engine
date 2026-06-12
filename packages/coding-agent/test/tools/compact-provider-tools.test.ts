import { describe, expect, it } from "bun:test";
import type { Context, Tool } from "@oh-my-pi/pi-ai";
import { z } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	compactProviderContext,
	compactProviderTools,
	compactToolDescription,
	stripNestedSchemaDescriptions,
} from "../../src/tools/compact-provider-tools";

describe("compactToolDescription", () => {
	it("keeps the first substantive line and drops markdown headings", () => {
		const description = "# Read\n\nReads files and directories.\n\nLong body that should not appear.";
		expect(compactToolDescription(description)).toBe("Reads files and directories.");
	});

	it("truncates long single-line summaries", () => {
		const long = "x".repeat(400);
		const compact = compactToolDescription(long, 50);
		expect(compact.length).toBeLessThanOrEqual(50);
		expect(compact.endsWith("…")).toBe(true);
	});
});

describe("stripNestedSchemaDescriptions", () => {
	it("removes property description fields from wire schema", () => {
		const schema = {
			type: "object",
			properties: {
				path: { type: "string", description: "very long path guidance" },
				_i: { type: "string", description: "intent" },
			},
			required: ["path"],
		};
		const stripped = stripNestedSchemaDescriptions(schema) as {
			properties: Record<string, Record<string, unknown>>;
		};
		expect(stripped.properties.path.description).toBeUndefined();
		expect(stripped.properties.path.type).toBe("string");
		expect(stripped.properties._i.description).toBeUndefined();
	});

	it("does not recurse into enum instance values", () => {
		const schema = {
			type: "string",
			enum: [{ description: "fast", value: 1 }],
		};
		const stripped = stripNestedSchemaDescriptions(schema) as {
			enum: Array<Record<string, unknown>>;
		};
		expect(stripped.enum[0]).toEqual({ description: "fast", value: 1 });
	});
});

describe("compactProviderTools", () => {
	const schema = z.object({
		path: z.string().describe("Path to read"),
		_i: z.string().optional(),
	});

	const tool: Tool = {
		name: "read",
		description: `# Read\n\nReads files.\n\n${"detail ".repeat(200)}`,
		parameters: schema,
	};

	it("returns tools unchanged when mode is off", () => {
		const out = compactProviderTools([tool], "off");
		expect(out?.[0]?.description).toBe(tool.description);
	});

	it("shortens descriptions in description mode", () => {
		const out = compactProviderTools([tool], "description")!;
		expect(out[0]!.description).toBe("Reads files.");
		const wire = toolWireSchema(out[0]!);
		const props = (wire as { properties?: Record<string, { description?: string }> }).properties;
		expect(props?.path?.description).toBe("Path to read");
	});

	it("strips nested schema descriptions in schema mode", () => {
		const out = compactProviderTools([tool], "schema")!;
		const wire = toolWireSchema(out[0]!);
		const props = (wire as { properties?: Record<string, { description?: string }> }).properties;
		expect(props?.path?.description).toBeUndefined();
	});

	it("reuses compacted wire tool per mode on repeated calls", () => {
		const first = compactProviderTools([tool], "description")![0]!;
		const second = compactProviderTools([tool], "description")![0]!;
		expect(second).toBe(first);
	});
});

describe("compactProviderContext", () => {
	it("leaves context unchanged when mode is off", () => {
		const ctx = { systemPrompt: ["hi"], messages: [], tools: [{ name: "t", description: "d", parameters: {} }] };
		expect(compactProviderContext(ctx, "off")).toBe(ctx);
	});

	it("compacts tools and preserves other context fields in description mode", () => {
		const longDesc = `# Read\n\nReads files.\n\n${"detail ".repeat(50)}`;
		const ctx: Context = {
			systemPrompt: ["hi"],
			messages: [{ role: "user", content: "ping", timestamp: 0 }],
			tools: [{ name: "read", description: longDesc, parameters: {} }],
		};
		const out = compactProviderContext(ctx, "description");
		expect(out).not.toBe(ctx);
		expect(out.systemPrompt).toBe(ctx.systemPrompt);
		expect(out.messages).toBe(ctx.messages);
		expect(out.tools?.[0]?.description).toBe("Reads files.");
		expect(out.tools?.[0]?.description).not.toBe(longDesc);
	});
});
