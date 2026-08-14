/** The durable pairing boot boundary. Paired navigation lives in PairedShell. */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { ground, ink } from "./design/tokens.ts";
import type { Connection } from "./platform/connection.ts";
import { clearConnection, loadConnection, saveConnection } from "./platform/connection.ts";
import { PairScreen } from "./screens/PairScreen.tsx";
import { PairedShell } from "./screens/PairedShell.tsx";

type Boot = { phase: "loading" } | { phase: "pair"; notice?: string } | { phase: "console"; connection: Connection };

export function App(): JSX.Element {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });

  useEffect(() => {
    let live = true;
    void loadConnection().then((connection) => {
      if (!live) return;
      setBoot(connection === null ? { phase: "pair" } : { phase: "console", connection });
    });
    return () => {
      live = false;
    };
  }, []);

  const pair = useCallback(async (connection: Connection) => {
    try {
      await saveConnection(connection);
    } catch (cause) {
      setBoot({ phase: "pair", notice: `Could not save this pairing: ${describe(cause)}` });
      return;
    }
    setBoot({ phase: "console", connection });
  }, []);

  const unpair = useCallback(async (notice?: string) => {
    let trailer = "";
    try {
      await clearConnection();
    } catch (cause) {
      trailer = ` The old token could not be erased from this device: ${describe(cause)}`;
    }
    setBoot({ phase: "pair", notice: notice === undefined ? trailer.trim() || undefined : `${notice}${trailer}` });
  }, []);

  if (boot.phase === "loading") {
    return (
      <View style={styles.boot} testID="boot">
        <ActivityIndicator color={ink.muted} />
      </View>
    );
  }

  if (boot.phase === "pair") return <PairScreen notice={boot.notice} onPair={pair} />;
  return <PairedShell connection={boot.connection} onUnpair={unpair} />;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: ground.base },
});
