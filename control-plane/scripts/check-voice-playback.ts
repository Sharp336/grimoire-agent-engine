#!/usr/bin/env bun
/**
 * Prove the leg `check-voice-loop.ts` cannot: that a browser plays the answer.
 *
 * The input leg has its own proof. This one exists because "the daemon emitted
 * a speech frame" and "a person heard the reply" are different claims, and
 * only the second one is what bi-directional voice means. Everything a browser
 * needs in order to be caught lying is here: the frame has to arrive at a real
 * page, decode to real samples, reach a real `AudioContext`, and finish
 * playing in real time.
 *
 * This script stands the daemon up and puts everything the browser needs where
 * the browser can reach it. Driving Chrome is the caller's job, because a
 * headless browser that cannot make sound is not evidence of anything.
 *
 *   bun run scripts/check-voice-playback.ts
 *
 * It prints one JSON line, then serves until killed.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ompd } from "../packages/daemon/src/daemon.ts";
import { pcmToBase64, selectTtsEngine } from "../packages/daemon/src/voice/index.ts";

/**
 * Short, unambiguous, and nothing like a hallucination. The agent's reply is
 * whatever the model says; only the daemon speaking it back is under test.
 */
const SPOKEN_PROMPT = "Reply with exactly the words green light and nothing else.";

const home = mkdtempSync(join(tmpdir(), "ompd-playback-"));
const dist = resolve(import.meta.dir, "../packages/web/dist");
const promptFile = join(dist, "spoken-prompt.b64");

/**
 * Whisper needs a model path and there is no useful default: without one the
 * daemon selects the null engine and says so, which is honest but means this
 * script proves nothing. Fail here instead, where the reason is obvious.
 */
const whisperModel = process.env.WHISPER_MODEL ?? join(homedir(), ".cache/whisper/ggml-base.en.bin");
if (!existsSync(whisperModel)) {
  console.error(`no whisper model at ${whisperModel}; set WHISPER_MODEL to one`);
  process.exit(1);
}

const daemon = new Ompd({
  home,
  overrides: { port: 0, whisperModel },
  repoRoot: home,
  onLog: (line) => console.error(`[daemon] ${line}`),
});

const info = await daemon.start();
const token = (await Bun.file(join(home, "token")).text()).trim();

// Synthesised with the same engine the daemon speaks through, so the audio the
// browser sends up is real speech from this machine rather than a fixture
// recorded somewhere else.
const tts = await selectTtsEngine();
const spoken = await tts.synthesize(SPOKEN_PROMPT);

// Served from the web root because the page has to fetch it: a base64 payload
// this size does not belong inlined in an evaluate call.
writeFileSync(promptFile, pcmToBase64(spoken.pcm));

const created = await fetch(`${info.url}/v1/agents`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "playback", cwd: home }),
});
if (created.status !== 201) {
  console.error(`could not create an agent: HTTP ${created.status} ${await created.text()}`);
  process.exit(1);
}
const { agent } = (await created.json()) as { agent: { id: string } };

console.log(
  JSON.stringify({
    url: info.url,
    token,
    agentId: agent.id,
    ttsEngine: tts.name,
    promptSamples: spoken.pcm.length,
    home,
  }),
);

const cleanup = async (): Promise<void> => {
  rmSync(promptFile, { force: true });
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", () => void cleanup());
process.once("SIGTERM", () => void cleanup());

// Serve until killed. The browser needs the daemon alive for the whole run.
await Promise.withResolvers<void>().promise;
