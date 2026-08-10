#!/usr/bin/env python3
"""E2E: WAV (16k mono s16) -> stream_start/audio/stop -> stt-nemotron binary."""
import json
import struct
import subprocess
import sys
import wave

BIN = "packages/coding-agent/native/stt-nemotron/.build/release/stt-nemotron"
WAV = "/tmp/omp-stt-test.wav"


def frame(msg, payload=b""):
    hdr = json.dumps(msg).encode()
    return struct.pack("<I", len(hdr)) + hdr + payload


def readable(stream):
    while True:
        line = stream.readline()
        if not line:
            return None
        line = line.strip()
        if line:
            yield json.loads(line)
        else:
            return


with wave.open(WAV, "rb") as w:
    assert w.getframerate() == 16000 and w.getnchannels() == 1, w.getparams()
    pcm = w.readframes(w.getnframes())

import array
s16 = array.array("h")
s16.frombytes(pcm)
f32 = [s / 32768.0 for s in s16]
chunk_samples = 4000  # 250 ms per stream_audio frame

proc = subprocess.Popen([BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

messages = []
partials = 0

# stream_start
proc.stdin.write(frame({"type": "stream_start", "id": "s1", "language": "en"}))
proc.stdin.flush()

# stream_audio chunks, reading opportunistically
import select
import os
os.set_blocking(proc.stdout.fileno(), False)

for i in range(0, len(f32), chunk_samples):
    payload = struct.pack(f"<{len(f32[i:i+chunk_samples])}f", *f32[i:i + chunk_samples])
    proc.stdin.write(frame({"type": "stream_audio", "id": "s1", "byteCount": len(payload)}, payload))
    proc.stdin.flush()

# drain until stream_done appears
proc.stdin.write(frame({"type": "stream_stop", "id": "s1"}))
proc.stdin.flush()

done = None
import time
deadline = time.time() + 120
os.set_blocking(proc.stdout.fileno(), True)
while time.time() < deadline:
    line = proc.stdout.readline()
    if not line:
        break
    line = line.strip()
    if not line:
        continue
    m = json.loads(line)
    if m["type"] == "partial":
        partials += 1
        if partials <= 3 or partials % 10 == 0:
            print(f"partial[{partials}]: {m['text']!r}")
    elif m["type"] == "segment":
        print(f"segment[{m['index']}]: {m['text']!r}")
    elif m["type"] == "stream_done":
        done = m["text"]
        break
    elif m["type"] == "error":
        print(f"ERROR: {m['error']}")
        sys.exit(1)
    else:
        print(f"{m['type']}: {json.dumps(m)[:200]}")

print("---")
print(f"partials: {partials}")
print(f"stream_done: {done!r}")
sys.exit(0 if done and "transcription" in done.lower() else 1)
