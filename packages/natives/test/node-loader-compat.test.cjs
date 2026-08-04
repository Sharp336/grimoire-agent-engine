"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

test("native entrypoint imports under Node", () => {
  const entrypoint = path.resolve(__dirname, "../native/loader-state.js");
  const moduleUrl = pathToFileURL(entrypoint).href;
  const script = [
    `const loader = await import(${JSON.stringify(moduleUrl)});`,
    "const context = loader.initLoaderContext({ platform: \"win32\", arch: \"x64\", isCompiledBinary: false });",
    "if (!context.nativeDir.endsWith(\"\\\\packages\\\\natives\\\\native\")) throw new Error(`unexpected native directory: ${context.nativeDir}`);",
  ].join("\n");
  try {
    execFileSync("node", ["--input-type=module", "-e", script], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);
    assert.fail(`Node could not import the native entrypoint:\n${stderr}`);
  }
});
