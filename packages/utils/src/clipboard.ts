import * as native from "@oh-my-pi/pi-natives";

async function spawnCapture(cmd: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<string> {
	const timeoutMs = options.timeoutMs ?? 2000;
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "ignore",
		stdin: options.input !== undefined ? Buffer.from(options.input) : "ignore",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		if (timedOut) throw new Error(`${cmd[0]} timed out after ${timeoutMs}ms`);
		if (proc.exitCode !== 0) throw new Error(`${cmd[0]} exited with code ${proc.exitCode}`);
		return stdout;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Copy text to the system clipboard.
 *
 * Emits OSC 52 first when running in a real terminal, then attempts native
 * clipboard copy as best-effort for local sessions. On Termux, tries
 * `termux-clipboard-set` before native.
 */
export async function copyToClipboard(text: string): Promise<void> {
	if (process.stdout.isTTY) {
		const onError = (err: unknown) => {
			process.stdout.off("error", onError);
			if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") return;
		};
		try {
			const encoded = Buffer.from(text).toString("base64");
			const osc52 = `\x1b]52;c;${encoded}\x07`;
			process.stdout.on("error", onError);
			process.stdout.write(osc52, err => {
				process.stdout.off("error", onError);
				if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") return;
			});
		} catch (err) {
			process.stdout.off("error", onError);
			if ((err as NodeJS.ErrnoException | null | undefined)?.code !== "EPIPE") {
				// OSC 52 is best-effort.
			}
		}
	}

	try {
		if (process.env.TERMUX_VERSION) {
			try {
				await spawnCapture(["termux-clipboard-set"], { input: text, timeoutMs: 5000 });
				return;
			} catch {
				// Fall through to native.
			}
		}

		await native.copyToClipboard(text);
	} catch {
		// Clipboard copy is best-effort.
	}
}
