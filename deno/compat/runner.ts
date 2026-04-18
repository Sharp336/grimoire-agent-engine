import "./bootstrap.ts";

const entry = Deno.args[0];
if (!entry) {
  console.error("Usage: deno run deno/compat/runner.ts <entrypoint> [args...]");
  Deno.exit(1);
}

const absPath = await Deno.realPath(entry);
await import(`file://${absPath}`);
