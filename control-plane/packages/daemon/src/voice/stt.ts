/**
 * Speech to text.
 *
 * OMP already runs state of the art ASR on this machine, on device: Parakeet
 * TDT v3 through sherpa-onnx, warm across recordings, `stt.enabled` on by
 * default. None of it is reimplemented here. What is missing is a way to reach
 * it from outside the TUI, and that is all these engines do.
 *
 * The engines are ordered omp, whisper, null. The last one is not a no-op: a
 * voice command that silently evaluates to the empty string is worse than one
 * that errors, because the operator has no way to tell "the daemon heard
 * nothing" from "the daemon has no ears". Every engine here either returns
 * real text or throws.
 */

import {
  BunCommandRunner,
  withScratchDir,
  type CommandRunner,
  type EngineAvailability,
} from "./exec.ts";
import { encodeWav } from "./wav.ts";

export interface SttEngine {
  /** Selection slot, one of `STT_ENGINE_ORDER`. */
  readonly name: string;
  transcribe(pcm: Int16Array, sampleRate: number): Promise<string>;
}

export type { EngineAvailability };

/** The engine is not usable on this machine. Selection catches this; callers see it only from the null engine. */
export class SttUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SttUnavailableError";
  }
}

/** The engine ran and produced nothing. Never collapsed into an empty transcript. */
export class EmptyTranscriptError extends Error {
  constructor(engine: string) {
    super(`${engine} returned no text for an utterance the endpointer accepted as speech`);
    this.name = "EmptyTranscriptError";
  }
}

/** The order `selectSttEngine` tries. Load-bearing: local and free before anything else. */
export const STT_ENGINE_ORDER: readonly string[] = ["omp", "whisper-cli", "null"];

const DEFAULT_STT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// omp
// ---------------------------------------------------------------------------

/** The key `omp setup speech --check --json` reports the ASR model under. */
const OMP_STT_REPORT_KEY = "Speech-to-Text model";

/**
 * Subcommands that would expose one-shot transcription.
 *
 * omp 17.2.12 exposes none of them: its STT worker is driven by the TUI
 * composer and by `/live`, and the ACP surface advertises only
 * `embeddedContext` and `image` prompt capabilities, so audio cannot be handed
 * over that way either. The probe below therefore reports this engine
 * unavailable on 17.2.12 and selection falls through, which is the correct
 * answer rather than a papered-over one. It is written as discovery against
 * the binary's own command list so the engine lights up on its own the day omp
 * ships the verb, instead of failing quietly against a guessed flag.
 */
const OMP_TRANSCRIBE_VERBS: readonly string[] = ["transcribe", "stt", "listen"];

export interface OmpSttOptions {
  runner?: CommandRunner;
  /** Binary name or path. Matches `SupervisorOptions.ompPath`. */
  ompPath?: string;
  timeoutMs?: number;
}

export class OmpSttEngine implements SttEngine {
  readonly name = "omp";

  #runner: CommandRunner;
  #ompPath: string;
  #timeoutMs: number;
  #probed: EngineAvailability | null = null;
  #verb: string | null = null;

  constructor(opts: OmpSttOptions = {}) {
    this.#runner = opts.runner ?? new BunCommandRunner();
    this.#ompPath = opts.ompPath ?? "omp";
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS;
  }

  /**
   * Three questions, in cost order: is omp here, is the ASR model downloaded,
   * and is there a verb to invoke it with. `--check` never downloads, so a
   * probe on a cold machine stays a probe.
   */
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
    // Measured against omp 17.2.12: `--check` exits 1 whenever any component
    // is missing and still prints the full report. The exit code summarises
    // readiness, it does not report failure, so gating on it would reject a
    // machine whose synthesis model is present because its ASR model is not.
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
    const entry = report[OMP_STT_REPORT_KEY];
    if (typeof entry !== "object" || entry === null) {
      return { available: false, reason: `omp speech report has no "${OMP_STT_REPORT_KEY}" entry` };
    }
    const status = entry as Record<string, unknown>;
    if (status.ready !== true) {
      const detail = typeof status.status === "string" ? status.status : "not ready";
      return { available: false, reason: `omp speech-to-text model is ${detail}` };
    }

    const verb = await this.#discoverVerb();
    if (!verb) {
      return {
        available: false,
        reason: `omp exposes no one-shot transcription subcommand (looked for ${OMP_TRANSCRIBE_VERBS.join(", ")})`,
      };
    }
    this.#verb = verb;
    return { available: true, reason: `omp ${verb} with the local speech model` };
  }

  /** Read the binary's own COMMANDS list rather than assuming a verb exists. */
  async #discoverVerb(): Promise<string | null> {
    const help = await this.#runner.run(this.#ompPath, ["--help"], { timeoutMs: 30_000 });
    if (help.code !== 0) return null;
    const commands = new Set<string>();
    let inCommands = false;
    for (const line of help.stdout.split("\n")) {
      if (/^COMMANDS\s*$/.test(line)) {
        inCommands = true;
        continue;
      }
      if (!inCommands) continue;
      const match = /^ {2}(\S+)\s{2,}\S/.exec(line);
      if (match?.[1]) {
        commands.add(match[1]);
      } else if (line.trim().length === 0) {
        // A blank line ends the block only once entries have been seen; the
        // heading is followed by one.
        if (commands.size > 0) break;
      }
    }
    for (const verb of OMP_TRANSCRIBE_VERBS) {
      if (commands.has(verb)) return verb;
    }
    return null;
  }

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    const probe = await this.probe();
    if (!probe.available || !this.#verb) throw new SttUnavailableError(probe.reason);
    const verb = this.#verb;

    const text = await withScratchDir("ompd-stt-", async (dir) => {
      const wav = `${dir}/utterance.wav`;
      await Bun.write(wav, encodeWav({ pcm, sampleRate }));
      const result = await this.#runner.run(this.#ompPath, [verb, wav], {
        timeoutMs: this.#timeoutMs,
      });
      if (result.code !== 0) {
        throw new Error(`omp ${verb} exited ${result.code}: ${result.stderr.trim() || "no stderr"}`);
      }
      return result.stdout.trim();
    });

    if (!text) throw new EmptyTranscriptError("omp");
    return text;
  }
}

// ---------------------------------------------------------------------------
// whisper
// ---------------------------------------------------------------------------

/**
 * `whisper-cli` is whisper.cpp and needs an explicit ggml model file; `whisper`
 * is the Python reference implementation and downloads its own. They share
 * nothing but a name, so the flavour is resolved at probe time and the
 * invocation differs accordingly.
 */
export type WhisperFlavor = "whisper-cli" | "whisper";

export interface WhisperCliOptions {
  runner?: CommandRunner;
  /** Force a specific binary instead of probing `whisper-cli` then `whisper`. */
  binary?: string;
  /** ggml model path for whisper.cpp, or model name for the Python whisper. */
  model?: string;
  /** Defaults to `process.env`. Injectable so selection tests do not read the host environment. */
  env?: Record<string, string | undefined>;
  language?: string;
  timeoutMs?: number;
}

const WHISPER_BINARIES: readonly WhisperFlavor[] = ["whisper-cli", "whisper"];

export class WhisperCliEngine implements SttEngine {
  readonly name = "whisper-cli";

  #runner: CommandRunner;
  #binary: string | undefined;
  #model: string | undefined;
  #env: Record<string, string | undefined>;
  #language: string | undefined;
  #timeoutMs: number;
  #probed: EngineAvailability | null = null;
  #resolved: { binary: string; flavor: WhisperFlavor; model: string } | null = null;

  constructor(opts: WhisperCliOptions = {}) {
    this.#runner = opts.runner ?? new BunCommandRunner();
    this.#binary = opts.binary;
    this.#model = opts.model;
    this.#env = opts.env ?? process.env;
    this.#language = opts.language;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS;
  }

  /** Which binary and flavour were selected, once probed. */
  resolved(): { binary: string; flavor: WhisperFlavor; model: string } | null {
    return this.#resolved;
  }

  async probe(): Promise<EngineAvailability> {
    if (this.#probed) return this.#probed;
    this.#probed = this.#runProbe();
    return this.#probed;
  }

  #runProbe(): EngineAvailability {
    const candidates = this.#binary ? [this.#binary] : WHISPER_BINARIES;
    let found: string | null = null;
    for (const candidate of candidates) {
      if (this.#runner.which(candidate)) {
        found = candidate;
        break;
      }
    }
    if (!found) {
      return { available: false, reason: `none of ${candidates.join(", ")} is on PATH` };
    }

    const flavor: WhisperFlavor = found.endsWith("whisper-cli") ? "whisper-cli" : "whisper";
    const model = this.#model ?? this.#env.WHISPER_MODEL;
    if (flavor === "whisper-cli" && !model) {
      // whisper.cpp has no default weights. Without -m it exits non-zero on
      // every call, so reporting it available would just move the failure.
      return {
        available: false,
        reason: `${found} needs a ggml model; set WHISPER_MODEL or pass model`,
      };
    }

    this.#resolved = { binary: found, flavor, model: model ?? "base" };
    return { available: true, reason: `${found} (${flavor})` };
  }

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    const probe = await this.probe();
    const resolved = this.#resolved;
    if (!probe.available || !resolved) throw new SttUnavailableError(probe.reason);

    const text = await withScratchDir("ompd-whisper-", async (dir) => {
      const wav = `${dir}/utterance.wav`;
      await Bun.write(wav, encodeWav({ pcm, sampleRate }));

      if (resolved.flavor === "whisper-cli") {
        const args = ["-m", resolved.model, "-f", wav, "--no-timestamps", "--no-prints"];
        if (this.#language) args.push("--language", this.#language);
        const result = await this.#runner.run(resolved.binary, args, { timeoutMs: this.#timeoutMs });
        if (result.code !== 0) {
          throw new Error(
            `${resolved.binary} exited ${result.code}: ${result.stderr.trim() || "no stderr"}`,
          );
        }
        return result.stdout.trim();
      }

      const args = [wav, "--model", resolved.model, "--output_format", "txt", "--output_dir", dir];
      if (this.#language) args.push("--language", this.#language);
      const result = await this.#runner.run(resolved.binary, args, { timeoutMs: this.#timeoutMs });
      if (result.code !== 0) {
        throw new Error(
          `${resolved.binary} exited ${result.code}: ${result.stderr.trim() || "no stderr"}`,
        );
      }
      // The Python CLI writes <stem>.txt beside the input and prints progress
      // to stdout, so the file is the transcript and stdout is not.
      const written = Bun.file(`${dir}/utterance.txt`);
      if (!(await written.exists())) return result.stdout.trim();
      const contents = await written.text();
      return contents.trim();
    });

    if (!text) throw new EmptyTranscriptError(resolved.binary);
    return text;
  }
}

// ---------------------------------------------------------------------------
// null
// ---------------------------------------------------------------------------

/**
 * The terminal engine. It exists to make "this machine cannot hear you" a
 * first-class, reportable outcome instead of an empty string that looks like a
 * user who said nothing.
 */
export class NullSttEngine implements SttEngine {
  readonly name = "null";

  #reasons: readonly string[];

  constructor(reasons: readonly string[] = []) {
    this.#reasons = reasons;
  }

  /** Why each better engine was skipped. */
  reasons(): readonly string[] {
    return this.#reasons;
  }

  async probe(): Promise<EngineAvailability> {
    return { available: false, reason: this.#describe() };
  }

  #describe(): string {
    if (this.#reasons.length === 0) return "no speech-to-text engine is configured";
    return `no speech-to-text engine is available: ${this.#reasons.join("; ")}`;
  }

  async transcribe(_pcm: Int16Array, _sampleRate: number): Promise<string> {
    throw new SttUnavailableError(this.#describe());
  }
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

export interface SttSelectionOptions {
  /** Shared runner. Individual engine options may override it. */
  runner?: CommandRunner;
  omp?: OmpSttOptions;
  whisper?: WhisperCliOptions;
  onLog?: (line: string) => void;
}

/**
 * First engine whose probe passes, in `STT_ENGINE_ORDER`. Never returns null:
 * the last slot is an engine that throws with the reasons the others declined.
 */
export async function selectSttEngine(opts: SttSelectionOptions = {}): Promise<SttEngine> {
  const runner = opts.runner;
  const candidates: Array<OmpSttEngine | WhisperCliEngine> = [
    new OmpSttEngine({ runner, ...opts.omp }),
    new WhisperCliEngine({ runner, ...opts.whisper }),
  ];

  const reasons: string[] = [];
  for (const engine of candidates) {
    const probe = await engine.probe();
    if (probe.available) {
      opts.onLog?.(`stt engine: ${engine.name} (${probe.reason})`);
      return engine;
    }
    reasons.push(`${engine.name}: ${probe.reason}`);
  }

  opts.onLog?.(`stt engine: null (${reasons.join("; ")})`);
  return new NullSttEngine(reasons);
}
