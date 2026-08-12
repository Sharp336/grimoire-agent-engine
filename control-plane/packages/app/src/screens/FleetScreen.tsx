/**
 * The bay: every agent the daemon is supervising, one strip each.
 *
 * Ordered by the daemon, not re-sorted here. The roster arrives in an order the
 * daemon chose and an operator learns where a strip sits; re-sorting by state
 * would move a strip under a finger the moment it starts working, which is
 * exactly when it is about to be tapped.
 */

import type { JSX } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { Agent, AgentId } from "@ompd/core/contracts";
import { AgentStrip, EMPTY_STATS } from "../components/AgentStrip.tsx";
import type { StripStats } from "../components/AgentStrip.tsx";
import { Glyph } from "../design/icons.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, space, stroke } from "../design/tokens.ts";

export interface FleetScreenProps {
  agents: readonly Agent[];
  stats: ReadonlyMap<AgentId, StripStats>;
  selected: AgentId | null;
  onSelect: (agent: Agent) => void;
  /** Injected so a test can pin the strip clocks. */
  now?: number;
}

export function FleetScreen({ agents, stats, selected, onSelect, now }: FleetScreenProps): JSX.Element {
  return (
    <View style={styles.screen} testID="fleet">
      <View style={styles.head}>
        <Glyph name="bay" size={16} color={ink.plain} />
        <Display heading testID="fleet-title">
          Bay
        </Display>
        <Kicker color={ink.muted} testID="fleet-count">
          {`${agents.length} ${agents.length === 1 ? "strip" : "strips"}`}
        </Kicker>
      </View>

      <FlatList
        testID="fleet-list"
        data={agents as Agent[]}
        keyExtractor={(agent) => agent.id}
        renderItem={({ item }) => (
          <AgentStrip
            agent={item}
            stats={stats.get(item.id) ?? EMPTY_STATS}
            selected={item.id === selected}
            onSelect={onSelect}
            now={now}
          />
        )}
        ListEmptyComponent={<Empty />}
      />
    </View>
  );
}

function Empty(): JSX.Element {
  return (
    <View style={styles.empty} testID="fleet-empty">
      <Glyph name="bay" size={26} color={ground.edge} />
      <Body color={ink.plain}>No agents.</Body>
      <Label color={ink.muted}>Start one with ompd agents create on the machine running the daemon.</Label>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ground.base },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    paddingVertical: space.step,
    borderBottomWidth: stroke.heavy,
    borderBottomColor: ground.edge,
  },
  empty: { alignItems: "center", gap: space.step, padding: space.gulf },
});
