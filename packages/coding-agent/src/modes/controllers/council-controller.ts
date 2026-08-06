import type { TUI } from "@oh-my-pi/pi-tui";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import {
	type CouncilCoordinator,
	type CouncilCoordinatorHost,
	type CouncilCoordinatorSnapshot,
	type CouncilMemberLiveProgress,
	getCouncilCoordinator,
} from "../../council/coordinator";
import { type CouncilManifest, type CouncilMemberStatus, isCouncilTerminalState } from "../../council/state";
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import type { ToolSession } from "../../tools";
import { previewLine, replaceTabs, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import type {
	CouncilPaneComponent,
	CouncilPaneRowSnapshot,
	CouncilPaneRowStatus,
	CouncilPaneSnapshot,
} from "../components/council-pane";

interface CouncilControllerContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	ui: TUI;
	councilPane: CouncilPaneComponent;
	showError(message: string): void;
}

export interface CouncilControllerDependencies {
	getCoordinator?: (host: CouncilCoordinatorHost) => CouncilCoordinator;
}

const COUNCIL_PANE_WARNING_LIMIT_PER_SOURCE = 5;

function projectCouncilPaneWarnings(manifest: CouncilManifest): string[] {
	const warnings: string[] = [];
	for (const warning of manifest.warnings.slice(0, COUNCIL_PANE_WARNING_LIMIT_PER_SOURCE)) {
		const sanitized = previewLine(replaceTabs(sanitizeText(warning)), TRUNCATE_LENGTHS.CONTENT);
		if (sanitized) warnings.push(sanitized);
	}

	let authFallbackCount = 0;
	for (const councilRound of manifest.rounds) {
		if (authFallbackCount >= COUNCIL_PANE_WARNING_LIMIT_PER_SOURCE) break;
		for (const member of councilRound.members) {
			if (!member.authFallbackUsed) continue;
			const sanitized = previewLine(
				replaceTabs(sanitizeText(`${member.role} used an authentication fallback`)),
				TRUNCATE_LENGTHS.CONTENT,
			);
			if (sanitized) warnings.push(sanitized);
			authFallbackCount++;
			if (authFallbackCount >= COUNCIL_PANE_WARNING_LIMIT_PER_SOURCE) break;
		}
	}
	return warnings;
}

function durableMemberStatus(status: CouncilMemberStatus, attempts: number): CouncilPaneRowStatus {
	switch (status) {
		case "pending":
			return "queued";
		case "running":
			return attempts > 1 ? "retry" : "running";
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
		case "interrupted":
			return "interrupted";
	}
}

function liveMemberStatus(progress: CouncilMemberLiveProgress): CouncilPaneRowStatus {
	if (progress.retryState) return "retry";
	switch (progress.status) {
		case "pending":
			return "queued";
		case "running":
			return "running";
		case "completed":
			return "succeeded";
		case "failed":
			return "failed";
		case "aborted":
			return "interrupted";
	}
}

function plannerStatus(manifest: CouncilManifest): CouncilPaneRowStatus {
	if (manifest.state === "dispatching") return "queued";
	if (manifest.state === "planning") return "running";
	if (manifest.planVersions.some(version => version.kind === "draft")) return "succeeded";
	if (manifest.state === "failed") return "failed";
	if (manifest.state === "cancelling" || manifest.state === "interrupted") return "interrupted";
	return "succeeded";
}

function mainStatus(manifest: CouncilManifest): CouncilPaneRowStatus {
	switch (manifest.state) {
		case "adjudicating":
			return "running";
		case "completed":
		case "completed-degraded":
			return "succeeded";
		case "cancelling":
		case "interrupted":
			return "interrupted";
		case "failed":
			return manifest.failure?.phase.toLowerCase().includes("planner") === true ? "queued" : "failed";
		default:
			return "queued";
	}
}

function currentRound(manifest: CouncilManifest): CouncilManifest["rounds"][number] | undefined {
	const running = manifest.rounds.find(round => round.status === "running");
	if (running) return running;
	const unresolved = manifest.rounds.find(
		round => !manifest.planVersions.some(version => version.round === round.round),
	);
	return unresolved ?? manifest.rounds.at(-1);
}

/** Convert the durable manifest plus bounded live telemetry into an immutable pane projection. */
export function projectCouncilPaneSnapshot(snapshot: CouncilCoordinatorSnapshot): CouncilPaneSnapshot {
	const manifest = snapshot.manifest;
	const round = currentRound(manifest);
	const plannerState = plannerStatus(manifest);
	const mainState = mainStatus(manifest);
	const rows: CouncilPaneRowSnapshot[] = [
		{
			key: "planner",
			label: "Planner",
			model: manifest.planner.resolvedModel,
			effort: manifest.planner.effort,
			status: plannerState,
			attempts: plannerState === "queued" ? 0 : 1,
			error:
				manifest.failure?.phase.toLowerCase().includes("planner") === true ? manifest.failure.reason : undefined,
		},
		{
			key: "main",
			label: "Main",
			model: manifest.mainSnapshot.model,
			effort: manifest.mainSnapshot.effort,
			status: mainState,
			attempts: mainState === "queued" ? 0 : 1,
			error:
				manifest.failure && !manifest.failure.phase.toLowerCase().includes("planner")
					? manifest.failure.reason
					: undefined,
		},
	];

	for (const rosterMember of [...manifest.roster].sort((left, right) => left.order - right.order)) {
		const record = round?.members.find(member => member.order === rosterMember.order);
		const live = snapshot.members.find(
			progress => progress.round === round?.round && progress.order === rosterMember.order,
		);
		const status = live
			? liveMemberStatus(live)
			: record
				? durableMemberStatus(record.status, record.attempts)
				: "queued";
		rows.push({
			key: `member:${rosterMember.order}:${rosterMember.role}`,
			label: rosterMember.role,
			model: record?.resolvedModel ?? rosterMember.resolvedModel,
			effort: rosterMember.effort,
			status,
			attempts: Math.max(record?.attempts ?? 0, live?.attempt ?? 0),
			lastIntent: live?.lastIntent,
			currentTool: live?.currentTool,
			currentToolArgs: live?.currentToolArgs,
			recentOutput: live?.recentOutput,
			requests: live?.requests,
			tokens: live?.tokens,
			cost: live?.cost,
			error: record?.failureReason ?? live?.retryState?.errorMessage,
		});
	}

	const warnings = projectCouncilPaneWarnings(manifest);
	return {
		runId: manifest.runId,
		state: manifest.state,
		round: round?.round ?? 0,
		totalRounds: manifest.config.rounds,
		startedAt: manifest.timestamps.startedAt ?? manifest.timestamps.createdAt,
		outputPath: manifest.outputPath,
		degraded: manifest.degraded,
		warnings,
		failure: manifest.failure?.reason,
		usage: {
			requests: manifest.usage.requests,
			tokens: manifest.usage.tokens,
			cost: manifest.usage.cost,
		},
		rows,
		terminal: isCouncilTerminalState(manifest.state),
	};
}

/** Session-scoped bridge between Council orchestration and the anchored live pane. */
export class CouncilController {
	readonly #ctx: CouncilControllerContext;
	readonly #getCoordinator: (host: CouncilCoordinatorHost) => CouncilCoordinator;
	#coordinator: CouncilCoordinator | undefined;
	#snapshot: CouncilCoordinatorSnapshot | undefined;
	#unsubscribe: (() => void) | undefined;
	#inputUnsubscribe: (() => void) | undefined;
	#boundSessionId: string | undefined;
	#bindingGeneration = 0;
	#tickTimer: NodeJS.Timeout | undefined;
	#cancelRequested = false;
	#cancelPromise: Promise<void> | undefined;
	#disposed = false;

	constructor(ctx: CouncilControllerContext, dependencies: CouncilControllerDependencies = {}) {
		this.#ctx = ctx;
		this.#getCoordinator = dependencies.getCoordinator ?? getCouncilCoordinator;
	}

	attach(): void {
		if (this.#disposed) return;
		if (!this.#inputUnsubscribe) {
			this.#inputUnsubscribe = this.#ctx.ui.addInputListener(data =>
				this.#ctx.councilPane.handleInput(data) ? { consume: true } : undefined,
			);
		}
		this.rebindForSession();
	}

	rebindForSession(): void {
		if (this.#disposed) return;
		const sessionId = this.#ctx.sessionManager.getSessionId();
		if (this.#boundSessionId === sessionId && this.#unsubscribe) return;

		const generation = ++this.#bindingGeneration;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#boundSessionId = undefined;
		this.#coordinator = undefined;
		this.#snapshot = undefined;
		this.#cancelPromise = undefined;
		this.#cancelRequested = false;
		this.#stopTicker();
		this.#ctx.councilPane.update(undefined);

		let toolSession: ToolSession;
		try {
			toolSession = this.#ctx.session.getToolSession();
		} catch (error) {
			// Unit/headless sessions may be intentionally constructed without mounted
			// tools. Production interactive sessions always provide the live instance.
			logger.debug("Council TUI unavailable without ToolSession", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const coordinator = this.#getCoordinator({
			session: this.#ctx.session,
			toolSession,
			sessionManager: this.#ctx.sessionManager,
			settings: this.#ctx.settings,
			modelRegistry: this.#ctx.session.modelRegistry,
		});
		this.#coordinator = coordinator;
		this.#boundSessionId = sessionId;
		this.#unsubscribe = coordinator.subscribe(snapshot => {
			if (
				this.#disposed ||
				generation !== this.#bindingGeneration ||
				this.#boundSessionId !== sessionId ||
				this.#coordinator !== coordinator
			) {
				return;
			}
			this.updatePane(snapshot);
		});
		void coordinator.status().catch(error => {
			if (
				this.#disposed ||
				generation !== this.#bindingGeneration ||
				this.#boundSessionId !== sessionId ||
				this.#coordinator !== coordinator
			) {
				return;
			}
			logger.debug("Council status hydration failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#bindingGeneration++;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#boundSessionId = undefined;
		this.#coordinator = undefined;
		this.#inputUnsubscribe?.();
		this.#inputUnsubscribe = undefined;
		this.#stopTicker();
		this.#snapshot = undefined;
		this.#cancelRequested = false;
		this.#cancelPromise = undefined;
		this.#ctx.councilPane.update(undefined);
	}

	hasActiveCouncil(): boolean {
		if (this.#coordinator?.executionInFlight) return true;
		const manifest = this.#snapshot?.manifest;
		return manifest !== undefined && !isCouncilTerminalState(manifest.state);
	}

	isCouncilAdjudicating(): boolean {
		return !this.#cancelRequested && this.#snapshot?.mainTurnOwned === true;
	}

	cancelCouncilRun(): boolean {
		const coordinator = this.#coordinator;
		if (!this.hasActiveCouncil() || this.#cancelPromise || !coordinator) return false;
		const generation = this.#bindingGeneration;
		this.#cancelRequested = true;
		const cancellation = coordinator.cancelForSessionTransition();
		this.#cancelPromise = cancellation;
		void cancellation
			.catch(error => {
				if (generation !== this.#bindingGeneration || this.#coordinator !== coordinator) return;
				this.#ctx.showError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (generation !== this.#bindingGeneration || this.#coordinator !== coordinator) return;
				this.#cancelRequested = false;
				this.#cancelPromise = undefined;
			});
		return true;
	}

	/**
	 * Settle Council before the owning AgentSession changes identity or storage.
	 * Reuses an in-flight UI cancellation so transitions have one bounded wait.
	 */
	async quiesceForSessionTransition(): Promise<void> {
		if (this.#cancelPromise) {
			await this.#cancelPromise;
			return;
		}
		if (!this.hasActiveCouncil() || !this.cancelCouncilRun()) return;
		await this.#cancelPromise;
	}

	setPaneExpanded(expanded: boolean): void {
		this.#ctx.councilPane.setExpanded(expanded);
	}

	togglePaneExpanded(): boolean {
		return this.#ctx.councilPane.toggleExpanded();
	}

	updatePane(snapshot: CouncilCoordinatorSnapshot): void {
		if (this.#disposed) return;
		this.#snapshot = snapshot;
		if (isCouncilTerminalState(snapshot.manifest.state)) this.#cancelRequested = false;
		this.#ctx.councilPane.update(projectCouncilPaneSnapshot(snapshot));
		this.#syncTicker();
	}

	#syncTicker(): void {
		if (!this.hasActiveCouncil()) {
			this.#stopTicker();
			return;
		}
		if (this.#tickTimer) return;
		this.#tickTimer = setInterval(() => this.#ctx.councilPane.tick(), 1_000);
		this.#tickTimer.unref?.();
	}

	#stopTicker(): void {
		if (!this.#tickTimer) return;
		clearInterval(this.#tickTimer);
		this.#tickTimer = undefined;
	}
}
