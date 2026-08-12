/**
 * Voice: carrying OMP's local speech stack over the network.
 *
 * Nothing here synthesises or recognises anything. OMP already runs Parakeet
 * TDT v3 and Kokoro-82M on device; the daemon's job is to make them reachable
 * from a phone, and to fail loudly when the machine has neither.
 */

export {
  VoiceBridge,
  VoiceBufferOverflowError,
  WIRE_SAMPLE_RATE,
  type VoiceBridgeOptions,
} from "./bridge.ts";
export {
  BunCommandRunner,
  CommandTimeoutError,
  withScratchDir,
  type CommandResult,
  type CommandRunner,
  type EngineAvailability,
} from "./exec.ts";
export {
  EmptyTranscriptError,
  NullSttEngine,
  OmpSttEngine,
  selectSttEngine,
  STT_ENGINE_ORDER,
  SttUnavailableError,
  WhisperCliEngine,
  type OmpSttOptions,
  type SttEngine,
  type SttSelectionOptions,
  type WhisperCliOptions,
  type WhisperFlavor,
} from "./stt.ts";
export {
  NullTtsEngine,
  OmpTtsEngine,
  sanitizeForSpeech,
  SayTtsEngine,
  selectTtsEngine,
  TTS_ENGINE_ORDER,
  TtsUnavailableError,
  type OmpTtsOptions,
  type SayTtsOptions,
  type TtsEngine,
  type TtsSelectionOptions,
} from "./tts.ts";
export {
  chunkFrames,
  detectUtteranceEnd,
  detectUtteranceEndFromEnergies,
  frameEnergy,
  resolveVadOptions,
  VAD_DEFAULTS,
  type ResolvedVadOptions,
  type VadOptions,
} from "./vad.ts";
export {
  base64ToPcm,
  decodeWav,
  encodeWav,
  pcmToBase64,
  WavFormatError,
  type PcmAudio,
} from "./wav.ts";
