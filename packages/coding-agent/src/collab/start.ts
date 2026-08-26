import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_RELAY_URL } from "@oh-my-pi/pi-wire";
import type { InteractiveModeContext } from "../modes/types";
import { expandTilde } from "../tools/path-utils";
import { CollabHost } from "./host";

export interface StartCollabOptions {
	relayUrl: string;
	webUrl?: string;
	writeLinkPath?: string;
}

/** Start a host and attach it to the interactive context. */
export async function startCollabHost(ctx: InteractiveModeContext, options: StartCollabOptions): Promise<CollabHost> {
	if (ctx.collabHost) return ctx.collabHost;
	const host = new CollabHost(ctx);
	await host.start(options.relayUrl, options.webUrl ?? "");
	ctx.collabHost = host;
	if (options.writeLinkPath?.trim()) {
		try {
			await writeCollabLink(options.writeLinkPath, host.link, ctx.sessionManager.getCwd());
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.showError(`Failed to write collab link file: ${detail}`);
		}
	}
	return host;
}

async function writeCollabLink(rawPath: string, link: string, ctxCwd: string): Promise<void> {
	const expanded = expandTilde(rawPath.trim());
	const target = path.isAbsolute(expanded) ? expanded : path.resolve(ctxCwd, expanded);
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	await fs.writeFile(target, link, { encoding: "utf8", mode: 0o600 });
	await fs.chmod(target, 0o600);
}

function resolveRelayUrl(input: string): string {
	const trimmed = input.trim();
	return trimmed.includes("://") ? trimmed : `wss://${trimmed}`;
}

/** Start the configured host once during interactive startup. */
export async function autoStartCollab(ctx: InteractiveModeContext): Promise<boolean> {
	if (ctx.collabGuest || ctx.collabHost || !ctx.settings.get("collab.autoStart")) return false;
	const relayInput = ctx.settings.get("collab.relayUrl")?.trim() ?? "";
	if (!relayInput) {
		ctx.showWarning("Collab auto-start skipped: set collab.relayUrl to a relay endpoint.");
		return false;
	}
	const relayUrl = resolveRelayUrl(relayInput);
	if (relayUrl === DEFAULT_RELAY_URL && !ctx.settings.isConfigured("collab.relayUrl")) {
		ctx.showWarning("Collab auto-start skipped: configure collab.relayUrl explicitly before using the public relay.");
		return false;
	}
	try {
		await startCollabHost(ctx, {
			relayUrl,
			webUrl: ctx.settings.get("collab.webUrl") ?? "",
			writeLinkPath: ctx.settings.get("collab.writeLinkPath") ?? "",
		});
		ctx.showStatus("Collab auto-started", { dim: true });
		return true;
	} catch (error) {
		ctx.showError(`Failed to auto-start collab session: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export { DEFAULT_RELAY_URL, resolveRelayUrl };
