import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, getToolsDir, hookFetch, setAgentDir } from "@oh-my-pi/pi-utils";
import { ensureTool } from "../../src/utils/tools-manager";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let testAgentDir = "";

function getYtDlpAssetName(): string {
	const platform = os.platform();
	const architecture = os.arch();

	if (platform === "darwin") {
		return "yt-dlp_macos";
	}
	if (platform === "linux") {
		return architecture === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
	}
	if (platform === "win32") {
		return architecture === "arm64" ? "yt-dlp_arm64.exe" : "yt-dlp.exe";
	}

	throw new Error(`Unsupported test platform: ${platform}/${architecture}`);
}

function createStreamingBinaryResponse(): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
				setTimeout(() => {
					controller.enqueue(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
					controller.close();
				}, 10);
			},
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/octet-stream" },
		},
	);
}

beforeEach(async () => {
	testAgentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-tools-manager-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (testAgentDir) {
		await fs.promises.rm(testAgentDir, { recursive: true, force: true });
		testAgentDir = "";
	}
});

describe("ensureTool yt-dlp auto-install", () => {
	it(
		"installs into the current agent tools dir when yt-dlp is missing",
		async () => {
			const version = "2026.04.07";
			const expectedToolsDir = getToolsDir();
			const expectedBinaryName = os.platform() === "win32" ? "yt-dlp.exe" : "yt-dlp";
			const assetName = getYtDlpAssetName();
			const binarySuffix = path.join("tools", expectedBinaryName);
			const latestReleaseUrl = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
			const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${assetName}`;
			const requests: string[] = [];
			const originalWhich = Bun.which.bind(Bun) as typeof Bun.which;
			const originalExistsSync = fs.existsSync.bind(fs) as typeof fs.existsSync;
			const originalMkdir = fs.promises.mkdir.bind(fs.promises) as typeof fs.promises.mkdir;

			vi.spyOn(Bun, "which").mockImplementation(command => (command === "yt-dlp" ? null : originalWhich(command)));
			vi.spyOn(fs, "existsSync").mockImplementation(candidate => {
				if (typeof candidate === "string" && path.normalize(candidate).endsWith(binarySuffix)) {
					return false;
				}
				return originalExistsSync(candidate);
			});
			vi.spyOn(fs.promises, "mkdir").mockImplementation(
				(async (...args: Parameters<typeof fs.promises.mkdir>) => {
					const [dir, options] = args;
					const resolvedDir = path.resolve(String(dir));
					if (resolvedDir !== expectedToolsDir) {
						throw new Error(`unexpected mkdir outside test tools dir: ${resolvedDir}`);
					}
					return await originalMkdir(dir, options);
				}) as typeof fs.promises.mkdir,
			);

			using _hook = hookFetch(async input => {
				const url = String(input);
				requests.push(url);
				if (url === latestReleaseUrl) {
					return new Response(JSON.stringify({ tag_name: version }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === downloadUrl) {
					return createStreamingBinaryResponse();
				}
				return new Response(`unexpected fetch: ${url}`, { status: 500 });
			});

			const installedPath = await ensureTool("yt-dlp", { silent: true });
			expect(installedPath).toBeDefined();
			expect(installedPath).toBe(path.join(expectedToolsDir, expectedBinaryName));
			expect(requests).toEqual([latestReleaseUrl, downloadUrl]);

			const installedStat = await fs.promises.stat(installedPath!);
			expect(installedStat.size).toBeGreaterThan(0);
			expect(path.dirname(installedPath!)).toBe(expectedToolsDir);

			if (os.platform() !== "win32") {
				expect(installedStat.mode & 0o111).not.toBe(0);
			}
		},
		{ timeout: 2000 },
	);
});
