import "@lu-zero/bun-compat";
import "./bootstrap.ts";
import { $, file, write, spawn, Glob, CryptoHasher } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const tmpDir = await Deno.makeTempDir({ prefix: "omp-e2e-" });
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL: ${name}`);
    console.log(`    ${(err as Error).message ?? err}`);
    failed++;
  }
}

console.log("=== E2E: Bun.file() ===");
await test("Bun.file().text()", async () => {
  const p = path.join(tmpDir, "hello.txt");
  await fs.writeFile(p, "hello world");
  const text = await file(p).text();
  if (text !== "hello world") throw new Error(`got "${text}"`);
});
await test("Bun.file().json()", async () => {
  const p = path.join(tmpDir, "data.json");
  await fs.writeFile(p, '{"key":"value"}');
  const data = (await file(p).json()) as Record<string, string>;
  if (data.key !== "value") throw new Error(`got ${JSON.stringify(data)}`);
});
await test("Bun.file().bytes()", async () => {
  const p = path.join(tmpDir, "binary.bin");
  const original = new Uint8Array([1, 2, 3, 4, 5]);
  await fs.writeFile(p, original);
  const bytes = await file(p).bytes();
  if (bytes.length !== 5 || bytes[0] !== 1 || bytes[4] !== 5) {
    throw new Error(`got ${bytes}`);
  }
});
await test("Bun.file().stat()", async () => {
  const p = path.join(tmpDir, "stat.txt");
  await fs.writeFile(p, "stat test");
  const stat = await file(p).stat();
  if (!stat) throw new Error("stat is null");
  if (stat.size !== 9) throw new Error(`size ${stat.size}`);
});

console.log("\n=== E2E: Bun.write() ===");
await test("Bun.write() string", async () => {
  const p = path.join(tmpDir, "subdir", "write.txt");
  await write(p, "written content");
  const text = await file(p).text();
  if (text !== "written content") throw new Error(`got "${text}"`);
});
await test("Bun.write() Uint8Array", async () => {
  const p = path.join(tmpDir, "subdir2", "binary.bin");
  const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  await write(p, data);
  const bytes = await file(p).bytes();
  if (bytes[0] !== 0xde || bytes[3] !== 0xef) {
    throw new Error(`got ${bytes}`);
  }
});
await test("Bun.write() auto-mkdir", async () => {
  const p = path.join(tmpDir, "deep", "nested", "dir", "file.txt");
  await write(p, "deep write");
  const text = await file(p).text();
  if (text !== "deep write") throw new Error(`got "${text}"`);
});

console.log("\n=== E2E: Bun.CryptoHasher ===");
await test("CryptoHasher sha256 hex", async () => {
  const h = new CryptoHasher("sha256").update("hello").digest("hex");
  if (typeof h !== "string")
    throw new Error(`expected string, got ${typeof h}`);
  if (
    h !== "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  ) {
    throw new Error(`hash mismatch: ${h}`);
  }
});
await test("CryptoHasher sha256 Uint8Array", async () => {
  const h = new CryptoHasher("sha256")
    .update(new Uint8Array([1, 2, 3]))
    .digest("hex");
  if (typeof h !== "string") throw new Error(`expected string`);
});

console.log("\n=== E2E: Bun.Glob ===");
await test("Glob.scan() basic", async () => {
  const globDir = path.join(tmpDir, "glob-test");
  await fs.mkdir(globDir, { recursive: true });
  await write(path.join(globDir, "glob1.txt"), "a");
  await write(path.join(globDir, "glob2.txt"), "b");
  await write(path.join(globDir, "glob3.json"), "{}");
  const glob = new Glob("*.txt");
  const results = await glob.scan({ cwd: globDir });
  results.sort();
  if (results.length !== 2)
    throw new Error(`expected 2, got ${results.length}: ${results}`);
  if (results[0] !== "glob1.txt") throw new Error(`first: ${results[0]}`);
});

console.log("\n=== E2E: Bun.Archive ===");
await test("Archive.write + read", async () => {
  const archivePath = path.join(tmpDir, "test.tar.gz");
  await Bun.Archive.write(
    archivePath,
    {
      "file1.txt": "content1",
      "file2.txt": new Uint8Array([0x42, 0x43]),
    },
    { compress: "gzip" },
  );
  const bytes = await file(archivePath).bytes();
  const archive = new Bun.Archive(bytes);
  const files = await archive.files();
  if (!files.has("file1.txt"))
    throw new Error(`missing file1.txt, have: ${[...files.keys()]}`);
  const f1 = await files.get("file1.txt")!.read();
  if (new TextDecoder().decode(f1) !== "content1") {
    throw new Error(`file1 content: ${new TextDecoder().decode(f1)}`);
  }
});

console.log("\n=== E2E: Bun.spawn with Bun.file stdin ===");
await test("spawn reads from pipe", async () => {
  const child = spawn(["cat"], {
    stdin: new TextEncoder().encode("pipe-test-data"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  const out = await new Response(child.stdout).text();
  if (code !== 0) throw new Error(`exit ${code}`);
  if (!out.includes("pipe-test-data")) throw new Error(`got: ${out}`);
});

console.log("\n=== E2E: $ shell advanced ===");
await test("$ captures large output", async () => {
  const r = await $`seq 1 100`.quiet().text();
  const lines = r.trim().split("\n");
  if (lines.length !== 100)
    throw new Error(`expected 100 lines, got ${lines.length}`);
});
await test("$ environment isolation", async () => {
  const r = await $`echo $ISOLATED_VAR`
    .quiet()
    .env({ ISOLATED_VAR: "isolated" })
    .text();
  if (r.trim() !== "isolated") throw new Error(`got: ${r.trim()}`);
});

console.log("\n=== E2E: Native addon (wyhash) ===");
await test("wyhash native", async () => {
  const { hash: hashObj } = await import("@lu-zero/bun-compat/bun");
  const result = hashObj.wyhash("test-input", 0);
  if (typeof result !== "bigint")
    throw new Error(`expected bigint, got ${typeof result}`);
  if (result === 0n) throw new Error("wyhash returned 0");
  console.log(`    wyhash("test-input", 0) = ${result}`);
});

console.log("\n=== E2E: Bun.nanoseconds ===");
await test("Bun.nanoseconds() works for arithmetic", async () => {
  const ns1 = Bun.nanoseconds();
  const ns2 = Bun.nanoseconds();
  const diff = (ns2 as number) - (ns1 as number);
  if (diff < 0) throw new Error(`negative diff: ${diff}`);
  const ms = diff / 1e6;
  if (typeof ms !== "number")
    throw new Error(`expected number, got ${typeof ms}`);
});

await fs.rm(tmpDir, { recursive: true, force: true });
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) Deno.exit(1);
