import { acquireH2Session } from "@oh-my-pi/pi-ai/providers/cursor/h2-pool";
import { createCursorHttp1Bridge } from "@oh-my-pi/pi-ai/providers/cursor/http1-bridge";
import { resolveCursorTransportMode } from "@oh-my-pi/pi-ai/providers/cursor/server-config";
import {
	__resetCursorTransportForTests,
	disposeCursorTransport,
	isCursorTransportDisposed,
	setCursorTransportDisposer,
} from "@oh-my-pi/pi-ai/providers/cursor/transport-lifecycle";

interface Result {
	ok: boolean;
	disposalBlocksNewWork: boolean;
	promiseIdentity: boolean;
	promisePendingBeforeRelease: boolean;
	promiseAwaitsTeardown: boolean;
	subsequentCallIdentity: boolean;
	error?: string;
}

async function main(): Promise<Result> {
	const result: Result = {
		ok: true,
		disposalBlocksNewWork: false,
		promiseIdentity: false,
		promisePendingBeforeRelease: false,
		promiseAwaitsTeardown: false,
		subsequentCallIdentity: false,
	};

	if (isCursorTransportDisposed()) {
		throw new Error("Expected transport to not be disposed initially");
	}

	await disposeCursorTransport();

	if (!isCursorTransportDisposed()) {
		throw new Error("Expected transport to be disposed after disposeCursorTransport()");
	}

	let threwH2 = false;
	try {
		await acquireH2Session("https://api2.cursor.sh", "cursor");
	} catch (err) {
		if (String(err).includes("disposed")) threwH2 = true;
	}
	if (!threwH2) {
		throw new Error("Expected acquireH2Session to reject with disposed error");
	}

	let threwMode = false;
	try {
		await resolveCursorTransportMode({
			baseUrl: "https://api2.cursor.sh",
			apiKey: "test-key",
			provider: "cursor",
			useHttp1ForAgent: false,
		});
	} catch (err) {
		if (String(err).includes("disposed")) threwMode = true;
	}
	if (!threwMode) {
		throw new Error("Expected resolveCursorTransportMode to reject with disposed error");
	}

	let threwBridge = false;
	try {
		await createCursorHttp1Bridge({
			baseUrl: "https://api2.cursor.sh",
			apiKey: "test-key",
			provider: "cursor",
			originalRequestId: "req-1",
			requestId: "req-2",
			requestBytes: new Uint8Array(),
		});
	} catch (err) {
		if (String(err).includes("disposed")) threwBridge = true;
	}
	if (!threwBridge) {
		throw new Error("Expected createCursorHttp1Bridge to reject with disposed error");
	}

	result.disposalBlocksNewWork = true;

	__resetCursorTransportForTests();
	if (isCursorTransportDisposed()) {
		throw new Error("Expected transport to not be disposed after __resetCursorTransportForTests()");
	}

	// Invariant 4: Composite Dispose Owns One Promise.
	// The disposer must not resolve until we manually trigger it, so the
	// disposal promise must remain pending at that point.
	let disposerResolver: (() => void) | undefined;
	let disposerResolved = false;

	const delayedDisposer = async (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		disposerResolver = resolve;
		await promise;
		disposerResolved = true;
	};

	setCursorTransportDisposer(delayedDisposer);

	const p1 = disposeCursorTransport();
	if (!isCursorTransportDisposed()) {
		throw new Error("Expected transport to be disposing after disposeCursorTransport()");
	}

	// Concurrent call while disposing should return the same promise.
	const p2 = disposeCursorTransport();
	result.promiseIdentity = p1 === p2;

	// The disposal promise must still be pending — the disposer has not been
	// manually triggered yet. We yield one event-loop turn via a 0ms timer;
	// if p2 settles during that window, it was already resolved (bug).
	const settledSymbol = Symbol("settled");
	const pendingSymbol = Symbol("pending");
	const probe = await Promise.race([
		p2.then(
			() => settledSymbol,
			() => settledSymbol,
		),
		new Promise<typeof settledSymbol | typeof pendingSymbol>(resolve => setTimeout(() => resolve(pendingSymbol), 0)),
	]);
	result.promisePendingBeforeRelease = probe === pendingSymbol;

	// Trigger disposer resolution.
	if (typeof disposerResolver !== "function") {
		throw new Error("disposerResolver was not set by the delayed disposer");
	}
	disposerResolver();

	// Await p2 — should wait for the delayed disposer to finish.
	await p2;
	result.promiseAwaitsTeardown = disposerResolved;

	// Subsequent call after disposal should return the same promise.
	const p3 = disposeCursorTransport();
	result.subsequentCallIdentity = p3 === p1;
	await p3;

	return result;
}

try {
	const result = await main();
	result.ok =
		result.ok &&
		result.disposalBlocksNewWork &&
		result.promiseIdentity &&
		result.promisePendingBeforeRelease &&
		result.promiseAwaitsTeardown &&
		result.subsequentCallIdentity;
	process.stdout.write(JSON.stringify(result));
	if (!result.ok) {
		process.exit(1);
	}
} catch (error) {
	const result: Result = {
		ok: false,
		disposalBlocksNewWork: false,
		promiseIdentity: false,
		promisePendingBeforeRelease: false,
		promiseAwaitsTeardown: false,
		subsequentCallIdentity: false,
		error: error instanceof Error ? error.message : String(error),
	};
	process.stdout.write(JSON.stringify(result));
	process.exit(1);
}
