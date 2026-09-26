import * as fs from "node:fs";
import { BlobStore } from "../../src/session/blob-store";

const [root, cut, body] = Bun.argv.slice(2);
if (!root || !cut || !body) throw new Error("Blob crash writer needs root, cut and body");

// Freeze the whole process at the cut, the way a crash leaves the managed tree, until the parent kills it.
const pause = new Int32Array(new SharedArrayBuffer(4));
const store = new BlobStore(root, (stage, hash) => {
	if (stage !== cut) return;
	fs.writeSync(1, `${stage} ${hash}\n`);
	for (;;) Atomics.wait(pause, 0, 0, 1_000);
});
await store.publish(Buffer.from(body), { extension: "png" });
