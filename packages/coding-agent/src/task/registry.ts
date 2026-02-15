import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AgentProgress, SingleResult, TaskToolDetails } from "./types";

/**
 * Handle for an async task execution.
 * Tracks state, progress, and completion of task runs.
 */
export interface AsyncTaskHandle {
	/** Unique task identifier */
	id: string;

	/** Current execution status */
	status: "running" | "completed" | "failed" | "cancelled";

	/** Agent type being executed */
	agent: string;

	/** Human-readable task description */
	description: string;

	/** Task creation timestamp (milliseconds) */
	createdAt: number;

	/** Task completion timestamp (milliseconds), only set when status != "running" */
	completedAt?: number;

	/** Progress tracking for the task execution */
	progress: AgentProgress[];

	/** Result data from the task, only set when status === "completed" */
	result?: SingleResult[];

	/** Error message, only set when status === "failed" */
	error?: string;

	/** Whether followUp delivery failed (user must check task result manually) */
	followUpDeliveryFailed?: boolean;

	/** Abort controller for cancellation */
	abortController: AbortController;

	/** Underlying promise for the task execution */
	promise: Promise<AgentToolResult<TaskToolDetails>>;
}

/**
 * Per-session registry for tracking async task handles.
 * Singleton within a session context.
 *
 * Simple state management: stores tasks in a Map, calls callbacks on completion,
 * enforces limits, and provides cleanup for completed tasks.
 */
export class TaskRegistry {
	static readonly MAX_TASKS = 100;

	#tasks = new Map<string, AsyncTaskHandle>();
	#completionCallbacks = new Map<string, Set<(handle: AsyncTaskHandle) => void>>();
	#evictionTimers = new Map<string, NodeJS.Timeout>();

	/**
	 * Register a new task.
	 * Throws if max running task limit is exceeded.
	 */
	register(id: string, handle: AsyncTaskHandle): void {
		const runningCount = Array.from(this.#tasks.values()).filter(t => t.status === "running").length;
		if (runningCount >= TaskRegistry.MAX_TASKS) {
			throw new Error(`Task limit of ${TaskRegistry.MAX_TASKS} running tasks exceeded`);
		}

		this.#tasks.set(id, handle);

		// Attach completion handler to the promise
		handle.promise
			.then(result => {
				// Only update status if still running (not cancelled)
				if (handle.status === "running") {
					handle.status = "completed";
					handle.result = result.details?.results;
					handle.completedAt = Date.now();
					this.#fireCompletion(id);
					// Schedule auto-eviction after retention period (5 minutes)
					this.#scheduleEviction(id);
				}
			})
			.catch(err => {
				// Only update status if still running (not cancelled)
				if (handle.status === "running") {
					handle.status = "failed";
					handle.error = err instanceof Error ? err.message : String(err);
					handle.completedAt = Date.now();
					this.#fireCompletion(id);
					// Schedule auto-eviction after retention period (5 minutes)
					this.#scheduleEviction(id);
				}
			});
	}

	/**
	 * Get a task by id.
	 * Returns undefined if not found.
	 */
	get(id: string): AsyncTaskHandle | undefined {
		return this.#tasks.get(id);
	}

	/**
	 * List all registered tasks.
	 */
	list(): AsyncTaskHandle[] {
		return Array.from(this.#tasks.values());
	}

	/**
	 * Cancel a task by id.
	 * Returns true if cancelled, false if already completed or unknown.
	 */
	cancel(id: string): boolean {
		const task = this.#tasks.get(id);
		if (!task) return false;
		if (task.status !== "running") return false;

		task.status = "cancelled";
		task.completedAt = Date.now();
		task.abortController.abort();
		this.#fireCompletion(id);
		this.#scheduleEviction(id);
		return true;
	}

	/**
	 * Register a callback to fire when a task completes (success, error, or cancellation).
	 * Handles being called before the task is registered (stores callbacks for later).
	 */
	onComplete(id: string, callback: (handle: AsyncTaskHandle) => void): void {
		if (!this.#completionCallbacks.has(id)) {
			this.#completionCallbacks.set(id, new Set());
		}
		const callbacks = this.#completionCallbacks.get(id);
		if (callbacks) {
			callbacks.add(callback);
		}

		// If task already exists and is completed, fire the callback immediately
		const handle = this.#tasks.get(id);
		if (handle && handle.status !== "running") {
			try {
				callback(handle);
			} catch {
				// Callbacks handle their own errors
			}
			if (callbacks) {
				callbacks.delete(callback);
			}
		}
	}

	/**
	 * Clean up completed tasks from the registry.
	 * Keeps running tasks.
	 */
	cleanup(): void {
		for (const [id, task] of this.#tasks.entries()) {
			if (task.status !== "running") {
				// Clear timer first (exception safety)
				const timer = this.#evictionTimers.get(id);
				if (timer) clearTimeout(timer);
				this.#evictionTimers.delete(id);
				// Then clean task and callbacks
				this.#tasks.delete(id);
				this.#completionCallbacks.delete(id);
			}
		}
		// Safety net for any remaining timers
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#fireCompletion(id: string): void {
		const callbacks = this.#completionCallbacks.get(id);
		const handle = this.#tasks.get(id);
		if (callbacks && handle) {
			for (const callback of callbacks) {
				try {
					callback(handle);
				} catch {
					// Callbacks handle their own errors
				}
			}
			this.#completionCallbacks.delete(id);
		}
	}

	#scheduleEviction(id: string): void {
		// Schedule auto-eviction after 5 minutes to allow check_task to work with recently completed tasks
		const RETENTION_MS = 5 * 60 * 1000; // 5 minutes
		const timer = setTimeout(() => {
			const handle = this.#tasks.get(id);
			if (handle && handle.status !== "running") {
				this.#tasks.delete(id);
				this.#completionCallbacks.delete(id);
			}
			this.#evictionTimers.delete(id);
		}, RETENTION_MS);
		timer.unref();
		this.#evictionTimers.set(id, timer);
	}
}
