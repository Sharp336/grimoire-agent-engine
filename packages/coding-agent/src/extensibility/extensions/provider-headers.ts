/**
 * Wraps a {@link StreamFn} so extensions can observe and edit provider request
 * headers per request, via the `before_provider_headers` event.
 *
 * Applied at the stream-fn boundary rather than inside a provider: every
 * provider reads its request headers from `options.headers`, so editing that
 * once here reaches all of them without per-provider changes. `StreamFn`
 * already permits a promise return, so awaiting the handlers needs no signature
 * change.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { ExtensionRunner } from "./runner";

/**
 * Build a {@link StreamFn} that emits `before_provider_headers` before
 * forwarding to `base`.
 *
 * Handlers receive a copy of `options.headers`, so a handler cannot mutate the
 * caller's object, and a caller reusing its options across requests is not
 * affected by a previous request's edits. When no extension subscribes, `base`
 * is called directly and no copy is made.
 */
export function wrapStreamFnWithProviderHeaders(runner: ExtensionRunner, base: StreamFn): StreamFn {
	return async (model, context, options) => {
		if (!runner.hasHandlers("before_provider_headers")) return base(model, context, options);
		const headers = await runner.emitBeforeProviderHeaders({ ...options?.headers }, model);
		return base(model, context, { ...options, headers });
	};
}
