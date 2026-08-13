/**
 * The whole app: pair, or take the position.
 *
 * There is no router. Two screens and one selection do not need one, and a
 * navigation library is a second source of truth about which agent is open.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Console } from "./console/Console.tsx";
import { ground, ink } from "./design/tokens.ts";
import type { Connection } from "./platform/connection.ts";
import { clearConnection, loadConnection, saveConnection } from "./platform/connection.ts";
import { PairScreen } from "./screens/PairScreen.tsx";

type Boot = { phase: "loading" } | { phase: "pair"; notice?: string } | { phase: "console"; connection: Connection };

export function App(): JSX.Element {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });

  useEffect(() => {
    let live = true;
    void loadConnection().then((connection) => {
      // A resolve landing after an unmount would set state on a dead tree, and
      // on the first launch after an install this promise is genuinely slow.
      if (!live) return;
      setBoot(connection === null ? { phase: "pair" } : { phase: "console", connection });
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * The store is written before the console opens, not alongside it. A pairing
   * that only exists in memory works perfectly until the app is closed, and
   * then the operator is back at this screen with a token they have already
   * used and cannot read again.
   */
  const pair = useCallback(async (connection: Connection) => {
    try {
      await saveConnection(connection);
    } catch (cause) {
      setBoot({ phase: "pair", notice: `Could not save this pairing: ${describe(cause)}` });
      return;
    }
    setBoot({ phase: "console", connection });
  }, []);

  /**
   * The daemon has confirmed the token is dead. Keeping it would leave the app
   * retrying forever against a credential nothing will accept, which looks
   * exactly like the daemon being down and is the one thing it is not.
   *
   * A failed erase is reported rather than swallowed: the next launch would
   * read that dead token back and bounce straight to this screen again, which
   * looks like the pairing never took.
   */
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

  if (boot.phase === "pair") {
    return <PairScreen notice={boot.notice} onPair={pair} />;
  }

  return (
    <Console
      // A new pairing is a new client, a new socket, and a clean session map.
      // Without this key the old console would keep its state across an unpair.
      key={`${boot.connection.transport === "direct" ? boot.connection.url : `${boot.connection.hubUrl}:${boot.connection.daemonId}`}:${boot.connection.token.length}`}
      connection={boot.connection}
      onUnpair={unpair}
    />
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: ground.base },
});
