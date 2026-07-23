//! Persistent PowerShell host sidecar exported via N-API.
//!
//! # Overview
//! A single long-lived `pwsh` process owns one shared runspace; every `run()`
//! on this host executes in it, so variables, imported modules,
//! `$LASTEXITCODE`, and the live result objects in `$global:__omp` persist
//! across calls and stay inspectable with `Enter-PSHostProcess -Id <pid>`. The
//! expensive process spawn is paid once per session; per-call cost is one
//! runspace pipeline over the warm host.
//!
//! The host loop is [`pshost_bootstrap.ps1`], embedded at build time and
//! written to a content-addressed temp file on first use. Communication is
//! 4-byte big-endian length-prefixed UTF-8 JSON frames over the child's stdio:
//!
//! - requests  (Rust -> host): `exec` / `stop` / `exit`
//! - events    (host -> Rust): `ready` / `chunk` / `done`
//!
//! # Architecture
//! ```text
//! PsHost (N-API) ── req frames ──▶ pwsh sidecar (shared runspace)
//!        ▲                                 │
//!        └──────── chunk/done frames ──────┘
//! ```

use std::{
	collections::HashMap,
	path::PathBuf,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering},
	},
	time::Duration,
};

use napi::{
	Env, Error, Result,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;
use pi_shell::{cancel as core_cancel, process as core_process};
use serde::{Deserialize, Serialize};
use tokio::{
	io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, ReadBuf},
	process::Command,
	sync::{mpsc, oneshot, watch},
};

use crate::task;

/// Host loop script, embedded so compiled binaries need no asset resolution.
const BOOTSTRAP: &str = include_str!("pshost_bootstrap.ps1");

/// Hard cap on a single inbound frame body, guarding against a desynced stream.
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// Bound on the reader→JS chunk queue. A slow `on_chunk` consumer backpressures
/// the sidecar's stdout pipe instead of buffering its whole output in memory
/// (mirrors `shell`'s bridge queue; see #4078).
const CHUNK_QUEUE_CHUNKS: usize = 64;

// ─────────────────────────────────────────────────────────────────────────────
// Wire protocol
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum HostRequest<'a> {
	Exec {
		id:      u32,
		command: &'a str,
		#[serde(skip_serializing_if = "Option::is_none")]
		cwd:     Option<&'a str>,
		#[serde(skip_serializing_if = "Option::is_none")]
		env:     Option<&'a HashMap<String, String>>,
		width:   u32,
	},
	Stop {
		id: u32,
	},
	Exit,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum HostEvent {
	// `pid` / `stream` arrive on the wire but aren't read here; serde ignores
	// the extra fields, so they're omitted from the variants.
	Ready,
	Chunk {
		id:   u32,
		text: String,
	},
	#[serde(rename_all = "camelCase")]
	Done {
		id:         u32,
		#[serde(default)]
		exit_code:  Option<i32>,
		had_errors: bool,
		#[serde(default)]
		stopped:    bool,
	},
}

/// Completion record routed from the reader back to the awaiting `run`.
struct DoneInfo {
	exit_code:  Option<i32>,
	had_errors: bool,
	stopped:    bool,
}

/// Per-exec routing: streamed chunks + the single completion signal.
struct Pending {
	chunk_tx: mpsc::Sender<String>,
	done_tx:  oneshot::Sender<DoneInfo>,
}

#[derive(Clone)]
enum ReadyState {
	Pending,
	Ready(i32),
	Failed(String),
}

// ─────────────────────────────────────────────────────────────────────────────
// N-API option / result objects
// ─────────────────────────────────────────────────────────────────────────────

/// Options for spawning a persistent PowerShell host.
#[napi(object)]
pub struct PsHostOptions {
	/// PowerShell executable to launch. Defaults to `pwsh`.
	pub shell_path:         Option<String>,
	/// Working directory for the host process (initial location).
	pub cwd:                Option<String>,
	/// Environment variables applied once at host launch.
	pub session_env:        Option<HashMap<String, String>>,
	/// PID of the omp process; the host self-terminates if it dies (orphan
	/// guard). Omit or `0` to disable the watchdog.
	pub parent_pid:         Option<i32>,
	/// Cap on retained result history entries. Defaults to `20`.
	pub history_depth:      Option<u32>,
	/// Milliseconds to wait for the ready handshake. Defaults to `15000`.
	pub startup_timeout_ms: Option<u32>,
}

/// Options for running a command on the host.
#[napi(object)]
pub struct PsRunOptions<'env> {
	/// PowerShell command text to execute in the shared runspace.
	pub command:    String,
	/// Location to set before running (persists into the runspace).
	pub cwd:        Option<String>,
	/// Environment variables to set before running. Process-scoped and never
	/// unset — once applied they persist for the host's lifetime. (Plumbed but
	/// not currently supplied by the coding-agent tool, which documents
	/// inline `$env:` assignment instead.)
	pub env:        Option<HashMap<String, String>>,
	/// Render width passed to `Out-String`. Defaults to `120`.
	pub width:      Option<u32>,
	/// Timeout in milliseconds before the in-flight pipeline is stopped.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:     Option<Unknown<'env>>,
}

/// Result of running a command on the host.
#[napi(object)]
pub struct PsRunResult {
	/// Exit code of a native command run by this invocation, when one ran.
	/// `$LASTEXITCODE` itself persists in the runspace, but a stale value from
	/// an earlier call is never attributed here.
	pub exit_code:  Option<i32>,
	/// Whether the command wrote to the error stream or set `HadErrors`.
	pub had_errors: bool,
	/// Whether the command was cancelled (abort signal or external stop).
	pub cancelled:  bool,
	/// Whether the command timed out before completion.
	pub timed_out:  bool,
	/// Monotonic id of this execution within the host.
	pub exec_id:    u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// Host core
// ─────────────────────────────────────────────────────────────────────────────

struct Config {
	shell_path:         String,
	cwd:                Option<String>,
	session_env:        Option<HashMap<String, String>>,
	parent_pid:         i32,
	history_depth:      u32,
	startup_timeout_ms: u64,
}

struct HostCore {
	config:         Config,
	script_path:    PathBuf,
	pid:            AtomicI32,
	next_id:        AtomicU32,
	/// Id of the in-flight exec (`0` == none); read by `abort`.
	current_id:     AtomicU32,
	started:        AtomicBool,
	req_tx:         mpsc::UnboundedSender<Vec<u8>>,
	req_rx:         Mutex<Option<mpsc::UnboundedReceiver<Vec<u8>>>>,
	pending:        Mutex<HashMap<u32, Pending>>,
	process:        Mutex<Option<core_process::Process>>,
	ready_tx:       watch::Sender<ReadyState>,
	ready_rx:       watch::Receiver<ReadyState>,
	stderr_tail:    Mutex<String>,
	/// Set (and reset) by `supervise` while the stderr pump is running.
	/// `exec()` uses this to rendezvous with the pump task before draining
	/// `stderr_tail`, so bytes the OS already delivered to the pipe by the
	/// time `done` arrives on the unrelated stdout channel aren't dropped
	/// just because the pump's own read hadn't been scheduled yet.
	stderr_sync_tx: Mutex<Option<mpsc::UnboundedSender<oneshot::Sender<()>>>>,
	/// Serializes execs: the shared runspace runs one pipeline at a time.
	exec_lock:      tokio::sync::Mutex<()>,
}

impl HostCore {
	fn send(&self, frame: Vec<u8>) -> Result<()> {
		self
			.req_tx
			.send(frame)
			.map_err(|_| Error::from_reason("PowerShell host is not running"))
	}

	/// Rendezvous with the stderr pump task before draining `stderr_tail`.
	/// `done` (stdout) and stderr bytes arrive on two independent OS pipes
	/// with no ordering guarantee between the tokio tasks reading them —
	/// even when the bytes were physically written to the kernel first (e.g.
	/// a child's `WaitForExit()` returning inside the PS script, which
	/// happens-before the wrapper continues and sends `done`), the pump
	/// task still needs its own independent scheduling to read them. This
	/// asks the pump to non-blockingly drain whatever the kernel has ready
	/// RIGHT NOW before replying, so a caller that awaits the reply sees
	/// every byte already delivered. Times out rather than hanging if the
	/// pump task is gone (host already died, or never had a stderr pipe).
	async fn sync_stderr(&self) {
		let Some(tx) = self.stderr_sync_tx.lock().clone() else {
			return;
		};
		let (ack_tx, ack_rx) = oneshot::channel();
		if tx.send(ack_tx).is_err() {
			return;
		}
		let _ = tokio::time::timeout(Duration::from_millis(200), ack_rx).await;
	}

	/// Drop the routing state for exec `id`: clear the in-flight marker (only if
	/// it is still ours) and remove its pending entry. Safe on any exit path.
	fn abandon(&self, id: u32) {
		self
			.current_id
			.compare_exchange(id, 0, Ordering::Relaxed, Ordering::Relaxed)
			.ok();
		self.pending.lock().remove(&id);
	}

	/// Run one command on the shared runspace, streaming rendered chunks to
	/// `chunk_tx`. Binding-free core of [`PsHost::run`]: no `Env`, no
	/// threadsafe function — directly unit-testable. Cancellation stops only the
	/// in-flight pipeline and is reported via `cancelled`/`timed_out`.
	async fn exec(
		self: &Arc<Self>,
		command: String,
		cwd: Option<String>,
		env: Option<HashMap<String, String>>,
		width: u32,
		cancel: task::CancelToken,
		chunk_tx: mpsc::Sender<String>,
	) -> Result<PsRunResult> {
		// A run issued before start() would otherwise park on done_rx until the
		// caller's timeout: nothing consumes req_tx until supervise() spawns.
		if !self.started.load(Ordering::SeqCst) {
			return Err(Error::from_reason("PowerShell host has not been started"));
		}
		// One pipeline at a time on the shared runspace.
		let _guard = self.exec_lock.lock().await;
		// The AbortSignal may already be aborted by the time we get the lock
		// (e.g. the caller cancelled while a cold host was still spawning, or
		// while queued behind another pipeline on this shared runspace).
		// Bail out here, before any exec/Pending state is created and before
		// the frame reaches the sidecar — otherwise a fast or destructive
		// command would start despite the cancelled tool call. `wait()`
		// resolves immediately once `aborted()` is true, so this costs no
		// extra delay.
		if cancel.aborted() {
			let reason = cancel.wait().await;
			let timed_out = matches!(reason, task::AbortReason::Timeout);
			return Ok(PsRunResult {
				exit_code: None,
				had_errors: false,
				cancelled: !timed_out,
				timed_out,
				exec_id: 0,
			});
		}
		// Ids start at 1: `current_id == 0` is the "nothing in flight" sentinel
		// read by abort(), hence the double increment.
		let id = self.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1);

		let (done_tx, mut done_rx) = oneshot::channel::<DoneInfo>();
		// A separate handle survives past `abandon(id)` dropping the Pending
		// entry's own sender, so the stderr forward below (after abandon) can
		// still deliver.
		let stderr_chunk_tx = chunk_tx.clone();
		self
			.pending
			.lock()
			.insert(id, Pending { chunk_tx, done_tx });
		self.current_id.store(id, Ordering::Relaxed);

		let exec = match encode_frame(&HostRequest::Exec {
			id,
			command: &command,
			cwd: cwd.as_deref(),
			env: env.as_ref(),
			width,
		}) {
			Ok(frame) => frame,
			Err(err) => {
				self.abandon(id);
				return Err(err);
			},
		};
		if let Err(err) = self.send(exec) {
			self.abandon(id);
			return Err(err);
		}
		// Bound the per-exec stderr forward (below) to content written DURING
		// this exec's window, not stale content from an idle period between
		// commands. Without this, a PREVIOUS command's fire-and-forget child
		// (spawned without waiting for it, e.g. Start-Process without -Wait)
		// could keep writing to the sidecar's inherited stderr pipe after
		// that command's own exec already completed and took+cleared the
		// tail; those idle-period bytes would then sit in stderr_tail until
		// THIS unrelated exec's completion misattributed them as its own
		// diagnostic output. A background child racing this exact clear (in
		// the narrow window between it and the exec's own frames starting)
		// remains possible but is now a few-millisecond race instead of an
		// unbounded idle period.
		self.stderr_tail.lock().clear();

		// `None` signals the host died before completing; every other path
		// yields a result and falls through to the shared cleanup below.
		let outcome = tokio::select! {
			res = &mut done_rx => match res {
				Ok(info) => Some(PsRunResult {
					exit_code:  info.exit_code,
					had_errors: info.had_errors,
					cancelled:  info.stopped,
					timed_out:  false,
					exec_id:    id,
				}),
				Err(_) => None,
			},
			reason = cancel.wait() => {
				// Stop just this pipeline; when the host acknowledges the stop,
				// the runspace (and all retained state) survives.
				let _ = self.send(encode_frame(&HostRequest::Stop { id })?);
				let timed_out = matches!(reason, task::AbortReason::Timeout);
				match tokio::time::timeout(Duration::from_secs(3), &mut done_rx).await {
					Ok(Ok(info)) => Some(PsRunResult {
						exit_code:  info.exit_code,
						had_errors: info.had_errors,
						cancelled:  !timed_out,
						timed_out,
						exec_id:    id,
					}),
					_ => {
						// No stop acknowledgement: the pipeline is wedged in
						// uncooperative native/.NET code and the runspace can no
						// longer be trusted — handing this host back to the pool
						// would hang or reject every later command behind the
						// stuck pipeline. Kill the sidecar; pools detect the dead
						// host via `alive` and respawn lazily on the next call.
						let process = self.process.lock().clone();
						if let Some(process) = process {
							let _ = process
								.terminate_tree(true, 0, 5_000, core_cancel::CancelToken::default())
								.await;
						}
						Some(PsRunResult {
							exit_code:  None,
							had_errors: true,
							cancelled:  !timed_out,
							timed_out,
							exec_id:    id,
						})
					},
				}
			},
		};

		self.abandon(id);
		// A child spawned by the user's command outside PowerShell's pipeline
		// with inherited stderr (e.g. a .NET ProcessStartInfo with
		// RedirectStandardError = false) writes directly to this sidecar's own
		// real OS stderr pipe -- untouched by the stdin/stdout detach in the
		// bootstrap, since stderr carries no protocol frames and detaching it
		// there would only discard the bytes before Rust ever saw them.
		// pump_stderr already captures that pipe into stderr_tail, but nothing
		// previously surfaced it past the startup-diagnostic phase, so it
		// silently vanished for a successfully-running exec. Forward
		// (and clear, bounding memory the same way as the PS1-side stream
		// release) whatever accumulated during this exec -- both on success
		// and on host death, where a child's last words are often the most
		// useful diagnostic. sync_stderr() rendezvous with the pump task
		// first so bytes the OS already delivered to the pipe by the time
		// `done` arrived on the unrelated stdout channel aren't dropped
		// just because the pump's own read hadn't been scheduled yet.
		self.sync_stderr().await;
		let stderr_content = std::mem::take(&mut *self.stderr_tail.lock());
		if !stderr_content.trim().is_empty() {
			let labeled = stderr_content
				.split('\n')
				.map(|line| {
					if line.trim().is_empty() {
						line.to_string()
					} else {
						format!("\x1b[31;1m{line}\x1b[0m")
					}
				})
				.collect::<Vec<_>>()
				.join("\n");
			let _ = stderr_chunk_tx
				.send(format!("[external process stderr]\n{labeled}\n"))
				.await;
		}
		match outcome {
			Some(result) => Ok(result),
			None => Err(Error::from_reason("PowerShell host terminated before the command completed")),
		}
	}
}

/// Encode a request as a length-prefixed JSON frame.
fn encode_frame<T: Serialize>(msg: &T) -> Result<Vec<u8>> {
	let json = serde_json::to_vec(msg).map_err(|err| Error::from_reason(err.to_string()))?;
	let mut frame = Vec::with_capacity(4 + json.len());
	frame.extend_from_slice(&u32::try_from(json.len()).unwrap_or(u32::MAX).to_be_bytes());
	frame.extend_from_slice(&json);
	Ok(frame)
}

/// True when `path` is a regular file (not a symlink) whose bytes hash to
/// `hash`. The bootstrap lives in a shared temp dir under a predictable name,
/// so pre-existing content must never be trusted: a planted file would
/// otherwise be handed to `pwsh -File` verbatim.
fn bootstrap_is_valid(path: &std::path::Path, hash: u64) -> bool {
	let Ok(meta) = std::fs::symlink_metadata(path) else {
		return false;
	};
	if !meta.is_file() {
		return false;
	}
	let Ok(bytes) = std::fs::read(path) else {
		return false;
	};
	xxhash_rust::xxh64::xxh64(&bytes, 0) == hash
}

/// Directory the bootstrap is materialized into. On Unix this is a private
/// per-user subdir (mode 0700, owned by the current euid) of the temp dir:
/// the script name is predictable, and in a shared world-writable /tmp
/// another user could pre-create valid bytes and rewrite them between hash
/// validation and `pwsh -File` opening the file. On Windows `%TEMP%` is
/// already per-user.
fn bootstrap_dir() -> Result<PathBuf> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
		let euid = unsafe { libc::geteuid() };
		let dir = std::env::temp_dir().join(format!("omp-pshost-{euid}"));
		let mut builder = std::fs::DirBuilder::new();
		builder.mode(0o700);
		match builder.create(&dir) {
			Ok(()) => {},
			Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {},
			Err(err) => {
				return Err(Error::from_reason(format!(
					"Failed to create PowerShell host script dir: {err}"
				)));
			},
		}
		// Refuse a squatted dir: it must be a real directory (not a symlink),
		// owned by us, with no group/other access.
		let meta = std::fs::symlink_metadata(&dir).map_err(|err| {
			Error::from_reason(format!("Failed to stat PowerShell host script dir: {err}"))
		})?;
		if !meta.is_dir() || meta.uid() != euid || (meta.permissions().mode() & 0o077) != 0 {
			return Err(Error::from_reason(
				"PowerShell host script dir has unsafe ownership or permissions",
			));
		}
		Ok(dir)
	}
	#[cfg(not(unix))]
	{
		Ok(std::env::temp_dir())
	}
}

/// Materialize the embedded bootstrap to a content-addressed file in
/// [`bootstrap_dir`]. The bytes are verified (hash + regular-file check)
/// before the path is ever returned — existence alone is not trusted, so a
/// planted or corrupted file is replaced rather than executed. Publication is
/// a unique temp file + atomic rename, so a host that reads a valid file
/// never sees a partial write, even when several processes first-write the
/// same new hash at once (e.g. `test:ts` and `test:rs` running in parallel
/// after a bootstrap change). A racing writer that wins leaves identical
/// bytes.
fn ensure_bootstrap() -> Result<PathBuf> {
	static TMP_NONCE: AtomicU32 = AtomicU32::new(0);
	let dir = bootstrap_dir()?;
	let hash = xxhash_rust::xxh64::xxh64(BOOTSTRAP.as_bytes(), 0);
	let path = dir.join(format!("omp-pshost-{hash:016x}.ps1"));
	if bootstrap_is_valid(&path, hash) {
		return Ok(path);
	}
	// pid + nonce: two hosts first-created concurrently in one process must
	// not write/truncate the same temp file before the rename publishes it.
	let tmp = dir.join(format!(
		"omp-pshost-{hash:016x}.{}.{}.tmp",
		std::process::id(),
		TMP_NONCE.fetch_add(1, Ordering::Relaxed)
	));
	std::fs::write(&tmp, BOOTSTRAP).map_err(|err| {
		Error::from_reason(format!("Failed to write PowerShell host script: {err}"))
	})?;
	if std::fs::rename(&tmp, &path).is_err() {
		// Windows rename fails onto an existing dest. If the dest already
		// validates, a concurrent writer published identical bytes — keep it;
		// deleting it here could yank the script out from under that process's
		// in-flight `pwsh -File`. Only a stale/invalid dest is replaced.
		if bootstrap_is_valid(&path, hash) {
			let _ = std::fs::remove_file(&tmp);
			return Ok(path);
		}
		let _ = std::fs::remove_file(&path);
		if std::fs::rename(&tmp, &path).is_err() {
			let _ = std::fs::remove_file(&tmp);
		}
	}
	if !bootstrap_is_valid(&path, hash) {
		return Err(Error::from_reason("Failed to install PowerShell host script"));
	}
	Ok(path)
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistent PowerShell host
// ─────────────────────────────────────────────────────────────────────────────

/// Persistent PowerShell host backed by a long-lived `pwsh` sidecar.
#[napi]
pub struct PsHost {
	core: Arc<HostCore>,
}

#[napi]
impl PsHost {
	/// Create a host handle. The sidecar is not launched until [`PsHost::start`]
	/// — construction only allocates channels and resolves the bootstrap script.
	#[napi(constructor)]
	pub fn new(options: PsHostOptions) -> Result<Self> {
		let script_path = ensure_bootstrap()?;
		let (req_tx, req_rx) = mpsc::unbounded_channel::<Vec<u8>>();
		let (ready_tx, ready_rx) = watch::channel(ReadyState::Pending);
		let config = Config {
			shell_path:         options.shell_path.unwrap_or_else(|| "pwsh".to_string()),
			cwd:                options.cwd,
			session_env:        options.session_env,
			parent_pid:         options.parent_pid.unwrap_or(0),
			history_depth:      options.history_depth.unwrap_or(20),
			startup_timeout_ms: u64::from(options.startup_timeout_ms.unwrap_or(15_000)),
		};
		let core = Arc::new(HostCore {
			config,
			script_path,
			pid: AtomicI32::new(0),
			next_id: AtomicU32::new(0),
			current_id: AtomicU32::new(0),
			started: AtomicBool::new(false),
			req_tx,
			req_rx: Mutex::new(Some(req_rx)),
			pending: Mutex::new(HashMap::new()),
			process: Mutex::new(None),
			ready_tx,
			ready_rx,
			stderr_tail: Mutex::new(String::new()),
			stderr_sync_tx: Mutex::new(None),
			exec_lock: tokio::sync::Mutex::new(()),
		});
		Ok(Self { core })
	}

	/// Launch the sidecar (idempotent) and wait for its ready handshake.
	///
	/// Returns the sidecar PID, usable with `Enter-PSHostProcess` for debugging.
	#[napi]
	pub async fn start(&self) -> Result<i32> {
		if !self.core.started.swap(true, Ordering::SeqCst) {
			let Some(req_rx) = self.core.req_rx.lock().take() else {
				return Err(Error::from_reason("PowerShell host already consumed its request channel"));
			};
			let core = Arc::clone(&self.core);
			tokio::spawn(async move { supervise(core, req_rx).await });
		}

		let timeout = Duration::from_millis(self.core.config.startup_timeout_ms);
		let mut rx = self.core.ready_rx.clone();
		let waited = tokio::time::timeout(timeout, async move {
			loop {
				let state = rx.borrow_and_update().clone();
				match state {
					ReadyState::Ready(pid) => return Ok(pid),
					ReadyState::Failed(err) => return Err(err),
					ReadyState::Pending => {},
				}
				if rx.changed().await.is_err() {
					return Err("PowerShell host terminated during startup".to_string());
				}
			}
		})
		.await;

		match waited {
			Ok(Ok(pid)) => Ok(pid),
			Ok(Err(err)) => Err(Error::from_reason(err)),
			Err(_) => Err(Error::from_reason("PowerShell host startup timed out")),
		}
	}

	/// PID of the sidecar (`0` until [`PsHost::start`] completes).
	#[napi(getter)]
	pub fn pid(&self) -> i32 {
		self.core.pid.load(Ordering::Relaxed)
	}

	/// Whether the sidecar process is currently running. `false` after a crash
	/// or after a wedged pipeline forced a kill on stop-ack timeout — pools use
	/// this to evict dead entries instead of handing them back out.
	#[napi(getter)]
	pub fn alive(&self) -> bool {
		self
			.core
			.process
			.lock()
			.as_ref()
			.is_some_and(|process| matches!(process.status(), core_process::ProcessStatus::Running))
	}

	/// Run `command` on the shared runspace.
	///
	/// `on_chunk` streams rendered output/error text. Returns exit status and
	/// flags; cancellation (timeout / abort signal) is reported via `cancelled`
	/// / `timed_out` rather than rejection, and leaves the runspace intact when
	/// the host acknowledges the stop. If it does not (pipeline wedged in an
	/// uncooperative native call), the sidecar is force-killed and [`alive`]
	/// turns false so pools evict the dead host instead of reusing it.
	#[napi]
	pub fn run<'env>(
		&self,
		env: &'env Env,
		options: PsRunOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
	) -> Result<PromiseRaw<'env, PsRunResult>> {
		let cancel = task::CancelToken::new(options.timeout_ms, options.signal);
		let core = Arc::clone(&self.core);
		let command = options.command;
		let cwd = options.cwd;
		let cmd_env = options.env;
		let width = options.width.unwrap_or(120);

		task::future(env, "pshost.run", async move {
			// Bridge the per-exec chunk stream to the JS callback. Created inside
			// the runtime context so `spawn_chunk_forwarder` has a reactor.
			let (chunk_tx, chunk_rx) = mpsc::channel::<String>(CHUNK_QUEUE_CHUNKS);
			let drain = spawn_chunk_forwarder(on_chunk, chunk_rx);
			let result = core
				.exec(command, cwd, cmd_env, width, cancel, chunk_tx)
				.await;
			let _ = drain.await;
			result
		})
	}

	/// Request that the in-flight pipeline stop, without tearing down the host.
	///
	/// Resolves immediately even when nothing is running.
	#[napi]
	pub fn abort(&self) -> Result<()> {
		let id = self.core.current_id.load(Ordering::Relaxed);
		if id == 0 {
			return Ok(());
		}
		if let Ok(frame) = encode_frame(&HostRequest::Stop { id }) {
			let _ = self.core.send(frame);
		}
		Ok(())
	}

	/// Gracefully shut down the sidecar: send `exit`, wait briefly, then
	/// hard-kill the process tree if it has not exited.
	#[napi]
	pub async fn dispose(&self) -> Result<()> {
		let process = self.core.process.lock().clone();
		// Snapshot the root's direct children BEFORE requesting exit: on
		// Unix/macOS, `Process::children()` is gated on the root's own live
		// identity and unconditionally returns empty once the root is no
		// longer Running, so capturing it only after observing a dead root
		// (the common graceful-exit case) would always find nothing — a
		// background child (`Start-Process`/`ProcessStartInfo`) the command
		// left running would leak forever even with the reap-on-clean-exit
		// branch below. This is the only point in `dispose()` where the root
		// is (as far as we know) still alive.
		let children_before_exit = process
			.as_ref()
			.map(core_process::Process::children)
			.unwrap_or_default();
		if let Ok(frame) = encode_frame(&HostRequest::Exit) {
			let _ = self.core.send(frame);
		}
		if let Some(process) = process {
			let _ = process
				.wait_for_exit(Some(Duration::from_secs(2)), core_cancel::CancelToken::default())
				.await;
			if matches!(process.status(), core_process::ProcessStatus::Running) {
				let _ = process
					.terminate_tree(true, 0, 5_000, core_cancel::CancelToken::default())
					.await;
			} else {
				// The root exited within the grace window, but terminate_tree
				// bails out immediately whenever the root isn't Running — it
				// would never reap a background child the command left running
				// when it returned. Reap the pre-exit snapshot directly; each
				// child's own `terminate_tree` call checks THAT process's live
				// identity, independent of the (already-dead) root's.
				for child in children_before_exit {
					let _ = child
						.terminate_tree(false, 0, 5_000, core_cancel::CancelToken::default())
						.await;
				}
			}
		}
		self.core.pending.lock().clear();
		Ok(())
	}
}

/// Forward per-exec chunk text to the JS callback, coalescing bursts so the JS
/// main thread never sees a multi-MB single call (mirrors
/// `shell::bridge_chunks`). Always spawns and drains `rx` to completion, even
/// with no callback: dropping `rx` outright (as an early `on_chunk?` return
/// once did) leaves every subsequent `chunk_tx.send()` in `read_events`
/// failing fast and silently discarded rather than blocking — tokio's
/// bounded `mpsc::Sender::send` errors immediately once every `Receiver` is
/// dropped, it does not wait for one. No hang either way, but the public
/// `on_chunk` parameter is optional, and a caller of `PsHost::run()` without
/// one deserves the same delivery semantics (chunks actually consumed, not
/// merely fail-fast-discarded) rather than depending on `read_events`
/// continuing to discard the `Result` it gets back from a dead channel.
fn spawn_chunk_forwarder(
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
	mut rx: mpsc::Receiver<String>,
) -> tokio::task::JoinHandle<()> {
	tokio::spawn(async move {
		let Some(on_chunk) = on_chunk else {
			// No callback: drain and discard so the bounded channel never fills.
			while rx.recv().await.is_some() {}
			return;
		};
		const MAX_BATCH_BYTES: usize = 64 * 1024;
		const INITIAL_BATCH_CAP: usize = 8 * 1024;
		let mut batch = String::with_capacity(INITIAL_BATCH_CAP);
		// A single PowerShell frame can be up to ~4M chars (multiple MB — see
		// Write-Chunk's $sliceChars in pshost_bootstrap.ps1). Every item pulled
		// here — the first (blocking recv) and every subsequent one coalesced
		// via non-blocking try_recv — goes through the SAME oversized check
		// before being appended to `batch`: an earlier version only checked
		// the first item, so a small chunk followed by a queued multi-MB one
		// still sailed through unsplit via the coalescing branch, silently
		// breaking the "JS main thread never sees a multi-MB single call"
		// contract for exactly the sequence codex flagged (small progress
		// chunk immediately followed by one large output chunk).
		'outer: while let Some(first) = rx.recv().await {
			let mut pending = Some(first);
			loop {
				let item = match pending.take() {
					Some(item) => item,
					None => match rx.try_recv() {
						Ok(item) => item,
						Err(_) => break, // nothing more immediately available
					},
				};

				if item.len() > MAX_BATCH_BYTES {
					// Flush whatever was already pending first, so delivery
					// order is preserved across the split.
					if !batch.is_empty() {
						let flushed =
							std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
						if on_chunk.call_async(Ok(flushed)).await.is_err() {
							break 'outer;
						}
					}
					let mut rest = item.as_str();
					while !rest.is_empty() {
						let split = floor_char_boundary(rest, MAX_BATCH_BYTES);
						let (piece, remainder) = rest.split_at(split);
						if on_chunk.call_async(Ok(piece.to_string())).await.is_err() {
							break 'outer;
						}
						rest = remainder;
					}
					continue;
				}

				if !batch.is_empty() && batch.len() + item.len() > MAX_BATCH_BYTES {
					let flushed =
						std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
					if on_chunk.call_async(Ok(flushed)).await.is_err() {
						break 'outer;
					}
				}
				batch.push_str(&item);
			}
			if !batch.is_empty() {
				let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
				// `call_async` resolves only after the JS callback ran, so
				// `run()` (which awaits this task) cannot resolve until every
				// batch is delivered — no truncated `sink.dump()` — and at
				// most one batch sits in the napi queue, so the JS
				// consumption rate backpressures the bounded channel and the
				// sidecar's stdout pipe. Err means the JS side is gone (env
				// teardown): stop forwarding.
				if on_chunk.call_async(Ok(payload)).await.is_err() {
					break;
				}
			}
		}
	})
}

/// Largest byte index `<= index` that lands on a UTF-8 char boundary in `s`.
/// `str::floor_char_boundary` is nightly-only; this is the stable equivalent
/// used to split an oversized chunk without slicing through a multi-byte
/// codepoint (which would panic).
const fn floor_char_boundary(s: &str, index: usize) -> usize {
	if index >= s.len() {
		return s.len();
	}
	let mut i = index;
	while i > 0 && !s.is_char_boundary(i) {
		i -= 1;
	}
	i
}

/// Supervisor: spawn the sidecar, wire stdio pumps, and route events until the
/// process exits or its stdout closes.
async fn supervise(core: Arc<HostCore>, req_rx: mpsc::UnboundedReceiver<Vec<u8>>) {
	let mut command = Command::new(&core.config.shell_path);
	command
		.arg("-NoLogo")
		.arg("-NoProfile")
		.arg("-NonInteractive")
		.arg("-File")
		.arg(&core.script_path)
		.arg("-ParentPid")
		.arg(core.config.parent_pid.to_string())
		.arg("-HistoryDepth")
		.arg(core.config.history_depth.to_string());
	if let Some(cwd) = &core.config.cwd {
		command.current_dir(cwd);
	}
	if let Some(env) = &core.config.session_env {
		command.envs(env);
	}
	command
		.stdin(std::process::Stdio::piped())
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.kill_on_drop(true);
	// Own process group on Unix: teardown uses terminate_tree(group=true),
	// which signals the target's group — that must never be the foreground
	// group inherited from the agent, or disposing a stuck sidecar would
	// SIGTERM omp itself and every sibling job.
	#[cfg(unix)]
	command.process_group(0);

	let mut child = match command.spawn() {
		Ok(child) => child,
		Err(err) => {
			core
				.ready_tx
				.send_replace(ReadyState::Failed(format!("Failed to spawn PowerShell host: {err}")));
			return;
		},
	};

	let pid = child.id().map_or(0, |pid| pid as i32);
	core.pid.store(pid, Ordering::Relaxed);
	*core.process.lock() = core_process::Process::from_pid(pid);

	let stdin = child.stdin.take().expect("child stdin piped");
	let stdout = child.stdout.take().expect("child stdout piped");
	let stderr = child.stderr.take().expect("child stderr piped");

	let writer = tokio::spawn(pump_writer(stdin, req_rx));
	let stderr_core = Arc::clone(&core);
	let (stderr_sync_tx, stderr_sync_rx) = mpsc::unbounded_channel();
	*core.stderr_sync_tx.lock() = Some(stderr_sync_tx);
	let stderr_pump = tokio::spawn(pump_stderr(stderr, stderr_core, stderr_sync_rx));

	read_events(stdout, &core).await;

	// stdout closed: the host is gone. Surface a startup failure if we never
	// became ready, and fail every awaiting exec so callers don't hang.
	if matches!(*core.ready_rx.borrow(), ReadyState::Pending) {
		let tail = core.stderr_tail.lock().clone();
		let detail = if tail.trim().is_empty() {
			"PowerShell host exited during startup".to_string()
		} else {
			tail
		};
		core.ready_tx.send_replace(ReadyState::Failed(detail));
	}
	core.pending.lock().clear();

	*core.stderr_sync_tx.lock() = None;
	writer.abort();
	stderr_pump.abort();
	let _ = child.wait().await;
}

/// Drain framed requests to the child's stdin.
async fn pump_writer(
	mut stdin: tokio::process::ChildStdin,
	mut req_rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
	while let Some(frame) = req_rx.recv().await {
		if stdin.write_all(&frame).await.is_err() {
			break;
		}
		if stdin.flush().await.is_err() {
			break;
		}
	}
}

/// Capture the child's stderr tail for diagnostics (capped).
async fn pump_stderr(
	mut stderr: tokio::process::ChildStderr,
	core: Arc<HostCore>,
	mut sync_rx: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
) {
	let mut buf = [0u8; 4096];
	loop {
		tokio::select! {
			biased;
			// A caller (HostCore::sync_stderr) wants a rendezvous before it
			// drains stderr_tail: non-blockingly pull everything the kernel
			// has ready RIGHT NOW, ack, then resume the normal blocking read.
			// Polling once per iteration (never `.await`ing on empty) means
			// this loop terminates the instant nothing more is available,
			// instead of blocking the ack on the next byte to arrive.
			Some(ack) = sync_rx.recv() => {
				while let Some(n) = poll_stderr_once(&mut stderr, &mut buf) {
					if n == 0 {
						break;
					}
					push_stderr_tail(&core, &buf[..n]);
				}
				let _ = ack.send(());
			}
			result = stderr.read(&mut buf) => {
				match result {
					Ok(0) | Err(_) => break,
					Ok(n) => push_stderr_tail(&core, &buf[..n]),
				}
			}
		}
	}
}

/// Append `data` to `stderr_tail`, capped the same way as the startup-tail
/// cap: bounds memory for a long-running command whose external child is
/// noisy on stderr.
fn push_stderr_tail(core: &HostCore, data: &[u8]) {
	let mut tail = core.stderr_tail.lock();
	tail.push_str(&String::from_utf8_lossy(data));
	if tail.len() > 8192 {
		let cut = floor_char_boundary(&tail, tail.len() - 8192);
		*tail = tail.split_off(cut);
	}
}

/// Single non-blocking poll of `stderr`: `Some(n)` (`n == 0` on EOF) if a
/// read completed immediately, `None` if it would otherwise block (nothing
/// available right now) or the pipe errored. Used only by the sync-drain
/// path above — the normal loop uses the plain `.await`ing read.
fn poll_stderr_once(stderr: &mut tokio::process::ChildStderr, buf: &mut [u8]) -> Option<usize> {
	let mut polled = None;
	let waker = std::task::Waker::noop();
	let mut cx = std::task::Context::from_waker(waker);
	let mut read_buf = ReadBuf::new(buf);
	if let std::task::Poll::Ready(result) = Pin::new(&mut *stderr).poll_read(&mut cx, &mut read_buf)
	{
		polled = result.ok().map(|()| read_buf.filled().len());
	}
	polled
}

/// Read framed events from the child's stdout and route them to waiters.
async fn read_events(stdout: tokio::process::ChildStdout, core: &Arc<HostCore>) {
	let mut reader = BufReader::new(stdout);
	let mut len_buf = [0u8; 4];
	loop {
		if reader.read_exact(&mut len_buf).await.is_err() {
			break;
		}
		let len = u32::from_be_bytes(len_buf) as usize;
		if len > MAX_FRAME_BYTES {
			break;
		}
		let mut body = vec![0u8; len];
		if reader.read_exact(&mut body).await.is_err() {
			break;
		}
		let Ok(event) = serde_json::from_slice::<HostEvent>(&body) else {
			continue;
		};
		match event {
			HostEvent::Ready => {
				let pid = core.pid.load(Ordering::Relaxed);
				core.ready_tx.send_replace(ReadyState::Ready(pid));
				// Any startup-time noise belongs to diagnosing a startup failure
				// (ReadyState::Pending's read above), not to the first real
				// exec's per-exec stderr forward.
				core.stderr_tail.lock().clear();
			},
			HostEvent::Chunk { id, text } => {
				// Clone the sender out before releasing the lock so we never hold
				// the pending mutex across the send.
				let chunk_tx = core
					.pending
					.lock()
					.get(&id)
					.map(|pending| pending.chunk_tx.clone());
				if let Some(chunk_tx) = chunk_tx {
					let _ = chunk_tx.send(text).await;
				}
			},
			HostEvent::Done { id, exit_code, had_errors, stopped } => {
				let pending = core.pending.lock().remove(&id);
				if let Some(pending) = pending {
					let _ = pending
						.done_tx
						.send(DoneInfo { exit_code, had_errors, stopped });
				}
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use tokio::sync::mpsc;

	use super::{CHUNK_QUEUE_CHUNKS, PsHost, PsHostOptions, spawn_chunk_forwarder};
	use crate::task;

	/// Skip the suite when no `pwsh` is reachable (CI without PowerShell).
	fn pwsh_available() -> bool {
		std::process::Command::new("pwsh")
			.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"])
			.stdout(std::process::Stdio::null())
			.stderr(std::process::Stdio::null())
			.status()
			.is_ok_and(|status| status.success())
	}

	fn test_host() -> PsHost {
		PsHost::new(PsHostOptions {
			shell_path:         None,
			cwd:                None,
			session_env:        None,
			parent_pid:         Some(std::process::id() as i32),
			history_depth:      None,
			startup_timeout_ms: None,
		})
		.expect("construct PsHost")
	}

	/// Run a command through the binding-free core, collecting rendered output.
	async fn run_cmd(
		host: &PsHost,
		command: &str,
		cancel: task::CancelToken,
	) -> (String, super::PsRunResult) {
		let (chunk_tx, mut chunk_rx) = mpsc::channel::<String>(super::CHUNK_QUEUE_CHUNKS);
		// Drain concurrently: the bounded channel backpressures the sidecar
		// reader, so draining only after `exec` returns could deadlock a
		// chunk-heavy command.
		let collector = tokio::spawn(async move {
			let mut output = String::new();
			while let Some(chunk) = chunk_rx.recv().await {
				output.push_str(&chunk);
			}
			output
		});
		let result = host
			.core
			.exec(command.to_string(), None, None, 200, cancel, chunk_tx)
			.await
			.expect("exec returns a result");
		let output = collector.await.expect("chunk collector joins");
		(output.trim().to_string(), result)
	}

	/// `on_chunk: None` must still drain (and discard) the bounded channel — no
	/// pwsh required, this exercises spawn_chunk_forwarder() directly against a
	/// synthetic producer standing in for read_events(). The review finding
	/// this guards against claimed the pre-fix None-early-return would hang
	/// `chunk_tx.send()` once the bounded channel filled; empirically that
	/// specific mechanism did not reproduce here (tokio's bounded
	/// `mpsc::Sender::send` fails FAST, not blocks, once every `Receiver` is
	/// dropped — verified by simulating the pre-fix early-return and observing
	/// an immediate `SendError` on the very first send, not a timeout). What
	/// the pre-fix code actually did: `rx` dropped the instant
	/// spawn_chunk_forwarder returned `None`, so read_events's
	/// `let _ = chunk_tx.send(text).await;` silently discarded every chunk via
	/// a failed send from the first call. No hang, but a caller of the public
	/// PsHost.run() API without a callback got zero visibility into command
	/// output — the fix makes that explicit (drain-and-discard) rather than
	/// incidental, so it stays correct if read_events ever stops discarding
	/// the send Result.
	#[tokio::test]
	async fn forwarder_drains_bounded_channel_with_no_callback() {
		let (tx, rx) = mpsc::channel::<String>(CHUNK_QUEUE_CHUNKS);
		let drain = spawn_chunk_forwarder(None, rx);

		let producer = tokio::time::timeout(Duration::from_secs(5), async move {
			// Well past capacity: proves sends succeed (and are drained) rather
			// than relying on discarded SendErrors from a dropped receiver.
			for i in 0..(CHUNK_QUEUE_CHUNKS * 4) {
				tx.send(format!("chunk-{i}")).await.expect("receiver alive");
			}
			// Dropping tx closes the channel, letting the drain loop exit.
		})
		.await;
		assert!(producer.is_ok(), "producer must not block on an undrained bounded channel");

		let drained = tokio::time::timeout(Duration::from_secs(5), drain).await;
		assert!(drained.is_ok(), "forwarder task must exit once the channel closes");
	}

	/// A previous command's fire-and-forget child (started without waiting
	/// for it) can keep writing to the sidecar's inherited stderr pipe AFTER
	/// that command's own exec has already completed and taken+cleared the
	/// tail. Reproduces the finding's exact complaint: those idle-period
	/// bytes must NOT surface as a LATER, unrelated exec's diagnostic output.
	#[tokio::test(flavor = "multi_thread")]
	async fn idle_period_stderr_does_not_leak_into_a_later_exec() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		// Fire-and-forget a child that sleeps, THEN writes to its inherited
		// stderr -- guaranteed to write well after this command's own exec
		// (which does not wait for it) has already completed.
		let child_args = if cfg!(windows) {
			"'cmd.exe'; '/c ping -n 2 127.0.0.1 >nul & echo idle-stderr-marker 1>&2'"
		} else {
			"'/bin/sh'; '-c'; 'sleep 0.6; echo idle-stderr-marker >&2'"
		};
		let spawn_cmd = format!(
			"$args = @({child_args}); $psi = New-Object System.Diagnostics.ProcessStartInfo; \
			 $psi.FileName = $args[0]; if ($args.Count -gt 2) {{ $psi.ArgumentList.Add($args[1]); \
			 $psi.ArgumentList.Add($args[2]) }} else {{ $psi.Arguments = $args[1] }}; \
			 $psi.UseShellExecute = $false; $psi.RedirectStandardError = $false; \
			 [void][System.Diagnostics.Process]::Start($psi); 'spawner-done'"
		);
		let (out, _) = run_cmd(&host, &spawn_cmd, task::CancelToken::default()).await;
		assert!(out.contains("spawner-done"), "spawner returns without waiting: {out:?}");
		assert!(!out.contains("idle-stderr-marker"), "child hasn't written yet: {out:?}");

		// Genuinely idle: no exec running while the child sleeps, then writes.
		tokio::time::sleep(Duration::from_millis(1400)).await;

		let (out2, _) = run_cmd(&host, "'unrelated-command'", task::CancelToken::default()).await;
		assert!(out2.contains("unrelated-command"), "unrelated exec's own output present: {out2:?}");
		assert!(
			!out2.contains("idle-stderr-marker"),
			"a later exec must not inherit a previous command's idle-period stderr: {out2:?}"
		);

		host.dispose().await.expect("host disposes");
	}

	/// A previous command's fire-and-forget background PowerShell runspace
	/// (started without waiting for it -- e.g. `$ps.BeginInvoke()`) can keep
	/// writing to the redirected [Console]::Out/Error `StringWriter`s AFTER
	/// that command's own exec has already completed and been drained.
	/// [Console]::Out is process-static, so a write from any runspace in
	/// this process lands in the same buffer. Reproduces the finding's exact
	/// complaint: those idle-period bytes must NOT surface as a LATER,
	/// unrelated exec's output. (A plain `Task.Run` delegate can't reproduce
	/// this: PowerShell scriptblocks require a runspace on the invoking
	/// thread, which a bare threadpool thread doesn't have -- a background
	/// runspace is the realistic vector, matching e.g. `Start-ThreadJob`.)
	#[tokio::test(flavor = "multi_thread")]
	async fn idle_period_console_writes_do_not_leak_into_a_later_exec() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		// Fire-and-forget a background runspace that sleeps, THEN writes
		// directly to [Console]::Out -- guaranteed to write well after this
		// command's own exec (which does not wait for it) has already
		// completed.
		let spawn_cmd = "$rs2 = [runspacefactory]::CreateRunspace(); $rs2.Open(); $ps2 = \
		                 [powershell]::Create(); $ps2.Runspace = $rs2; \
		                 [void]$ps2.AddScript('Start-Sleep -Milliseconds 700; \
		                 [Console]::Out.Write(\"idle-console-marker\")'); [void]$ps2.BeginInvoke(); \
		                 'spawner-done'";
		let (out, _) = run_cmd(&host, spawn_cmd, task::CancelToken::default()).await;
		assert!(out.contains("spawner-done"), "spawner returns without waiting: {out:?}");
		assert!(!out.contains("idle-console-marker"), "runspace hasn't written yet: {out:?}");

		// Genuinely idle: no exec running while the task sleeps, then writes.
		tokio::time::sleep(Duration::from_millis(1400)).await;

		let (out2, _) = run_cmd(&host, "'unrelated-command'", task::CancelToken::default()).await;
		assert!(out2.contains("unrelated-command"), "unrelated exec's own output present: {out2:?}");
		assert!(
			!out2.contains("idle-console-marker"),
			"a later exec must not inherit a previous command's idle-period console write: {out2:?}"
		);

		host.dispose().await.expect("host disposes");
	}

	/// `floor_char_boundary` must never slice through a multi-byte UTF-8
	/// codepoint (which panics `str::split_at`), and splitting on its result
	/// repeatedly must reconstruct the original string exactly (no lost or
	/// duplicated bytes) -- the property `spawn_chunk_forwarder`'s oversized-
	/// chunk split depends on.
	#[test]
	fn floor_char_boundary_splits_without_corrupting_utf8() {
		use super::floor_char_boundary;

		assert_eq!(floor_char_boundary("hello", 3), 3, "pure-ASCII index is already a boundary");
		assert_eq!(floor_char_boundary("hello", 100), 5, "clamps to the string length");
		assert_eq!(floor_char_boundary("hello", 0), 0);

		// "café" — 'é' is 2 bytes (U+00E9), so byte index 4 (mid-'é') is NOT a
		// boundary; the floor must back off to 3 (right after 'f').
		let s = "café";
		assert_eq!(s.len(), 5, "café is 5 bytes: c-a-f-é(2 bytes)");
		assert_eq!(floor_char_boundary(s, 4), 3, "backs off out of the middle of 'é'");
		let (head, tail) = s.split_at(floor_char_boundary(s, 4));
		assert_eq!(format!("{head}{tail}"), s, "split reconstructs the original exactly");

		// Reassembling a full multi-byte string via repeated small-budget
		// splits (as the forwarder's while-loop does) must lose nothing.
		let text = "héllo wörld 🎉 more técxt".repeat(50);
		let mut rest = text.as_str();
		let mut pieces = Vec::new();
		while !rest.is_empty() {
			let split = floor_char_boundary(rest, 7); // tiny budget to force many splits
			let (piece, remainder) = rest.split_at(split);
			pieces.push(piece.to_string());
			rest = remainder;
		}
		assert_eq!(pieces.concat(), text, "reassembled pieces equal the original text exactly");
	}

	/// `pump_stderr`'s 8KiB cap computes a raw byte offset (`tail.len() -
	/// 8192`); with non-ASCII stderr content that offset can land inside a
	/// multi-byte codepoint, and the pre-fix `String::split_off` panics on a
	/// non-boundary index -- silently killing the stderr pump task, after
	/// which inherited-child stderr stops being captured for the rest of the
	/// host's life. Reproduces the exact panic, then proves
	/// `floor_char_boundary` (already used by the chunk-forwarder split)
	/// closes it by rounding the cut down to a valid boundary first.
	#[test]
	fn stderr_tail_trim_does_not_panic_on_a_multibyte_boundary() {
		use super::floor_char_boundary;

		// 4200 two-byte 'é' codepoints (8400 bytes) plus one trailing ASCII
		// byte: the odd total length forces `len - 8192` to land on an odd
		// byte index, which is the second (interior) byte of one of the
		// 'é's -- never a codepoint start.
		let mut tail = "é".repeat(4200);
		tail.push('x');
		assert_eq!(tail.len(), 8401);

		let naive_cut = tail.len() - 8192;
		assert!(!tail.is_char_boundary(naive_cut), "test setup: the cut must land mid-codepoint");

		let _silence = crate::testing::SilenceHook::new();
		let panicked = std::panic::catch_unwind({
			let mut probe = tail.clone();
			move || probe.split_off(naive_cut)
		})
		.is_err();
		assert!(
			panicked,
			"pre-fix split_off must panic on a mid-codepoint cut (confirms the repro is real)"
		);

		let cut = floor_char_boundary(&tail, naive_cut);
		let trimmed = tail.split_off(cut);
		assert!(trimmed.len() <= 8192 + 1, "kept roughly the last 8192 bytes: {}", trimmed.len());
		assert_eq!(
			trimmed,
			std::str::from_utf8(trimmed.as_bytes()).unwrap(),
			"result is valid UTF-8"
		);
	}

	/// A single oversized item (e.g. PowerShell's up-to-4M-char frames) must
	/// be SPLIT into `<= MAX_BATCH_BYTES`-ish pieces before reaching the JS
	/// callback, not forwarded whole. `call_async` needs a real N-API `Env`
	/// (can't construct a `ThreadsafeFunction` in a plain unit test), so this
	/// exercises the split path's producer/consumer plumbing around
	/// `spawn_chunk_forwarder(None, ...)` -- proving an oversized single send
	/// still completes promptly and every byte is drained -- while the actual
	/// per-call payload-size bound is verified end-to-end from JS (host.run()
	/// smoke test, see PR discussion).
	#[tokio::test]
	async fn forwarder_accepts_an_oversized_single_chunk() {
		let (tx, rx) = mpsc::channel::<String>(CHUNK_QUEUE_CHUNKS);
		let drain = spawn_chunk_forwarder(None, rx);

		// Larger than MAX_BATCH_BYTES (64KiB) by construction.
		let huge = "x".repeat(200 * 1024);
		let sent = tokio::time::timeout(Duration::from_secs(5), tx.send(huge)).await;
		assert!(sent.is_ok() && sent.unwrap().is_ok(), "oversized single send completes");
		drop(tx);

		let drained = tokio::time::timeout(Duration::from_secs(5), drain).await;
		assert!(drained.is_ok(), "forwarder task must exit after draining the oversized item");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn persists_state_and_maps_cancellation() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		let pid = host.start().await.expect("host starts");
		assert!(pid > 0, "host reports a live pid");
		assert_eq!(host.pid(), pid);

		// Rendered output + clean status.
		let (out, res) = run_cmd(&host, "$x = 21; $x * 2", task::CancelToken::default()).await;
		assert_eq!(out, "42");
		assert!(!res.had_errors);

		// Same runspace: $x set above survives into the next exec.
		let (out, _) = run_cmd(&host, "$x + 1", task::CancelToken::default()).await;
		assert_eq!(out, "22");

		// The previous result's live objects are inspectable without re-running.
		let (out, _) = run_cmd(&host, "$__omp.Last", task::CancelToken::default()).await;
		assert_eq!(out, "22");

		// Error stream sets had_errors (cross-platform).
		let (_, res) = run_cmd(
			&host,
			"Get-Item /__omp_does_not_exist_zzz__ -ErrorAction Continue",
			task::CancelToken::default(),
		)
		.await;
		assert!(res.had_errors, "error stream maps to had_errors");

		// Native exit code propagates.
		let exit_cmd = if cfg!(windows) {
			"cmd /c exit 7"
		} else {
			"/bin/sh -c 'exit 7'"
		};
		let (_, res) = run_cmd(&host, exit_cmd, task::CancelToken::default()).await;
		assert_eq!(res.exit_code, Some(7), "native exit code propagates");

		// Repeating the identical native exit must still be attributed to this
		// invocation (command-lookup flag; a value change alone can't see it).
		let (_, res) = run_cmd(&host, exit_cmd, task::CancelToken::default()).await;
		assert_eq!(res.exit_code, Some(7), "repeated identical native exit is reported");

		// A PS-only command after a native exit must not inherit the stale code.
		let (_, res) = run_cmd(&host, "'ok'", task::CancelToken::default()).await;
		assert_eq!(res.exit_code, None, "no stale exit code after a native exit");
		assert!(!res.had_errors, "PS-only command is not an error");

		// A terminating error must not corrupt the persisted $LASTEXITCODE: the
		// wrapped script's finally restores it (still 7 from the native exit).
		let (_, res) = run_cmd(&host, "throw 'boom'", task::CancelToken::default()).await;
		assert!(res.had_errors, "throw surfaces as had_errors");
		let (out, _) = run_cmd(&host, "$LASTEXITCODE", task::CancelToken::default()).await;
		assert_eq!(out, "7", "LASTEXITCODE survives a terminating error");

		// Invalid cwd fails fast without running the command.
		let (bad_out, bad_res) = {
			let (tx, mut rx) = mpsc::channel::<String>(super::CHUNK_QUEUE_CHUNKS);
			let r = host
				.core
				.exec(
					"'should not run'".to_string(),
					Some("__omp_no_such_dir_zzz__".to_string()),
					None,
					200,
					task::CancelToken::default(),
					tx,
				)
				.await
				.expect("exec returns a result");
			let mut s = String::new();
			while let Ok(c) = rx.try_recv() {
				s.push_str(&c);
			}
			(s, r)
		};
		assert!(bad_res.had_errors, "invalid cwd marks the run failed");
		assert!(!bad_out.contains("should not run"), "command must not run with invalid cwd");

		// Timeout stops the in-flight pipeline fast and is reported as timed_out,
		// without rejecting; the runspace survives.
		let started = std::time::Instant::now();
		let (_, res) =
			run_cmd(&host, "Start-Sleep -Seconds 30", task::CancelToken::new(Some(800), None)).await;
		assert!(res.timed_out, "long sleep times out");
		assert!(!res.cancelled, "timeout is not a signal cancel");
		assert!(started.elapsed() < Duration::from_secs(10), "timeout returns promptly");

		// State intact after the aborted pipeline (same runspace).
		let (out, _) = run_cmd(&host, "$x * 10", task::CancelToken::default()).await;
		assert_eq!(out, "210", "runspace state survives a stopped pipeline");

		host.dispose().await.expect("host disposes");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn maps_signal_abort_distinct_from_timeout() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		// External abort (AbortReason::Signal) with no timeout configured: the
		// result must attribute the stop to cancellation, not the timeout arm.
		// (emplace_abort_token: a default token has no abort flag to hook.)
		let mut cancel = task::CancelToken::default();
		let aborter = cancel.emplace_abort_token();
		let (chunk_tx, _chunk_rx) = mpsc::channel::<String>(super::CHUNK_QUEUE_CHUNKS);
		let exec_fut =
			host
				.core
				.exec("Start-Sleep -Seconds 30".to_string(), None, None, 200, cancel, chunk_tx);
		let abort_fut = async {
			tokio::time::sleep(Duration::from_millis(400)).await;
			aborter.abort(task::AbortReason::Signal);
		};
		let (res, ()) = tokio::join!(exec_fut, abort_fut);
		let res = res.expect("aborted exec still resolves");
		assert!(res.cancelled, "signal abort maps to cancelled");
		assert!(!res.timed_out, "signal abort is not attributed to timeout");

		// Only the pipeline was stopped; the runspace survives.
		let (out, _) = run_cmd(&host, "'alive'", task::CancelToken::default()).await;
		assert_eq!(out, "alive", "runspace survives a signal abort");

		host.dispose().await.expect("host disposes");
	}

	/// If the caller's `AbortSignal` is already aborted by the time `exec()`
	/// reaches the native layer (e.g. cancelled while a cold host was still
	/// spawning), the exec frame must never reach the sidecar: no pipeline
	/// should run, and the result must report cancellation immediately.
	#[tokio::test(flavor = "multi_thread")]
	async fn aborted_before_exec_never_publishes_the_frame() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		// Abort BEFORE exec() is ever called -- not racing it mid-flight.
		let mut cancel = task::CancelToken::default();
		let aborter = cancel.emplace_abort_token();
		aborter.abort(task::AbortReason::Signal);

		let (chunk_tx, mut chunk_rx) = mpsc::channel::<String>(super::CHUNK_QUEUE_CHUNKS);
		let res = host
			.core
			.exec("$global:__marker = 'ran'".to_string(), None, None, 200, cancel, chunk_tx)
			.await
			.expect("pre-aborted exec still resolves");
		assert!(res.cancelled, "pre-aborted call reports cancelled");
		assert!(!res.timed_out, "signal abort is not attributed to timeout");
		assert!(chunk_rx.recv().await.is_none(), "no output chunk was ever produced");

		// The command text must never have reached the runspace.
		let (out, _) = run_cmd(
			&host,
			"if ($global:__marker) { 'ran' } else { 'never-ran' }",
			task::CancelToken::default(),
		)
		.await;
		assert_eq!(out, "never-ran", "the exec frame was never sent to the sidecar");

		host.dispose().await.expect("host disposes");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn surfaces_host_death_mid_exec_as_error() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		// Kill the sidecar from inside the exec: the awaiting run must reject
		// promptly instead of hanging until an outer timeout.
		let (chunk_tx, _chunk_rx) = mpsc::channel::<String>(super::CHUNK_QUEUE_CHUNKS);
		let res = host
			.core
			.exec(
				"[Environment]::Exit(3)".to_string(),
				None,
				None,
				200,
				task::CancelToken::default(),
				chunk_tx,
			)
			.await;
		assert!(res.is_err(), "host death mid-exec surfaces as an error");
	}

	/// A user command spawning a background child with default
	/// `ProcessStartInfo` settings (matching round-24's pattern:
	/// `UseShellExecute=$false`, nothing explicitly redirected) can inherit
	/// the sidecar's own std handles on Windows. `Detach()`'s `SetStdHandle`
	/// only repoints the STD SLOT at NUL -- it never cleared
	/// `HANDLE_FLAG_INHERIT` on the original handle it keeps open -- so that
	/// child could receive an inheritable duplicate of the write end of the
	/// stdout protocol pipe. If the host then dies while that child is still
	/// alive, an OS pipe stays open for writing as long as ANY process holds
	/// a duplicate of the write end, so Rust's `read_events` would never see
	/// EOF until the orphaned child ALSO exits, hiding host death instead of
	/// reporting it promptly.
	#[tokio::test(flavor = "multi_thread")]
	async fn host_death_is_detected_promptly_even_with_a_long_lived_child_holding_inherited_handles()
	{
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		// Fire-and-forget a long-lived child using the exact
		// ProcessStartInfo shape that empirically inherits handles on this
		// platform (round-24's pattern) -- the finding's "handle inheritance
		// enabled" scenario.
		let spawn_cmd = if cfg!(windows) {
			"$psi = New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName = 'ping.exe'; \
			 $psi.Arguments = '-n 30 127.0.0.1'; $psi.UseShellExecute = $false; \
			 [void][System.Diagnostics.Process]::Start($psi); 'spawner-done'"
		} else {
			"$psi = New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName = '/bin/sleep'; \
			 $psi.Arguments = '30'; $psi.UseShellExecute = $false; \
			 [void][System.Diagnostics.Process]::Start($psi); 'spawner-done'"
		};
		let (out, _) = run_cmd(&host, spawn_cmd, task::CancelToken::default()).await;
		assert!(out.contains("spawner-done"), "spawner returns without waiting: {out:?}");

		// Kill the sidecar from inside a separate exec. Bound the wait
		// generously above ordinary IPC/process teardown latency but far
		// below the 30s the orphaned child survives for -- if EOF were
		// hidden behind that child's still-open handle duplicate, this
		// would time out instead of detecting death promptly.
		let (chunk_tx, _chunk_rx) = mpsc::channel::<String>(super::CHUNK_QUEUE_CHUNKS);
		let result = tokio::time::timeout(
			Duration::from_secs(10),
			host.core.exec(
				"[Environment]::Exit(3)".to_string(),
				None,
				None,
				200,
				task::CancelToken::default(),
				chunk_tx,
			),
		)
		.await;
		assert!(
			result.is_ok(),
			"host death must be detected within 10s even with a long-lived child holding inherited \
			 handles -- a hidden EOF would stall this until the child's own 30s lifetime ends"
		);
		assert!(result.unwrap().is_err(), "host death mid-exec surfaces as an error");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn kills_host_when_stop_is_not_acknowledged() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		// [Thread]::Sleep blocks inside .NET, so BeginStop cannot interrupt it:
		// no done frame arrives, and the stop-ack timeout must kill the sidecar
		// instead of handing a wedged runspace back for reuse.
		let started = std::time::Instant::now();
		let (_, res) = run_cmd(
			&host,
			"[System.Threading.Thread]::Sleep(60000)",
			task::CancelToken::new(Some(500), None),
		)
		.await;
		assert!(res.timed_out, "wedged pipeline reports timed_out");
		assert!(res.had_errors, "unacknowledged stop is a failed run");
		assert!(started.elapsed() < Duration::from_secs(20), "kill path returns promptly");
		assert!(!host.alive(), "sidecar is dead after an unacknowledged stop");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn surfaces_warning_host_and_verbose_streams() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		// Write-Host -> Information stream (previously dropped); surfaced verbatim.
		let (out, res) = run_cmd(&host, "Write-Host 'host-line'", task::CancelToken::default()).await;
		assert!(out.contains("host-line"), "Write-Host output captured: {out:?}");
		assert!(!res.had_errors, "Write-Host is not an error");

		// Write-Warning -> Warning stream, labeled, and not a failure.
		let (out, res) =
			run_cmd(&host, "Write-Warning 'be-careful'", task::CancelToken::default()).await;
		assert!(out.contains("WARNING: be-careful"), "warning labeled: {out:?}");
		assert!(!res.had_errors, "warning does not set had_errors");

		// Direct Console.Out writes are buffered at startup redirection, never
		// spliced into the framed protocol stream: the host survives and the
		// text surfaces as ordinary output.
		let (out, res) = run_cmd(
			&host,
			"[Console]::WriteLine('console-direct'); 'pipeline-ok'",
			task::CancelToken::default(),
		)
		.await;
		assert!(out.contains("console-direct"), "Console.Out captured: {out:?}");
		assert!(out.contains("pipeline-ok"), "pipeline output intact: {out:?}");
		assert!(!res.had_errors, "Console.Out write is not an error");

		// Verbose is captured only when the command opts in via -Verbose.
		let (quiet, _) = run_cmd(&host, "Write-Verbose 'hidden'", task::CancelToken::default()).await;
		assert!(!quiet.contains("hidden"), "verbose suppressed by default: {quiet:?}");
		let (loud, _) =
			run_cmd(&host, "Write-Verbose 'shown' -Verbose", task::CancelToken::default()).await;
		assert!(loud.contains("VERBOSE: shown"), "verbose labeled when opted in: {loud:?}");

		host.dispose().await.expect("host disposes");
	}

	/// A child spawned outside PowerShell's pipeline with inherited stderr
	/// (e.g. .NET ProcessStartInfo with RedirectStandardError = false) writes
	/// directly to the sidecar's own real OS stderr pipe — untouched by the
	/// bootstrap's stdin/stdout detach — which pump_stderr already captures
	/// into stderr_tail but nothing previously surfaced past the startup
	/// diagnostic phase. Must surface as forwarded output, and must not leak
	/// into a later, unrelated exec.
	#[tokio::test(flavor = "multi_thread")]
	async fn forwards_inherited_child_stderr_and_does_not_leak_across_execs() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		let child_args = if cfg!(windows) {
			"'cmd.exe'; '/c echo stderr-marker-xyz 1>&2'"
		} else {
			"'/bin/sh'; '-c'; 'echo stderr-marker-xyz >&2'"
		};
		let cmd = format!(
			"$args = @({child_args}); $psi = New-Object System.Diagnostics.ProcessStartInfo; \
			 $psi.FileName = $args[0]; if ($args.Count -gt 2) {{ $psi.ArgumentList.Add($args[1]); \
			 $psi.ArgumentList.Add($args[2]) }} else {{ $psi.Arguments = $args[1] }}; \
			 $psi.UseShellExecute = $false; $psi.RedirectStandardError = $false; $p = \
			 [System.Diagnostics.Process]::Start($psi); $p.WaitForExit(); 'pipeline-still-ok'"
		);
		let (out, res) = run_cmd(&host, &cmd, task::CancelToken::default()).await;
		assert!(out.contains("stderr-marker-xyz"), "inherited child stderr forwarded: {out:?}");
		assert!(out.contains("[external process stderr]"), "forwarded content is labeled: {out:?}");
		assert!(out.contains("pipeline-still-ok"), "pipeline's own output intact: {out:?}");
		assert!(
			!res.had_errors,
			"inherited stderr alone does not flip had_errors (avoids false positives from benign \
			 stderr loggers)"
		);

		// A later, unrelated exec must not see the previous exec's forwarded
		// stderr content (take-and-clear must not leak across execs).
		let (out2, _) = run_cmd(&host, "'clean-second-run'", task::CancelToken::default()).await;
		assert!(
			!out2.contains("stderr-marker-xyz"),
			"no stale stderr leaks into a later exec: {out2:?}"
		);

		host.dispose().await.expect("host disposes");
	}

	/// End-to-end wiring: `HostCore::sync_stderr()` round-trips through the
	/// real channel to a real `pump_stderr` task and gets an ack only after
	/// the pump has drained everything currently buffered — proving the
	/// production code path `exec()` uses (not just the underlying
	/// primitive) delivers bytes without an explicit sleep/yield in the
	/// caller.
	#[tokio::test(flavor = "multi_thread")]
	async fn sync_stderr_rendezvous_drains_the_real_pump_task() {
		let host = test_host();
		let core = std::sync::Arc::clone(&host.core);

		let mut cmd = if cfg!(windows) {
			let mut c = tokio::process::Command::new("cmd.exe");
			c.args(["/c", "echo rendezvous-marker 1>&2"]);
			c
		} else {
			let mut c = tokio::process::Command::new("/bin/sh");
			c.args(["-c", "echo rendezvous-marker >&2"]);
			c
		};
		let mut child = cmd
			.stderr(std::process::Stdio::piped())
			.spawn()
			.expect("spawn stderr-writing child");
		let stderr = child.stderr.take().expect("child stderr piped");

		let (sync_tx, sync_rx) = mpsc::unbounded_channel();
		*core.stderr_sync_tx.lock() = Some(sync_tx);
		let pump = tokio::spawn(super::pump_stderr(stderr, std::sync::Arc::clone(&core), sync_rx));

		child.wait().await.expect("child exits");
		core.sync_stderr().await;
		let tail = core.stderr_tail.lock().clone();
		assert!(
			tail.contains("rendezvous-marker"),
			"sync_stderr()'s ack must not arrive until the pump has drained buffered bytes: {tail:?}"
		);

		pump.abort();
	}

	/// A command can leave a detached background child running when it
	/// returns (e.g. `Start-Process`/`ProcessStartInfo` without waiting).
	/// `dispose()`'s `terminate_tree` call bails out immediately whenever the
	/// root process isn't `Running` — so if the sidecar's own graceful `exit`
	/// completes within the wait window (the common case: `Exit` just ends
	/// the read loop, it never waits on unrelated children), that early
	/// return previously skipped tree cleanup entirely and the background
	/// child leaked forever. `dispose()` must reap it directly in that path.
	#[tokio::test(flavor = "multi_thread")]
	async fn dispose_reaps_a_background_child_even_when_the_root_exits_cleanly() {
		if !pwsh_available() {
			eprintln!("skipping pshost test: pwsh not found on PATH");
			return;
		}

		let host = test_host();
		host.start().await.expect("host starts");

		let child_args = if cfg!(windows) {
			"'ping.exe'; '-n'; '30'; '127.0.0.1'"
		} else {
			"'/bin/sleep'; '30'"
		};
		let spawn_cmd = format!(
			"$args = @({child_args}); $psi = New-Object System.Diagnostics.ProcessStartInfo; \
			 $psi.FileName = $args[0]; $psi.ArgumentList.Add($args[1]); if ($args.Count -gt 2) {{ \
			 $psi.ArgumentList.Add($args[2]); $psi.ArgumentList.Add($args[3]) }}; \
			 $psi.UseShellExecute = $false; $p = [System.Diagnostics.Process]::Start($psi); \
			 \"child-pid:$($p.Id)\""
		);
		let (out, _) = run_cmd(&host, &spawn_cmd, task::CancelToken::default()).await;
		let pid: i32 = out
			.lines()
			.find_map(|line| line.trim().strip_prefix("child-pid:"))
			.and_then(|s| s.trim().parse().ok())
			.unwrap_or_else(|| panic!("child pid printed: {out:?}"));

		let is_running = |pid: i32| {
			super::core_process::Process::from_pid(pid)
				.is_some_and(|p| matches!(p.status(), super::core_process::ProcessStatus::Running))
		};
		assert!(is_running(pid), "background child is alive before dispose (pid {pid})");

		host.dispose().await.expect("host disposes");

		// terminate_tree's hard wave has its own internal wait; poll briefly
		// rather than asserting instantaneously to avoid a flaky race against
		// OS process-table teardown latency.
		let mut reaped = false;
		for _ in 0..20 {
			if !is_running(pid) {
				reaped = true;
				break;
			}
			tokio::time::sleep(Duration::from_millis(100)).await;
		}
		assert!(
			reaped,
			"dispose() must reap a background child even when the root exits cleanly (pid {pid})"
		);
	}
}
