import { describe, expect, test } from "bun:test";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import {
	dispatchRpcInputFrame,
	type PendingExtensionRequest,
	RpcInputDispatcher,
	type RpcInputFrameDeps,
	RpcPendingExtensionRequests,
	RpcResponseBarrier,
	RpcShutdownCoordinator,
	RpcTerminalTeardown,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type {
	RpcCommand,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

type OutputFrame = RpcResponse | object;

const isResponseFrame = (frame: OutputFrame): frame is RpcResponse => "type" in frame && frame.type === "response";

const makeDeps = (
	handleCommand: RpcInputFrameDeps["handleCommand"],
	options?: { pendingExtensionRequests?: Map<string, PendingExtensionRequest> },
) => {
	const outputs: OutputFrame[] = [];
	const deps: RpcInputFrameDeps = {
		handleCommand,
		output: obj => {
			outputs.push(obj as OutputFrame);
		},
		errorResponse: (id, command, message) => ({
			id,
			type: "response",
			command,
			success: false,
			error: message,
		}),
		pendingExtensionRequests: options?.pendingExtensionRequests ?? new Map<string, PendingExtensionRequest>(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
	return { deps, outputs };
};

const flushMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));

const requestExtensionInput = (deps: RpcInputFrameDeps, id: string, message: string) => {
	const response = Promise.withResolvers<RpcExtensionUIResponse>();
	deps.pendingExtensionRequests.set(id, {
		resolve: response.resolve,
		reject: error => response.reject(error),
	});
	deps.output({
		type: "extension_ui_request",
		id,
		method: "input",
		message,
	});
	return response.promise;
};

const cancelledBashResponse = (id: string): RpcResponse => ({
	id,
	type: "response",
	command: "bash",
	success: true,
	data: {
		output: "",
		exitCode: -1,
		cancelled: true,
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	},
});

describe("dispatchRpcInputFrame", () => {
	test("bash is dispatched in the background so abort_bash preempts it (issue #4079 A)", async () => {
		const { promise: bashPending, resolve: resolveBash } = Promise.withResolvers<RpcResponse>();
		let abortBashCalled = false;

		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "bash") {
				// Block until abort_bash resolves the shared promise.
				return await bashPending;
			}
			if (command.type === "abort_bash") {
				abortBashCalled = true;
				// Emulate `session.abortBash()` cancelling the in-flight bash so
				// the queued executeBash promise resolves with cancelled=true.
				resolveBash(cancelledBashResponse("b1"));
				return { id: command.id, type: "response", command: "abort_bash", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);

		// Kick off bash. If the fix works, dispatchRpcInputFrame returns
		// undefined immediately without waiting for handleCommand.
		const bashAwait = dispatchRpcInputFrame({ id: "b1", type: "bash", command: "sleep 9999" }, deps);
		expect(bashAwait).toBeUndefined();
		await flushMicrotasks();
		expect(outputs).toHaveLength(0);

		// Now dispatch abort_bash. It must run serially (not backgrounded)
		// and resolve after handleCommand completes.
		const abortAwait = dispatchRpcInputFrame({ id: "a1", type: "abort_bash" }, deps);
		expect(abortAwait).toBeInstanceOf(Promise);
		await abortAwait;

		expect(abortBashCalled).toBe(true);
		expect(outputs[0]).toEqual({
			id: "a1",
			type: "response",
			command: "abort_bash",
			success: true,
		});

		// The background bash response arrives after abort_bash.
		await flushMicrotasks();
		expect(outputs).toHaveLength(2);
		const bashFrame = outputs[1] as RpcResponse;
		expect(bashFrame.command).toBe("bash");
		expect(bashFrame.success).toBe(true);
		if (bashFrame.command === "bash" && bashFrame.success) {
			expect(bashFrame.data.cancelled).toBe(true);
			expect(bashFrame.data.exitCode).toBe(-1);
		}
	});

	test("non-bash commands are dispatched serially (ordering preserved)", async () => {
		const started: string[] = [];
		const finished: string[] = [];
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			started.push(command.type);
			await Bun.sleep(5);
			finished.push(command.type);
			if (command.type === "abort_retry") {
				return { id: command.id, type: "response", command: "abort_retry", success: true };
			}
			if (command.type === "set_auto_retry") {
				return { id: command.id, type: "response", command: "set_auto_retry", success: true };
			}
			throw new Error(`unexpected: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);

		const first = dispatchRpcInputFrame({ id: "c1", type: "abort_retry" }, deps);
		expect(first).toBeInstanceOf(Promise);
		// The input loop awaits each command's promise before pulling the next
		// frame; simulate that contract by awaiting before the next dispatch.
		await first;
		expect(outputs).toHaveLength(1);
		expect(started).toEqual(["abort_retry"]);
		expect(finished).toEqual(["abort_retry"]);

		const second = dispatchRpcInputFrame({ id: "c2", type: "set_auto_retry", enabled: true }, deps);
		await second;
		expect(outputs).toHaveLength(2);
		expect(started).toEqual(["abort_retry", "set_auto_retry"]);
	});

	test("bash handler errors surface as an error response on the background frame", async () => {
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "bash") throw new Error("kaboom");
			throw new Error(`unexpected: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);

		const awaited = dispatchRpcInputFrame({ id: "b2", type: "bash", command: "echo hi" }, deps);
		expect(awaited).toBeUndefined();

		// Give the background dispatch a chance to run its catch.
		await flushMicrotasks();
		await flushMicrotasks();

		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toEqual({
			id: "b2",
			type: "response",
			command: "bash",
			success: false,
			error: "kaboom",
		});
	});

	test("background bash task is exposed so EOF cleanup can await its response", async () => {
		const bashResponse: RpcResponse = {
			id: "b3",
			type: "response",
			command: "bash",
			success: true,
			data: {
				output: "done",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 4,
				outputLines: 1,
				outputBytes: 4,
			},
		};
		const { promise: bashPending, resolve: resolveBash } = Promise.withResolvers<RpcResponse>();
		const { deps, outputs } = makeDeps(async command => {
			if (command.type === "bash") return await bashPending;
			throw new Error(`unexpected: ${command.type}`);
		});
		let trackedTask: Promise<void> | undefined;
		deps.trackBackgroundTask = task => {
			trackedTask = task;
		};

		const awaited = dispatchRpcInputFrame({ id: "b3", type: "bash", command: "echo done" }, deps);
		expect(awaited).toBeUndefined();
		expect(trackedTask).toBeInstanceOf(Promise);
		expect(outputs).toHaveLength(0);

		resolveBash(bashResponse);
		await trackedTask;

		expect(outputs).toEqual([bashResponse]);
	});
});

describe("RpcInputDispatcher", () => {
	test("control frames resolve extension UI requests while an ordinary command is active", async () => {
		let depsRef: RpcInputFrameDeps;
		const { deps, outputs } = makeDeps(async command => {
			if (command.type !== "prompt") throw new Error(`unexpected command type: ${command.type}`);
			const response = await requestExtensionInput(depsRef, "ui-active", "Continue?");
			return {
				id: command.id,
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: "value" in response && response.value === "continue" },
			};
		});
		depsRef = deps;
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "prompt-1", type: "prompt", message: "ask extension" });
		await flushMicrotasks();

		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "ui-active",
				method: "input",
				message: "Continue?",
			},
		]);

		dispatcher.dispatch({ type: "extension_ui_response", id: "ui-active", value: "continue" });
		await dispatcher.drain();

		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "ui-active",
				method: "input",
				message: "Continue?",
			},
			{
				id: "prompt-1",
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: true },
			},
		]);
	});

	test("malformed frames emit a parse error without ending the input reader", () => {
		const { deps, outputs } = makeDeps(async command => ({
			id: command.id,
			type: "response",
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		}));
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch(null);

		expect(outputs).toEqual([
			expect.objectContaining({
				type: "response",
				command: "parse",
				success: false,
				error: expect.stringContaining("Failed to parse command:"),
			}),
		]);
	});

	test("ordinary commands stay serialized while first command is blocked", async () => {
		const releaseFirst = Promise.withResolvers<void>();
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "abort_retry") {
				await releaseFirst.promise;
				return { id: command.id, type: "response", command: "abort_retry", success: true };
			}
			if (command.type === "get_state") {
				return {
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: {
						thinkingLevel: undefined,
						isStreaming: false,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "all",
						interruptMode: "immediate",
						sessionId: "session-1",
						autoCompactionEnabled: false,
						fastModeEnabled: false,
						fastModeActive: false,
						tokensPerSecond: null,
						messageCount: 0,
						queuedMessageCount: 0,
						todoPhases: [],
					},
				};
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "first", type: "abort_retry" });
		dispatcher.dispatch({ id: "second", type: "get_state" });
		await flushMicrotasks();

		expect(started).toEqual(["abort_retry"]);
		expect(outputs).toHaveLength(0);

		releaseFirst.resolve();
		await dispatcher.drain();

		expect(started).toEqual(["abort_retry", "get_state"]);
		expect((outputs[0] as RpcResponse).id).toBe("first");
		expect((outputs[1] as RpcResponse).id).toBe("second");
		expect((outputs[1] as RpcResponse).command).toBe("get_state");
	});

	test("serial command rejection emits an error response and does not poison the queue", async () => {
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "abort_retry") throw new Error("retry controller exploded");
			if (command.type === "set_auto_retry") {
				return { id: command.id, type: "response", command: "set_auto_retry", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "bad", type: "abort_retry" });
		dispatcher.dispatch({ id: "next", type: "set_auto_retry", enabled: true });
		await dispatcher.drain();

		expect(started).toEqual(["abort_retry", "set_auto_retry"]);
		expect(outputs).toEqual([
			{
				id: "bad",
				type: "response",
				command: "abort_retry",
				success: false,
				error: "retry controller exploded",
			},
			{
				id: "next",
				type: "response",
				command: "set_auto_retry",
				success: true,
			},
		]);
	});

	test("drain after EOF rejects active and queued host tool requests without emitting new calls", async () => {
		const disconnectMessage = "RPC client disconnected before host tool execution completed";
		const hostToolFrames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			hostToolFrames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_wait",
				description: "Waits for host process",
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		]);
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			if (command.type !== "prompt") throw new Error(`unexpected command type: ${command.type}`);
			started.push(command.id ?? "");
			await tool.execute(`toolu_${command.id}`, {});
			return {
				id: command.id,
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: true },
			};
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "active", type: "prompt", message: "active host tool" });
		dispatcher.dispatch({ id: "queued", type: "prompt", message: "queued host tool" });
		await flushMicrotasks();

		expect(started).toEqual(["active"]);
		expect(hostToolFrames).toHaveLength(1);
		expect(hostToolFrames[0]).toMatchObject({
			type: "host_tool_call",
			toolCallId: "toolu_active",
			toolName: "host_wait",
			arguments: {},
		});

		bridge.close(disconnectMessage);
		await dispatcher.drain();

		expect(started).toEqual(["active", "queued"]);
		expect(hostToolFrames).toHaveLength(1);
		expect(outputs).toEqual([
			{
				id: "active",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
			{
				id: "queued",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
		]);
	});

	test("drain after EOF rejects active and future extension UI requests", async () => {
		const disconnectMessage = "RPC client disconnected before extension UI response completed";
		const pendingExtensionRequests = new RpcPendingExtensionRequests();
		const started: string[] = [];
		let depsRef: RpcInputFrameDeps;
		const { deps, outputs } = makeDeps(
			async command => {
				if (command.type !== "prompt") throw new Error(`unexpected command type: ${command.type}`);
				started.push(command.id ?? "");
				await requestExtensionInput(depsRef, `${command.id}-dialog`, command.message);
				return {
					id: command.id,
					type: "response",
					command: "prompt",
					success: true,
					data: { agentInvoked: true },
				};
			},
			{ pendingExtensionRequests },
		);
		depsRef = deps;
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "active", type: "prompt", message: "active dialog" });
		dispatcher.dispatch({ id: "queued", type: "prompt", message: "queued dialog" });
		await flushMicrotasks();

		expect(started).toEqual(["active"]);
		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "active-dialog",
				method: "input",
				message: "active dialog",
			},
		]);

		pendingExtensionRequests.rejectAll(disconnectMessage);
		await dispatcher.drain();

		expect(started).toEqual(["active", "queued"]);
		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "active-dialog",
				method: "input",
				message: "active dialog",
			},
			{
				id: "active",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
			{
				type: "extension_ui_request",
				id: "queued-dialog",
				method: "input",
				message: "queued dialog",
			},
			{
				id: "queued",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
		]);
	});
});

describe("RpcShutdownCoordinator", () => {
	/** performShutdown spy that records call count and outputs.length at the moment it ran. */
	const makeShutdownRecorder = (outputs: OutputFrame[]) => {
		const state = { calls: 0, outputsAtShutdown: -1 };
		const performShutdown = async () => {
			state.calls++;
			state.outputsAtShutdown = outputs.length;
		};
		return { state, performShutdown };
	};

	/**
	 * Full production-shaped harness: a background-dispatched bash frame whose
	 * handler blocks on a gate, tracked by the coordinator exactly as
	 * `runRpcMode` wires it (`trackBackgroundTask: task => coordinator.track(task)`).
	 */
	const makeBashHarness = () => {
		const gate = Promise.withResolvers<RpcResponse>();
		const { deps, outputs } = makeDeps(async command => {
			if (command.type === "bash") return await gate.promise;
			throw new Error(`unexpected: ${command.type}`);
		});
		const shutdown = { requested: false };
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => shutdown.requested,
			performShutdown: recorder.performShutdown,
		});
		deps.trackBackgroundTask = task => coordinator.track(task);
		return { gate, deps, outputs, shutdown, recorder, coordinator };
	};

	test("deferred shutdown drains an in-flight background bash before performShutdown", async () => {
		const { gate, deps, outputs, shutdown, recorder, coordinator } = makeBashHarness();

		const awaited = dispatchRpcInputFrame({ id: "s1", type: "bash", command: "sleep 9999" }, deps);
		expect(awaited).toBeUndefined();

		// Extension calls pi.shutdown() while bash is in flight; the input loop
		// re-checks after its next serially-awaited frame.
		shutdown.requested = true;
		const check = coordinator.checkShutdownRequested();

		// The check must stay pending while the background bash still owes its
		// response frame. Race it against a flushed sentinel: if the check could
		// resolve, its microtask would win before the setImmediate tick.
		const winner = await Promise.race([check.then(() => "shutdown"), flushMicrotasks().then(() => "pending")]);
		expect(winner).toBe("pending");
		expect(recorder.state.calls).toBe(0);
		expect(outputs).toHaveLength(0);

		gate.resolve(cancelledBashResponse("s1"));
		await check;

		expect(outputs).toEqual([cancelledBashResponse("s1")]);
		expect(recorder.state.calls).toBe(1);
		// The bash response frame was already written when performShutdown ran.
		expect(recorder.state.outputsAtShutdown).toBe(1);
	});

	test("settle hook fires the deferred shutdown when no further client frames arrive", async () => {
		const { gate, deps, outputs, shutdown, recorder } = makeBashHarness();

		const awaited = dispatchRpcInputFrame({ id: "s2", type: "bash", command: "sleep 9999" }, deps);
		expect(awaited).toBeUndefined();

		// Shutdown requested mid-bash; the stdin loop is parked with no frames,
		// so the test never calls checkShutdownRequested() — only track()'s
		// settle hook can trigger it.
		shutdown.requested = true;
		await flushMicrotasks();
		expect(recorder.state.calls).toBe(0);

		gate.resolve(cancelledBashResponse("s2"));
		await flushMicrotasks();
		await flushMicrotasks();

		expect(recorder.state.calls).toBe(1);
		expect(outputs).toEqual([cancelledBashResponse("s2")]);
		expect(recorder.state.outputsAtShutdown).toBe(1);
	});

	test("concurrent triggers are latched: performShutdown runs exactly once", async () => {
		const outputs: OutputFrame[] = [];
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			performShutdown: recorder.performShutdown,
		});

		const gateA = Promise.withResolvers<void>();
		const gateB = Promise.withResolvers<void>();
		coordinator.track(gateA.promise);
		coordinator.track(gateB.promise);

		// Explicit trigger (input loop) races the settle hooks of both tasks.
		const check = coordinator.checkShutdownRequested();
		gateA.resolve();
		gateB.resolve();
		await check;
		await flushMicrotasks();
		await flushMicrotasks();

		expect(recorder.state.calls).toBe(1);
		// A later re-check reuses the latched sequence instead of re-running it.
		await coordinator.checkShutdownRequested();
		expect(recorder.state.calls).toBe(1);
	});

	test("no-op when shutdown was not requested", async () => {
		const outputs: OutputFrame[] = [];
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => false,
			performShutdown: recorder.performShutdown,
		});

		await coordinator.checkShutdownRequested();
		expect(recorder.state.calls).toBe(0);

		// A tracked task settling with the flag false never triggers shutdown.
		const gate = Promise.withResolvers<void>();
		coordinator.track(gate.promise);
		gate.resolve();
		await flushMicrotasks();
		await flushMicrotasks();
		expect(recorder.state.calls).toBe(0);
	});

	test("drain() waits for tasks tracked while draining", async () => {
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => false,
			performShutdown: async () => {},
		});

		const gateA = Promise.withResolvers<void>();
		const gateB = Promise.withResolvers<void>();
		coordinator.track(gateA.promise);
		// When A settles, a new task B enters the set mid-drain.
		void gateA.promise.then(() => {
			coordinator.track(gateB.promise);
		});

		let drained = false;
		const drain = coordinator.drain().then(() => {
			drained = true;
		});

		gateA.resolve();
		await flushMicrotasks();
		// A settled and B was tracked mid-drain; drain must keep waiting on B.
		expect(drained).toBe(false);

		gateB.resolve();
		await drain;
		expect(drained).toBe(true);
	});
});

/**
 * Production-shaped wiring of the held-`/council` response path: barrier +
 * serial dispatcher + shutdown coordinator + terminal teardown, assembled
 * exactly as `runRpcMode` assembles them, driven by a stub `handleCommand` that
 * models the `/council` builtin's command output and hold registration.
 */
describe("RPC council response barrier", () => {
	const makeCouncilHarness = (
		options: { quiesceCouncil?: () => Promise<void>; dispose?: () => Promise<void>; holdRawRejection?: boolean } = {},
	) => {
		const outputs: OutputFrame[] = [];
		const trace: string[] = [];
		const exits: number[] = [];
		const councilRun = Promise.withResolvers<void>();
		const shutdownState = { requested: false };
		let teardownFlushes = 0;
		let disposeCalls = 0;
		const slowSerialGate = Promise.withResolvers<void>();
		// Models the ordered stdout queue: every frame extends it, and reading it
		// after a write yields a promise that covers that frame.
		let stdoutQueue: Promise<void> = Promise.resolve();
		const output = (frame: object) => {
			outputs.push(frame as OutputFrame);
			stdoutQueue = stdoutQueue.then(() => {});
		};

		const barrier = new RpcResponseBarrier({
			emit: response => output(response),
			flushOutput: () => stdoutQueue,
			track: operation => shutdownCoordinator.track(operation),
		});

		const deps: RpcInputFrameDeps = {
			handleCommand: async command => {
				if (command.type === "prompt") {
					const message = command.message;
					if (message.startsWith("/council start")) {
						output({ type: "command_output", text: "Resolving council roster…" });
						const response: RpcResponse = {
							id: command.id,
							type: "response",
							command: "prompt",
							success: true,
							data: { agentInvoked: false },
						};
						// `runRpcMode` neutralizes the task inside `holdTurn`; the raw variant
						// exercises the barrier's own guarantee that a rejected run still
						// produces the correlated frame.
						barrier.hold(
							response,
							options.holdRawRejection ? councilRun.promise : councilRun.promise.catch(() => {}),
						);
						return response;
					}
					if (message === "/council cancel") {
						trace.push("council-cancel");
						output({ type: "command_output", text: "Council run-1 cancelled." });
						councilRun.resolve();
					}
					return { id: command.id, type: "response", command: "prompt", success: true };
				}
				trace.push(command.type);
				// A serial command slow enough that a later frame is still queued behind it
				// when stdin closes.
				if (command.type === "get_state") await slowSerialGate.promise;
				return { id: command.id, type: "response", command: command.type, success: true } as RpcResponse;
			},
			output,
			errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
			deferResponse: response => barrier.defer(response),
			trackBackgroundTask: task => shutdownCoordinator.track(task),
			pendingExtensionRequests: new Map<string, PendingExtensionRequest>(),
			onHostToolResult: () => {},
			onHostToolUpdate: () => {},
			onHostUriResult: () => {},
		};

		const teardown = new RpcTerminalTeardown({
			quiesceCouncil: async () => {
				trace.push("quiesce");
				await options.quiesceCouncil?.();
			},
			abandonHeldResponses: () => {
				trace.push("abandon");
				barrier.abandon();
			},
			dispose: async () => {
				disposeCalls++;
				trace.push("dispose");
				await options.dispose?.();
			},
			flushOutput: () => {
				teardownFlushes++;
				return stdoutQueue;
			},
			exit: code => {
				exits.push(code);
				trace.push(`exit:${code}`);
				return undefined as never;
			},
		});

		const shutdownCoordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => shutdownState.requested,
			prepareShutdown: () => teardown.quiesce(),
			performShutdown: () => teardown.finish(),
		});

		const dispatcher = new RpcInputDispatcher({
			deps,
			afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
		});

		return {
			outputs,
			trace,
			exits,
			dispatcher,
			teardown,
			shutdownCoordinator,
			shutdownState,
			councilRun,
			barrier,
			slowSerialGate,
			/** Whether the `/council` builtin has actually run and registered its hold. */
			councilStarted: () => outputs.some(frame => "text" in frame && frame.text === "Resolving council roster…"),
			get disposeCalls() {
				return disposeCalls;
			},
			get teardownFlushes() {
				return teardownFlushes;
			},
			/** Ids of every response frame written, in wire order. */
			responseIds: () => outputs.filter(isResponseFrame).map(frame => frame.id),
			/** The run finishing on its own: terminal command output, then settlement. */
			completeCouncil: () => {
				output({ type: "command_output", text: "Council run-1 completed; plan published." });
				councilRun.resolve();
			},
		};
	};

	/** Nothing but protocol objects may reach stdout in RPC mode. */
	const expectProtocolOnly = (outputs: OutputFrame[]) => {
		expect(outputs.every(frame => "type" in frame && typeof frame.type === "string")).toBe(true);
	};

	const settle = async () => {
		for (let pass = 0; pass < 4; pass++) await flushMicrotasks();
	};

	test("a later abort response overtakes the held council prompt response", async () => {
		const harness = makeCouncilHarness();

		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start audit the subsystem" });
		await settle();
		// The kickoff line is out, but the prompt still owes its response.
		expect(harness.outputs).toEqual([{ type: "command_output", text: "Resolving council roster…" }]);

		harness.dispatcher.dispatch({ id: "a1", type: "abort" });
		await settle();
		expect(harness.responseIds()).toEqual(["a1"]);

		harness.completeCouncil();
		await settle();
		expect(harness.responseIds()).toEqual(["a1", "p1"]);
		expectProtocolOnly(harness.outputs);
	});

	test("/council cancel is processed and answered before the held response it releases", async () => {
		const harness = makeCouncilHarness();

		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start expensive work" });
		await settle();
		harness.dispatcher.dispatch({ id: "c1", type: "prompt", message: "/council cancel" });
		await settle();

		expect(harness.trace).toContain("council-cancel");
		expect(harness.responseIds()).toEqual(["c1", "p1"]);
	});

	test("session-changing frames keep executing while a council response is held", async () => {
		const harness = makeCouncilHarness();

		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start long run" });
		await settle();
		harness.dispatcher.dispatch({ id: "n1", type: "new_session" });
		harness.dispatcher.dispatch({ id: "s1", type: "switch_session", sessionPath: "/tmp/other.jsonl" });
		harness.dispatcher.dispatch({ id: "b1", type: "branch", entryId: "entry-1" });
		harness.dispatcher.dispatch({ id: "h1", type: "handoff" });
		await settle();

		expect(harness.trace).toEqual(["new_session", "switch_session", "branch", "handoff"]);
		expect(harness.responseIds()).toEqual(["n1", "s1", "b1", "h1"]);

		harness.completeCouncil();
		await settle();
		expect(harness.responseIds()).toEqual(["n1", "s1", "b1", "h1", "p1"]);
	});

	test("terminal command output precedes exactly one correlated response on normal completion", async () => {
		const harness = makeCouncilHarness();

		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start audit" });
		await settle();
		harness.completeCouncil();
		await settle();

		expect(harness.outputs).toEqual([
			{ type: "command_output", text: "Resolving council roster…" },
			{ type: "command_output", text: "Council run-1 completed; plan published." },
			{ id: "p1", type: "response", command: "prompt", success: true, data: { agentInvoked: false } },
		]);
		expect(harness.responseIds().filter(id => id === "p1")).toHaveLength(1);
	});

	test("a rejected held task still yields exactly one correlated response and no error frame", async () => {
		const harness = makeCouncilHarness({ holdRawRejection: true });

		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start doomed run" });
		await settle();
		harness.councilRun.reject(new Error("council run failed"));
		await settle();

		expect(harness.responseIds()).toEqual(["p1"]);
		expect(harness.outputs.some(frame => isResponseFrame(frame) && frame.success === false)).toBe(false);
		expectProtocolOnly(harness.outputs);
	});

	test("pi.shutdown() during a hold quiesces first, then drains the owed response, then disposes", async () => {
		const harness = makeCouncilHarness({
			// Quiescence is what makes the held run settle at all.
			quiesceCouncil: async () => {
				harness.completeCouncil();
			},
		});

		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start audit" });
		await settle();
		harness.shutdownState.requested = true;
		await harness.shutdownCoordinator.checkShutdownRequested();
		await settle();

		expect(harness.trace).toEqual(["quiesce", "dispose", "exit:0"]);
		// The owed frame was written before disposal, not dropped by it.
		expect(harness.outputs.at(-1)).toEqual({
			id: "p1",
			type: "response",
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		});
		expect(harness.exits).toEqual([0]);
		expect(harness.disposeCalls).toBe(1);
		expect(harness.teardownFlushes).toBe(1);
		expectProtocolOnly(harness.outputs);
	});

	test("a council cancellation timeout releases the barrier and exits nonzero", async () => {
		const harness = makeCouncilHarness({
			quiesceCouncil: async () => {
				throw new Error("Council cancellation timed out after 5000ms");
			},
		});

		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start uncancellable" });
		await settle();
		harness.shutdownState.requested = true;
		await harness.shutdownCoordinator.checkShutdownRequested();
		await settle();

		expect(harness.trace).toEqual(["quiesce", "abandon", "dispose", "exit:1"]);
		// Abandoned, not dropped: the client still gets its correlated response.
		expect(harness.responseIds()).toEqual(["p1"]);
		expect(harness.exits).toEqual([1]);
		expect(harness.disposeCalls).toBe(1);
	});

	test("a disposal that rethrows a captured transition failure still exits nonzero after full teardown", async () => {
		const harness = makeCouncilHarness({
			quiesceCouncil: async () => {
				harness.completeCouncil();
			},
			dispose: async () => {
				throw new Error("Council cancellation did not settle before the transition deadline");
			},
		});

		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start audit" });
		await settle();
		harness.shutdownState.requested = true;
		await harness.shutdownCoordinator.checkShutdownRequested();
		await settle();

		expect(harness.trace).toEqual(["quiesce", "dispose", "exit:1"]);
		expect(harness.exits).toEqual([1]);
		// Owed protocol output is still drained exactly once after the failed disposal.
		expect(harness.teardownFlushes).toBe(1);
	});

	test("stdin EOF runs the same bounded sequence and latches against a prior shutdown", async () => {
		const harness = makeCouncilHarness({
			quiesceCouncil: async () => {
				harness.completeCouncil();
			},
		});

		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start audit" });
		await settle();

		// The EOF tail of `runRpcMode`, in order: accepted serial work first, then
		// Council quiescence, then the response operations waiting on it.
		await harness.dispatcher.drain();
		await harness.teardown.quiesce();
		await harness.shutdownCoordinator.drain();
		await harness.teardown.finish();

		expect(harness.trace).toEqual(["quiesce", "dispose", "exit:0"]);
		expect(harness.responseIds()).toEqual(["p1"]);

		// A late `pi.shutdown()` must not re-quiesce, re-dispose, or re-exit.
		harness.shutdownState.requested = true;
		await harness.shutdownCoordinator.checkShutdownRequested();
		await settle();
		expect(harness.disposeCalls).toBe(1);
		expect(harness.exits).toEqual([0]);
		expect(harness.teardownFlushes).toBe(1);
	});

	test("stdin EOF stops a council queued behind an accepted serial command", async () => {
		// Production quiescence peeks the registry: it is a no-op when no run exists.
		// Quiescing before the serial drain would therefore latch on nothing, then let
		// the drained `/council` frame start a run whose held response never settles.
		const harness = makeCouncilHarness({
			quiesceCouncil: async () => {
				if (harness.councilStarted()) harness.completeCouncil();
			},
		});

		harness.dispatcher.dispatch({ id: "s1", type: "get_state" });
		harness.dispatcher.dispatch({ id: "p1", type: "prompt", message: "/council start audit" });
		await settle();
		// Still parked behind the slow command when stdin closes.
		expect(harness.councilStarted()).toBe(false);

		const eof = (async () => {
			await harness.dispatcher.drain();
			await harness.teardown.quiesce();
			await harness.shutdownCoordinator.drain();
			await harness.teardown.finish();
		})();
		// The accepted command finishes during the drain, releasing the queued frame.
		harness.slowSerialGate.resolve();
		await eof;

		expect(harness.councilStarted()).toBe(true);
		expect(harness.trace).toEqual(["get_state", "quiesce", "dispose", "exit:0"]);
		expect(harness.responseIds()).toEqual(["s1", "p1"]);
		expect(harness.exits).toEqual([0]);
		expect(harness.teardownFlushes).toBe(1);
		expectProtocolOnly(harness.outputs);
	});

	test("a settlement-triggered shutdown failure is observed rather than dropped", async () => {
		const failures: unknown[] = [];
		const gate = Promise.withResolvers<void>();
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			performShutdown: async () => {
				throw new Error("teardown exploded");
			},
			onShutdownError: error => failures.push(error),
		});

		coordinator.track(gate.promise);
		gate.resolve();
		await flushMicrotasks();
		await flushMicrotasks();

		expect(failures).toHaveLength(1);
		expect(String(failures[0])).toContain("teardown exploded");
	});

	test("prepareShutdown runs before the drain so a held response can settle at all", async () => {
		const order: string[] = [];
		const held = Promise.withResolvers<void>();
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			prepareShutdown: async () => {
				order.push("prepare");
				held.resolve();
			},
			performShutdown: async () => {
				order.push("perform");
			},
		});
		coordinator.track(
			held.promise.then(() => {
				order.push("tracked");
			}),
		);

		await coordinator.checkShutdownRequested();

		expect(order).toEqual(["prepare", "tracked", "perform"]);
	});
});
