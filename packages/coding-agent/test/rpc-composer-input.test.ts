import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { ComposerInputRouter } from "../src/modes/controllers/composer-input-router";
import { PromptDocumentService } from "../src/modes/controllers/prompt-document-service";

function router(overrides: Partial<ConstructorParameters<typeof ComposerInputRouter>[0]> = {}) {
	return new ComposerInputRouter({
		isStreaming: false,
		queuedMessageCount: 0,
		isCompacting: false,
		expandEmoticons: false,
		...overrides,
	});
}

describe("RPC composer parity", () => {
	it("accepts image-only primary submissions", async () => {
		const result = await router().route("", [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		expect(result).toEqual({
			kind: "prompt",
			text: "",
			images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
		});
	});

	it("keeps builtin, shell, Python, and follow-up precedence in one route", async () => {
		const builtin = await router({ builtin: async text => text === "/help" ? { consumed: true } : undefined }).route("/help");
		expect(builtin).toEqual({ kind: "builtin", text: "/help", consumed: true });
		expect(await router().route("! printf ok")).toEqual({ kind: "bash", command: "printf ok", excludeFromContext: false });
		expect(await router().route("$ print(1)")).toEqual({ kind: "python", code: "print(1)", excludeFromContext: false });
		expect(await router({ isStreaming: true }).route("later", undefined, "followUp")).toEqual({ kind: "follow-up", text: "later" });
	});

	it("normalizes small pastes and expands marker-backed large pastes", async () => {
		const documents = new PromptDocumentService();
		const small = documents.insertPastedText("a\r\nb\t\u0001");
		expect(small).toEqual({ kind: "inserted", text: "a\nb   ", lineCount: 2, marker: false });
		const large = documents.insertPastedText("line\n".repeat(12));
		expect(large.kind).toBe("inserted");
		if (large.kind !== "inserted") return;
		expect(large.marker).toBe(true);
		expect(documents.expandPasteMarkers(large.text)).toBe("line\n".repeat(12));
	});

	it("offers an RPC large-paste choice and writes local documents atomically", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-rpc-paste-"));
		const documents = new PromptDocumentService({ getLocalRoot: () => root });
		const pending = documents.insertPastedText("line\n".repeat(4), 3);
		expect(pending.kind).toBe("pending-choice");
		if (pending.kind !== "pending-choice") return;
		const resolved = await documents.resolvePasteChoice(pending.pending.id, "localFile");
		expect(resolved.localFile).toMatch(/^local:\/\/paste-1\.md$/);
		expect(await readFile(join(root, "paste-1.md"), "utf8")).toBe("line\n".repeat(4));
	});
});
