# stt-nemotron — OMP FluidAudio STT worker

Native speech-to-text worker for the editor's push-to-talk (space-hold)
dictation. A self-contained Swift binary wrapping FluidAudio's
`StreamingNemotronMultilingualAsrManager` (CoreML/ANE, true incremental
streaming partials). Replaces the sherpa-onnx subprocess when active.

## Protocol

Stdin: `[UInt32 LE headerLen][JSON header][raw Float32 LE payload?]`
Stdout: newline-delimited JSON (one message per line; never raw bytes).

Messages mirror `src/stt/asr-protocol.ts` (`SttWorkerInbound` /
`SttWorkerOutbound`): `ping`, `download`, `transcribe`, `stream_start`,
`stream_audio`, `stream_stop`, `stream_cancel`. Audio payloads are raw
little-endian Float32 mono 16 kHz samples; the header carries `byteCount`.

No VAD segmentation: partials stream live from the model per chunk; one final
`segment` is emitted at `stream_stop` followed by `stream_done` carrying the
full transcript.

## Models

FluidAudio cache, shared with VoxKey:
`~/Library/Application Support/FluidAudio/Models/nemotron-multilingual/latin/1120ms/`

The worker lazily downloads the variant on first use (`download` message) or
reuses the cache. The bundled model inside `/Applications/VoxKey.app` is the
same latin/1120ms variant.

## Build

```sh
bun --cwd=../.. run build:stt-worker   # swift build -c release
```

The binary lands in `.build/release/stt-nemotron` and is auto-discovered by
`src/stt/nemotron-worker-client.ts` (workspace walk-up) unless
`OMP_STT_WORKER_BIN` overrides the path.

## Manual regression probe

```sh
python3 e2e_stream_test.py    # expects /tmp/omp-stt-test.wav (16k mono s16)
# generate: say -o /tmp/omp-stt-test.aiff "…" && afconvert -f WAVE -d LEI16@16000 …
```

Integration via the real client path: `bun test src/stt/nemotron-stt.test.ts`
(skips when the binary or model cache is absent).
