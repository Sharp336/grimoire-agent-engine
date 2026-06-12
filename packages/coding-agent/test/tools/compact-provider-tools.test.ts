import { describe, expect, it } from "bun:test";
import type { Tool } from "@oh-my-pi/pi-ai";
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
});

describe("compactProviderContext", () => {
	it("leaves context unchanged when mode is off", () => {
		const ctx = { systemPrompt: ["hi"], messages: [], tools: [{ name: "t", description: "d", parameters: {} }] };
		expect(compactProviderContext(ctx, "off")).toBe(ctx);
	});
});
