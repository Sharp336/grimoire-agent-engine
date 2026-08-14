/** The paired app's two peer surfaces share one live selected-agent target. */

import type { Agent, AgentId } from "@ompd/core/contracts";
import type { JSX } from "react";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Console } from "../console/Console.tsx";
import { useCowork } from "../cowork/useCowork.ts";
import { Glyph } from "../design/icons.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";
import { CoworkScreen } from "./CoworkScreen.tsx";

type Surface = "console" | "cowork";

/**
 * Exported for a render-level integration test without mutating durable pairing
 * state. Initial values model the state after a tab press and a console agent
 * selection; production takes the default console route.
 */
export function PairedShell({
  connection,
  onUnpair,
  initialSurface = "console",
  initialAgent = null,
}: {
  connection: Connection;
  onUnpair: (notice?: string) => void;
  initialSurface?: Surface;
  initialAgent?: Agent | null;
}): JSX.Element {
  const [surface, setSurface] = useState<Surface>(initialSurface);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(initialAgent);
  const [requestedAgentId, setRequestedAgentId] = useState<AgentId | null>(null);

  const openSession = useCallback((agentId: string) => {
    setRequestedAgentId(agentId as AgentId);
    setSurface("console");
  }, []);

  return (
    <View style={styles.app} testID="paired-shell">
      <View style={styles.switcher} accessibilityRole="tablist">
        <SurfaceButton active={surface === "console"} label="Console" glyph="bay" onPress={() => setSurface("console")} />
        <SurfaceButton active={surface === "cowork"} label="Cowork" glyph="tasks" onPress={() => setSurface("cowork")} />
      </View>
      <View style={styles.content}>
        {surface === "console" ? (
          <Console
            key={`${connection.url}:${connection.token.length}`}
            connection={connection}
            onUnpair={onUnpair}
            onSelectedAgentChange={setSelectedAgent}
            requestedAgentId={requestedAgentId}
          />
        ) : (
          <CoworkPane connection={connection} agent={selectedAgent} onOpenSession={openSession} />
        )}
      </View>
    </View>
  );
}

function CoworkPane({ connection, agent, onOpenSession }: { connection: Connection; agent: Agent | null; onOpenSession: (agentId: string) => void }): JSX.Element {
  if (agent === null) {
    return (
      <View style={styles.empty} testID="cowork-needs-agent">
        <Text style={styles.emptyText}>Select an agent in Console before starting a task.</Text>
      </View>
    );
  }
  return <ConnectedCowork connection={connection} agent={agent} onOpenSession={onOpenSession} />;
}

function ConnectedCowork({ connection, agent, onOpenSession }: { connection: Connection; agent: Agent; onOpenSession: (agentId: string) => void }): JSX.Element {
  const [state, actions] = useCowork(connection, agent.cwd, agent.id);
  return (
    <CoworkScreen
      tasks={state.tasks}
      skills={state.skills}
      connectors={state.connectors}
      onStartTask={(input) => void actions.startTask(input)}
      onInvokeSkill={(skill) => void actions.startTask({ title: skill.name, prompt: `/${skill.name}`, skillName: skill.name })}
      onOpenSession={onOpenSession}
    />
  );
}

function SurfaceButton({ active, label, glyph, onPress }: { active: boolean; label: string; glyph: "bay" | "tasks"; onPress: () => void }): JSX.Element {
  const color = active ? signal.amber : ink.muted;
  return (
    <Pressable accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={label} onPress={onPress} style={[styles.surfaceButton, active && styles.surfaceButtonActive]}>
      <Glyph name={glyph} size={14} color={color} />
      <Text style={[styles.surfaceLabel, active && styles.surfaceLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: ground.base },
  switcher: { flexDirection: "row", backgroundColor: ground.surface, borderBottomWidth: stroke.hair, borderBottomColor: ground.edge, paddingHorizontal: space.tight },
  surfaceButton: { minHeight: TOUCH_TARGET, flexDirection: "row", alignItems: "center", gap: space.snug, paddingHorizontal: space.step, borderBottomWidth: stroke.heavy, borderBottomColor: "transparent" },
  surfaceButtonActive: { borderBottomColor: signal.amber },
  surfaceLabel: { color: ink.muted, fontFamily: "Archivo-SemiBold", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.8 },
  surfaceLabelActive: { color: ink.bright },
  content: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.wide, backgroundColor: ground.base },
  emptyText: { color: ink.muted, fontFamily: "Archivo-Regular", fontSize: 16, lineHeight: 24, textAlign: "center" },
});
