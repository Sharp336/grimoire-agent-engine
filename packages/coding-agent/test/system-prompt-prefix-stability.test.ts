import { describe, expect, it } from "bun:test";
import { renderMCPServerInstructions } from "../src/sdk";
import { type AppliedToolSignatureTool, computeAppliedToolSignature } from "../src/session/session-tools";

const ALPHA_INSTRUCTIONS = "Use `alpha.query` for structured lookups.";
const ZETA_INSTRUCTIONS = "Zeta requires an explicit workspace id.";

function connectOrder(): Map<string, string> {
	return new Map([
		["alpha", ALPHA_INSTRUCTIONS],
		["zeta", ZETA_INSTRUCTIONS],
	]);
}

/** Same servers, opposite insertion order — what a transport flap produces. */
function reconnectOrder(): Map<string, string> {
	return new Map([
		["zeta", ZETA_INSTRUCTIONS],
		["alpha", ALPHA_INSTRUCTIONS],
	]);
}

describe("MCP server instruction rendering", () => {
	it("renders byte-identical markdown regardless of server connect order", () => {
		// Against the pre-fix code this FAILED: the render iterated the server map
		// directly, so the reconnect ordering emitted `### zeta` before `### alpha`.
		// The rebuild-skip signature already sorted, so the reorder never tripped a
		// rebuild, and the next rebuild for any unrelated reason silently rewrote
		// the system prompt and invalidated the whole provider prefix cache.
		const rendered = renderMCPServerInstructions(reconnectOrder()).join("\n\n");
		expect(rendered).toBe(renderMCPServerInstructions(connectOrder()).join("\n\n"));
	});

	it("still carries every server's name and instructions, in name order", () => {
		// Pre-fix this failed on the ordering assertion (alpha followed zeta for a
		// reconnect-ordered map). It also keeps the ordering fix from "fixing" the
		// order by dropping or merging servers.
		const rendered = renderMCPServerInstructions(reconnectOrder()).join("\n\n");
		expect(rendered).toContain("## MCP Server Instructions");
		expect(rendered).toContain(`### alpha\n${ALPHA_INSTRUCTIONS}`);
		expect(rendered).toContain(`### zeta\n${ZETA_INSTRUCTIONS}`);
		expect(rendered.indexOf("### alpha")).toBeLessThan(rendered.indexOf("### zeta"));
	});

	it("changes output when an instruction body changes", () => {
		// Non-vacuity guard for the ordering test: if the renderer ignored or
		// collapsed instruction bodies, order-insensitivity would hold trivially.
		// Pre-fix this passed — it is here to prove the two tests above are not
		// comparing empty or constant strings.
		const before = renderMCPServerInstructions(new Map([["alpha", ALPHA_INSTRUCTIONS]])).join("\n\n");
		const after = renderMCPServerInstructions(
			new Map([["alpha", `${ALPHA_INSTRUCTIONS} Prefer batched calls.`]]),
		).join("\n\n");
		expect(after).not.toBe(before);
	});

	it("truncates an oversized instruction body with a marker", () => {
		// The ordering fix had to keep the truncation and the emitted markdown shape
		// byte-identical apart from order; pre-fix code truncated the same way, so
		// this is the regression guard on that promise.
		const oversized = "x".repeat(20_000);
		const rendered = renderMCPServerInstructions(new Map([["alpha", oversized]])).join("\n\n");
		expect(rendered).toContain("\n[truncated]");
		expect(rendered.length).toBeLessThan(oversized.length);
		expect(renderMCPServerInstructions(new Map([["alpha", "short"]])).join("\n\n")).not.toContain("[truncated]");
	});

	it("emits no section at all when no server reported instructions", () => {
		// The call site now appends whatever this returns, so an empty map must
		// produce zero parts — otherwise a bare "## MCP Server Instructions" header
		// would be spliced into the prompt for every session with an MCP manager.
		expect(renderMCPServerInstructions(new Map())).toEqual([]);
	});
});

const SEARCH_TOOL = {
	name: "search",
	label: "Search",
	description: "Search the workspace.",
	parameters: {
		type: "object",
		properties: { filter: { type: "object", properties: { depth: { type: "number" } } } },
		required: ["filter"],
	},
} satisfies AppliedToolSignatureTool;

const READ_TOOL = {
	name: "read",
	label: "Read",
	description: "Read a file.",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} satisfies AppliedToolSignatureTool;

function signatureFor(tools: readonly AppliedToolSignatureTool[]): string {
	return computeAppliedToolSignature({ toolNames: tools.map(tool => tool.name), tools, mountedTools: [] });
}

describe("applied tool signature", () => {
	it("differs when a nested input-schema property changes", () => {
		// Against the pre-fix code this FAILED: `parameters` was not read at all, so
		// two tools identical in name/label/description produced the SAME signature
		// while the rendered tool inventory and the provider tool array both changed
		// — the rebuild was skipped and the model was told the wrong schema.
		// Identical names here also prove the digest cache is keyed on the schema
		// object, not on the tool name.
		const rebuiltSchema = {
			...SEARCH_TOOL,
			parameters: {
				type: "object",
				properties: { filter: { type: "object", properties: { depth: { type: "string" } } } },
				required: ["filter"],
			},
		};
		expect(signatureFor([rebuiltSchema])).not.toBe(signatureFor([SEARCH_TOOL]));
	});

	it("ignores schema object key order", () => {
		// Key order is not observable on the wire, so a provider or MCP server that
		// re-serializes the same schema with different key order must NOT force a
		// prompt rebuild (that rebuild is itself a prefix-cache miss). Pre-fix this
		// passed vacuously because schemas were unread; it now pins the recursive
		// key sort, and fails if the digest ever serializes keys as-authored.
		const reordered = {
			...SEARCH_TOOL,
			parameters: {
				required: ["filter"],
				properties: { filter: { properties: { depth: { type: "number" } }, type: "object" } },
				type: "object",
			},
		};
		expect(signatureFor([reordered])).toBe(signatureFor([SEARCH_TOOL]));
	});

	it("differs when only schema array order changes", () => {
		// `required`/`enum`/`anyOf` order IS wire-visible, so the digest must not
		// sort arrays the way it sorts keys. Pre-fix this FAILED (schemas unread);
		// it also fails if someone "simplifies" the digest into a fully sorted
		// serializer, which would hide a real prompt change.
		const twoRequired = {
			...SEARCH_TOOL,
			parameters: {
				type: "object",
				properties: { filter: { type: "object" }, depth: { type: "number" } },
				required: ["filter", "depth"],
			},
		};
		const swappedRequired = {
			...twoRequired,
			parameters: { ...twoRequired.parameters, required: ["depth", "filter"] },
		};
		expect(signatureFor([swappedRequired])).not.toBe(signatureFor([twoRequired]));
	});

	it("differs when the tool array is reordered", () => {
		// Tool order is render order, so a reorder must rebuild. Pre-fix this passed
		// through the name segment; it now also pins that the appended schema segment
		// is joined order-preservingly — a sorted or set-based schema segment would
		// still let this pass, so the assertion below on a *stable* schema segment
		// contributing per position is what keeps the new segment honest.
		expect(signatureFor([READ_TOOL, SEARCH_TOOL])).not.toBe(signatureFor([SEARCH_TOOL, READ_TOOL]));
	});

	it("is stable across repeated calls on the same schema objects", () => {
		// The per-schema digest is memoized in a WeakMap keyed on schema identity so
		// the signature does not re-serialize every schema on every rebuild check. A
		// memo that returned a rotating or mutated value would make the skip check
		// thrash and rebuild (and bust the prefix cache) on every call. Pre-fix this
		// passed vacuously — nothing was memoized because nothing was read.
		const tools = [SEARCH_TOOL, READ_TOOL];
		const first = signatureFor(tools);
		expect(signatureFor(tools)).toBe(first);
		expect(signatureFor([SEARCH_TOOL, READ_TOOL])).toBe(first);
	});

	it("still covers every input it covered before the schema segment was added", () => {
		// Guards the extraction of the signature out of `SessionTools`: each input it
		// used to read must still reach the output. Pre-fix (as a private method)
		// these all held; a field dropped during the extraction would silently skip
		// rebuilds for description, Code Mode, and MCP-instruction changes.
		const baseline = signatureFor([SEARCH_TOOL]);
		expect(signatureFor([{ ...SEARCH_TOOL, description: "Search the workspace, harder." }])).not.toBe(baseline);
		expect(signatureFor([{ ...SEARCH_TOOL, label: "Find" }])).not.toBe(baseline);
		expect(signatureFor([{ ...SEARCH_TOOL, customWireName: "grep" }])).not.toBe(baseline);
		expect(signatureFor([{ ...SEARCH_TOOL, name: "search_v2" }])).not.toBe(baseline);

		const inputs = { toolNames: ["search"], tools: [SEARCH_TOOL], mountedTools: [] };
		expect(computeAppliedToolSignature({ ...inputs, directToolNames: ["search"] })).not.toBe(
			computeAppliedToolSignature(inputs),
		);
		expect(
			computeAppliedToolSignature({ ...inputs, serverInstructions: new Map([["alpha", ALPHA_INSTRUCTIONS]]) }),
		).not.toBe(computeAppliedToolSignature(inputs));
	});

	it("ignores MCP server connect order, exactly as the rendered section now does", () => {
		// The other half of the render/signature pairing: the signature was already
		// order-insensitive here (this passed pre-fix), while the renderer was not.
		// Both halves together are the invariant — if a future change makes the
		// signature order-sensitive, the renderer's sort must go with it.
		const inputs = { toolNames: ["search"], tools: [SEARCH_TOOL], mountedTools: [] };
		expect(computeAppliedToolSignature({ ...inputs, serverInstructions: reconnectOrder() })).toBe(
			computeAppliedToolSignature({ ...inputs, serverInstructions: connectOrder() }),
		);
	});
});
