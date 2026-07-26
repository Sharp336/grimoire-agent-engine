import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError, throwIfAborted } from "../tool-errors";

/**
 * Marks a run-scoped promise as observed without changing its behavior for awaited callers.
 *
 * Browser run teardown aborts can reject promises created for evaluated code after user code
 * has stopped observing them (for example fire-and-forget `wait()`/facade calls). In 16.3.0
 * those zero-consumer rejections reached the process-level `unhandledRejection` handler and
 * killed every subagent sharing the process (issues #4499/#4672). Attaching a no-op rejection
 * handler at creation makes the promise observed while returning the original promise so callers
 * that do await it still receive the rejection.
 */
export function markHandled<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => undefined);
	return promise;
}

/** Headroom subtracted from the cell budget so an in-run deadline fires before the opaque whole-cell timeout. */
export const CELL_BUDGET_SLACK_MS = 1_000;

/** Default poll deadline for `wait(predicate)` before clamping to the cell budget. */
export const DEFAULT_PREDICATE_TIMEOUT_MS = 30_000;

/** Options for the predicate form of the run-scoped `wait()` helper. */
export interface WaitPredicateOptions {
	/** Max time to poll before failing, in ms (default 30s, clamped to the cell budget). */
	timeout?: number;
	/** Poll interval in ms (default 100, floor 10). */
	interval?: number;
}

/**
 * Effective `wait(predicate)` deadline for a given cell budget. Always strictly below
 * the cell budget so the named `wait(predicate) timed out` error wins the race against
 * the opaque whole-cell "Browser code execution timed out". `0`/`Infinity` ("disable")
 * map to the largest bounded deadline; negative/NaN garbage falls back to the default.
 */
export function resolvePredicateTimeout(cellTimeoutMs: number, explicit?: number): number {
	const budgetBound = Math.max(1, cellTimeoutMs - CELL_BUDGET_SLACK_MS);
	if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;
	if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
	return Math.min(DEFAULT_PREDICATE_TIMEOUT_MS, budgetBound);
}

/**
 * Run-scoped `wait()` helper for evaluated browser code, honoring the owning run's
 * cancellation signal.
 *
 * - `wait(ms)` sleeps for `ms` milliseconds.
 * - `wait(fn, { timeout?, interval? })` polls `fn` (sync or async) until it returns a
 *   truthy value and resolves with that value; throws a named `ToolError` on timeout
 *   instead of stalling into the whole-cell deadline. Predicate errors propagate.
 */
export function waitForBrowserRun(
	msOrPredicate: number | (() => unknown),
	signal: AbortSignal,
	opts?: WaitPredicateOptions,
): Promise<unknown> {
	const promise = (async (): Promise<unknown> => {
		throwIfAborted(signal);
		if (typeof msOrPredicate === "number") {
			await untilAborted(signal, async () => await Bun.sleep(msOrPredicate));
			throwIfAborted(signal);
			return undefined;
		}
		if (typeof msOrPredicate !== "function") {
			throw new ToolError("wait(...) expects milliseconds (number) or a predicate function to poll");
		}
		const timeout =
			opts?.timeout !== undefined && Number.isFinite(opts.timeout) && opts.timeout > 0
				? opts.timeout
				: DEFAULT_PREDICATE_TIMEOUT_MS;
		const interval = Math.max(opts?.interval ?? 100, 10);
		const deadline = Date.now() + timeout;
		for (;;) {
			const value = await untilAborted(signal, async () => await msOrPredicate());
			throwIfAborted(signal);
			if (value) return value;
			if (Date.now() + interval > deadline) {
				throw new ToolError(`wait(predicate) timed out after ${timeout}ms — predicate never returned truthy`);
			}
			await untilAborted(signal, async () => await Bun.sleep(interval));
		}
	})();
	return markHandled(promise);
}

/** Binds a long-lived browser facade to one evaluated run's abort signal. */
export function bindBrowserRunFacade<T extends object>(target: T, signal: AbortSignal): T {
	const boundObjects = new WeakMap<object, object>();
	const hasCallableSurface = (value: object): boolean => {
		for (const key of Reflect.ownKeys(value)) {
			if (typeof Object.getOwnPropertyDescriptor(value, key)?.value === "function") return true;
		}
		const prototype = Object.getPrototypeOf(value);
		if (!prototype || prototype === Object.prototype || prototype === Array.prototype) return false;
		return Reflect.ownKeys(prototype).some(
			key => key !== "constructor" && typeof Object.getOwnPropertyDescriptor(prototype, key)?.value === "function",
		);
	};
	const bind = <U extends object>(current: U): U => {
		if (current instanceof AbortSignal) return current;
		const existing = boundObjects.get(current);
		if (existing) return existing as U;
		const cache = new Map<PropertyKey, unknown>();
		const proxy = new Proxy(current, {
			get(source, prop) {
				throwIfAborted(signal);
				if (cache.has(prop)) return cache.get(prop);
				const value = Reflect.get(source, prop, source);
				if (typeof value === "function") {
					const wrapped = (...args: unknown[]): unknown => {
						throwIfAborted(signal);
						const result = Reflect.apply(value, source, args);
						if (result && typeof result === "object") {
							const then = Reflect.get(result, "then");
							if (typeof then === "function") {
								return markHandled(
									Promise.resolve(result).then(resolved => {
										throwIfAborted(signal);
										if (!resolved || typeof resolved !== "object") return resolved;
										const callableValue = Array.isArray(resolved)
											? resolved.some(item => item && typeof item === "object" && hasCallableSurface(item))
											: hasCallableSurface(resolved);
										return callableValue ? bind(resolved) : resolved;
									}),
								);
							}
						}
						throwIfAborted(signal);
						return result;
					};
					cache.set(prop, wrapped);
					return wrapped;
				}
				if (value && typeof value === "object") {
					const wrapped = bind(value);
					cache.set(prop, wrapped);
					return wrapped;
				}
				return value;
			},
		});
		boundObjects.set(current, proxy);
		return proxy;
	};
	return bind(target);
}
