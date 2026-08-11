/**
 * Ordering-critical RPC session startup.
 *
 * RPC mode must start a resuming session in this exact order:
 *   1. install the output subscriber,
 *   2. initializeExtensions with `emitSessionStart: false` and the runtime
 *      event delivery gate engaged (`pauseRuntimeEventDelivery: true`),
 *   3. attachHeadlessGoalAdapter (its initial `controller.restore()`),
 *   4. resumeRuntimeEventDelivery (buffered credential_disabled /
 *      mcp_notification deliver now that the goal is restored),
 *   5. emitExtensionSessionStart.
 *
 * Restore() is what reconciles a persisted goal: it sets goal-mode state,
 * exposes the `goal` tool, and emits `goal_updated`. That event must reach
 * (a) the output subscriber installed BEFORE restore (get_state has no goal
 * field — the event is the only client signal) and (b) an INITIALIZED
 * extension runner (an uninitialized runtime throws on tool access). And
 * `session_start` must fire only AFTER restore so a session_start handler that
 * inspects tools or starts a turn observes goal-mode state.
 *
 * The runtime event delivery gate covers the second turn-starting hazard:
 * `credential_disabled` / `mcp_notification` handlers may call
 * `pi.sendUserMessage` and start a turn. The runner must be initialized
 * BEFORE restore (so restore's `goal_updated` reaches initialized handlers),
 * but if notifications buffered before initialize were drained during
 * initialize — or if fresh ones delivered immediately — the resulting turn
 * would run with NO goal restored. The gate holds those two event types
 * buffered from initialize until step 4, so a notification handler that sends
 * a message starts its turn in goal mode. `goal_updated` is deliberately NOT
 * gated: restore's `goal_updated` reaches initialized handlers while the gate
 * is still held.
 *
 * The whole sequence lives here — not inline in runRpcMode — so the ordering
 * test binds to the same production wiring it guards.
 */
import { attachHeadlessGoalAdapter } from "../../goals/headless-goal-adapter";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { emitExtensionSessionStart, type InitializeExtensionsOptions, initializeExtensions } from "../runtime-init";

/**
 * Run the RPC startup sequence: install the event subscriber, initialize the
 * extension runner WITHOUT emitting `session_start` and with runtime event
 * delivery paused, restore any persisted goal via the headless goal adapter,
 * resume runtime event delivery (buffered notifications now deliver with the
 * goal restored), then emit `session_start` last.
 *
 * @param output Event sink for agent session events (RPC stdout in production).
 * @param options Extension init options; `emitSessionStart` is forced to false
 *   and `pauseRuntimeEventDelivery` defaults to true (pass `false` only to
 *   prove the gate is load-bearing) so `session_start` can never precede the
 *   goal restore and no startup notification can start a turn before it.
 * @returns The goal-adapter detach function (unsubscribes + clears the switch
 *   reconciler). Call it at shutdown before `session.dispose()`.
 */
export async function runRpcSessionStartup(
	session: AgentSession,
	output: (event: AgentSessionEvent) => void,
	options: Omit<InitializeExtensionsOptions, "emitSessionStart">,
): Promise<() => void> {
	// Output all agent events as JSON. Installed BEFORE the goal adapter's
	// initial restore so the `goal_updated` a resumed goal emits during restore
	// reaches the client (get_state has no goal field — the event is the only
	// signal). The steps below that precede restore (runner.initialize/onError)
	// emit no agent events, so nothing spurious is forwarded during init.
	session.subscribe(event => {
		output(event);
	});

	// Set up extensions with RPC-based UI context, deferring `session_start`:
	// a session_start handler may inspect tools or start a turn, so it must run
	// AFTER the goal adapter has restored a persisted goal. The runner itself
	// is still initialized here so the `goal_updated` emitted by restore()
	// reaches initialized extension handlers — and runtime event delivery is
	// paused so buffered/fresh credential_disabled / mcp_notification cannot
	// start a turn before the restore (a handler that calls pi.sendUserMessage
	// would run outside goal mode).
	await initializeExtensions(session, {
		...options,
		emitSessionStart: false,
		pauseRuntimeEventDelivery: options.pauseRuntimeEventDelivery ?? true,
	});

	// Drive goal-mode lifecycle for this headless RPC session (enter/resume/
	// drop + opt-in auto-continuation). The initial restore reconciles a
	// persisted goal and emits `goal_updated` — which must reach BOTH the
	// output subscriber installed above AND the initialized extension runner
	// (goal_updated is not gated). Detached at shutdown so no continuation can
	// be submitted after session.dispose().
	const detachGoalAdapter = await attachHeadlessGoalAdapter(session, "rpc");

	// Deliver notifications held by the delivery gate: buffered (pre-init and
	// during the pause) credential_disabled / mcp_notification now reach their
	// handlers with the goal restored, so a handler that calls sendUserMessage
	// starts its turn in goal mode. runner.onError was already registered by
	// initializeExtensions, so the direct drain needs no microtask deferral.
	await session.extensionRunner?.resumeRuntimeEventDelivery();

	// Extensions now observe the restored session: any session_start handler
	// that inspects tools or starts a turn sees goal-mode state. Emitted last
	// so session_start can never precede the goal restore.
	await emitExtensionSessionStart(session);

	return detachGoalAdapter;
}
