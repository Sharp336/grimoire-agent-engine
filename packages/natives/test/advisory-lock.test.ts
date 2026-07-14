import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AdvisoryLock } from "../native/index.js";

const roots: string[] = [];

async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisory-lock-test-"));
	roots.push(root);
	return root;
}

async function waitForReady(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				const stderr = await new Response(child.stderr).text();
				throw new Error(`advisory lock child exited before ready: ${stderr}`);
			}
			buffered += decoder.decode(value, { stream: true });
			if (buffered.includes("ready\n")) return;
		}
	} finally {
		reader.releaseLock();
	}
}

afterEach(async () => {
	while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

describe("native advisory lock", () => {
	it("reports contention without waiting and preserves the permanent guard file", async () => {
		const root = await fixture();
		const guardPath = path.join(root, "session.guard");
		const first = AdvisoryLock.tryAcquire(guardPath);
		expect(first).not.toBeNull();
		expect(AdvisoryLock.tryAcquire(guardPath)).toBeNull();
		first?.release();
		first?.release();
		const second = AdvisoryLock.tryAcquire(guardPath);
		expect(second).not.toBeNull();
		second?.release();
		expect((await fs.stat(guardPath)).isFile()).toBe(true);
		if (process.platform !== "win32") {
			expect((await fs.stat(guardPath)).mode & 0o777).toBe(0o600);
		}
	});

	it("releases the operating-system lock when a holder is killed", async () => {
		const root = await fixture();
		const guardPath = path.join(root, "crash.guard");
		const moduleUrl = new URL("../native/index.js", import.meta.url).href;
		const childScript = [
			`import { AdvisoryLock } from ${JSON.stringify(moduleUrl)};`,
			`const lock = AdvisoryLock.tryAcquire(${JSON.stringify(guardPath)});`,
			`if (!lock) throw new Error("lock unexpectedly busy");`,
			`process.stdout.write("ready\\n");`,
			`setInterval(() => {}, 1000);`,
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", childScript], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			await waitForReady(child);
			expect(AdvisoryLock.tryAcquire(guardPath)).toBeNull();
			child.kill("SIGKILL");
			await child.exited;
			let recovered = AdvisoryLock.tryAcquire(guardPath);
			for (let attempt = 0; recovered === null && attempt < 20; attempt++) {
				await Bun.sleep(10);
				recovered = AdvisoryLock.tryAcquire(guardPath);
			}
			expect(recovered).not.toBeNull();
			recovered?.release();
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
		}
	});

	it("rejects directory and symlink or reparse targets", async () => {
		const root = await fixture();
		expect(() => AdvisoryLock.tryAcquire(root)).toThrow();
		const target = path.join(root, "target.guard");
		await fs.writeFile(target, "");
		const link = path.join(root, "link.guard");
		if (process.platform === "win32") {
			const junctionTarget = path.join(root, "junction-target");
			await fs.mkdir(junctionTarget);
			await fs.symlink(junctionTarget, link, "junction");
		} else {
			await fs.symlink(target, link);
		}
		expect(() => AdvisoryLock.tryAcquire(link)).toThrow();
	});

	it.skipIf(process.platform === "win32")(
		"rejects permissive existing guard files without changing their mode",
		async () => {
			const root = await fixture();
			const guardPath = path.join(root, "permissive.guard");
			await fs.writeFile(guardPath, "");
			await fs.chmod(guardPath, 0o640);

			expect(() => AdvisoryLock.tryAcquire(guardPath)).toThrow("0600");
			expect((await fs.stat(guardPath)).mode & 0o777).toBe(0o640);
		},
	);
});
