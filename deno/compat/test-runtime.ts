import { $ } from "bun";
import { spawn, spawnSync } from "bun";

console.log("=== Test 1: $ shell basic ===");
const r1 = await $`echo hello`.quiet();
console.log("exitCode:", r1.exitCode);
console.log("stdout:", new TextDecoder().decode(r1.stdout));
console.log("stderr:", new TextDecoder().decode(r1.stderr));

console.log("\n=== Test 2: $ shell .text() ===");
const r2 = await $`echo world`.quiet().text();
console.log("text:", JSON.stringify(r2));

console.log("\n=== Test 3: $ shell .nothrow() ===");
const r3 = await $`exit 42`.quiet().nothrow();
console.log("exitCode:", r3.exitCode);

console.log("\n=== Test 4: $ shell .cwd() ===");
const r4 = await $`pwd`.quiet().cwd("/tmp");
console.log("cwd result:", r4.stdout.toString().trim());

console.log("\n=== Test 5: $ shell .env() ===");
const r5 = await $`echo $MY_TEST_VAR`.quiet().env({ MY_TEST_VAR: "it-works" });
console.log("env result:", r5.stdout.toString().trim());

console.log("\n=== Test 6: Bun.spawn basic ===");
const child6 = spawn(["echo", "spawn-works"], {
  stdout: "pipe",
  stderr: "pipe",
});
const code6 = await child6.exited;
const out6 = new Response(child6.stdout).text();
const err6 = new Response(child6.stderr).text();
console.log("exitCode:", code6);
console.log("stdout:", JSON.stringify(await out6));
console.log("stderr:", JSON.stringify(await err6));

console.log("\n=== Test 7: Bun.spawn stdin Uint8Array ===");
const child7 = spawn(["cat"], {
  stdin: new TextEncoder().encode("hello from stdin\n"),
  stdout: "pipe",
  stderr: "pipe",
});
const code7 = await child7.exited;
const out7 = await new Response(child7.stdout).text();
console.log("stdin echo:", JSON.stringify(out7));

console.log("\n=== Test 8: Bun.spawn kill ===");
const child8 = spawn(["sleep", "60"], { stdout: "pipe", stderr: "pipe" });
child8.kill();
const code8 = await child8.exited;
console.log("killed exitCode:", code8);

console.log("\n=== Test 9: Bun.spawnSync ===");
const r9 = spawnSync(["echo", "sync-works"], {
  stdout: "pipe",
  stderr: "pipe",
});
console.log("spawnSync exitCode:", r9.exitCode);
console.log("spawnSync stdout:", r9.stdout.toString().trim());

console.log("\n=== Test 10: Bun.spawn streaming stdout via getReader ===");
const child10 = spawn(
  ["bash", "-c", "for i in 1 2 3; do echo line$i; sleep 0.1; done"],
  { stdout: "pipe", stderr: "pipe" },
);
const reader = (child10.stdout as ReadableStream<Uint8Array>).getReader();
const chunks: string[] = [];
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(new TextDecoder().decode(value));
}
const code10 = await child10.exited;
console.log("streaming exitCode:", code10);
console.log("streaming chunks:", chunks.length, "total text:", chunks.join(""));

console.log("\n=== Test 11: Bun.serve ===");
const { serve } = await import("bun");
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  reusePort: false,
  fetch: (req) => new Response(`hello from serve, url=${req.url}`),
});
console.log("server.port:", server.port);
const resp = await fetch(`http://127.0.0.1:${server.port}/test`);
console.log("response:", await resp.text());
server.stop(true);
console.log("server stopped");

console.log("\n=== All tests passed ===");
