import { sanitizeText } from "@oh-my-pi/pi-utils";
import { isAuthenticated, kNoAuth } from "../../config/model-registry";
import { getModelMatchPreferences, resolveCliModel } from "../../config/model-resolver";
import { parseCouncilConfig, resolveCouncilMemberSelector } from "../../council/config";
import type { CouncilCoordinator, CouncilCoordinatorHost } from "../../council/coordinator";
import { getCouncilCoordinator } from "../../council/coordinator";
import { type CouncilManifest, isCouncilTerminalState } from "../../council/state";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed } from "./parse";

const COUNCIL_USAGE = "Usage: /council <task> | status | cancel | resume [run-id] | config";
const COUNCIL_SUBCOMMANDS: Record<string, true> = {
	status: true,
	cancel: true,
	resume: true,
	config: true,
};

type ParsedCouncilAction =
	| { kind: "usage" }
	| { kind: "task"; task: string }
	| { kind: "status" }
	| { kind: "cancel" }
	| { kind: "resume"; runId?: string }
	| { kind: "config" }
	| { kind: "error"; message: string };

export interface CouncilCommandDependencies {
	getCoordinator(host: CouncilCoordinatorHost): CouncilCoordinator;
}

const DEFAULT_DEPENDENCIES: CouncilCommandDependencies = {
	getCoordinator: getCouncilCoordinator,
};

/** Parse council arguments without normalizing task content beyond the command's documented outer trim. */
export function parseCouncilCommandArgs(rawArgs: string): ParsedCouncilAction {
	const args = rawArgs.trim();
	if (!args) return { kind: "usage" };

	const markerMatch = /^--(?:\s|$)/.exec(args);
	if (markerMatch) {
		const task = args.slice(markerMatch[0].length).trim();
		return task ? { kind: "task", task } : { kind: "usage" };
	}

	const firstWhitespace = args.search(/\s/);
	const firstToken = firstWhitespace === -1 ? args : args.slice(0, firstWhitespace);
	if (!COUNCIL_SUBCOMMANDS[firstToken]) {
		return { kind: "task", task: args };
	}
	const trailing = firstWhitespace === -1 ? "" : args.slice(firstWhitespace).trim();
	switch (firstToken) {
		case "status":
			return trailing ? { kind: "error", message: "Usage: /council status" } : { kind: "status" };
		case "cancel":
			return trailing ? { kind: "error", message: "Usage: /council cancel" } : { kind: "cancel" };
		case "config":
			return trailing ? { kind: "error", message: "Usage: /council config" } : { kind: "config" };
		case "resume": {
			if (!trailing) return { kind: "resume" };
			if (/\s/.test(trailing)) return { kind: "error", message: "Usage: /council resume [run-id]" };
			return { kind: "resume", runId: trailing };
		}
	}
	return { kind: "task", task: args };
}

/** Stable one-line snapshot used by start, resume, cancel, and status output. */
export function formatCouncilSnapshot(manifest: CouncilManifest): string {
	const currentRound =
		manifest.rounds.find(round => round.status === "running") ??
		manifest.rounds.find(round => round.status === "pending") ??
		manifest.rounds.at(-1);
	const members = currentRound?.members ?? [];
	const running = members.filter(member => member.status === "running").length;
	const succeeded = members.filter(member => member.status === "succeeded").length;
	const failed = members.filter(member => member.status === "failed").length;
	const round = currentRound?.round ?? 0;
	const warningCount = manifest.warnings.length;
	return `Council ${manifest.runId}: state=${manifest.state}; round=${round}; roster=${succeeded}/${members.length} succeeded, ${running} running, ${failed} failed; warnings=${warningCount}; output=${manifest.outputPath}`;
}

export function isCouncilRunTerminal(manifest: CouncilManifest): boolean {
	return isCouncilTerminalState(manifest.state);
}
export function councilMoveBlockMessage(
	coordinator: Pick<CouncilCoordinator, "executionInFlight" | "setupInFlight" | "snapshot">,
): string | undefined {
	if (coordinator.setupInFlight) {
		return "Cannot move while council setup/preflight is in progress; use /council cancel first.";
	}
	const snapshot = coordinator.snapshot;
	if (snapshot && !isCouncilRunTerminal(snapshot)) {
		return `Cannot move while council run ${snapshot.runId} is ${snapshot.state}; use /council cancel first.`;
	}
	if (coordinator.executionInFlight) {
		return "Cannot move while council execution is still settling; wait for it to finish.";
	}
	return undefined;
}

function coordinatorHost(runtime: SlashCommandRuntime): CouncilCoordinatorHost {
	return {
		session: runtime.session,
		toolSession: runtime.session.getToolSession(),
		sessionManager: runtime.sessionManager,
		settings: runtime.settings,
		modelRegistry: runtime.session.modelRegistry,
	};
}

function errorText(error: unknown): string {
	return sanitizeText(error instanceof Error ? error.message : String(error));
}

async function runAndHold(
	runtime: SlashCommandRuntime,
	coordinator: CouncilCoordinator,
	operation: () => Promise<CouncilManifest>,
): Promise<void> {
	const expectedSessionId = runtime.sessionManager.getSessionId();
	const ownsSession = (): boolean => runtime.sessionManager.getSessionId() === expectedSessionId;
	try {
		const manifest = await operation();
		if (!ownsSession()) return;
		const completion = coordinator.completion;
		let kickoffReported: PromiseWithResolvers<void> | undefined;
		if (completion && !isCouncilTerminalState(manifest.state)) {
			kickoffReported = Promise.withResolvers<void>();
			const heldCompletion = completion.finally(async () => {
				await kickoffReported!.promise;
				if (!ownsSession()) return;
				const terminal = coordinator.snapshot;
				if (!terminal) return;
				const rawFailure = sanitizeText(terminal.failure?.reason ?? "")
					.replace(/\s+/g, " ")
					.trim();
				const failure = rawFailure && rawFailure.length > 240 ? `${rawFailure.slice(0, 239)}…` : rawFailure;
				try {
					await runtime.output(`${formatCouncilSnapshot(terminal)}${failure ? `; failure=${failure}` : ""}`);
				} catch {
					// Command output delivery must not rewrite the coordinator's outcome.
				}
			});
			runtime.holdTurn?.(heldCompletion);
		}
		try {
			if (ownsSession()) await runtime.output(formatCouncilSnapshot(manifest));
		} finally {
			kickoffReported?.resolve();
		}
	} catch (error) {
		if (ownsSession()) await runtime.output(errorText(error));
	}
}

async function formatIdleCouncilStatus(runtime: SlashCommandRuntime): Promise<string> {
	try {
		const config = parseCouncilConfig(runtime.settings);
		const sessionId = runtime.sessionManager.getSessionId();
		const roster = await Promise.all(
			config.members.map(async member => {
				if (!member.enabled) return `${member.role}=disabled`;
				const roleResolution = resolveCouncilMemberSelector(runtime.settings, member.role);
				if (roleResolution.kind === "unassigned") return `${member.role}=unassigned`;
				if (roleResolution.kind === "invalid") return `${member.role}=invalid-selector`;
				const resolved = resolveCliModel({
					cliModel: roleResolution.selector,
					modelRegistry: runtime.session.modelRegistry,
					settings: runtime.settings,
					preferences: getModelMatchPreferences(runtime.settings),
				});
				if (!resolved.model) return `${member.role}=unresolvable`;
				const modelName = `${resolved.model.provider}/${resolved.model.id}`;
				try {
					const apiKey = await runtime.session.modelRegistry.getApiKey(resolved.model, sessionId);
					return apiKey === kNoAuth || isAuthenticated(apiKey)
						? `${member.role}=${modelName}`
						: `${member.role}=${modelName} (credentials unavailable)`;
				} catch {
					return `${member.role}=${modelName} (credentials unresolved)`;
				}
			}),
		);
		const enabled = config.members.filter(member => member.enabled).length;
		const concurrency = runtime.settings.get("task.maxConcurrency");
		return `No active council run. rounds=${config.rounds}; task.maxConcurrency=${concurrency}; roster=${enabled}/${config.members.length} enabled [${roster.join(", ")}]; cost=$0.`;
	} catch (error) {
		return `No active council run. configuration invalid: ${errorText(error)}; cost=$0.`;
	}
}

/** Shared TUI/ACP handler. Every branch consumes the slash command and never forwards task text to the model. */
export async function handleCouncilCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
	dependencies: CouncilCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<SlashCommandResult> {
	const action = parseCouncilCommandArgs(command.args);
	if (action.kind === "usage" || action.kind === "error") {
		await runtime.output(action.kind === "usage" ? COUNCIL_USAGE : action.message);
		return commandConsumed();
	}
	if (action.kind === "config") {
		if (runtime.openCouncilConfig) {
			await runtime.openCouncilConfig();
		} else {
			await runtime.output("Council configuration requires the Model Hub Roles view.");
		}
		return commandConsumed();
	}

	const coordinator = dependencies.getCoordinator(coordinatorHost(runtime));
	if (action.kind === "status") {
		try {
			if (coordinator.setupInFlight && !coordinator.snapshot) {
				await runtime.output("Council setup/preflight is in progress; cost=$0.");
			} else {
				const manifest = await coordinator.status();
				await runtime.output(manifest ? formatCouncilSnapshot(manifest) : await formatIdleCouncilStatus(runtime));
			}
		} catch (error) {
			await runtime.output(errorText(error));
		}
		return commandConsumed();
	}
	if (action.kind === "cancel") {
		try {
			const prior = coordinator.snapshot;
			const pendingSetup = coordinator.setupInFlight;
			if (pendingSetup) {
				await coordinator.cancelForSessionTransition();
				const current = coordinator.snapshot;
				const createdDuringCancellation =
					current && (!prior || current.runId !== prior.runId || current.state !== prior.state);
				await runtime.output(
					createdDuringCancellation ? formatCouncilSnapshot(current) : "Council setup cancelled before dispatch.",
				);
			} else {
				const active = await coordinator.status();
				if (!active || (isCouncilTerminalState(active.state) && !coordinator.executionInFlight)) {
					await runtime.output("No active council run.");
				} else if (isCouncilTerminalState(active.state)) {
					await runtime.output(formatCouncilSnapshot(active));
				} else {
					await runtime.output(formatCouncilSnapshot(await coordinator.cancel()));
				}
			}
		} catch (error) {
			await runtime.output(errorText(error));
		}
		return commandConsumed();
	}
	if (action.kind === "resume") {
		await runAndHold(runtime, coordinator, () => coordinator.resume(action.runId));
		return commandConsumed();
	}

	await runAndHold(runtime, coordinator, () => coordinator.start(action.task));
	return commandConsumed();
}
