//
//  stt-nemotron — OMP STT ↔ Nemotron Swift worker
//
//  Wire protocol: see nemotron-stt-protocol.md.
//  Framing IN  (stdin):  [UInt32 LE headerByteLen][header JSON][raw payload?]
//  Framing OUT (stdout): NDJSON, one message per line. Never raw bytes outbound.
//
//  stderr is free for diagnostic prints; stdout is JSON-only and lock-guarded.
//

import Foundation
import AVFoundation
import Darwin
import FluidAudio

// MARK: - Raw stdio (unbuffered syscalls)

/// Read exactly `count` bytes from stdin (fd 0). Returns a short Data on EOF/error.
private func readExactly(_ count: Int) -> Data {
    guard count > 0 else { return Data() }
    var buf = [UInt8](repeating: 0, count: count)
    var got = 0
    while got < count {
        let n = buf.withUnsafeMutableBufferPointer { ptr -> Int in
            read(0, ptr.baseAddress! + got, count - got)
        }
        if n <= 0 { break } // EOF (0) or error (<0)
        got += n
    }
    return Data(buf.prefix(got))
}

/// Diagnostic line to stderr (fd 2). Never touches stdout.
private func logErr(_ message: String) {
    var bytes = Array(message.utf8)
    bytes.append(0x0A)
    bytes.withUnsafeBufferPointer { ptr in
        var off = 0
        while off < ptr.count {
            let n = write(2, ptr.baseAddress! + off, ptr.count - off)
            if n <= 0 { break }
            off += n
        }
    }
}

private let stdoutLock = NSLock()

/// Serialize `object` to compact JSON + '\n' and write it to stdout (fd 1),
//  fully under `stdoutLock` so partial-callback writes never interleave.
private func emitLine(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(
        withJSONObject: object,
        options: [.sortedKeys]
    ) else {
        return
    }
    var bytes = [UInt8](data)
    bytes.append(0x0A)
    stdoutLock.lock()
    bytes.withUnsafeBufferPointer { ptr in
        var off = 0
        while off < ptr.count {
            let n = write(1, ptr.baseAddress! + off, ptr.count - off)
            if n <= 0 { break }
            off += n
        }
    }
    stdoutLock.unlock()
}

// MARK: - Outbound message builders

private func emitPong(_ id: String) {
    emitLine(["type": "pong", "id": id])
}
private func emitDownloaded(_ id: String) {
    emitLine(["type": "downloaded", "id": id])
}
private func emitError(_ id: String, _ message: String) {
    emitLine(["type": "error", "id": id, "error": message])
}
private func emitTranscription(_ id: String, _ text: String) {
    emitLine(["type": "transcription", "id": id, "text": text])
}
private func emitPartial(_ id: String, _ text: String) {
    emitLine(["type": "partial", "id": id, "text": text])
}
private func emitSegment(_ id: String, index: Int, _ text: String) {
    emitLine(["type": "segment", "id": id, "index": index, "text": text])
}
private func emitStreamDone(_ id: String, _ text: String) {
    emitLine(["type": "stream_done", "id": id, "text": text])
}
private func emitLog(_ level: String, _ message: String) {
    emitLine(["type": "log", "level": level, "msg": message])
}
private func emitProgress(_ id: String, fraction: Double) {
    let loaded = max(0, min(100, Int((fraction * 100).rounded())))
    emitLine([
        "type": "progress",
        "id": id,
        "event": [
            "modelKey": "nemotron",
            "status": "progress",
            "loaded": loaded,
            "total": 100,
        ],
    ])
}

// MARK: - Process state (single-threaded loop ⇒ no concurrent mutation)

/// Model cache directory, memoised after the first successful `download` /
/// lazy download. Reused by both managers so we never re-download.
/// All mutable state is touched only by the sequential stdin loop; the partial
/// callback (the sole off-loop entry point) captures its session id by value and
/// only ever calls the lock-guarded stdout writer, so no real data race exists.
nonisolated(unsafe) private var modelDir: URL?

/// Two independent managers so a batch `transcribe` never disturbs an
/// active stream. Each is loaded once per process and `reset()` per session.
nonisolated(unsafe) private var streamMgr: StreamingNemotronMultilingualAsrManager?
nonisolated(unsafe) private var transcribeMgr: StreamingNemotronMultilingualAsrManager?

/// The id of the currently active streaming session.
nonisolated(unsafe) private var currentSessionId: String?
/// Guards the at-most-one segment rule for the active session.
nonisolated(unsafe) private var sessionSegmentEmitted = false

// MARK: - Helpers

/// OMP settings use "en", "en-US", undefined(auto). Normalise for setLanguage.
private func normalizedLanguage(_ raw: String?) -> String? {
    guard let lang = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
          !lang.isEmpty else {
        return nil
    }
    switch lang.lowercased() {
    case "en": return "en-US"
    case "auto": return nil
    default: return lang
    }
}

/// Resolve an integer field that JSONSerialization may surface as Int or NSNumber.
private func intField(_ header: [String: Any], _ key: String) -> Int {
    if let n = header[key] as? Int { return n }
    if let n = header[key] as? NSNumber { return n.intValue }
    return 0
}

/// Wrap little-endian Float32 mono bytes as a 16 kHz non-interleaved PCM
/// buffer — exactly FluidAudio's target format (resampleBuffer fast path).
private func pcmBuffer(from data: Data) -> AVAudioPCMBuffer? {
    let frameCount = AVAudioFrameCount(data.count / 4)
    guard frameCount > 0,
          let format = AVAudioFormat(
              commonFormat: .pcmFormatFloat32,
              sampleRate: 16000,
              channels: 1,
              interleaved: false),
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)
    else { return nil }
    buffer.frameLength = frameCount
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let dst = buffer.floatChannelData?[0],
              let src = raw.bindMemory(to: Float.self).baseAddress else { return }
        dst.update(from: src, count: Int(frameCount))
    }
    return buffer
}

// MARK: - Download / load (memoised)

/// Download the requested variant into the shared cache, emitting progress.
/// Memoises `modelDir` on success. Returns false (and emits error) on failure.
private func ensureDownloaded(id: String, languageCode: String, chunkMs: Int) async -> Bool {
    if modelDir != nil { return true }
    do {
        let dir = try await StreamingNemotronMultilingualAsrManager.downloadVariant(
            languageCode: languageCode,
            chunkMs: chunkMs,
            progressHandler: { progress in
                emitProgress(id, fraction: progress.fractionCompleted)
            }
        )
        modelDir = dir
        return true
    } catch {
        emitError(id, "Download failed: \(error.localizedDescription)")
        return false
    }
}

private func loadStreamManager(id: String) async -> StreamingNemotronMultilingualAsrManager? {
    if let m = streamMgr { return m }
    guard let dir = modelDir else {
        emitError(id, "No model directory available")
        return nil
    }
    do {
        let m = StreamingNemotronMultilingualAsrManager()
        try await m.loadModels(from: dir)
        streamMgr = m
        return m
    } catch {
        emitError(id, "Model load failed: \(error.localizedDescription)")
        return nil
    }
}

private func loadTranscribeManager(id: String) async -> StreamingNemotronMultilingualAsrManager? {
    if let m = transcribeMgr { return m }
    guard let dir = modelDir else {
        emitError(id, "No model directory available")
        return nil
    }
    do {
        let m = StreamingNemotronMultilingualAsrManager()
        try await m.loadModels(from: dir)
        transcribeMgr = m
        return m
    } catch {
        emitError(id, "Model load failed: \(error.localizedDescription)")
        return nil
    }
}

/// Ensure the model variant is downloaded for a streaming/transcribe op when
/// no explicit `download` preceded it. The full `multilingual` variant is the
/// safe default when the requested language is unknown/auto.
private func ensureModelDir(id: String, language: String?) async -> Bool {
    if modelDir != nil { return true }
    let code = (language?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
        ? language!
        : "auto"
    return await ensureDownloaded(id: id, languageCode: code, chunkMs: 1120)
}

// MARK: - Message handlers

private func handlePing(_ header: [String: Any]) {
    emitPong((header["id"] as? String) ?? "")
}

private func handleDownload(_ header: [String: Any]) async {
    let id = (header["id"] as? String) ?? ""
    let languageCode = (header["languageCode"] as? String) ?? "auto"
    let rawChunkMs = intField(header, "chunkMs")
    let chunkMs = rawChunkMs > 0 ? rawChunkMs : 1120
    if await ensureDownloaded(id: id, languageCode: languageCode, chunkMs: chunkMs) {
        emitDownloaded(id)
    }
}

private func handleStreamStart(_ header: [String: Any]) async {
    let id = (header["id"] as? String) ?? ""
    let language = header["language"] as? String

    guard await ensureModelDir(id: id, language: language) else { return }
    guard let mgr = await loadStreamManager(id: id) else { return }

    await mgr.reset()
    currentSessionId = id
    sessionSegmentEmitted = false
    await mgr.setLanguage(normalizedLanguage(language))
    await mgr.setPartialCallback { [id] text in
        emitPartial(id, text)
    }
    // No explicit ack for stream_start (per protocol).
}

private func handleStreamAudio(_ header: [String: Any], payload: Data) async {
    let id = (header["id"] as? String) ?? ""
    guard let mgr = streamMgr else {
        emitError(id, "stream_audio without an active stream")
        return
    }
    guard currentSessionId == id else {
        emitError(id, "stream_audio for an unknown or finished session")
        return
    }
    guard let buffer = pcmBuffer(from: payload) else {
        emitError(id, "Invalid audio payload (expected Float32 LE mono 16kHz)")
        return
    }
    do {
        // Running transcript is surfaced via the partial callback; the return
        // value is intentionally discarded during streaming.
        _ = try await mgr.process(audioBuffer: buffer)
    } catch {
        emitError(id, "process failed: \(error.localizedDescription)")
    }
}

private func handleStreamStop(_ header: [String: Any]) async {
    let id = (header["id"] as? String) ?? ""
    guard let mgr = streamMgr else {
        emitError(id, "stream_stop without an active stream")
        return
    }
    guard currentSessionId == id else {
        emitError(id, "stream_stop for an unknown or finished session")
        return
    }
    let finalText: String
    do {
        finalText = try await mgr.finish()
    } catch {
        emitError(id, "finish failed: \(error.localizedDescription)")
        currentSessionId = nil
        return
    }
    let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty && !sessionSegmentEmitted {
        emitSegment(id, index: 0, trimmed)
        sessionSegmentEmitted = true
    }
    emitStreamDone(id, trimmed)
    currentSessionId = nil
}

private func handleStreamCancel(_ header: [String: Any]) async {
    let id = (header["id"] as? String) ?? ""
    if let mgr = streamMgr {
        await mgr.reset()
    }
    if currentSessionId == id {
        currentSessionId = nil
    }
    // Emits nothing further for this id (per protocol).
}

private func handleTranscribe(_ header: [String: Any], payload: Data) async {
    let id = (header["id"] as? String) ?? ""
    let language = header["language"] as? String

    guard await ensureModelDir(id: id, language: language) else { return }
    guard let mgr = await loadTranscribeManager(id: id) else { return }

    await mgr.reset()
    await mgr.setLanguage(normalizedLanguage(language))

    guard let buffer = pcmBuffer(from: payload) else {
        emitError(id, "Invalid audio payload (expected Float32 LE mono 16kHz)")
        return
    }
    do {
        _ = try await mgr.process(audioBuffer: buffer)
        let text = try await mgr.finish()
        emitTranscription(id, text.trimmingCharacters(in: .whitespacesAndNewlines))
    } catch {
        emitError(id, "transcribe failed: \(error.localizedDescription)")
    }
}

private func dispatch(type: String, header: [String: Any], payload: Data) async {
    switch type {
    case "ping":
        handlePing(header)
    case "download":
        await handleDownload(header)
    case "transcribe":
        await handleTranscribe(header, payload: payload)
    case "stream_start":
        await handleStreamStart(header)
    case "stream_audio":
        await handleStreamAudio(header, payload: payload)
    case "stream_stop":
        await handleStreamStop(header)
    case "stream_cancel":
        await handleStreamCancel(header)
    default:
        let id = (header["id"] as? String) ?? ""
        let msg = "Unknown message type: \(type)"
        if id.isEmpty {
            emitLog("warn", msg)
        } else {
            emitError(id, msg)
        }
    }
}

// MARK: - Frame loop

private func runWorker() async {
    while true {
        // [UInt32 LE headerByteLength]
        let lenBytes = readExactly(4)
        if lenBytes.count < 4 {
            return // clean EOF on stdin → exit 0
        }
        let headerLen = UInt32(lenBytes[0])
            | (UInt32(lenBytes[1]) << 8)
            | (UInt32(lenBytes[2]) << 16)
            | (UInt32(lenBytes[3]) << 24)

        guard headerLen > 0, headerLen <= 1_048_576 else {
            // Corrupt framing — cannot resync. Log and stop.
            logErr("stt-nemotron: invalid header length \(headerLen); stopping")
            return
        }

        // [header JSON UTF-8]
        let headerData = readExactly(Int(headerLen))
        if headerData.count < Int(headerLen) {
            return // truncated → EOF
        }
        guard let header = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any] else {
            emitLog("error", "Failed to parse header JSON")
            continue
        }
        let type = (header["type"] as? String) ?? ""

        // [optional raw payload]
        let byteCount = intField(header, "byteCount")
        var payload = Data()
        if byteCount > 0 {
            payload = readExactly(byteCount)
            if payload.count < byteCount {
                return // truncated → EOF
            }
        }

        await dispatch(type: type, header: header, payload: payload)
    }
}

// MARK: - Entry point

logErr("stt-nemotron: worker ready")

// dispatchMain() parks the main thread on the GCD main run loop (never
// returns); the stdin loop runs on the cooperative pool. On stdin EOF we
// exit(0) to terminate cleanly.
Task {
    await runWorker()
    exit(0)
}
dispatchMain()
