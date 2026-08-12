/**
 * Where a device gets its credential.
 *
 * `notice` explains why the operator is looking at this screen again rather
 * than at their agents. A pairing form with no explanation, after a console
 * that was working a second ago, reads as the app having lost its mind.
 */

import type { JSX } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Body, Display, Kicker, Label } from "../design/text.tsx";
import type { Connection } from "../platform/connection.ts";
import { SUGGESTED_SOCKET_URL } from "../platform/connection.ts";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";

export function PairScreen({
  notice,
  onPair,
}: {
  notice?: string;
  onPair: (connection: Connection) => void;
}): JSX.Element {
  const [url, setUrl] = useState(SUGGESTED_SOCKET_URL);
  const [token, setToken] = useState("");
  const ready = url.trim().length > 0 && token.trim().length > 0;

  return (
    <View style={styles.screen} testID="pair">
      <View style={styles.form}>
        <Kicker color={ink.muted}>ompd</Kicker>
        <Display heading>Take the position</Display>

        {notice === undefined ? null : (
          <View style={styles.notice} accessibilityLiveRegion="assertive" testID="pair-notice">
            <Glyph name="unpair" size={12} color={signal.ochre} />
            <Label color={signal.ochre} style={styles.noticeText}>
              {notice}
            </Label>
          </View>
        )}

        <Body color={ink.plain}>
          Run ompd device pair on the machine running the daemon, then paste the token it prints.
        </Body>

        <Field label="Daemon socket" value={url} onChange={setUrl} testID="pair-url" />
        <Field label="Device token" value={token} onChange={setToken} secure testID="pair-token" />

        <Pressable
          testID="pair-submit"
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={() => {
            onPair({ url: url.trim(), token: token.trim(), scopes: [] });
          }}
          style={({ pressed }) => [
            styles.submit,
            { borderColor: ready ? signal.sage : ground.edge },
            pressed && { backgroundColor: ground.active },
          ]}
        >
          <Label color={ready ? signal.sage : ink.faint}>Connect</Label>
        </Pressable>
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  secure,
  testID,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  secure?: boolean;
  testID: string;
}): JSX.Element {
  return (
    <View style={styles.field}>
      <Kicker color={ink.muted}>{label}</Kicker>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        style={[styles.input, type.code]}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure === true}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ground.base, justifyContent: "center", padding: space.loose },
  form: { gap: space.step, maxWidth: 480, width: "100%", alignSelf: "center" },
  notice: {
    flexDirection: "row",
    gap: space.snug,
    padding: space.step,
    backgroundColor: signalWash.ochre,
    borderLeftWidth: stroke.heavy,
    borderLeftColor: signal.ochre,
  },
  noticeText: { flex: 1 },
  field: { gap: space.tight },
  input: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    color: ink.bright,
    backgroundColor: ground.surface,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  submit: {
    minHeight: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: stroke.hair,
    marginTop: space.snug,
  },
});
