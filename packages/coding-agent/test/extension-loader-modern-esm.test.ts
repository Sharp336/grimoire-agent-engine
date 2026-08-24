import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

describe("extension compatibility dispatch", () => {
  test("loads modern-esm extensions without legacy graph preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-modern-esm-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", omp: { compatibility: "modern-esm" } }));
    await writeFile(join(root, "extension.ts"), "export default pi => pi.setLabel(\"modern\");\n");
    const result = await loadExtensions([join(root, "extension.ts")], root);
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
  });

  test("keeps extensions without modern metadata on the legacy path", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-legacy-esm-"));
    await writeFile(join(root, "extension.ts"), "export default pi => pi.setLabel(\"legacy\");\n");
    const result = await loadExtensions([join(root, "extension.ts")], root);
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
  });
});
