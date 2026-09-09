import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";

it("recovers a committed active three MiB message after process kill without resubmission or changing its old version", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "engine-active-crash-"));
	const fixture = path.join(import.meta.dir, "fixtures", "runtime-v1-crash.ts");
	const children: Array<Bun.Subprocess> = [];
	const spawn = (mode: string) => {
		const child = Bun.spawn([process.execPath, fixture, directory, mode], {
			stdin: "pipe",
			stdout: Bun.file(path.join(directory, `${mode}-${children.length}.stdout`)),
			stderr: Bun.file(path.join(directory, `${mode}-${children.length}.stderr`)),
		});
		children.push(child);
		return child;
	};
	try {
		const child = spawn("stream");
		const readyPath = path.join(directory, "ready.json");
		const deadline = Date.now() + 30000;
		while (!fs.existsSync(readyPath)) {
			if (child.exitCode !== null) throw new Error(await Bun.file(path.join(directory, "stream-0.stderr")).text());
			if (Date.now() >= deadline)
				throw new Error(
					`Active message did not reach durable admission before crash deadline: ${await Bun.file(path.join(directory, "stream-0.stdout")).text()} ${await Bun.file(path.join(directory, "stream-0.stderr")).text()}`,
				);
			await Bun.sleep(20);
		}
		const ready = await Bun.file(readyPath).json();
		expect(ready.baseline).toMatchObject({ status: "streaming", partial: true, totalBytes: 3 * 1024 * 1024 });
		expect(ready.dispatches).toBe(1);
		child.kill("SIGKILL");
		await withTimeout(child.exited, 10000, "Owned crash fixture did not stop");
		for (const generation of [2, 3]) {
			const recovered = spawn("recover");
			expect(await withTimeout(recovered.exited, 30000, "Recovery fixture did not exit")).toBe(0);
			const result = await Bun.file(path.join(directory, `recovered-${generation}.json`)).json();
			expect(result.dispatches).toBe(0);
			expect(result.generation).toBe(generation);
			expect(result.attempt.state).toBe("interrupted");
			expect(result.intent.holds.some((hold: { kind: string }) => hold.kind === "recovery")).toBe(true);
			expect(result.baseline).toMatchObject({
				...ready.baseline,
				status: "interrupted",
				revision: ready.baseline.revision + 1,
				resource: { ...ready.baseline.resource, revision: ready.baseline.revision + 1 },
			});
			expect(result.hash).toBe(ready.hash);
			expect(result.work.scannedRows).toBeLessThan(10);
		}
	} finally {
		for (const child of children) {
			if (child.exitCode === null) child.kill("SIGKILL");
			await withTimeout(child.exited, 10000, "Owned fixture cleanup did not stop");
		}
		fs.rmSync(directory, { recursive: true });
	}
}, 90000);
