import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const runtime = readFileSync(resolve(root, "src/vibe/runtime.ts"), "utf8");
const director = readFileSync(resolve(root, "src/prompts/system/vibe-mode-active.md"), "utf8");

describe("delegated skill dependency boundary", () => {
  test("worker bootstrap injects boundary without forwarding AGENTS.md", () => {
    expect(runtime).toContain("VIBE_DELEGATED_WORKER_BOUNDARY");
    expect(runtime).toContain("contextFiles: session.contextFiles?.filter");
    expect(runtime).toContain('path.basename(file.path).toLowerCase() !== "agents.md"');
    expect(runtime).toContain('"type":"dependency_required"');
    expect(runtime).toContain('"execution_owner":"parent_active_session"');
    expect(runtime).toContain('"reason":"delegated_worker_boundary"');
  });

  test("director consumes dependency and validates parent dispatch evidence", () => {
    expect(director).toContain("dependency_required");
    expect(director).toContain("/skill:<skill> <args>");
    expect(director).toContain("skill-dispatch-result/v1");
    expect(director).toContain("Never describe");
  });
});
