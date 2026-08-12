/**
 * One agent, as a strip.
 *
 * The metaphor is a controller's flight strip rather than a chat list row: a
 * fixed set of columns, in the same place on every strip, so the bay is read by
 * scanning down a column instead of reading each row. Which is why the numbers
 * are monospaced and why an absent reading prints as a dash rather than being
 * omitted, because a hole in a column is faster to see than a missing line.
 *
 * The left edge carries the state colour as a bar. It is the only colour on a
 * resting strip, so a bay of eight agents answers "which one needs me" without
 * anything being read at all.
 */

import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent } from "@ompd/core/contracts";
import { elapsed, formatMoney, shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { agentSignal, ground, ink, pressureSignal, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";

export interface StripStats {
  /** Fraction of the context window consumed, in `[0, 1]`. Null when unknown. */
  contextFraction: number | null;
  costAmount: number | null;
  costCurrency: string;
  tools: number;
  running: number;
  clearances: number;
}

export const EMPTY_STATS: StripStats = {
  contextFraction: null,
  costAmount: null,
  costCurrency: "USD",
  tools: 0,
  running: 0,
  clearances: 0,
};

export interface AgentStripProps {
  agent: Agent;
  stats: StripStats;
  selected: boolean;
  onSelect: (agent: Agent) => void;
  /** Injected so a test can pin the clocks instead of racing the wall. */
  now?: number;
}

export function AgentStrip({ agent, stats, selected, onSelect, now }: AgentStripProps): JSX.Element {
  const tone = signal[agentSignal(agent.state)];
  const pressure = stats.contextFraction === null ? null : signal[pressureSignal(stats.contextFraction)];
  const clearances = stats.clearances;

  return (
    <Pressable
      testID={`strip-${agent.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${agent.name}, ${agent.state}${clearances > 0 ? `, ${clearances} awaiting clearance` : ""}`}
      onPress={() => {
        onSelect(agent);
      }}
      style={({ pressed }) => [
        styles.strip,
        selected && styles.selected,
        pressed && { backgroundColor: ground.active },
      ]}
    >
      <View style={[styles.bar, { backgroundColor: tone }]} />
      <View style={styles.body}>
        <View style={styles.headline}>
          <Title numberOfLines={1} style={styles.name}>
            {agent.name}
          </Title>
          <Kicker color={tone} testID={`strip-state-${agent.id}`}>
            {agent.state}
          </Kicker>
        </View>

        <View style={styles.originRow}>
          <Glyph name="bay" size={10} color={ink.faint} />
          <Label color={ink.muted} numberOfLines={1} style={styles.origin}>
            {shortenPath(agent.cwd, 2)}
          </Label>
          <Data color={ink.faint}>{elapsed(agent.lastActiveAt, now)}</Data>
        </View>

        <View style={styles.readings}>
          <Reading
            glyph="load"
            tone={pressure ?? ink.faint}
            testID={`strip-context-${agent.id}`}
            value={stats.contextFraction === null ? "--" : `${Math.round(stats.contextFraction * 100)}%`}
          />
          <Reading
            glyph="cost"
            tone={ink.plain}
            testID={`strip-cost-${agent.id}`}
            value={stats.costAmount === null ? "--" : formatMoney(stats.costAmount, stats.costCurrency)}
          />
          <Reading
            glyph="activity"
            tone={stats.running > 0 ? signal.amber : ink.plain}
            testID={`strip-tools-${agent.id}`}
            value={stats.running > 0 ? `${stats.running}/${stats.tools}` : String(stats.tools)}
          />
          {clearances > 0 ? (
            <View style={styles.clearance}>
              <Glyph name="clearance" size={11} color={signal.ochre} />
              <Data color={signal.ochre} testID={`strip-clearances-${agent.id}`}>
                {clearances}
              </Data>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function Reading({
  glyph,
  value,
  tone,
  testID,
}: {
  glyph: "load" | "cost" | "activity";
  value: string;
  tone: string;
  testID: string;
}): JSX.Element {
  return (
    <View style={styles.reading}>
      <Glyph name={glyph} size={11} color={ink.faint} />
      <Data color={tone} testID={testID}>
        {value}
      </Data>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
    minHeight: TOUCH_TARGET * 1.6,
  },
  selected: { backgroundColor: ground.raised },
  bar: { width: 3 },
  body: { flex: 1, paddingVertical: space.step, paddingHorizontal: space.wide, gap: space.tight },
  headline: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.snug },
  name: { flexShrink: 1 },
  originRow: { flexDirection: "row", alignItems: "center", gap: space.tight },
  origin: { flex: 1 },
  readings: { flexDirection: "row", alignItems: "center", gap: space.wide, marginTop: space.hair },
  reading: { flexDirection: "row", alignItems: "center", gap: space.tight },
  clearance: { flexDirection: "row", alignItems: "center", gap: space.tight, marginLeft: "auto" },
});
