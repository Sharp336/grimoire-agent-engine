/**
 * Text to speech.
 *
 * Same posture as `stt.ts`: omp already runs Kokoro-82M on device through the
 * bundled ONNX runtime and exposes it as `omp say --out <wav>`, so this module
 * is process invocation plus WAV decoding, not synthesis.
 *
 * The part worth attention is `sanitizeForSpeech`. An assistant turn is
 * markdown, and markdown read aloud is unbearable: a fenced diff becomes two
 * minutes of punctuation, a URL becomes a spelled-out slug. Anything visual is
 * removed before a single sample is generated, both because it is unlistenable
 * and because synthesis is charged by the character.
 */

import {
  BunCommandRunner,
  withScratchDir,
  type CommandRunner,
  type EngineAvailability,
} from "./exec.ts";
import { decodeWav, type PcmAudio } from "./wav.ts";

export interface TtsEngine {
  /** Selection slot, one of `TTS_ENGINE_ORDER`. */
  readonly name: string;
  synthesize(text: string): Promise<PcmAudio>;
}

export class TtsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsUnavailableError";
  }
}

/** The order `selectTtsEngine` tries. Local neural voice first, OS voice as the floor. */
export const TTS_ENGINE_ORDER: readonly string[] = ["omp", "say", "null"];

const DEFAULT_TTS_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// sanitising
// ---------------------------------------------------------------------------

/** Fenced blocks, both fence styles, including an unterminated trailing fence. */
const FENCED_CODE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HORIZONTAL_RULE = /^[ \t]*(?:[-*_][ \t]*){3,}$/gm;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/gm;
const BLOCKQUOTE = /^[ \t]*>+[ \t]?/gm;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm;
const TABLE_PIPE = /[ \t]*\|[ \t]*/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const AUTOLINK = /<(?:https?|ftp|mailto):[^>\s]*>/gi;
const BARE_URL = /\b(?:https?:\/\/|ftp:\/\/|www\.|mailto:)\S+/gi;
const INLINE_CODE = /`+([^`]*)`+/g;
const BOLD_OR_STRIKE = /(\*\*|__|~~)(.+?)\1/g;
const EMPHASIS = /(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const WHITESPACE = /\s+/g;

/**
 * Strip everything that only means something on a screen.
 *
 * Fences go first: their contents are frequently full of characters that would
 * otherwise be read as markdown, and removing the block wholesale avoids
 * having to reason about that at all. Line-anchored structure (headings,
 * quotes, bullets, table rules) is removed next, while newlines still exist to
 * anchor against. Inline constructs come last, and whitespace is collapsed
 * once at the end.
 *
 * Links keep their label and lose their target. A spoken "see the docs" is
 * useful; a spoken "h t t p s colon slash slash" is not.
 */
export function sanitizeForSpeech(text: string): string {
  let out = text.replace(FENCED_CODE, "$1");
  out = out.replace(HTML_COMMENT, " ");
  out = out.replace(HORIZONTAL_RULE, " ");
  out = out.replace(TABLE_RULE, " ");
  out = out.replace(HEADING, "");
  out = out.replace(BLOCKQUOTE, "");
  out = out.replace(LIST_MARKER, "");
  out = out.replace(IMAGE, " ");
  out = out.replace(LINK, "$1");
  out = out.replace(AUTOLINK, " ");
  out = out.replace(BARE_URL, " ");
  out = out.replace(INLINE_CODE, "$1");
  out = out.replace(BOLD_OR_STRIKE, "$2");
  out = out.replace(EMPHASIS, "$1$2");
  out = out.replace(HTML_TAG, " ");
  out = out.replace(TABLE_PIPE, ", ");
  return out.replace(WHITESPACE, " ").trim();
}

// ---------------------------------------------------------------------------
// omp
// ---------------------------------------------------------------------------

/** The key `omp setup speech --check --json` reports the synthesis model under. */
const OMP_TTS_REPORT_KEY = "Text-to-Speech model";

export interface OmpTtsOptions {
  runner?: CommandRunner;
  ompPath?: string;
  /** Kokoro voice id. Omitted means the machine's `tts.localVoice`. */
  voice?: string;
  /** Local TTS model key. Omitted means the machine's `tts.localModel`. */
  model?: string;
  timeoutMs?: number;
}

export class OmpTtsEngine implements TtsEngine {
  readonly name = "omp";

  #runner: CommandRunner;
  #ompPath: string;
  #voice: string | undefined;
  #model: string | undefined;
  #timeoutMs: number;
  #probed: EngineAvailability | null = null;

  constructor(opts: OmpTtsOptions = {}) {
    this.#runner = opts.runner ?? new BunCommandRunner();
    this.#ompPath = opts.ompPath ?? "omp";
    this.#voice = opts.voice;
    this.#model = opts.model;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  }

  async probe(): Promise<EngineAvailability> {
    if (this.#probed) return this.#probed;
    this.#probed = await this.#runProbe();
    return this.#probed;
  }

  async #runProbe(): Promise<EngineAvailability> {
    if (!this.#runner.which(this.#ompPath)) {
      return { available: false, reason: `${this.#ompPath} is not on PATH` };
    }
    const check = await this.#runner.run(this.#ompPath, ["setup", "speech", "--check", "--json"], {
      timeoutMs: 30_000,
    });
    // `--check` exits 1 when any component is missing and still prints the
    // full report; see the matching note in stt.ts. Gating on the exit code
    // here is what wrongly demoted a ready Kokoro to the OS voice.
    let parsed: unknown;
    try {
      parsed = JSON.parse(check.stdout);
    } catch {
      return {
        available: false,
        reason: `omp setup speech --check printed no report (exit ${check.code})`,
      };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { available: false, reason: "omp speech report was not an object" };
    }
    // Dynamic-key JSON from a subprocess: guarded by the typeof checks around it.
    const report = parsed as Record<string, unknown>;
    const entry = report[OMP_TTS_REPORT_KEY];
    if (typeof entry !== "object" || entry === null) {
      return { available: false, reason: `omp speech report has no "${OMP_TTS_REPORT_KEY}" entry` };
    }
    const status = entry as Record<string, unknown>;
    if (status.ready !== true) {
      const detail = typeof status.status === "string" ? status.status : "not ready";
      return { available: false, reason: `omp text-to-speech model is ${detail}` };
    }
    const model = typeof status.status === "string" ? status.status : "local";
    return { available: true, reason: `omp say (${model})` };
  }

  async synthesize(text: string): Promise<PcmAudio> {
    const probe = await this.probe();
    if (!probe.available) throw new TtsUnavailableError(probe.reason);

    return withScratchDir("ompd-tts-", async (dir) => {
      // `--file` rather than a positional argument: an assistant turn can run
      // to thousands of characters and argv has a hard limit.
      const source = `${dir}/say.txt`;
      const out = `${dir}/say.wav`;
      await Bun.write(source, text);

      const args = ["say", "--file", source, "--out", out];
      if (this.#voice) args.push("--voice", this.#voice);
      if (this.#model) args.push("--model", this.#model);
      const result = await this.#runner.run(this.#ompPath, args, { timeoutMs: this.#timeoutMs });
      if (result.code !== 0) {
        throw new Error(`omp say exited ${result.code}: ${result.stderr.trim() || "no stderr"}`);
      }

      const wav = Bun.file(out);
      if (!(await wav.exists())) throw new Error(`omp say wrote no audio to ${out}`);
      const audio = decodeWav(new Uint8Array(await wav.arrayBuffer()));
      if (audio.pcm.length === 0) throw new Error("omp say produced an empty waveform");
      return audio;
    });
  }
}

// ---------------------------------------------------------------------------
// macOS say
// ---------------------------------------------------------------------------

/**
 * `say -o out.wav` writes AIFF unless told otherwise, so the data format is
 * pinned. LEI16 is little-endian signed 16-bit, which is the wire format
 * already, and 22050Hz is what the system voices are sampled at.
 */
const SAY_DATA_FORMAT = "LEI16@22050";

export interface SayTtsOptions {
  runner?: CommandRunner;
  binary?: string;
  /** System voice name, e.g. Samantha. Omitted means the user's default. */
  voice?: string;
  /** Defaults to `process.platform`. Injectable so selection tests do not depend on the host OS. */
  platform?: string;
  timeoutMs?: number;
}

export class SayTtsEngine implements TtsEngine {
  readonly name = "say";

  #runner: CommandRunner;
  #binary: string;
  #voice: string | undefined;
  #platform: string;
  #timeoutMs: number;
  #probed: EngineAvailability | null = null;

  constructor(opts: SayTtsOptions = {}) {
    this.#runner = opts.runner ?? new BunCommandRunner();
    this.#binary = opts.binary ?? "say";
    this.#voice = opts.voice;
    this.#platform = opts.platform ?? process.platform;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  }

  async probe(): Promise<EngineAvailability> {
    if (this.#probed) return this.#probed;
    this.#probed = this.#runProbe();
    return this.#probed;
  }

  #runProbe(): EngineAvailability {
    // Linux has unrelated binaries named `say`; the flags below are Apple's.
    if (this.#platform !== "darwin") {
      return { available: false, reason: `${this.#binary} is macOS only, platform is ${this.#platform}` };
    }
    if (!this.#runner.which(this.#binary)) {
      return { available: false, reason: `${this.#binary} is not on PATH` };
    }
    return { available: true, reason: `macOS ${this.#binary}` };
  }

  async synthesize(text: string): Promise<PcmAudio> {
    const probe = await this.probe();
    if (!probe.available) throw new TtsUnavailableError(probe.reason);

    return withScratchDir("ompd-say-", async (dir) => {
      const source = `${dir}/say.txt`;
      const out = `${dir}/say.wav`;
      await Bun.write(source, text);

      const args = ["-f", source, "-o", out, `--data-format=${SAY_DATA_FORMAT}`];
      if (this.#voice) args.push("-v", this.#voice);
      const result = await this.#runner.run(this.#binary, args, { timeoutMs: this.#timeoutMs });
      if (result.code !== 0) {
        throw new Error(`${this.#binary} exited ${result.code}: ${result.stderr.trim() || "no stderr"}`);
      }

      const wav = Bun.file(out);
      if (!(await wav.exists())) throw new Error(`${this.#binary} wrote no audio to ${out}`);
      const audio = decodeWav(new Uint8Array(await wav.arrayBuffer()));
      if (audio.pcm.length === 0) throw new Error(`${this.#binary} produced an empty waveform`);
      return audio;
    });
  }
}

// ---------------------------------------------------------------------------
// null
// ---------------------------------------------------------------------------

/** Terminal engine. Speaking is optional, so failing here is loud but not fatal to a session. */
export class NullTtsEngine implements TtsEngine {
  readonly name = "null";

  #reasons: readonly string[];

  constructor(reasons: readonly string[] = []) {
    this.#reasons = reasons;
  }

  reasons(): readonly string[] {
    return this.#reasons;
  }

  async probe(): Promise<EngineAvailability> {
    return { available: false, reason: this.#describe() };
  }

  #describe(): string {
    if (this.#reasons.length === 0) return "no text-to-speech engine is configured";
    return `no text-to-speech engine is available: ${this.#reasons.join("; ")}`;
  }

  async synthesize(_text: string): Promise<PcmAudio> {
    throw new TtsUnavailableError(this.#describe());
  }
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

export interface TtsSelectionOptions {
  runner?: CommandRunner;
  omp?: OmpTtsOptions;
  say?: SayTtsOptions;
  onLog?: (line: string) => void;
}

/** First engine whose probe passes, in `TTS_ENGINE_ORDER`. Never returns null. */
export async function selectTtsEngine(opts: TtsSelectionOptions = {}): Promise<TtsEngine> {
  const runner = opts.runner;
  const candidates: Array<OmpTtsEngine | SayTtsEngine> = [
    new OmpTtsEngine({ runner, ...opts.omp }),
    new SayTtsEngine({ runner, ...opts.say }),
  ];

  const reasons: string[] = [];
  for (const engine of candidates) {
    const probe = await engine.probe();
    if (probe.available) {
      opts.onLog?.(`tts engine: ${engine.name} (${probe.reason})`);
      return engine;
    }
    reasons.push(`${engine.name}: ${probe.reason}`);
  }

  opts.onLog?.(`tts engine: null (${reasons.join("; ")})`);
  return new NullTtsEngine(reasons);
}
