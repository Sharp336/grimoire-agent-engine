import { commandConsumed } from "../slash-commands/helpers/parse";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../slash-commands/types";
import { shortenPath } from "../tools/render-utils";
import { SessionChannelManager, type SessionChannelState } from "./manager";
import type { SessionChannelSnapshot } from "./protocol";

function formatChannel(channel: SessionChannelSnapshot, selfId: string): string[] {
	const name = channel.name ? ` (${channel.name})` : "";
	const lines = [`- ${channel.id}${name} — ${channel.members.length} sessions — agent broadcast: ${channel.id}/all`];
	for (const member of channel.members) {
		const marker = member.id === selfId ? " (this session)" : "";
		const label = member.title ?? shortenPath(member.cwd);
		lines.push(`  - ${member.id}${marker} — ${label}`);
		for (const agent of member.agents) {
			const address = `${channel.id}/${member.id}/${agent.id}`;
			lines.push(`    - ${address} [${agent.displayName} · ${agent.status}]`);
		}
	}
	return lines;
}

function formatState(state: SessionChannelState): string {
	const lines = [`This running session: ${state.self.id}`];
	if (state.channels.length === 0) {
		lines.push("Open channels: none");
	} else {
		lines.push("Open channels:");
		for (const channel of state.channels) lines.push(...formatChannel(channel, state.self.id));
	}
	const available = state.sessions.filter(session => session.id !== state.self.id);
	if (available.length === 0) {
		lines.push("Other running sessions: none");
	} else {
		lines.push("Other running sessions:");
		for (const session of available) {
			lines.push(`- ${session.id} — ${session.title ?? shortenPath(session.cwd)} — ${session.agents.length} agents`);
		}
	}
	lines.push("Authorize: /channel open <session-id> [session-id ...]");
	return lines.join("\n");
}

/** User-only authorization and revocation surface for cross-session groups. */
export async function handleSessionChannelCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const manager = SessionChannelManager.forSession(runtime.session);
	if (!manager) {
		await runtime.output("Cross-session channels are unavailable in this session.");
		return commandConsumed();
	}
	const [verb = "list", ...args] = command.args.trim().split(/\s+/).filter(Boolean);
	try {
		switch (verb) {
			case "list":
			case "status":
				await runtime.output(formatState(await manager.state()));
				break;
			case "open": {
				if (args.length === 0) throw new Error("Usage: /channel open <session-id> [session-id ...]");
				const channel = await manager.open(args);
				await runtime.output(
					`Channel ${channel.id} opened with ${channel.members.length} sessions. Every member can send to ${channel.id}/all or select one or more listed agent addresses.`,
				);
				break;
			}
			case "add": {
				const [channel, ...sessions] = args;
				if (!channel || sessions.length === 0) {
					throw new Error("Usage: /channel add <channel-id> <session-id> [session-id ...]");
				}
				const updated = await manager.add(channel, sessions);
				await runtime.output(`Channel ${updated.id} now has ${updated.members.length} sessions.`);
				break;
			}
			case "remove": {
				const [channel, session] = args;
				if (!channel || !session || args.length !== 2) {
					throw new Error("Usage: /channel remove <channel-id> <session-id>");
				}
				const updated = await manager.remove(channel, session);
				await runtime.output(
					updated
						? `Session removed. Channel ${updated.id} remains open with ${updated.members.length} sessions.`
						: "Session removed. Fewer than two sessions remain, so the channel closed.",
				);
				break;
			}
			case "leave": {
				const [channel] = args;
				if (!channel || args.length !== 1) throw new Error("Usage: /channel leave <channel-id>");
				await manager.leave(channel, "user");
				await runtime.output(`Left channel ${channel}. Rejoining requires new user authorization.`);
				break;
			}
			case "close": {
				const [channel] = args;
				if (!channel || args.length !== 1) throw new Error("Usage: /channel close <channel-id>");
				await manager.closeChannel(channel);
				await runtime.output(`Closed channel ${channel}. Reopening requires new user authorization.`);
				break;
			}
			default:
				throw new Error(`Unknown /channel action: ${verb}`);
		}
	} catch (error) {
		await runtime.output(error instanceof Error ? error.message : String(error));
	}
	return commandConsumed();
}
