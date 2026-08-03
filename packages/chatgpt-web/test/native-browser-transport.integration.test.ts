import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { createPlaywrightPipeTransport, type NativeBrowserPipeLike } from "../src/runtime/playwright-transport";

interface NativeOwnedFileLike {
	close(): void;
}
interface NativeProcessLike {
	wait(timeoutMs?: number): Promise<{ exitCode: number | null; signal: string | null }>;
	terminate(): Promise<void>;
	close(): void;
}
interface NativeBrowserLike {
	process: NativeProcessLike;
	pipe: NativeBrowserPipeLike;
}
interface BrowserNativeModule {
	NativeOwnedFile: { open(path: string, directory: boolean): NativeOwnedFileLike };
	openVerifiedExecutable(spec: { path: string; sha256: string; version: string }): Promise<object>;
	createLaunchEnvironment(profile: {
		kind: "browser-child";
		profileRoot: NativeOwnedFileLike;
		profileGeneration: string;
		ownerFence: string;
	}): object;
	launchVerifiedBrowser(spec: {
		executable: object;
		environment: object;
		options: { headed: boolean; featureToggles: readonly string[] };
	}): Promise<NativeBrowserLike>;
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hash.update(chunk);
	return hash.digest("hex");
}

async function closePipe(pipe: NativeBrowserPipeLike | undefined): Promise<void> {
	if (!pipe) return;
	try {
		await pipe.close();
	} catch {
		// Best-effort fixture cleanup after the primary assertion path.
	}
}

test("native inherited remote-debugging pipe connects to pinned Chromium", async () => {
	const executablePath = process.env.CHATGPT_WEB_TEST_CHROMIUM;
	const version = process.env.CHATGPT_WEB_TEST_CHROMIUM_VERSION;
	expect(executablePath, "CHATGPT_WEB_TEST_CHROMIUM is required for this explicit integration gate").toBeTruthy();
	expect(version, "CHATGPT_WEB_TEST_CHROMIUM_VERSION is required for digest/version binding").toBeTruthy();
	// The platform addon is loaded only after the explicit CI gate variables are validated.
	const native = (await import("@oh-my-pi/pi-natives")) as unknown as BrowserNativeModule;
	for (const name of [
		"NativeOwnedFile",
		"openVerifiedExecutable",
		"createLaunchEnvironment",
		"launchVerifiedBrowser",
	] as const) {
		expect(native[name], `native primitive ${name} is required`).toBeDefined();
	}
	const profilePath = path.join(tmpdir(), `omp-chatgpt-web-chromium-${randomBytes(16).toString("hex")}`);
	await mkdir(profilePath, { recursive: false, mode: 0o700 });
	let profile: NativeOwnedFileLike | undefined;
	let owned: NativeBrowserLike | undefined;
	try {
		profile = native.NativeOwnedFile.open(profilePath, true);
		const executable = await native.openVerifiedExecutable({
			path: executablePath!,
			sha256: await sha256File(executablePath!),
			version: version!,
		});
		const environment = native.createLaunchEnvironment({
			kind: "browser-child",
			profileRoot: profile,
			profileGeneration: randomBytes(32).toString("hex"),
			ownerFence: randomBytes(32).toString("hex"),
		});
		owned = await native.launchVerifiedBrowser({
			executable,
			environment,
			options: {
				headed: false,
				featureToggles: ["disable-background-networking", "disable-component-update", "disable-default-apps"],
			},
		});
		const transport = createPlaywrightPipeTransport(owned.pipe);
		const browser = await chromium.connectOverCDP(transport, { isLocal: true, noDefaults: true });
		try {
			expect(await browser.version()).not.toBe("");
			const context = browser.contexts()[0];
			expect(context).toBeDefined();
			const page = await context!.newPage();
			await page.goto("about:blank");
			expect(page.url()).toBe("about:blank");
			await page.close();
		} finally {
			await browser.close();
		}
		await closePipe(owned.pipe);
		await owned.process.terminate();
		const exit = await owned.process.wait(10_000);
		expect(exit.exitCode !== null || exit.signal !== null).toBe(true);
	} finally {
		await closePipe(owned?.pipe);
		await owned?.process.terminate().catch(() => undefined);
		owned?.process.close();
		profile?.close();
		await rm(profilePath, { recursive: true, force: true });
	}
}, 60_000);
