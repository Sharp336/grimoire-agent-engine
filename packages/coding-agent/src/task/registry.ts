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
				handle.status = "completed";
				handle.result = result.details?.results;
				handle.completedAt = Date.now();
				this.#fireCompletion(id);
			})
			.catch(err => {
				handle.status = "failed";
				handle.error = err instanceof Error ? err.message : String(err);
				handle.completedAt = Date.now();
				this.#fireCompletion(id);
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
		return true;
	}

	/**
	 * Register a callback to fire when a task completes (success, error, or cancellation).
	 */
	onComplete(id: string, callback: (handle: AsyncTaskHandle) => void): void {
		if (!this.#completionCallbacks.has(id)) {
			this.#completionCallbacks.set(id, new Set());
		}
		this.#completionCallbacks.get(id)!.add(callback);
	}

	/**
	 * Clean up completed tasks from the registry.
	 * Keeps running tasks.
	 */
	cleanup(): void {
		for (const [id, task] of this.#tasks.entries()) {
			if (task.status !== "running") {
				this.#tasks.delete(id);
				this.#completionCallbacks.delete(id);
			}
		}
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
}
