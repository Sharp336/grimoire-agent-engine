/** A wake/timeout race that releases its timer when the owner changes or stops. */
export async function waitForEngineWake(wake: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	const timeout = Promise.withResolvers<void>();
	const abort = () => timeout.resolve();
	signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, Math.min(2_147_483_647, Math.max(0, timeoutMs)));
	try {
		await Promise.race([wake, timeout.promise]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
