import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";
import type { Browser, BrowserServer, BrowserType, CDPSession, Page } from "patchright";
import { ToolError } from "../tool-errors";

export type { Browser, BrowserServer, CDPSession, Page };

/**
 * Lazy access to patchright's `chromium` browser instance. The patchright
 * package (→ patchright-core) runs a Node-version guard and loads the heavy
 * coreBundle (which conditionally `require`s chromium-bidi) as a module side
 * effect, so importing it at top level would execute Patchright during `omp`
 * startup — before the browser tool is ever used. That conflicts with the
 * packaging contract (bundle-dist.ts) that treats patchright/patchright-core/
 * chromium-bidi as runtime externals: a missing or broken Patchright subtree
 * in an npm or compiled-binary install would crash `omp` at startup instead
 * of producing a browser-tool error on first use. Load it lazily via
 * require() inside launch/connect paths only.
 * // Exception to ts-no-dynamic-import: static import would trigger the
 * // heavy module side effect we explicitly need to defer.
 */
let _chromium: BrowserType | undefined;
function chromium(): BrowserType {
	if (!_chromium) _chromium = require("patchright").chromium;
	return _chromium!;
}

export const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };

/**
 * Per-CDP-message timeout applied to every patchright launch/connect. Set above
 * `TOOL_TIMEOUTS.browser.max` (30s) so the agent-side wall-clock is the canonical
 * limit; this constant only catches genuinely stuck CDP sockets (renderer wedged,
 * connection dropped, etc.).
 */
export const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;

/**
 * Patchright (patched Playwright) provides built-in undetectable stealth:
 * Runtime.enable leak avoidance, Console.enable disable, command-flag leak
 * fixes, and closed shadow root support. No custom injection scripts needed.
 *
 * @see https://github.com/Kaliiiiiiiiii-Vinyzu/patchright
 */

let chromiumExecutablePromise: Promise<string | undefined> | undefined;

/**
 * Resolve a Chromium executable to use for headless launch.
 *
 * Priority: system Chrome/Chromium > PUPPETEER_EXECUTABLE_PATH env >
 * patchright's bundled Chromium (auto-downloaded on first use).
 *
 * Patchright bundles its own Chromium via `npx patchright install chromium`.
 * We still detect system Chrome for cases where the bundled browser hasn't been
 * downloaded yet or the user prefers their installed Chrome (better fingerprint).
 */
/**
 * Download Patchright's bundled Chromium. Tries multiple strategies so this
 * works on npm installs (npx), standalone binaries (node + patchright CLI), and
 * Bun-only hosts. Throws ToolError with an actionable message if all fail.
 */
async function installPatchrightChromium(): Promise<void> {
	// Strategy 1: npx patchright install chromium (npm-based installs).
	// Bun.spawn throws synchronously if npx is not on PATH, so catch and
	// fall through to the node strategy instead of crashing.
	let npxStderr = "";
	try {
		const child = Bun.spawn(["npx", "patchright", "install", "chromium"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		// Drain both stdout and stderr concurrently — if stdout fills the pipe
		// buffer, the child blocks on write and never exits.
		const [stderr] = await Promise.all([new Response(child.stderr).text(), new Response(child.stdout).text()]);
		npxStderr = stderr;
		const exitCode = await child.exited;
		if (exitCode === 0) return;
		logger.warn("npx patchright install failed", { exitCode, stderr: npxStderr.slice(-500) });
	} catch {}

	// Strategy 2: node with patchright CLI module (binary installs where node exists)
	let nodeStderr = "";
	try {
		const child2 = Bun.spawn(
			["node", "-e", "require('patchright/lib/program').program.parse(['node','patchright','install','chromium'])"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stderr2] = await Promise.all([new Response(child2.stderr).text(), new Response(child2.stdout).text()]);
		nodeStderr = stderr2;
		const exit2 = await child2.exited;
		if (exit2 === 0) return;
		logger.warn("node patchright install failed", { exitCode: exit2, stderr: nodeStderr.slice(-500) });
	} catch {}

	throw new ToolError(
		"Failed to install Chromium for patchright. " +
			"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary, " +
			"or run `npx patchright install chromium` manually." +
			(npxStderr ? `\nnpx stderr: ${npxStderr.slice(-300)}` : "") +
			(nodeStderr ? `\nnode stderr: ${nodeStderr.slice(-300)}` : ""),
	);
}

async function ensureChromiumExecutable(): Promise<string | undefined> {
	const sysChrome = resolveSystemChromium();
	if (sysChrome) return sysChrome;
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (envPath) return envPath;
	if (chromiumExecutablePromise) return chromiumExecutablePromise;

	chromiumExecutablePromise = (async () => {
		const exe = chromium().executablePath();
		if (fs.existsSync(exe)) return exe;
		// Self-provision: download Chromium on first use, matching the old
		// @puppeteer/browsers behavior. Try multiple strategies so this works
		// on npm installs, standalone binaries, and Bun-only hosts.
		logger.warn("Patchright Chromium not found, downloading (first browser use)", {
			expectedPath: exe,
		});
		await installPatchrightChromium();
		if (!fs.existsSync(exe)) {
			throw new ToolError(
				`Chromium was installed but the executable is not at the expected path: ${exe}. ` +
					"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary.",
			);
		}
		return exe;
	})().catch(err => {
		chromiumExecutablePromise = undefined;
		if (err instanceof ToolError) throw err;
		throw new ToolError(
			`Failed to resolve Chromium executable for patchright: ${(err as Error).message}. ` +
				"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary, or install one manually.",
		);
	});
	return chromiumExecutablePromise;
}

let resolvedChromium: string | null | undefined; // undefined = unchecked; null = not found

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		return st.isFile();
	} catch {
		return false;
	}
}

function systemChromiumCandidates(): string[] {
	const home = os.homedir();
	const candidates: string[] = [];
	switch (process.platform) {
		case "darwin": {
			for (const root of ["/Applications", path.join(home, "Applications")]) {
				candidates.push(
					path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
					path.join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
					path.join(root, "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"),
					path.join(root, "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
					path.join(root, "Chromium.app/Contents/MacOS/Chromium"),
					path.join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				);
			}
			break;
		}
		case "linux": {
			const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"];
			for (const name of names) {
				const found = $which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
				"/var/lib/flatpak/exports/bin/com.google.Chrome",
				"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
			);
			let onNixos = false;
			try {
				onNixos = fs.existsSync("/etc/NIXOS");
			} catch {}
			if (onNixos) {
				candidates.push(path.join(home, ".nix-profile/bin/chromium"), "/run/current-system/sw/bin/chromium");
			}
			break;
		}
		case "win32": {
			const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
			const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData\\Local");
			candidates.push(
				path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFiles, "Chromium\\Application\\chrome.exe"),
				path.join(localAppData, "Chromium\\Application\\chrome.exe"),
				path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
				path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
			);
			break;
		}
	}
	return candidates;
}

function resolveSystemChromium(): string | undefined {
	if (resolvedChromium !== undefined) return resolvedChromium ?? undefined;
	const seen = new Set<string>();
	for (const candidate of systemChromiumCandidates()) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (isExecutableFile(candidate)) {
			resolvedChromium = candidate;
			logger.debug("Using system Chrome/Chromium", { path: candidate });
			return candidate;
		}
	}
	resolvedChromium = null;
	return undefined;
}

export interface LaunchHeadlessOptions {
	headless: boolean;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

/**
 * Launch a headless Chromium browser via patchright.
 *
 * Patchright provides built-in stealth (Runtime.enable avoidance, command-flag
 * fixes, etc.) so no custom injection scripts or UA overrides are applied.
 *
 * Per patchright best practice, we use `channel: "chrome"` when a system Chrome
 * is available (better fingerprint than Chromium), and fall back to the bundled
 * Chromium otherwise.
 */
export async function launchHeadlessBrowser(opts: LaunchHeadlessOptions): Promise<BrowserServer> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	const executablePath = await ensureChromiumExecutable();
	const launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", `--window-size=${vp.width},${vp.height}`];

	const proxy = process.env.PUPPETEER_PROXY;
	if (proxy) {
		launchArgs.push(`--proxy-server=${proxy}`);
		// Chrome (since v72) bypasses proxies for localhost by default. When PUPPETEER_PROXY_BYPASS_LOOPBACK
		// is true, add <-loopback> so traffic to localhost reaches the proxy (e.g. for mitmdump/auth capture).
		const bypassLoopback = process.env.PUPPETEER_PROXY_BYPASS_LOOPBACK?.toLowerCase();
		if (bypassLoopback === "true" || bypassLoopback === "1" || bypassLoopback === "yes" || bypassLoopback === "on") {
			launchArgs.push("--proxy-bypass-list=<-loopback>");
		}
	}
	const ignoreCert = process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS?.toLowerCase();
	if (ignoreCert === "true" || ignoreCert === "1" || ignoreCert === "yes" || ignoreCert === "on") {
		launchArgs.push("--ignore-certificate-errors");
	}

	const sysChrome = resolveSystemChromium();
	// Use launchServer so the worker can connect via chromium.connect(wsEndpoint).
	// Playwright's Browser (from launch()) doesn't expose wsEndpoint(); BrowserServer does.
	return await chromium().launchServer({
		headless: opts.headless,
		// When using a system Chrome, use channel "chrome" for the best fingerprint.
		// Otherwise let patchright use its bundled Chromium.
		channel: sysChrome ? "chrome" : undefined,
		executablePath,
		args: launchArgs,
		timeout: BROWSER_PROTOCOL_TIMEOUT_MS,
	});
}

/**
 * Apply viewport dimensions (width, height, deviceScaleFactor) to a page.
 *
 * Playwright's `setViewportSize` handles width/height. For deviceScaleFactor,
 * we use CDP `Emulation.setDeviceMetricsOverride` since Playwright only supports
 * DPR at context creation time, not on an existing page.
 */
export async function applyViewport(
	page: Page,
	viewport?: { width: number; height: number; deviceScaleFactor?: number },
): Promise<void> {
	const vp = viewport ?? DEFAULT_VIEWPORT;
	await page.setViewportSize({ width: vp.width, height: vp.height });
	const dpr = vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor;
	if (dpr !== 1) {
		try {
			const session = await page.context().newCDPSession(page);
			await session.send("Emulation.setDeviceMetricsOverride", {
				width: vp.width,
				height: vp.height,
				deviceScaleFactor: dpr,
				mobile: false,
			});
			await session.detach();
		} catch (err) {
			logger.debug("Failed to set deviceScaleFactor via CDP", { error: (err as Error).message });
		}
	}
}

/**
 * Connect to an existing browser via its WebSocket endpoint.
 * Used by the tab worker to connect to the browser launched by the supervisor.
 */
export async function connectBrowser(browserWSEndpoint: string): Promise<Browser> {
	return await chromium().connect(browserWSEndpoint, { timeout: BROWSER_PROTOCOL_TIMEOUT_MS });
}

/**
 * Connect to an existing browser via its CDP HTTP endpoint (e.g. http://127.0.0.1:9222).
 * Used for attaching to Electron apps or externally-launched Chrome instances.
 */
export async function connectOverCDP(cdpUrl: string): Promise<Browser> {
	return await chromium().connectOverCDP(cdpUrl, { timeout: BROWSER_PROTOCOL_TIMEOUT_MS });
}

/**
 * Resolve the target ID for a page via CDP.
 * Playwright doesn't expose Target objects; we use CDP to get the target info.
 */
export async function pageTargetId(page: Page): Promise<string> {
	const session = await page.context().newCDPSession(page);
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		const targetId = info.targetInfo?.targetId;
		if (!targetId) throw new ToolError("Target id unavailable from CDP target info");
		return targetId;
	} finally {
		await session.detach().catch(() => undefined);
	}
}
