import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { BridgeMessage, ExternalPeer } from "@oh-my-pi/prime-bridge-protocol";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import { replaceTabs } from "../render-utils";

function sanitize(value: string): string {
	return replaceTabs(sanitizeText(value))
		.replace(/[\r\n]+/g, " ")
		.trim();
}

export const EXTERNAL_PEER_ID_PREFIX = "prime://";

export function normalizeExternalPeerId(id: string): string {
	if (!id.isWellFormed()) throw new Error("Prime peer ID must be well-formed Unicode");
	return `${EXTERNAL_PEER_ID_PREFIX}${encodeURIComponent(id)}`;
}

export function externalTargetId(id: string): string | undefined {
	if (!id.startsWith(EXTERNAL_PEER_ID_PREFIX)) return undefined;
	try {
		const target = decodeURIComponent(id.slice(EXTERNAL_PEER_ID_PREFIX.length));
		return target.length > 0 ? target : undefined;
	} catch {
		return undefined;
	}
}

export function externalMessageMatchesFrom(message: BridgeMessage, from: string | undefined): boolean {
	return from === undefined || normalizeExternalPeerId(message.originSessionId) === from;
}

export function formatExternalMessage(message: BridgeMessage): string {
	const replyTag = message.replyTo ? ` (reply to ${sanitize(message.replyTo)})` : "";
	return `[${sanitize(message.meshMessageId)}] ${sanitize(normalizeExternalPeerId(message.originSessionId))}${replyTag}: ${sanitize(message.body)}`;
}

export function formatExternalPeers(peers: ExternalPeer[]): string {
	if (peers.length === 0) return "External Prime peers: none.";
	return [
		"External Prime peers:",
		...peers.map(peer => `- ${sanitize(peer.id)} [${sanitize(peer.displayName)} · ${sanitize(peer.status)}]`),
	].join("\n");
}

export function formatExternalInbox(messages: BridgeMessage[], peek: boolean): string {
	if (messages.length === 0) return "External Prime inbox empty.";
	const header = peek
		? `${messages.length} unread external Prime message(s):`
		: `${messages.length} external Prime message(s):`;
	return [header, ...messages.map(message => `- ${formatExternalMessage(message)}`)].join("\n");
}

export function externalRenderResult(
	result: { content: Array<{ type: string; text?: string }> },
	_options: RenderResultOptions,
	_uiTheme: Theme,
): Component {
	const text = result.content.find(part => part.type === "text")?.text ?? "";
	return new Text(replaceTabs(sanitizeText(text)), 0, 0);
}
