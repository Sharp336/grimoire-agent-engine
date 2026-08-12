/**
 * The one impure edge between the client and the screens.
 *
 * Everything that decides what is on screen is in `state.ts` and is pure. This
 * file owns the socket, subscribes it to that reducer, and hands back the
 * actions a view can take. Keeping the split sharp is what lets a canned frame
 * stream produce byte-identical state to a live daemon.
 */

import { useEffect, useMemo, useReducer, useRef } from "react";
import { AppState } from "react-native";
import type { AgentId, ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import { OmpdClient } from "../client.ts";
import type { Connection } from "../platform/connection.ts";
import { apply, emptyConsole } from "./state.ts";
import type { ConsoleState } from "./state.ts";

export interface ConsoleActions {
  select: (agentId: AgentId) => void;
  back: () => void;
  prompt: (agentId: AgentId, text: string) => void;
  cancel: (agentId: AgentId) => void;
  decide: (agentId: AgentId, requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
  dismiss: () => void;
}

export function useConsole(connection: Connection): [ConsoleState, ConsoleActions] {
  const [state, dispatch] = useReducer(apply, connection.scopes, emptyConsole);

  // The client outlives every render and must never be rebuilt by one: a new
  // socket per render is a reconnect loop that looks like a flaky daemon.
  const clientRef = useRef<OmpdClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = new OmpdClient({ url: connection.url, token: connection.token });
  }
  const client = clientRef.current;

  /**
   * Which agents this device has already asked for a full transcript.
   *
   * A ref rather than a read of the reducer's state: `attach` is called from
   * the action, which cannot see the state it is about to produce, and asking
   * for a full backfill twice replays a log that is already on screen. Per
   * hook instance, so unpairing and pairing again starts clean.
   */
  const backfilled = useRef(new Set<AgentId>());

  useEffect(() => {
    const offs = [
      client.on("status", (event) => {
        dispatch({ t: "status", event });
      }),
      client.on("agents", (event) => {
        dispatch({ t: "agents", event });
      }),
      client.on("update", (event) => {
        dispatch({ t: "update", event });
      }),
      client.on("approval", (event) => {
        dispatch({ t: "approval", event });
      }),
      client.on("error", (event) => {
        dispatch({ t: "error", event });
      }),
      client.on("say", (event) => {
        dispatch({ t: "say", event });
      }),
      client.on("unauthorized", (event) => {
        dispatch({ t: "unauthorized", event });
      }),
    ];
    client.start();
    return () => {
      for (const off of offs) off();
      client.close();
    };
  }, [client]);

  // Phones suspend timers in the background, so a pending backoff may be hours
  // stale by the time the app is looked at again.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (status !== "active") return;
      client.reconnectNow();
    });
    return () => {
      subscription.remove();
    };
  }, [client]);

  const actions = useMemo<ConsoleActions>(
    () => ({
      select(agentId) {
        dispatch({ t: "select", agentId });
        // The first time this device sees an agent it asks for the whole
        // transcript, because a console opened mid-session should show the
        // session. After that the client's own watermark resumes, so revisiting
        // a strip never replays a log that is already on screen.
        client.attach(agentId, backfilled.current.has(agentId) ? {} : { sinceSeq: 0 });
        backfilled.current.add(agentId);
      },
      back() {
        dispatch({ t: "select", agentId: null });
      },
      prompt(agentId, text) {
        client.prompt(agentId, text);
        dispatch({ t: "prompt", agentId, text });
      },
      cancel(agentId) {
        client.cancel(agentId);
      },
      decide(agentId, requestId, choice, scope) {
        client.decide(agentId, requestId, choice, scope);
        dispatch({ t: "decide", agentId, requestId, choice });
      },
      dismiss() {
        dispatch({ t: "dismiss" });
      },
    }),
    [client],
  );

  return [state, actions];
}
