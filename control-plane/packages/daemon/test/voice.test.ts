/**
 * Voice bridge tests.
 *
 * Everything here runs on synthetic PCM against fake subprocesses: no
 * microphone, no model download, no network. That is not a convenience, it is
 * what makes the tests mean anything. The interesting logic in the voice slice
 * is endpointing, buffer discipline, sanitising, and engine selection, and all
 * four are decided before a single audio sample reaches a speech binary.
 *
 * Each test is written to fail if the feature it covers were removed. Several
 * of them would pass trivially against a weaker implementation, so they are
 * paired with a negative case: the endpointer test asserts a mid-speech pause
 * does *not* fire, the selection tests assert the first available engine wins
 * rather than merely that some engine is returned, and the sanitiser test
 * asserts the code body is gone rather than only that the fence markers are.
 *
 * A live section at the bottom exercises the real engines on this machine. It
 * is gated behind OMPD_LIVE=1 because it depends on what is installed.
 */

import { describe, expect, test } from "bun:test";
import { SCOPE_PROMPT, SCOPE_READ, type Actor, type ServerFrame } from "@ompd/core";
import { UnauthorizedError } from "../src/supervisor.ts";
import {
  base64ToPcm,
  chunkFrames,
  decodeWav,
  detectUtteranceEnd,
  encodeWav,
  frameEnergy,
  NullSttEngine,
  NullTtsEngine,
  OmpSttEngine,
  pcmToBase64,
  sanitizeForSpeech,
  selectSttEngine,
  selectTtsEngine,
  STT_ENGINE_ORDER,
  SttUnavailableError,
  TTS_ENGINE_ORDER,
  TtsUnavailableError,
  VAD_DEFAULTS,
  VoiceBridge,
  VoiceBufferOverflowError,
  WavFormatError,
  WIRE_SAMPLE_RATE,
  type CommandResult,
  type CommandRunner,
  type PcmAudio,
  type SttEngine,
  type TtsEngine,
} from "../src/voice/index.ts";

// The wire rate, taken from the bridge rather than restated, so a change to the
// contract fails here instead of silently disagreeing with it.
const RATE = WIRE_SAMPLE_RATE;
const AGENT = "agt_0123456789abcdef";
const speaker: Actor = { deviceId: "phone", scopes: [SCOPE_READ, SCOPE_PROMPT] };
const listener: Actor = { deviceId: "watcher", scopes: [SCOPE_READ] };

// ---------------------------------------------------------------------------
// synthetic audio
// ---------------------------------------------------------------------------

/** A tone at `amplitude` of full scale. RMS of a sine is amplitude / sqrt(2). */
function sine(ms: number, amplitude: number, freq = 220, rate = RATE): Int16Array {
  const count = Math.floor((rate * ms) / 1000);
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    pcm[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
  }
  return pcm;
}

function silence(ms: number, rate = RATE): Int16Array {
  return new Int16Array(Math.floor((rate * ms) / 1000));
}

function concat(...parts: Int16Array[]): Int16Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

type FakeProgram = (args: readonly string[]) => CommandResult;

/** A PATH and a set of programs, so engine selection is decided by the test. */
class FakeRunner implements CommandRunner {
  readonly calls: Array<{ bin: string; args: readonly string[] }> = [];
  #programs: Map<string, FakeProgram>;

  constructor(programs: Record<string, FakeProgram>) {
    this.#programs = new Map(Object.entries(programs));
  }

  which(bin: string): string | null {
    return this.#programs.has(bin) ? `/fake/bin/${bin}` : null;
  }

  async run(bin: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ bin, args });
    const program = this.#programs.get(bin);
    if (!program) return { code: 127, stdout: "", stderr: `${bin}: command not found` };
    return program(args);
  }
}

interface OmpFakeOptions {
  sttReady?: boolean;
  ttsReady?: boolean;
  /** Whether `omp --help` advertises a one-shot transcription verb. */
  transcribeVerb?: boolean;
  transcript?: string;
}

function ompProgram(opts: OmpFakeOptions): FakeProgram {
  const help = [
    "omp v17.2.12",
    "",
    "COMMANDS",
    "  acp            Run Oh My Pi as an ACP server over stdio",
    "  config         Manage configuration settings",
    ...(opts.transcribeVerb ? ["  transcribe     Transcribe an audio file with the local model"] : []),
    "  say            Synthesize text with the local TTS engine",
    "",
    "Environment Variables:",
    "  ANTHROPIC_API_KEY          - Anthropic Claude models",
  ].join("\n");

  const report = {
    "Speech-to-Text model": opts.sttReady
      ? { ready: true, status: "parakeet" }
      : { ready: false, status: "parakeet \u2014 not downloaded" },
    "Text-to-Speech model": opts.ttsReady
      ? { ready: true, status: "kokoro" }
      : { ready: false, status: "kokoro \u2014 not downloaded" },
  };
  // Measured against omp 17.2.12: `--check` exits 1 whenever any component is
  // missing, and prints the full report regardless. A fake that always exits 0
  // would let a probe that gates on the exit code pass here and reject a
  // perfectly good engine on the real machine, which is exactly what happened.
  const allReady = opts.sttReady === true && opts.ttsReady === true;

  return (args) => {
    if (args[0] === "--help") return { code: 0, stdout: help, stderr: "" };
    if (args[0] === "setup") {
      return { code: allReady ? 0 : 1, stdout: JSON.stringify(report), stderr: "" };
    }
    if (args[0] === "transcribe") return { code: 0, stdout: `${opts.transcript ?? "hello"}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: `unknown command ${args[0] ?? ""}` };
  };
}

class ScriptedStt implements SttEngine {
  readonly name = "scripted";
  readonly received: Array<{ samples: number; sampleRate: number }> = [];
  #reply: string | Error;

  constructor(reply: string | Error) {
    this.#reply = reply;
  }

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    this.received.push({ samples: pcm.length, sampleRate });
    if (this.#reply instanceof Error) throw this.#reply;
    return this.#reply;
  }
}

class RecordingTts implements TtsEngine {
  readonly name = "recording";
  readonly received: string[] = [];
  readonly audio: PcmAudio = { pcm: sine(40, 0.5, 440, 24_000), sampleRate: 24_000 };

  async synthesize(text: string): Promise<PcmAudio> {
    this.received.push(text);
    return this.audio;
  }
}

interface Harness {
  bridge: VoiceBridge;
  frames: ServerFrame[];
  transcripts: string[];
  stt: ScriptedStt;
  tts: RecordingTts;
}

function harness(opts: { stt?: ScriptedStt; maxBufferedSeconds?: number } = {}): Harness {
  const frames: ServerFrame[] = [];
  const transcripts: string[] = [];
  const stt = opts.stt ?? new ScriptedStt("run the tests");
  const tts = new RecordingTts();
  const bridge = new VoiceBridge({
    send: (frame) => frames.push(frame),
    stt,
    tts,
    onTranscript: (_agentId, text) => {
      transcripts.push(text);
    },
    sampleRate: RATE,
    maxBufferedSeconds: opts.maxBufferedSeconds,
  });
  return { bridge, frames, transcripts, stt, tts };
}

/** Feed audio in 100ms packets, the way a browser recorder would. */
async function stream(bridge: VoiceBridge, pcm: Int16Array, actor: Actor = speaker): Promise<void> {
  const packet = RATE / 10;
  for (let offset = 0; offset < pcm.length; offset += packet) {
    await bridge.pushAudio(AGENT, pcmToBase64(pcm.subarray(offset, offset + packet)), actor);
  }
}

// ---------------------------------------------------------------------------
// endpointing
// ---------------------------------------------------------------------------

describe("vad", () => {
  test("energy separates a tone from silence by an order of magnitude", () => {
    expect(frameEnergy(silence(20))).toBe(0);
    // RMS of a 0.3 amplitude sine is 0.3/sqrt(2).
    expect(frameEnergy(sine(20, 0.3))).toBeCloseTo(0.212, 2);
    expect(frameEnergy(sine(20, 0.3))).toBeGreaterThan(VAD_DEFAULTS.speechThreshold);
  });

  test("fires once speech is followed by enough trailing silence", () => {
    const frames = chunkFrames(concat(sine(500, 0.3), silence(800)), RATE);
    expect(detectUtteranceEnd(frames)).toBe(true);
  });

  test("does not fire on a brief pause in the middle of speech", () => {
    // 300ms of quiet between two phrases, then only 100ms at the end: well
    // under the 700ms hangover, so the speaker still has the floor.
    const frames = chunkFrames(
      concat(sine(400, 0.3), silence(300), sine(400, 0.3), silence(100)),
      RATE,
    );
    expect(detectUtteranceEnd(frames)).toBe(false);
  });

  test("does not fire on silence that was never preceded by speech", () => {
    // An open microphone in a quiet room must not synthesise an utterance.
    expect(detectUtteranceEnd(chunkFrames(silence(5_000), RATE))).toBe(false);
  });

  test("does not fire when the speech was shorter than the minimum", () => {
    const frames = chunkFrames(concat(sine(40, 0.3), silence(1_000)), RATE);
    expect(detectUtteranceEnd(frames)).toBe(false);
  });

  test("hysteresis holds the floor through more between-threshold frames than the hangover", () => {
    // 0.02 amplitude sine has RMS ~0.0141: above silenceThreshold (0.01) and
    // below speechThreshold (0.02). Collapse the two thresholds into one and
    // every one of these frames becomes trailing silence, so the utterance
    // ends early and the speaker gets cut off mid-breath.
    const between = sine(1_000, 0.02);
    const betweenFrames = chunkFrames(between, RATE);
    expect(frameEnergy(betweenFrames[0] ?? new Int16Array(0))).toBeGreaterThan(
      VAD_DEFAULTS.silenceThreshold,
    );
    expect(frameEnergy(betweenFrames[0] ?? new Int16Array(0))).toBeLessThan(
      VAD_DEFAULTS.speechThreshold,
    );
    // The run must outlast the hangover, or the test would pass on length
    // alone rather than on the threshold that kept the floor.
    expect(betweenFrames.length).toBeGreaterThan(VAD_DEFAULTS.hangoverFrames);

    expect(detectUtteranceEnd(chunkFrames(concat(sine(300, 0.3), between), RATE))).toBe(false);
    // A frame that actually falls under the low threshold does end it, so the
    // case above is hysteresis and not a detector that never fires.
    expect(
      detectUtteranceEnd(chunkFrames(concat(sine(300, 0.3), between, silence(800)), RATE)),
    ).toBe(true);
    // The same level with no speech before it never enters speech at all.
    expect(detectUtteranceEnd(chunkFrames(concat(between, silence(1_000)), RATE))).toBe(false);
  });

  test("rejects an inverted hysteresis rather than silently reordering it", () => {
    expect(() => detectUtteranceEnd([], { speechThreshold: 0.01, silenceThreshold: 0.5 })).toThrow(
      RangeError,
    );
  });

  test("chunking drops only the trailing partial frame", () => {
    const frames = chunkFrames(silence(105), RATE);
    expect(frames.length).toBe(5);
    expect(frames[0]?.length).toBe(320);
  });
});

// ---------------------------------------------------------------------------
// wire format
// ---------------------------------------------------------------------------

describe("wav and pcm framing", () => {
  test("base64 round trips PCM16 exactly", () => {
    const pcm = sine(30, 0.8);
    const back = base64ToPcm(pcmToBase64(pcm));
    expect(back.length).toBe(pcm.length);
    expect(back[0]).toBe(pcm[0] ?? 0);
    expect(back[100]).toBe(pcm[100] ?? 0);
    expect(back.at(-1)).toBe(pcm.at(-1) ?? 0);
  });

  test("wav round trips samples and rate", () => {
    const pcm = sine(25, 0.5, 440, 24_000);
    const decoded = decodeWav(encodeWav({ pcm, sampleRate: 24_000 }));
    expect(decoded.sampleRate).toBe(24_000);
    expect(decoded.pcm.length).toBe(pcm.length);
    expect(decoded.pcm[10]).toBe(pcm[10] ?? 0);
  });

  test("decoding walks chunks instead of assuming a 44 byte header", () => {
    // Real encoders put LIST/fact chunks before data. Splice one in and the
    // fixed-offset shortcut reads metadata as audio.
    const original = encodeWav({ pcm: sine(20, 0.5), sampleRate: RATE });
    const listChunk = new Uint8Array(16);
    const listView = new DataView(listChunk.buffer);
    for (const [i, ch] of [..."LIST"].entries()) listView.setUint8(i, ch.charCodeAt(0));
    listView.setUint32(4, 8, true);
    for (const [i, ch] of [..."INFOxxxx"].entries()) listView.setUint8(8 + i, ch.charCodeAt(0));

    const spliced = new Uint8Array(original.length + listChunk.length);
    spliced.set(original.subarray(0, 36), 0);
    spliced.set(listChunk, 36);
    spliced.set(original.subarray(36), 36 + listChunk.length);
    new DataView(spliced.buffer).setUint32(4, spliced.length - 8, true);

    const decoded = decodeWav(spliced);
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.pcm.length).toBe(320);
  });

  test("rejects bytes that are not RIFF/WAVE", () => {
    expect(() => decodeWav(new TextEncoder().encode("not audio at all!!"))).toThrow(WavFormatError);
  });

  test("rejects a PCM payload with a trailing half sample", () => {
    expect(() => base64ToPcm(Buffer.from([1, 2, 3]).toString("base64"))).toThrow(WavFormatError);
  });
});

// ---------------------------------------------------------------------------
// sanitising
// ---------------------------------------------------------------------------

const ASSISTANT_TURN = [
  "# Results",
  "",
  "Ran the **suite**: 42 passing, see [the run](https://ci.example.com/runs/91)",
  "or https://ci.example.com/raw for the log.",
  "",
  "```ts",
  "const secret = computeTheAnswer(41 + 1);",
  "console.log(secret);",
  "```",
  "",
  "- Use `bun test` next",
  "- Docs: <https://docs.example.com>",
  "",
  "> Quoted advice here.",
].join("\n");

describe("sanitizeForSpeech", () => {
  test("removes code fences, their contents, urls, and markdown syntax", () => {
    const spoken = sanitizeForSpeech(ASSISTANT_TURN);

    expect(spoken).not.toContain("```");
    expect(spoken).not.toContain("computeTheAnswer");
    expect(spoken).not.toContain("console.log");
    expect(spoken).not.toContain("http");
    expect(spoken).not.toContain("ci.example.com");
    expect(spoken).not.toContain("docs.example.com");
    expect(spoken).not.toContain("](");
    expect(spoken).not.toContain("**");
    expect(spoken).not.toContain("#");
    expect(spoken).not.toContain("`");
    expect(spoken).not.toContain(">");

    expect(spoken).toContain("Results");
    expect(spoken).toContain("Ran the suite: 42 passing");
    expect(spoken).toContain("see the run");
    expect(spoken).toContain("Use bun test next");
    expect(spoken).toContain("Quoted advice here.");
  });

  test("a turn that is only a code fence sanitises to nothing", () => {
    const only = ["```bash", "rm -rf /tmp/x", "```"].join("\n");
    expect(sanitizeForSpeech(only)).toBe("");
  });

  test("collapses table pipes and rules into speakable clauses", () => {
    const table = ["| host | state |", "| --- | --- |", "| local | idle |"].join("\n");
    const spoken = sanitizeForSpeech(table);
    expect(spoken).not.toContain("|");
    expect(spoken).not.toContain("---");
    expect(spoken).toContain("host");
    expect(spoken).toContain("idle");
  });

  test("the bridge sanitises before the engine is called", () => {
    // The point of the whole exercise: the synthesiser must never see markdown.
    const { bridge, tts } = harness();
    return bridge.speak(AGENT, ASSISTANT_TURN).then((spoke) => {
      expect(spoke).toBe(true);
      expect(tts.received).toHaveLength(1);
      expect(tts.received[0]).not.toContain("```");
      expect(tts.received[0]).not.toContain("console.log");
      expect(tts.received[0]).not.toContain("https://");
      expect(tts.received[0]).toContain("42 passing");
    });
  });
});

// ---------------------------------------------------------------------------
// bridge
// ---------------------------------------------------------------------------

describe("VoiceBridge", () => {
  test("transcribes on utterance end and emits a final transcript", async () => {
    const { bridge, frames, transcripts, stt } = harness();
    await stream(bridge, concat(sine(400, 0.3), silence(900)));

    const transcript = frames.find((f) => f.t === "transcript");
    expect(transcript).toEqual({ t: "transcript", agentId: AGENT, text: "run the tests", final: true });
    expect(transcripts).toEqual(["run the tests"]);
    expect(stt.received).toHaveLength(1);
    expect(stt.received[0]?.sampleRate).toBe(RATE);
    // The whole utterance reaches the engine: 400ms of speech plus the 700ms
    // hangover that closed it, and no more. Cutting at the hangover rather
    // than at end of stream is what makes the turn feel immediate.
    expect(stt.received[0]?.samples).toBeGreaterThanOrEqual(RATE * 1.1);
    expect(stt.received[0]?.samples).toBeLessThan(RATE * 1.25);
    // Audio after the cut belongs to the next utterance, not this one.
    expect(bridge.bufferedSeconds(AGENT)).toBeCloseTo(0.2, 2);
  });

  test("does not transcribe while the speaker is only pausing", async () => {
    const { bridge, frames, stt } = harness();
    await stream(bridge, concat(sine(400, 0.3), silence(300), sine(400, 0.3), silence(100)));

    expect(stt.received).toHaveLength(0);
    expect(frames.filter((f) => f.t === "transcript")).toHaveLength(0);
    expect(bridge.bufferedSeconds(AGENT)).toBeCloseTo(1.2, 2);
  });

  test("audio_end flushes a buffer the endpointer has not closed", async () => {
    const { bridge, frames, stt } = harness();
    await stream(bridge, concat(sine(400, 0.3), silence(100)));
    expect(stt.received).toHaveLength(0);

    await bridge.endAudio(AGENT, speaker);
    expect(stt.received).toHaveLength(1);
    expect(frames.filter((f) => f.t === "transcript")).toHaveLength(1);
  });

  test("audio_end on an empty buffer is a no-op, not an empty transcript", async () => {
    const { bridge, frames, stt } = harness();
    await bridge.endAudio(AGENT, speaker);
    expect(stt.received).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  test("a failed transcription becomes an error frame, never a silent drop", async () => {
    const { bridge, frames, transcripts } = harness({
      stt: new ScriptedStt(new SttUnavailableError("no speech-to-text engine is available")),
    });
    await stream(bridge, concat(sine(400, 0.3), silence(900)));

    expect(frames.filter((f) => f.t === "transcript")).toHaveLength(0);
    expect(transcripts).toHaveLength(0);
    const error = frames.find((f) => f.t === "error");
    expect(error).toMatchObject({ t: "error", agentId: AGENT, code: "stt_failed" });
    expect(error && "message" in error ? error.message : "").toContain("no speech-to-text engine");
  });

  test("buffered audio is capped with an error instead of growing without bound", async () => {
    const { bridge, frames } = harness({ maxBufferedSeconds: 1 });
    const packet = pcmToBase64(silence(400));

    await bridge.pushAudio(AGENT, packet, speaker);
    await bridge.pushAudio(AGENT, packet, speaker);
    expect(bridge.bufferedSeconds(AGENT)).toBeCloseTo(0.8, 3);

    await expect(bridge.pushAudio(AGENT, packet, speaker)).rejects.toThrow(VoiceBufferOverflowError);
    // Dropped, not retained: the point of the cap is that memory comes back.
    expect(bridge.bufferedSeconds(AGENT)).toBe(0);
    expect(frames.at(-1)).toMatchObject({ t: "error", code: "voice_buffer_overflow" });
  });

  test("an open microphone never grows the buffer past the cap", async () => {
    // Silence never triggers the endpointer, so this is the shape of the leak
    // the cap exists to prevent: a client that connected and walked away.
    const { bridge, frames } = harness({ maxBufferedSeconds: 1 });
    const packet = pcmToBase64(silence(400));
    let peak = 0;

    for (let i = 0; i < 30; i++) {
      await bridge.handleFrame({ t: "audio", agentId: AGENT, pcm: packet }, speaker);
      peak = Math.max(peak, bridge.bufferedSeconds(AGENT));
    }

    expect(peak).toBeLessThanOrEqual(1);
    expect(frames.filter((f) => f.t === "error" && f.code === "voice_buffer_overflow").length)
      .toBeGreaterThan(0);
  });

  test("audio from a device without prompt scope is refused", async () => {
    const { bridge, frames } = harness();
    await expect(
      bridge.pushAudio(AGENT, pcmToBase64(sine(100, 0.3)), listener),
    ).rejects.toThrow(UnauthorizedError);
    expect(bridge.bufferedSeconds(AGENT)).toBe(0);
    expect(frames).toHaveLength(0);
  });

  test("handleFrame reports faults as frames rather than throwing at the socket", async () => {
    const { bridge, frames } = harness();
    await bridge.handleFrame({ t: "audio", agentId: AGENT, pcm: pcmToBase64(sine(100, 0.3)) }, listener);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: "error", agentId: AGENT, code: "voice_error" });
    expect(frames[0] && "message" in frames[0] ? frames[0].message : "").toContain(SCOPE_PROMPT);
  });

  test("handleFrame ignores frames that belong to other subsystems", async () => {
    const { bridge, frames } = harness();
    await bridge.handleFrame({ t: "ping" }, speaker);
    await bridge.handleFrame({ t: "prompt", agentId: AGENT, text: "hi" }, speaker);
    expect(frames).toHaveLength(0);
  });

  test("speech is emitted as base64 PCM16 at the wire rate, not the engine's", async () => {
    // Kokoro renders at 24kHz and the wire is 16kHz, so the bridge resamples.
    // Asserting the engine's own length here would pass only while the two
    // rates happened to match, which is the bug this replaced.
    const { bridge, frames, tts } = harness();
    expect(await bridge.speak(AGENT, "Twelve tests passing.")).toBe(true);

    const speech = frames.find((f) => f.t === "speech");
    expect(speech).toBeDefined();

    const pcm = base64ToPcm(speech && "pcm" in speech ? speech.pcm : "");
    const expected = Math.round((tts.audio.pcm.length * WIRE_SAMPLE_RATE) / tts.audio.sampleRate);
    // Within a sample: resampling rounds, and pinning an exact count would
    // make this test about the interpolator rather than the contract.
    expect(Math.abs(pcm.length - expected)).toBeLessThanOrEqual(1);
    expect(pcm.length).toBeGreaterThan(0);
  });

  test("nothing is spoken and nothing is sent when a turn sanitises away", async () => {
    const { bridge, frames, tts } = harness();
    expect(await bridge.speak(AGENT, ["```sh", "ls -la", "```"].join("\n"))).toBe(false);
    expect(tts.received).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  test("a failing prompt is reported as a prompt failure, not as a failure to hear", async () => {
    // Regression: both calls once shared a try block, so a supervisor that
    // refused the prompt was reported to the client as `stt_failed`. That
    // sends the operator to their microphone to fix a transcription that
    // was perfect.
    const frames: ServerFrame[] = [];
    const bridge = new VoiceBridge({
      send: (frame) => frames.push(frame),
      stt: new ScriptedStt("run the tests"),
      sampleRate: RATE,
      onTranscript: () => {
        throw new Error("unknown agent");
      },
    });

    await stream(bridge, concat(sine(400, 0.3), silence(900)));

    const transcript = frames.find((f) => f.t === "transcript");
    expect(transcript).toBeDefined();
    expect(transcript && "text" in transcript ? transcript.text : "").toBe("run the tests");

    const error = frames.find((f) => f.t === "error");
    expect(error && "code" in error ? error.code : "").toBe("voice_prompt_failed");
    expect(error && "message" in error ? error.message : "").toBe("unknown agent");

    // Order matters: the client must see the text it said before the failure
    // of what that text became.
    expect(frames.indexOf(transcript as ServerFrame)).toBeLessThan(
      frames.indexOf(error as ServerFrame),
    );
  });

  test("a socket that fails mid-transcript does not wedge the agent forever", async () => {
    // Regression: the re-entrancy guard was once released by two hand-placed
    // deletes rather than one finally, and `#send` sat between them. A socket
    // that threw while delivering the transcript left the guard set, and from
    // then on every utterance for that agent hit the guard and vanished. A
    // dropped connection is routine, so this was permanent silent loss.
    const stt = new ScriptedStt("first utterance");
    let failNextSend = true;
    const delivered: ServerFrame[] = [];
    const bridge = new VoiceBridge({
      send: (frame) => {
        if (frame.t === "transcript" && failNextSend) {
          failNextSend = false;
          throw new Error("socket closed");
        }
        delivered.push(frame);
      },
      stt,
      sampleRate: RATE,
    });

    // The gateway calls this from a socket message handler, so it must absorb
    // the send failure rather than turn it into an unhandled rejection.
    await bridge.handleFrame(
      { t: "audio", agentId: AGENT, pcm: pcmToBase64(concat(sine(400, 0.3), silence(900))) },
      speaker,
    );
    expect(stt.received).toHaveLength(1);

    // The channel still works: a second utterance is heard and delivered.
    await bridge.handleFrame(
      { t: "audio", agentId: AGENT, pcm: pcmToBase64(concat(sine(400, 0.3), silence(900))) },
      speaker,
    );
    expect(stt.received).toHaveLength(2);
    expect(delivered.filter((f) => f.t === "transcript")).toHaveLength(1);
  });

  test("reset discards an utterance without transcribing it", async () => {
    const { bridge, stt } = harness();
    await stream(bridge, sine(400, 0.3));
    expect(bridge.bufferedSeconds(AGENT)).toBeGreaterThan(0);

    bridge.reset(AGENT);
    expect(bridge.bufferedSeconds(AGENT)).toBe(0);
    await bridge.endAudio(AGENT, speaker);
    expect(stt.received).toHaveLength(0);
  });

  test("engines in use are reportable", () => {
    const bridge = new VoiceBridge({ send: () => {} });
    expect(bridge.engines()).toEqual({ stt: "null", tts: "null" });
  });
});

// ---------------------------------------------------------------------------
// null engines
// ---------------------------------------------------------------------------

describe("null engines", () => {
  test("NullSttEngine throws instead of returning empty text", async () => {
    const engine = new NullSttEngine(["omp: model not downloaded", "whisper-cli: not on PATH"]);
    const attempt = engine.transcribe(sine(200, 0.3), RATE);

    await expect(attempt).rejects.toThrow(SttUnavailableError);
    await expect(attempt).rejects.toThrow(/model not downloaded/);
    // The failure mode this guards: resolving to "" and looking like silence.
    await expect(attempt).rejects.not.toBe("");
  });

  test("NullSttEngine with no reasons still explains itself", async () => {
    await expect(new NullSttEngine().transcribe(sine(50, 0.3), RATE)).rejects.toThrow(
      /no speech-to-text engine is configured/,
    );
  });

  test("a bridge with no engines configured errors on audio rather than swallowing it", async () => {
    const frames: ServerFrame[] = [];
    const bridge = new VoiceBridge({ send: (f) => frames.push(f), sampleRate: RATE });
    await bridge.handleFrame(
      { t: "audio", agentId: AGENT, pcm: pcmToBase64(concat(sine(400, 0.3), silence(900))) },
      speaker,
    );

    expect(frames.filter((f) => f.t === "transcript")).toHaveLength(0);
    expect(frames.find((f) => f.t === "error")).toMatchObject({ code: "stt_failed" });
  });

  test("NullTtsEngine throws rather than emitting empty audio", async () => {
    await expect(new NullTtsEngine(["omp: not on PATH"]).synthesize("hello")).rejects.toThrow(
      TtsUnavailableError,
    );
  });
});

// ---------------------------------------------------------------------------
// engine selection
// ---------------------------------------------------------------------------

describe("engine selection", () => {
  test("stt prefers omp when its model and a verb are both present", async () => {
    // whisper is also installed here, so this fails if the order is reversed.
    const runner = new FakeRunner({
      omp: ompProgram({ sttReady: true, ttsReady: true, transcribeVerb: true }),
      "whisper-cli": () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const engine = await selectSttEngine({
      runner,
      whisper: { env: { WHISPER_MODEL: "/models/ggml-base.bin" } },
    });
    expect(engine.name).toBe("omp");
    expect(STT_ENGINE_ORDER.indexOf(engine.name)).toBe(0);
  });

  test("stt falls back to whisper when omp has no ASR model downloaded", async () => {
    // This is the real state of the machine ompd was built on: kokoro ready,
    // parakeet absent, and `--check` exiting 1 because of the second fact.
    const runner = new FakeRunner({
      omp: ompProgram({ sttReady: false, ttsReady: true, transcribeVerb: true }),
      "whisper-cli": () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const stt = new OmpSttEngine({ runner });
    // Declined for the model, not for the exit code. Those are different bugs
    // and only one of them is the machine's fault.
    expect((await stt.probe()).reason).toContain("not downloaded");

    const engine = await selectSttEngine({
      runner,
      whisper: { env: { WHISPER_MODEL: "/models/ggml-base.bin" } },
    });
    expect(engine.name).toBe("whisper-cli");
    expect(STT_ENGINE_ORDER.indexOf(engine.name)).toBe(1);
  });

  test("stt declines omp when the binary exposes no transcription verb", async () => {
    // omp 17.2.12: the model can be ready and still be unreachable from a CLI.
    const runner = new FakeRunner({ omp: ompProgram({ sttReady: true, transcribeVerb: false }) });
    const engine = await selectSttEngine({ runner, whisper: { env: {} } });

    expect(engine.name).toBe("null");
    expect(engine).toBeInstanceOf(NullSttEngine);
    const reasons = (engine as NullSttEngine).reasons().join(" ");
    expect(reasons).toContain("one-shot transcription subcommand");
  });

  test("stt declines whisper.cpp with no ggml model rather than failing at call time", async () => {
    const runner = new FakeRunner({ "whisper-cli": () => ({ code: 0, stdout: "", stderr: "" }) });
    const engine = await selectSttEngine({ runner, whisper: { env: {} } });

    expect(engine.name).toBe("null");
    expect((engine as NullSttEngine).reasons().join(" ")).toContain("needs a ggml model");
  });

  test("stt takes the python whisper, which needs no model file", async () => {
    const runner = new FakeRunner({ whisper: () => ({ code: 0, stdout: "", stderr: "" }) });
    const engine = await selectSttEngine({ runner, whisper: { env: {} } });
    expect(engine.name).toBe("whisper-cli");
  });

  test("stt ends at the null engine when the machine has nothing, with reasons", async () => {
    const engine = await selectSttEngine({ runner: new FakeRunner({}), whisper: { env: {} } });

    expect(engine.name).toBe("null");
    expect(STT_ENGINE_ORDER.indexOf(engine.name)).toBe(STT_ENGINE_ORDER.length - 1);
    expect((engine as NullSttEngine).reasons()).toEqual([
      "omp: omp is not on PATH",
      "whisper-cli: none of whisper-cli, whisper is on PATH",
    ]);
  });

  test("a resolved omp stt engine actually invokes the discovered verb", async () => {
    const runner = new FakeRunner({
      omp: ompProgram({ sttReady: true, transcribeVerb: true, transcript: "open the pod bay doors" }),
    });
    const engine = new OmpSttEngine({ runner });

    expect(await engine.transcribe(sine(200, 0.3), RATE)).toBe("open the pod bay doors");
    const invocation = runner.calls.find((c) => c.args[0] === "transcribe");
    expect(invocation?.args[1]).toMatch(/\.wav$/);
  });

  test("tts prefers omp over the OS voice", async () => {
    // sttReady is deliberately false, so `omp setup speech --check` exits 1
    // here exactly as it does on the machine this was built on. A probe that
    // reads the exit code instead of the report demotes a ready Kokoro to the
    // system voice, which is the bug this test was written after finding.
    const runner = new FakeRunner({
      omp: ompProgram({ sttReady: false, ttsReady: true }),
      say: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const engine = await selectTtsEngine({ runner, say: { platform: "darwin" } });
    expect(engine.name).toBe("omp");
    expect(TTS_ENGINE_ORDER.indexOf(engine.name)).toBe(0);
  });

  test("tts falls back to macOS say when omp has no voice model", async () => {
    const runner = new FakeRunner({
      omp: ompProgram({ ttsReady: false }),
      say: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const engine = await selectTtsEngine({ runner, say: { platform: "darwin" } });
    expect(engine.name).toBe("say");
    expect(TTS_ENGINE_ORDER.indexOf(engine.name)).toBe(1);
  });

  test("tts does not take a non-Apple binary that happens to be called say", async () => {
    const runner = new FakeRunner({ say: () => ({ code: 0, stdout: "", stderr: "" }) });
    const engine = await selectTtsEngine({ runner, say: { platform: "linux" } });
    expect(engine.name).toBe("null");
    expect(TTS_ENGINE_ORDER.indexOf(engine.name)).toBe(TTS_ENGINE_ORDER.length - 1);
  });
});

// ---------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------

/**
 * Against the real binaries on this machine. Gated because the answer depends
 * on what is installed, which is exactly what makes it worth running by hand
 * before trusting a deployment.
 */
const live = process.env.OMPD_LIVE === "1" ? describe : describe.skip;

live("live engines", () => {
  test("selection reports what this machine can actually do", async () => {
    const log: string[] = [];
    const stt = await selectSttEngine({ onLog: (line) => log.push(line) });
    const tts = await selectTtsEngine({ onLog: (line) => log.push(line) });

    expect(STT_ENGINE_ORDER).toContain(stt.name);
    expect(TTS_ENGINE_ORDER).toContain(tts.name);
    expect(log).toHaveLength(2);
  });

  test("the resolved tts engine produces real audio the wire can carry", async () => {
    const engine = await selectTtsEngine();
    if (engine.name === "null") {
      await expect(engine.synthesize("hello")).rejects.toThrow(TtsUnavailableError);
      return;
    }

    const audio = await engine.synthesize(sanitizeForSpeech("Twelve **tests** passing."));
    expect(audio.pcm.length).toBeGreaterThan(audio.sampleRate / 10);
    expect(audio.sampleRate).toBeGreaterThan(8_000);
    expect(base64ToPcm(pcmToBase64(audio.pcm)).length).toBe(audio.pcm.length);
  }, 120_000);
});
