import { BlobStore } from "../../src/session/blob-store";

const [root, cut, body] = Bun.argv.slice(2);
if (!root || !cut || !body) throw new Error("Blob crash writer needs root, cut and body");

const pause = new Int32Array(new SharedArrayBuffer(4));
const store = new BlobStore(root, (stage, hash) => {
	if (stage !== cut) return;
	process.stdout.write(`${stage} ${hash}\n`);
	for (;;) Atomics.wait(pause, 0, 0, 1_000);
});
store.putSync(Buffer.from(body), { extension: "png" });
