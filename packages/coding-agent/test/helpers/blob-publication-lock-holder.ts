import * as fs from "node:fs/promises";
import * as path from "node:path";

const [lock, ready, release] = process.argv.slice(2);
if (!lock || !ready || !release) throw new Error("lock holder requires lock, ready, and release paths");

await fs.mkdir(path.dirname(lock), { recursive: true });
const handle = await fs.open(lock, "wx");
try {
	await handle.writeFile(`${process.pid}\n${Math.round(Date.now() - process.uptime() * 1000)}\n`);
	await handle.sync();
} finally {
	await handle.close();
}
await fs.writeFile(ready, "");
try {
	for (;;) {
		try {
			await fs.access(release);
			break;
		} catch {
			await Bun.sleep(10);
		}
	}
} finally {
	await fs.unlink(lock);
}
