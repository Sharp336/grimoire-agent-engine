/**
 * The position: the bay, a log, and the wiring between the socket and both.
 *
 * All of the decisions live in `state.ts`. This places them.
 */

import type { JSX } from "react";
import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Toast } from "../components/Toast.tsx";
import { useSplitLayout } from "../design/layout.ts";
import { ground, stroke } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";
import { FleetScreen } from "../screens/FleetScreen.tsx";
import { SessionScreen } from "../screens/SessionScreen.tsx";
import { allStats, fleetClearances, sessionFor } from "./state.ts";
import { useConsole } from "./useConsole.ts";

export function Console({
  connection,
  onUnpair,
}: {
  connection: Connection;
  onUnpair: (notice?: string) => void;
}): JSX.Element {
  const [state, actions] = useConsole(connection);
  const split = useSplitLayout();

  useEffect(() => {
    if (state.unauthorized === null) return;
    onUnpair(`${state.unauthorized} Pair this device again to carry on.`);
  }, [state.unauthorized, onUnpair]);

  const stats = useMemo(() => allStats(state), [state]);
  const clearances = useMemo(() => fleetClearances(state), [state]);
  const agent = state.agents.find((candidate) => candidate.id === state.selected) ?? null;

  // Wide enough for both and nothing open is a hole rather than a choice, so
  // the top strip is taken. On a phone, opening a log is a deliberate act.
  useEffect(() => {
    if (!split || state.selected !== null) return;
    const top = state.agents[0];
    if (top !== undefined) actions.select(top.id);
  }, [split, state.selected, state.agents, actions]);

  const bay = (
    <FleetScreen
      agents={state.agents}
      stats={stats}
      selected={state.selected}
      onSelect={(picked) => {
        actions.select(picked.id);
      }}
    />
  );

  const log =
    agent === null ? null : (
      <SessionScreen
        agent={agent}
        session={sessionFor(state, agent.id)}
        connection={state.connection}
        attempt={state.attempt}
        delayMs={state.delayMs}
        canApprove={state.canApprove}
        refusal={state.refusal}
        spoken={state.spoken.get(agent.id)?.text ?? null}
        fleetClearances={clearances}
        onBack={actions.back}
        onSubmit={(text) => {
          actions.prompt(agent.id, text);
        }}
        onCancel={() => {
          actions.cancel(agent.id);
        }}
        onDecide={(requestId, choice, scope) => {
          actions.decide(agent.id, requestId, choice, scope);
        }}
      />
    );

  return (
    <View style={styles.position} testID="console">
      {split ? (
        <View style={styles.split}>
          <View style={styles.bay}>{bay}</View>
          <View style={styles.log}>{log}</View>
        </View>
      ) : (
        (log ?? bay)
      )}
      {state.notice === null ? null : <Toast message={state.notice} onDismiss={actions.dismiss} />}
    </View>
  );
}

const styles = StyleSheet.create({
  position: { flex: 1, backgroundColor: ground.base },
  split: { flex: 1, flexDirection: "row" },
  bay: { width: 340, borderRightWidth: stroke.heavy, borderRightColor: ground.edge },
  log: { flex: 1 },
});
