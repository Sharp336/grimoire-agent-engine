/**
 * Clipboard helpers backed by native arboard bindings.
 *
 * Adds OSC 52 fallback for SSH/mosh, Termux support, and headless guards
 * on top of the native arboard layer.
 */

import { execSync } from "node:child_process";

import { ImageFormat, PhotonImage } from "../image";
import { native } from "../native";

import type { ClipboardImage } from "./types";

export type { ClipboardImage } from "./types";

/** Whether a display server is available on Linux. */
const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

const PREFERRED_WAYLAND_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"] as const;

function runWaylandClipboardCommand(args: string[]): Uint8Array | null {
	const result = Bun.spawnSync(["wl-paste", ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0 || result.stdout.length === 0) {
		return null;
	}
	return result.stdout;
}

async function tryReadWaylandClipboardImage(): Promise<ClipboardImage | null> {
	if (process.platform !== "linux" || !process.env.WAYLAND_DISPLAY) {
		return null;
	}

	const typeBytes = runWaylandClipboardCommand(["--list-types"]);
	if (!typeBytes) {
		return null;
	}

	const types = Buffer.from(typeBytes)
		.toString("utf-8")
		.split(/\r?\n/)
		.map(type => type.trim())
		.filter(Boolean);
	const imageType =
		PREFERRED_WAYLAND_IMAGE_TYPES.find(type => types.includes(type)) ?? types.find(type => type.startsWith("image/"));
	if (!imageType) {
		return null;
	}

	const imageBytes = runWaylandClipboardCommand(["--type", imageType, "--no-newline"]);
	if (!imageBytes) {
		return null;
	}

	try {
		const image = await PhotonImage.parse(imageBytes);
		const pngBytes = await image.encode(ImageFormat.PNG, 100);
		return { data: pngBytes, mimeType: "image/png" };
	} catch {
		return null;
	}
}

/**
 * Copy text to the system clipboard.
 *
 * Emits OSC 52 first when running in a real terminal (works over SSH/mosh),
 * then attempts native clipboard copy as best-effort for local sessions.
 * On Termux, tries `termux-clipboard-set` before native.
 *
 * @param text - UTF-8 text to place on the clipboard.
 */
export async function copyToClipboard(text: string): Promise<void> {
	if (process.stdout.isTTY) {
		const onError = (err: unknown) => {
			process.stdout.off("error", onError);
			// Prevent unhandled 'error' from crashing the process when stdout is a closed pipe.
			if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
				return;
			}
		};
		try {
			const encoded = Buffer.from(text).toString("base64");
			const osc52 = `\x1b]52;c;${encoded}\x07`;
			process.stdout.on("error", onError);
			process.stdout.write(osc52, err => {
				process.stdout.off("error", onError);
				// If stdout is closed (e.g. piped to a process that exits early),
				// ignore EPIPE and proceed with native clipboard best-effort.
				if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
					return;
				}
			});
		} catch (err) {
			process.stdout.off("error", onError);
			if ((err as NodeJS.ErrnoException | null | undefined)?.code !== "EPIPE") {
				// Ignore all write failures (OSC 52 is best-effort).
			}
		}
	}

	// Also try native tools (best effort for local sessions)
	try {
		if (process.env.TERMUX_VERSION) {
			try {
				execSync("termux-clipboard-set", { input: text, timeout: 5000 });
				return;
			} catch {
				// Fall through to native
			}
		}

		await native.copyToClipboard(text);
	} catch {
		// Ignore — clipboard copy is best-effort
	}
}

/**
 * Read an image from the system clipboard.
 *
 * Returns null on Termux (no image clipboard support) or when no display
 * server is available (headless/SSH without forwarding).
 *
 * @returns PNG payload or null when no image is available.
 */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
	if (process.env.TERMUX_VERSION) {
		return null;
	}

	if (!hasDisplay) {
		return null;
	}

	const nativeImage = await native.readImageFromClipboard();
	if (nativeImage) {
		return nativeImage;
	}
	return tryReadWaylandClipboardImage();
}
