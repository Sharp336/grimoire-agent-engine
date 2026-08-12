/**
 * One agent's log, with its instruments under it.
 *
 * The header carries identity and state; the transcript carries the work; the
 * readout carries the two numbers that decide whether to keep going. Composer
 * last, because it is the only thing here a thumb reaches for.
 */

import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import { Composer } from "../components/Composer.tsx";
import { StatusReadout } from "../components/StatusReadout.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { elapsed, shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { agentSignal, ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { ConnectionState } from "../client.ts";
import type { SessionState } from "../session/model.ts";

export interface SessionScreenProps {
  agent: Agent;
  session: SessionState;
  connection: ConnectionState;
  attempt: number;
  delayMs?: number;
  canApprove: boolean;
  refusal?: string;
  /** The daemon's prose for the last settled turn, if it sent one. */
  spoken: string | null;
  /** Pending clearances across the fleet, so the readout is not agent-local. */
  fleetClearances: number;
  onBack: () => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
  now?: number;
}

export function SessionScreen(props: SessionScreenProps): JSX.Element {
  const { agent, session, connection } = props;
  const tone = signal[agentSignal(agent.state)];
  const busy = agent.state === "busy";

  return (
    <View style={styles.screen} testID="session">
      <View style={[styles.head, { borderBottomColor: tone }]}>
        <Pressable
          testID="session-back"
          accessibilityRole="button"
          accessibilityLabel="Back to the bay"
          onPress={props.onBack}
          style={styles.back}
        >
          <Glyph name="back" size={14} color={ink.plain} />
        </Pressable>

        <View style={styles.ident}>
          <Title heading numberOfLines={1} testID="session-name">
            {agent.name}
          </Title>
          <View style={styles.meta}>
            <Label color={ink.muted} numberOfLines={1} style={styles.origin}>
              {shortenPath(agent.cwd, 3)}
            </Label>
            <Data color={ink.faint}>{elapsed(agent.lastActiveAt, props.now)}</Data>
          </View>
        </View>

        <Kicker color={tone} testID="session-state">
          {agent.state}
        </Kicker>
      </View>

      <Transcript
        entries={session.entries}
        canApprove={props.canApprove}
        refusal={props.refusal}
        onDecide={props.onDecide}
        spoken={props.spoken}
      />

      <StatusReadout
        state={connection}
        attempt={props.attempt}
        delayMs={props.delayMs}
        usage={session.usage}
        clearances={props.fleetClearances}
      />

      <Composer
        enabled={connection === "connected"}
        busy={busy}
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ground.base },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.heavy,
  },
  back: { width: TOUCH_TARGET, height: TOUCH_TARGET, alignItems: "center", justifyContent: "center" },
  ident: { flex: 1, gap: space.hair },
  meta: { flexDirection: "row", alignItems: "center", gap: space.snug },
  origin: { flexShrink: 1 },
});
