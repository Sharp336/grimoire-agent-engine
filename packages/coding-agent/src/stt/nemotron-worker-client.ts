import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isBunTestRuntime, isCompiledBinary, logger } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { workerEnvFromParent } from "../subprocess/worker-client";
import type { SttWorkerInbound, SttWorkerOutbound } from "./asr-protocol";
import type { SttModelKey } from "./models";

/**
 * Native FluidAudio Nemotron STT worker transport.
 *
 * The sherpa/transformers workers are Bun subprocesses re-running this package
 * with Bun's structured IPC; the Nemotron worker is a self-contained Swift
 * binary (`native/stt-nemotron`) implementing the same request shape over a
 * plain stdio protocol — a UInt32-LE-length-prefixed JSON header (optionally
 * followed by raw Float32 audio bytes) inbound, newline-delimited JSON
 * outbound. See docs in the Swift package or `nemotron-stt-protocol.md`.
 *
 * The binary is optional: when it cannot be resolved the caller falls back to
 * the sherpa worker, so source checkouts without a Swift toolchain keep the
 * legacy engine.
 */

type NemotronSubprocess = Subprocess<"pipe", "pipe", number | "ignore">;

/** Parent-side fan-out mirrors {@link SpawnedSubprocess} without Bun IPC. */
export interface NemotronSpawnedWorker {
	proc: NemotronSubprocess;
	inbound: Set<(message: SttWorkerOutbound) => void>;
	errors: Set<(error: Error) => void>;
	intentionalExit: { value: boolean };
	stderrDrained: Promise<void>;
}

export interface NemotronWorkerHandle {
	send(message: SttWorkerInbound): void;
	onMessage(handler: (message: SttWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
	ref(): void;
	unref(): void;
}

const STDERR_TAIL_LIMIT_BYTES = 16 * 1024;

/**
 * Resolve the `stt-nemotron` binary. Order: explicit override → shipped with
 * the compiled binary → workspace build output (debug or release).
 */
export function resolveNemotronWorkerPath(): string | null {
	const override = process.env.OMP_STT_WORKER_BIN;
	if (override && fs.existsSync(override)) return override;
	if (isCompiledBinary()) {
		const shipped = path.join(path.dirname(process.execPath), "stt-nemotron");
		if (fs.existsSync(shipped)) return shipped;
	}
	// Dev path: walk up from this module to the workspace root and look in the
	// Swift package's build products.
	let dir = import.meta.dir;
	for (let i = 0; i < 8; i++) {
		for (const profile of ["release", "debug"]) {
			const candidate = path.join(dir, "packages/coding-agent/native/stt-nemotron/.build", profile, "stt-nemotron");
			if (fs.existsSync(candidate)) return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** Tail of the worker's stderr, surfaced with a crash so native stacks reach the parent. */
class StderrTail {
	#chunks: Uint8Array[] = [];
	#bytes = 0;
	constructor(readonly limit: number) {}

	append(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		this.#chunks.push(chunk);
		this.#bytes += chunk.length;
		while (this.#bytes > this.limit && this.#chunks.length > 1) {
			const head = this.#chunks.shift();
			if (head) this.#bytes -= head.length;
		}
		if (this.#bytes > this.limit && this.#chunks.length === 1) {
			const only = this.#chunks[0];
			const start = only.length - this.limit;
			this.#chunks[0] = only.subarray(start);
			this.#bytes = this.limit;
		}
	}

	suffix(): string {
		if (this.#bytes === 0) return "";
		const merged = new Uint8Array(this.#bytes);
		let offset = 0;
		for (const chunk of this.#chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		const text = new TextDecoder().decode(merged).replace(/\s+$/u, "");
		return text.length === 0 ? "" : `: ${text}`;
	}
}

/** File-backed stderr capture that never pins the event loop (mirrors worker-client). */
function createStderrCaptureFd(): { target: number; fd: number; dir: string } | null {
	try {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-nemotron-stt-"));
		const fd = fs.openSync(path.join(dir, "stderr.log"), "w+");
		return { target: fd, fd, dir };
	} catch (error) {
		logger.debug("nemotron stt worker stderr capture unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function readStderrTail(fd: number, tail: StderrTail): void {
	try {
		const size = fs.fstatSync(fd).size;
		if (size <= 0) return;
		const length = Math.min(size, tail.limit);
		const buffer = new Uint8Array(length);
		fs.readSync(fd, buffer, 0, length, size - length);
		tail.append(buffer);
	} catch {
		// Best-effort diagnostics only.
	}
}

function cleanupStderrCapture(capture: { fd: number; dir: string } | null): void {
	if (!capture) return;
	try {
		fs.closeSync(capture.fd);
	} catch {
		// Already closed.
	}
	try {
		fs.rmSync(capture.dir, { recursive: true, force: true });
	} catch {
		// Temp cleanup failure is harmless.
	}
}

/**
 * Spawn the Swift worker and wire its NDJSON fan-out. The child is `unref`'d
 * outside `bun test` so an idle worker never blocks process exit; the smoke
 * probe and in-flight requests re-ref it explicitly.
 */
export function createNemotronSttSubprocess(binaryPath?: string): NemotronSpawnedWorker {
	const bin = binaryPath ?? resolveNemotronWorkerPath();
	if (!bin) {
		throw new Error(
			"stt-nemotron binary not found (set OMP_STT_WORKER_BIN or run packages/coding-agent/scripts/build-stt-worker.ts)",
		);
	}
	const inbound = new Set<(message: SttWorkerOutbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const intentionalExit = { value: false };
	const stderrCapture = createStderrCaptureFd();
	const stderrTail = new StderrTail(STDERR_TAIL_LIMIT_BYTES);
	const stderrDrained = Promise.withResolvers<void>();

	const proc = Bun.spawn([bin], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: stderrCapture?.target ?? "ignore",
		env: workerEnvFromParent(),
		onExit(_proc, exitCode, signalCode) {
			if (stderrCapture) {
				readStderrTail(stderrCapture.fd, stderrTail);
				cleanupStderrCapture(stderrCapture);
			}
			stderrDrained.resolve();
			if (exitCode === 0) return;
			if (exitCode === null && intentionalExit.value) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
			const err = new Error(`nemotron stt worker exited with ${reason}${stderrTail.suffix()}`);
			for (const handler of errors) handler(err);
		},
	});
	if (!isBunTestRuntime()) proc.unref();

	// NDJSON fan-out: split the worker's stdout at newlines and decode each
	// complete line. Chunks are byte-aligned arbitrarily, so a carry buffer
	// reassembles partial lines across reads.
	void (async () => {
		const stdout = proc.stdout;
		if (typeof stdout !== "object") return;
		const decoder = new TextDecoder();
		let carry = "";
		try {
			for await (const chunk of stdout) {
				carry += decoder.decode(chunk, { stream: true });
				let index = carry.indexOf("\n");
				while (index >= 0) {
					const line = carry.slice(0, index).replace(/\r$/u, "");
					carry = carry.slice(index + 1);
					index = carry.indexOf("\n");
					if (line.length === 0) continue;
					let message: SttWorkerOutbound;
					try {
						message = JSON.parse(line) as SttWorkerOutbound;
					} catch {
						logger.warn("nemotron stt worker emitted non-JSON line", { line });
						continue;
					}
					for (const handler of inbound) handler(message);
				}
			}
			const trailing = carry + decoder.decode();
			if (trailing.trim().length > 0) {
				try {
					const message = JSON.parse(trailing) as SttWorkerOutbound;
					for (const handler of inbound) handler(message);
				} catch {
					logger.warn("nemotron stt worker emitted trailing non-JSON", { line: trailing });
				}
			}
		} catch (error) {
			// Stdout ends when the worker exits; a read failure here is a worker
			// death that onExit also reports — no separate surfacing needed.
			logger.debug("nemotron stt worker stdout read ended", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	})();

	return { proc, inbound, errors, intentionalExit, stderrDrained: stderrDrained.promise };
}

/**
 * Encode one inbound message per the contract: UInt32-LE header length, JSON
 * header, then the raw Float32 payload for `transcribe` / `stream_audio`.
 */
export function encodeNemotronFrame(message: SttWorkerInbound): Uint8Array {
	let audio: Float32Array | undefined;
	let header: Record<string, unknown>;
	switch (message.type) {
		case "transcribe":
			audio = message.audio;
			header = {
				type: "transcribe",
				id: message.id,
				language: message.language,
				byteCount: audio.byteLength,
			};
			break;
		case "stream_audio":
			audio = message.audio;
			header = { type: "stream_audio", id: message.id, byteCount: audio.byteLength };
			break;
		case "stream_start":
			header = { type: "stream_start", id: message.id, language: message.language };
			break;
		case "download":
			header = { type: "download", id: message.id };
			break;
		default:
			header = { type: message.type, id: message.id };
			break;
	}
	const headerBytes = new TextEncoder().encode(JSON.stringify(header));
	const payload = audio ? new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength) : new Uint8Array(0);
	const frame = new Uint8Array(4 + headerBytes.length + payload.length);
	new DataView(frame.buffer).setUint32(0, headerBytes.length, true);
	frame.set(headerBytes, 4);
	frame.set(payload, 4 + headerBytes.length);
	return frame;
}

/** Wrap the spawned Swift worker as the worker-handle shape SttClient expects. */
export function createNemotronWorkerHandle(
	spawned: NemotronSpawnedWorker,
): NemotronWorkerHandle & { spawned: NemotronSpawnedWorker } {
	const { proc, inbound, errors, intentionalExit } = spawned;
	return {
		spawned,
		send(message) {
			try {
				void proc.stdin.write(encodeNemotronFrame(message));
			} catch (error) {
				logger.debug("nemotron stt worker send failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
		onMessage(handler) {
			inbound.add(handler);
			return () => inbound.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		async terminate() {
			intentionalExit.value = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		},
		ref() {
			try {
				proc.ref();
			} catch {
				// Already gone.
			}
		},
		unref() {
			try {
				proc.unref();
			} catch {
				// Already gone.
			}
		},
	};
}

/** Engine discriminator used by SttClient to route between worker kinds. */
export type SttWorkerEngine = "native-nemotron" | "bun-sherpa";

/** The engine a given tier decodes on: Swift worker for nemotron, Bun worker otherwise. */
export function resolveWorkerEngine(modelKey: SttModelKey, nemotronAvailable: boolean): SttWorkerEngine {
	if (modelKey === "nemotron") return nemotronAvailable ? "native-nemotron" : "bun-sherpa";
	return "bun-sherpa";
}
