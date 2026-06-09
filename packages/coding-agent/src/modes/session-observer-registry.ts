import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentProgress, SubagentLifecyclePayload, SubagentProgressPayload } from "../task";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task";
import type { EventBus } from "../utils/event-bus";

export interface ObservableSession {
	id: string;
	kind: "main" | "subagent";
	label: string;
	agent?: string;
	description?: string;
	status: "active" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	lastUpdate: number;
	/** Latest progress snapshot from the subagent executor */
	progress?: AgentProgress;
	parentId?: string;
	phase?: string;
}

export interface ObserverTreeNode {
	session: ObservableSession;
	children: ObserverTreeNode[];
}

const STATUS_MAP: Record<string, ObservableSession["status"]> = {
	started: "active",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};

export class SessionObserverRegistry {
	#sessions = new Map<string, ObservableSession>();
	#listeners = new Set<() => void>();
	#eventBusUnsubscribers: Array<() => void> = [];
	#eventBus?: EventBus;

	getEventBus(): EventBus | undefined {
		return this.#eventBus;
	}

	/** Add a change listener. Returns unsubscribe function. */
	onChange(cb: () => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	#notifyListeners(): void {
		for (const cb of this.#listeners) cb();
	}

	setMainSession(sessionFile?: string): void {
		const existing = this.#sessions.get("main");
		this.#sessions.set("main", {
			id: "main",
			kind: "main",
			label: "Main Session",
			status: "active",
			sessionFile: sessionFile ?? existing?.sessionFile,
			lastUpdate: Date.now(),
		});
		this.#notifyListeners();
	}

	getSessions(): ObservableSession[] {
		const sessions = [...this.#sessions.values()];
		sessions.sort((a, b) => {
			if (a.kind === "main") return -1;
			if (b.kind === "main") return 1;
			return a.lastUpdate - b.lastUpdate;
		});
		return sessions;
	}

	getTree(): ObserverTreeNode[] {
		const sessions = this.getSessions();
		const nodes = new Map<string, ObserverTreeNode>();

		for (const s of sessions) {
			nodes.set(s.id, { session: s, children: [] });
		}

		const parentMap = new Map<string, string | null>();

		for (const s of sessions) {
			if (s.id === "main") {
				continue;
			}
			let pId: string | null = s.parentId ?? null;
			if (!pId || pId === MAIN_AGENT_ID || pId === "main" || !this.#sessions.has(pId)) {
				pId = null;
			}
			if (pId !== null) {
				let curr: string | null = pId;
				let hasCycle = false;
				const visited = new Set<string>();
				while (curr !== null && curr !== undefined) {
					if (curr === s.id) {
						hasCycle = true;
						break;
					}
					if (visited.has(curr)) {
						hasCycle = true;
						break;
					}
					visited.add(curr);
					curr = parentMap.get(curr) ?? null;
				}
				if (hasCycle) {
					pId = null;
				}
			}
			parentMap.set(s.id, pId);
		}

		const roots: ObserverTreeNode[] = [];
		const mainNode = nodes.get("main");
		if (mainNode) {
			roots.push(mainNode);
		}

		for (const s of sessions) {
			if (s.id === "main") {
				continue;
			}
			const node = nodes.get(s.id)!;
			const pId = parentMap.get(s.id);
			if (pId === null || pId === undefined) {
				if (mainNode) {
					mainNode.children.push(node);
				} else {
					roots.push(node);
				}
			} else {
				const parentNode = nodes.get(pId);
				if (parentNode) {
					parentNode.children.push(node);
				} else {
					if (mainNode) {
						mainNode.children.push(node);
					} else {
						roots.push(node);
					}
				}
			}
		}

		return roots;
	}

	getActiveSubagentCount(): number {
		let count = 0;
		for (const s of this.#sessions.values()) {
			if (s.kind === "subagent" && s.status === "active") count++;
		}
		return count;
	}

	/** Clear all tracked sessions (e.g. on session switch). Keeps EventBus subscriptions and listeners. */
	resetSessions(): void {
		this.#sessions.clear();
		this.#notifyListeners();
	}

	dispose(): void {
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];
		this.#sessions.clear();
		this.#listeners.clear();
	}

	subscribeToEventBus(eventBus: EventBus): void {
		this.#eventBus = eventBus;
		// Dispose previous EventBus subscriptions if called again
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];

		this.#eventBusUnsubscribers.push(
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				const payload = data as SubagentLifecyclePayload;
				const status = STATUS_MAP[payload.status];
				if (!status) return;

				const existing = this.#sessions.get(payload.id);
				const parentId = payload.parentId;
				const phase = (payload as any).phase;
				if (existing) {
					existing.status = status;
					existing.lastUpdate = Date.now();
					if (payload.description) existing.description = payload.description;
					if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
					existing.parentId = parentId ?? existing.parentId;
					if (phase !== undefined) existing.phase = phase;
				} else {
					this.#sessions.set(payload.id, {
						id: payload.id,
						kind: "subagent",
						label: payload.description ?? `Subagent #${payload.index}`,
						agent: payload.agent,
						description: payload.description,
						status,
						sessionFile: payload.sessionFile,
						lastUpdate: Date.now(),
						parentId,
						...(phase !== undefined ? { phase } : {}),
					});
				}
				this.#notifyListeners();
			}),
		);

		this.#eventBusUnsubscribers.push(
			eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				const payload = data as SubagentProgressPayload;
				const progress = payload.progress;
				const id = progress.id;
				const existing = this.#sessions.get(id);

				const parentId = payload.parentId;
				if (existing) {
					existing.lastUpdate = Date.now();
					existing.progress = progress;
					if (progress.description) existing.description = progress.description;
					if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
					existing.parentId = parentId ?? existing.parentId;
				} else {
					this.#sessions.set(id, {
						id,
						kind: "subagent",
						label: progress.description ?? `Subagent #${payload.index}`,
						agent: payload.agent,
						description: progress.description,
						status: "active",
						sessionFile: payload.sessionFile,
						lastUpdate: Date.now(),
						progress,
						parentId,
					});
				}
				this.#notifyListeners();
			}),
		);
	}
}
