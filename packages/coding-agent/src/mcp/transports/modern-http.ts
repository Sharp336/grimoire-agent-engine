/**
 * MCP 2026-07-28 request metadata and tool-parameter headers.
 *
 * These headers are opt-in: a request without the negotiated protocol version in
 * `_meta` remains a legacy 2025-03-26 request.
 */
import { setGeneratedHeader } from "./header-policy";

const MCP_PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const MCP_HEADER_ANNOTATION = "x-mcp-header";
const HTTP_FIELD_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BASE64_SENTINEL_PREFIX = "=?base64?";
const BASE64_SENTINEL_SUFFIX = "?=";
const FORBIDDEN_ANNOTATION_CONTEXT_KEYS = [
	"items",
	"prefixItems",
	"additionalItems",
	"contains",
	"oneOf",
	"anyOf",
	"allOf",
	"not",
	"if",
	"then",
	"else",
	"$ref",
	"$dynamicRef",
	"$recursiveRef",
] as const;

type MCPToolHeaderType = "string" | "integer" | "boolean";

/** A validated mapping from a tool argument path to an MCP parameter header. */
export interface MCPToolHeaderBinding {
	headerName: string;
	path: string[];
	type: MCPToolHeaderType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Encode a string for an MCP HTTP field value.
 *
 * RFC 9110 permits visible ASCII, spaces, and horizontal tabs. Leading or
 * trailing whitespace is encoded so that HTTP trimming cannot change the
 * mirrored value. Values that resemble the sentinel are encoded as well to
 * avoid ambiguity for servers decoding the wire value.
 */
function encodeHeaderValue(value: string): string {
	const plain = /^[\x20-\x7e\t]*$/.test(value);
	const hasLeadingOrTrailingWhitespace = /^\s|\s$/u.test(value);
	const hasSentinelShape = value.startsWith(BASE64_SENTINEL_PREFIX) && value.endsWith(BASE64_SENTINEL_SUFFIX);
	if (plain && !hasLeadingOrTrailingWhitespace && !hasSentinelShape) return value;

	return `${BASE64_SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${BASE64_SENTINEL_SUFFIX}`;
}

/**
 * Add the protocol metadata headers required by MCP 2026-07-28.
 *
 * The presence of a string protocol version in `_meta` is the compatibility
 * switch. No modern headers are added to legacy requests.
 */
export function applyModernRequestHeaders(
	headers: Record<string, string>,
	method: string,
	params: Record<string, unknown>,
): void {
	const metadata = params._meta;
	if (!isRecord(metadata)) return;

	const protocolVersion = metadata[MCP_PROTOCOL_VERSION_META];
	if (typeof protocolVersion !== "string") return;

	setGeneratedHeader(headers, "MCP-Protocol-Version", protocolVersion);
	setGeneratedHeader(headers, "Mcp-Method", method);

	let name: unknown;
	if (method === "tools/call" || method === "prompts/get") {
		name = params.name;
	} else if (method === "resources/read") {
		name = params.uri;
	}
	if (typeof name === "string") {
		setGeneratedHeader(headers, "Mcp-Name", encodeHeaderValue(name));
	}
}

/**
 * Collect and validate all x-mcp-header annotations in a tool input schema.
 *
 * An annotation is valid only on a primitive property reached from the root
 * through `properties` keys. Everything below other schema keywords (including
 * arrays, composition, conditionals, and references) is deliberately treated
 * as non-static and therefore rejected if it contains an annotation.
 */
export function collectToolHeaderBindings(inputSchema: Record<string, unknown>): {
	bindings: MCPToolHeaderBinding[];
	error?: string;
} {
	if (!isRecord(inputSchema)) {
		return { bindings: [], error: "inputSchema must be an object" };
	}

	const bindings: MCPToolHeaderBinding[] = [];
	const seenHeaderNames = new Set<string>();
	let error: string | undefined;
	const activeObjects = new WeakSet<object>();

	const fail = (message: string): void => {
		error ??= message;
	};

	const visit = (value: unknown, path: string[] | null, schemaNode: boolean): void => {
		if (error) return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, null, false);
			return;
		}
		if (!isRecord(value)) return;
		if (activeObjects.has(value)) return;
		activeObjects.add(value);

		if (Object.hasOwn(value, MCP_HEADER_ANNOTATION)) {
			const annotation = value[MCP_HEADER_ANNOTATION];
			const hasForbiddenContext = FORBIDDEN_ANNOTATION_CONTEXT_KEYS.some(key => Object.hasOwn(value, key));
			if (!schemaNode || path === null || path.length === 0 || hasForbiddenContext) {
				fail("x-mcp-header must be on a statically reachable property");
			} else if (typeof annotation !== "string" || !HTTP_FIELD_NAME_TOKEN.test(annotation)) {
				fail("x-mcp-header must be a non-empty HTTP field-name token");
			} else {
				const normalizedName = annotation.toLowerCase();
				if (seenHeaderNames.has(normalizedName)) {
					fail(`duplicate x-mcp-header value: ${annotation}`);
				} else {
					seenHeaderNames.add(normalizedName);
					const type = value.type;
					if (type !== "string" && type !== "integer" && type !== "boolean") {
						fail("x-mcp-header requires type string, integer, or boolean");
					} else {
						bindings.push({
							headerName: `Mcp-Param-${annotation}`,
							path: [...path],
							type,
						});
					}
				}
			}
		}

		for (const [key, child] of Object.entries(value)) {
			if (key === MCP_HEADER_ANNOTATION || error) continue;

			if (key === "properties" && schemaNode) {
				if (!isRecord(child)) {
					visit(child, null, false);
					continue;
				}
				for (const [propertyName, propertySchema] of Object.entries(child)) {
					if (isRecord(propertySchema)) {
						visit(propertySchema, [...(path ?? []), propertyName], true);
					} else {
						// A malformed property schema cannot be a static annotation
						// location, but inspect nested values for forbidden annotations.
						visit(propertySchema, null, false);
					}
				}
				continue;
			}

			// Any annotation below another schema keyword is forbidden, even if
			// that keyword happens to contain a nested object with `properties`.
			visit(child, null, false);
		}

		activeObjects.delete(value);
	};

	visit(inputSchema, [], true);
	return error ? { bindings: [], error } : { bindings };
}

/**
 * Extract and encode validated tool-parameter headers from a call's arguments.
 * Missing, null, and type-mismatched values are omitted.
 */
export function buildToolParameterHeaders(
	bindings: MCPToolHeaderBinding[],
	args: Record<string, unknown>,
): Record<string, string> {
	const headers: Record<string, string> = {};

	for (const binding of bindings) {
		let value: unknown = args;
		let present = true;
		for (const segment of binding.path) {
			if (!isRecord(value) || !Object.hasOwn(value, segment)) {
				present = false;
				break;
			}
			value = value[segment];
		}
		if (!present || value === null || value === undefined) continue;

		let text: string;
		switch (binding.type) {
			case "string":
				if (typeof value !== "string") continue;
				text = value;
				break;
			case "integer":
				if (typeof value !== "number" || !Number.isSafeInteger(value)) continue;
				text = String(value);
				break;
			case "boolean":
				if (typeof value !== "boolean") continue;
				text = value ? "true" : "false";
				break;
			default:
				continue;
		}

		setGeneratedHeader(headers, binding.headerName, encodeHeaderValue(text));
	}

	return headers;
}
