import { commandConsumed } from "../slash-commands/helpers/parse";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	TuiSlashCommandRuntime,
} from "../slash-commands/types";
import { shortenPath } from "../tools/render-utils";
import { SessionChannelManager, type SessionChannelState } from "./manager";
import type { ChannelSessionSnapshot, SessionChannelSnapshot } from "./protocol";

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
	lines.push("Authorize: /channel open (interactive) or /channel open <session-id> [session-id ...]");
	return lines.join("\n");
}

type ChannelOutput = (text: string) => Promise<void> | void;

async function executeChannelAction(
	manager: SessionChannelManager,
	verb: string,
	args: string[],
	output: ChannelOutput,
): Promise<void> {
	switch (verb) {
		case "list":
		case "status":
			await output(formatState(await manager.state()));
			return;
		case "open": {
			if (args.length === 0) throw new Error("Usage: /channel open <session-id> [session-id ...]");
			const channel = await manager.open(args);
			await output(
				`Channel ${channel.id} opened with ${channel.members.length} sessions. Every member can send to ${channel.id}/all or select one or more listed agent addresses.`,
			);
			return;
		}
		case "toggle": {
			const [channel, ...sessions] = args;
			if (!channel || sessions.length === 0) {
				throw new Error("Usage: /channel toggle <channel-id> <session-id> [session-id ...]");
			}
			const updated = await manager.setMembers(channel, sessions);
			await output(`Channel ${updated.id} now has ${updated.members.length} sessions.`);
			return;
		}
		case "leave": {
			const [channel] = args;
			if (!channel || args.length !== 1) throw new Error("Usage: /channel leave <channel-id>");
			await manager.leave(channel, "user");
			await output(`Left channel ${channel}. Rejoining requires new user authorization.`);
			return;
		}
		case "close": {
			const [channel] = args;
			if (!channel || args.length !== 1) throw new Error("Usage: /channel close <channel-id>");
			await manager.closeChannel(channel);
			await output(`Closed channel ${channel}. Reopening requires new user authorization.`);
			return;
		}
		default:
			throw new Error(`Unknown /channel action: ${verb}`);
	}
}

async function selectSessions(
	runtime: TuiSlashCommandRuntime,
	title: string,
	sessions: readonly ChannelSessionSnapshot[],
	initiallySelected: ReadonlySet<string>,
): Promise<string[] | undefined> {
	const selected = new Set(initiallySelected);
	const rows = sessions.map(session => ({
		id: session.id,
		label: `${session.id} — ${session.title ?? shortenPath(session.cwd)} — ${session.agents.length} agents`,
	}));
	const idByLabel = new Map(rows.map(row => [row.label, row.id]));

	while (true) {
		const doneLabel = `Done (${selected.size} selected)`;
		const choice = await runtime.ctx.showHookSelector(title, [...rows.map(row => row.label), doneLabel], {
			selectionMarker: "checkbox",
			checkedIndices: rows.flatMap((row, index) => (selected.has(row.id) ? [index] : [])),
			markableCount: rows.length,
			disabledIndices: selected.size === 0 ? [rows.length] : [],
			helpText: "Enter/click toggles · choose Done to apply · Esc cancels",
		});
		if (choice === undefined) return undefined;
		if (choice === doneLabel) return [...selected];
		const id = idByLabel.get(choice);
		if (!id) continue;
		if (selected.has(id)) selected.delete(id);
		else selected.add(id);
	}
}

function resolveChannel(query: string, channels: readonly SessionChannelSnapshot[]): SessionChannelSnapshot {
	const matches = channels.filter(
		channel => channel.id === query || channel.id.startsWith(query) || channel.name === query,
	);
	if (matches.length === 1 && matches[0]) return matches[0];
	if (matches.length === 0) throw new Error(`No open channel matches ${query}`);
	throw new Error(`Channel selector ${query} is ambiguous`);
}

/** Headless/ACP authorization surface. Interactive mode overrides open/toggle with selectors. */
export async function handleSessionChannelCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const manager = SessionChannelManager.forSession(runtime.session);
	if (!manager) {
		await runtime.output(
			"Cross-session channels are disabled. Enable Interaction → Agent Channels in /settings and restart.",
		);
		return commandConsumed();
	}
	const [verb = "list", ...args] = command.args.trim().split(/\s+/).filter(Boolean);
	try {
		await executeChannelAction(manager, verb, args, runtime.output);
	} catch (error) {
		await runtime.output(error instanceof Error ? error.message : String(error));
	}
	return commandConsumed();
}

/** Interactive user authorization with checkbox selectors for opening and membership changes. */
export async function handleSessionChannelTuiCommand(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const ctx = runtime.ctx;
	ctx.editor.setText("");
	const manager = SessionChannelManager.forSession(ctx.session);
	if (!manager) {
		ctx.showStatus(
			"Cross-session channels are disabled. Enable Interaction → Agent Channels in /settings and restart.",
		);
		return commandConsumed();
	}
	const [verb = "list", ...args] = command.args.trim().split(/\s+/).filter(Boolean);
	try {
		if (verb === "open" && args.length === 0) {
			const state = await manager.state();
			const sessions = state.sessions.filter(session => session.id !== state.self.id);
			if (sessions.length === 0) throw new Error("No other channel-capable sessions are running.");
			const selected = await selectSessions(runtime, "Open channel with sessions", sessions, new Set());
			if (!selected) return commandConsumed();
			const channel = await manager.open(selected);
			ctx.showStatus(`Channel ${channel.id} opened with ${channel.members.length} sessions.`);
			return commandConsumed();
		}

		if (verb === "toggle" && args.length <= 1) {
			const state = await manager.state();
			if (state.channels.length === 0) throw new Error("No cross-session channels are open.");
			let channel: SessionChannelSnapshot;
			if (args[0]) {
				channel = resolveChannel(args[0], state.channels);
			} else if (state.channels.length === 1 && state.channels[0]) {
				channel = state.channels[0];
			} else {
				const labels = state.channels.map(candidate =>
					candidate.name ? `${candidate.id} — ${candidate.name}` : candidate.id,
				);
				const selectedChannel = await ctx.showHookSelector("Choose channel", labels);
				if (!selectedChannel) return commandConsumed();
				const index = labels.indexOf(selectedChannel);
				const matched = state.channels[index];
				if (!matched) return commandConsumed();
				channel = matched;
			}
			const sessions = state.sessions.filter(session => session.id !== state.self.id);
			const currentIds = new Set(
				channel.members.filter(member => member.id !== state.self.id).map(member => member.id),
			);
			const selected = await selectSessions(
				runtime,
				`Toggle sessions in ${channel.name ?? channel.id}`,
				sessions,
				currentIds,
			);
			if (!selected) return commandConsumed();
			const updated = await manager.setMembers(channel.id, selected);
			ctx.showStatus(`Channel ${updated.id} now has ${updated.members.length} sessions.`);
			return commandConsumed();
		}

		await executeChannelAction(manager, verb, args, text => ctx.showStatus(text));
	} catch (error) {
		ctx.showError(error instanceof Error ? error.message : String(error));
	}
	return commandConsumed();
}
