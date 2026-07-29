//! Cross-platform power assertions for preventing idle sleep.
//!
//! Exposes a small N-API handle that acquires the platform's sleep-inhibition
//! primitive on construction and releases it on `stop()`/drop. Unsupported
//! platforms retain a no-op handle so higher layers can use one code path.

use napi_derive::napi;

/// Options for starting a power assertion.
///
/// Each boolean maps to a `caffeinate(8)` flag and the closest corresponding
/// platform capability. Multiple flags can be combined; when set, one
/// assertion is taken per flag and all are released together when the
/// handle is stopped or dropped.
///
/// If every flag is unset (or omitted), the handle behaves as if `idle`
/// were `true` — preserving the historical default of `caffeinate -i`.
#[napi(object, js_name = "PowerAssertionOptions")]
pub struct PowerAssertionOptions {
	/// Human-readable reason shown in platform power diagnostics.
	pub reason:  Option<String>,
	/// `caffeinate -i`: prevent the system from idle-sleeping.
	pub idle:    Option<bool>,
	/// `caffeinate -s`: prevent the system from sleeping (AC power only).
	pub system:  Option<bool>,
	/// `caffeinate -u`: declare the user is active (wakes the display).
	pub user:    Option<bool>,
	/// `caffeinate -d`: prevent the display from idle-sleeping.
	pub display: Option<bool>,
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		ffi::{CString, c_char, c_void},
		ptr,
	};

	use napi::{Error, Result};

	const UTF8_ENCODING: u32 = 0x0800_0100;
	const ASSERTION_LEVEL_ON: u32 = 255;
	const ASSERTION_ID_NONE: u32 = 0;
	const PREVENT_USER_IDLE_SYSTEM_SLEEP: &str = "PreventUserIdleSystemSleep";
	const PREVENT_SYSTEM_SLEEP: &str = "PreventSystemSleep";
	const PREVENT_USER_IDLE_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";
	const USER_IS_ACTIVE: &str = "UserIsActive";

	/// Variants this module knows how to acquire. Mirrors the `caffeinate(8)`
	/// flag set the public API exposes (`-i`, `-s`, `-u`, `-d`).
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub enum AssertionKind {
		PreventIdleSystemSleep,
		PreventSystemSleep,
		DeclareUserActive,
		PreventDisplaySleep,
	}

	impl AssertionKind {
		const fn iokit_name(self) -> &'static str {
			match self {
				Self::PreventIdleSystemSleep => PREVENT_USER_IDLE_SYSTEM_SLEEP,
				Self::PreventSystemSleep => PREVENT_SYSTEM_SLEEP,
				Self::DeclareUserActive => USER_IS_ACTIVE,
				Self::PreventDisplaySleep => PREVENT_USER_IDLE_DISPLAY_SLEEP,
			}
		}
	}

	type CFStringRef = *const c_void;
	type CFTypeRef = *const c_void;
	type IOPMAssertionID = u32;
	type IOPMAssertionLevel = u32;
	type IOReturn = i32;

	#[link(name = "CoreFoundation", kind = "framework")]
	unsafe extern "C" {
		fn CFStringCreateWithCString(
			alloc: *const c_void,
			c_str: *const c_char,
			encoding: u32,
		) -> CFStringRef;
		fn CFRelease(value: CFTypeRef);
	}

	#[link(name = "IOKit", kind = "framework")]
	unsafe extern "C" {
		fn IOPMAssertionCreateWithName(
			assertion_type: CFStringRef,
			assertion_level: IOPMAssertionLevel,
			assertion_name: CFStringRef,
			assertion_id: *mut IOPMAssertionID,
		) -> IOReturn;
		fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
	}

	struct CfString(CFStringRef);

	impl CfString {
		fn new(value: &str) -> Result<Self> {
			let c_string = CString::new(value).map_err(|_| {
				Error::from_reason("Power assertion strings must not contain NUL bytes")
			})?;
			// SAFETY: `c_string` is a valid, NUL-terminated UTF-8 byte sequence for the
			// duration of the call, and CoreFoundation copies the contents into a new
			// `CFString` when creation succeeds.
			let string_ref =
				unsafe { CFStringCreateWithCString(ptr::null(), c_string.as_ptr(), UTF8_ENCODING) };
			if string_ref.is_null() {
				return Err(Error::from_reason(
					"Failed to allocate CoreFoundation string for power assertion",
				));
			}
			Ok(Self(string_ref))
		}

		const fn as_ptr(&self) -> CFStringRef {
			self.0
		}
	}

	impl Drop for CfString {
		fn drop(&mut self) {
			if self.0.is_null() {
				return;
			}
			// SAFETY: `self.0` was returned by `CFStringCreateWithCString` in
			// `CfString::new` and this wrapper owns the single outstanding reference, so
			// releasing it here balances creation exactly once.
			unsafe { CFRelease(self.0) };
		}
	}

	pub struct AssertionInner {
		assertion_id: IOPMAssertionID,
	}

	impl AssertionInner {
		pub fn start(kind: AssertionKind, reason: &str) -> Result<Self> {
			let assertion_type = CfString::new(kind.iokit_name())?;
			let assertion_reason = CfString::new(reason)?;
			let mut assertion_id = ASSERTION_ID_NONE;
			// SAFETY: both `CFStringRef` values are valid live CoreFoundation strings owned
			// by this stack frame, `ASSERTION_LEVEL_ON` is the documented enabled value,
			// and `assertion_id` points to writable storage for the returned identifier.
			let status = unsafe {
				IOPMAssertionCreateWithName(
					assertion_type.as_ptr(),
					ASSERTION_LEVEL_ON,
					assertion_reason.as_ptr(),
					&mut assertion_id,
				)
			};
			if status != 0 {
				return Err(Error::from_reason(format!(
					"Failed to acquire macOS power assertion {kind:?} (IOReturn={status})"
				)));
			}
			Ok(Self { assertion_id })
		}

		pub fn stop(&mut self) -> Result<()> {
			if self.assertion_id == ASSERTION_ID_NONE {
				return Ok(());
			}
			let assertion_id = self.assertion_id;
			self.assertion_id = ASSERTION_ID_NONE;
			// SAFETY: `assertion_id` came from a successful `IOPMAssertionCreateWithName`
			// call owned by this handle, and we clear local ownership before releasing so
			// the same assertion cannot be released twice.
			let status = unsafe { IOPMAssertionRelease(assertion_id) };
			if status != 0 {
				return Err(Error::from_reason(format!(
					"Failed to release macOS power assertion (IOReturn={status})"
				)));
			}
			Ok(())
		}
	}

	impl Drop for AssertionInner {
		fn drop(&mut self) {
			let _ = self.stop();
		}
	}
}

#[cfg(target_os = "linux")]
mod platform {
	use log::debug;
	use napi::{Error, Result};
	use parking_lot::Mutex;
	use zbus::{blocking::Connection, zvariant::OwnedFd};

	const LOGIN1_DESTINATION: &str = "org.freedesktop.login1";
	const LOGIN1_PATH: &str = "/org/freedesktop/login1";
	const LOGIN1_MANAGER: &str = "org.freedesktop.login1.Manager";
	const INHIBIT_MODE: &str = "block";
	const INHIBIT_WHO: &str = "Oh My Pi";

	// The connection owns the D-Bus transport, while each assertion owns only its
	// inhibitor fd. Reuse a healthy transport so a new assertion does not
	// synchronously reconnect from the JavaScript thread; a failed call clears it
	// for the next acquisition to reconnect.
	static SYSTEM_BUS: Mutex<Option<Connection>> = Mutex::new(None);

	/// Holds login1's inhibitor descriptor. Closing it releases the inhibit.
	pub struct AssertionInner {
		inhibitor: Option<OwnedFd>,
	}

	impl AssertionInner {
		pub fn try_start(what: &str, reason: &str) -> Option<Self> {
			match Self::start(what, reason) {
				Ok(inner) => Some(inner),
				Err(error) => {
					debug!("Unable to acquire login1 sleep inhibitor: {error}");
					None
				},
			}
		}

		fn start(what: &str, reason: &str) -> Result<Self> {
			let mut system_bus = SYSTEM_BUS.lock();
			let connection = system_bus.get_or_insert(Connection::system().map_err(|error| {
				Error::from_reason(format!("Unable to connect to the system bus: {error}"))
			})?);
			let reply = match connection.call_method(
				Some(LOGIN1_DESTINATION),
				LOGIN1_PATH,
				Some(LOGIN1_MANAGER),
				"Inhibit",
				&(what, INHIBIT_WHO, reason, INHIBIT_MODE),
			) {
				Ok(reply) => reply,
				Err(error) => {
					*system_bus = None;
					return Err(Error::from_reason(format!("login1 Inhibit failed: {error}")));
				},
			};
			let inhibitor = reply.body().deserialize::<OwnedFd>().map_err(|error| {
				Error::from_reason(format!("Invalid login1 inhibitor response: {error}"))
			})?;
			Ok(Self { inhibitor: Some(inhibitor) })
		}

		pub fn stop(&mut self) {
			self.inhibitor.take();
		}
	}

	impl Drop for AssertionInner {
		fn drop(&mut self) {
			self.stop();
		}
	}
}

#[cfg(target_os = "windows")]
mod platform {
	use std::{
		sync::mpsc::{self, Sender},
		thread::{self, JoinHandle},
	};

	use napi::{Error, Result};
	use windows_sys::Win32::System::Power::{
		ES_CONTINUOUS, EXECUTION_STATE, SetThreadExecutionState,
	};

	pub struct AssertionInner {
		release: Option<Sender<()>>,
		worker:  Option<JoinHandle<()>>,
	}

	impl AssertionInner {
		pub fn start(flags: EXECUTION_STATE) -> Result<Self> {
			let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
			let (release, release_receiver) = mpsc::channel();
			// SetThreadExecutionState is thread-affine: acquire and release must happen
			// on the same dedicated thread for the full lifetime of this handle.
			let worker = thread::spawn(move || {
				// SAFETY: `flags` contains only documented `EXECUTION_STATE` bits.
				let result = unsafe { SetThreadExecutionState(flags) };
				let acquired = result != 0;
				let _ = ready_sender.send(if acquired {
					Ok(())
				} else {
					Err(std::io::Error::last_os_error().to_string())
				});
				if !acquired {
					return;
				}
				let _ = release_receiver.recv();
				// SAFETY: this is the same dedicated thread that acquired the state.
				unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
			});
			match ready_receiver.recv() {
				Ok(Ok(())) => Ok(Self { release: Some(release), worker: Some(worker) }),
				Ok(Err(error)) => {
					let _ = worker.join();
					Err(Error::from_reason(format!(
						"Failed to acquire Windows power assertion: {error}"
					)))
				},
				Err(error) => {
					let _ = worker.join();
					Err(Error::from_reason(format!(
						"Windows power assertion worker exited before initialization: {error}"
					)))
				},
			}
		}

		pub fn stop(&mut self) {
			if let Some(release) = self.release.take() {
				let _ = release.send(());
			}
			if let Some(worker) = self.worker.take() {
				let _ = worker.join();
			}
		}
	}

	impl Drop for AssertionInner {
		fn drop(&mut self) {
			self.stop();
		}
	}
}

/// Long-lived cross-platform power assertion.
///
/// macOS uses `IOKit`, Linux holds a login1 inhibitor file descriptor, and
/// Windows holds thread-affine execution state until the handle is stopped or
/// dropped. Other platforms return a no-op handle.
#[napi(js_name = "PowerAssertion")]
pub struct PowerAssertion {
	#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
	inners: Vec<platform::AssertionInner>,
}

#[napi]
impl PowerAssertion {
	/// Acquire a power assertion. Unsupported platforms return a no-op handle
	/// so callers can stay cross-platform.
	#[napi(factory)]
	pub fn start(options: Option<PowerAssertionOptions>) -> napi::Result<Self> {
		let reason = options
			.as_ref()
			.and_then(|value| value.reason.as_deref())
			.filter(|value| !value.trim().is_empty())
			.unwrap_or("Oh My Pi agent session");
		let idle = options.as_ref().and_then(|v| v.idle).unwrap_or(false);
		let system = options.as_ref().and_then(|v| v.system).unwrap_or(false);
		let user = options.as_ref().and_then(|v| v.user).unwrap_or(false);
		let display = options.as_ref().and_then(|v| v.display).unwrap_or(false);

		// Preserve historical default: an empty options object behaves as
		// `caffeinate -i` (prevent idle system sleep).
		let effective_idle = idle || !(system || user || display);

		#[cfg(target_os = "macos")]
		{
			let mut kinds: Vec<platform::AssertionKind> = Vec::new();
			if effective_idle {
				kinds.push(platform::AssertionKind::PreventIdleSystemSleep);
			}
			if system {
				kinds.push(platform::AssertionKind::PreventSystemSleep);
			}
			if user {
				kinds.push(platform::AssertionKind::DeclareUserActive);
			}
			if display {
				kinds.push(platform::AssertionKind::PreventDisplaySleep);
			}
			let mut inners: Vec<platform::AssertionInner> = Vec::with_capacity(kinds.len());
			for kind in kinds {
				inners.push(platform::AssertionInner::start(kind, reason)?);
			}
			Ok(Self { inners })
		}
		#[cfg(target_os = "linux")]
		{
			let _ = user;
			let what = match (effective_idle, system, display) {
				(true, true, true) => "idle:sleep:handle-lid-switch",
				(true, true, false) => "idle:sleep",
				(true, false, true) => "idle:handle-lid-switch",
				(true, false, false) => "idle",
				(false, true, true) => "sleep:handle-lid-switch",
				(false, true, false) => "sleep",
				(false, false, true) => "handle-lid-switch",
				(false, false, false) => return Ok(Self { inners: Vec::new() }),
			};
			let inners = platform::AssertionInner::try_start(what, reason)
				.into_iter()
				.collect();
			Ok(Self { inners })
		}
		#[cfg(target_os = "windows")]
		{
			use windows_sys::Win32::System::Power::{
				ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
			};

			let _ = user;
			let mut flags = ES_CONTINUOUS;
			if effective_idle || system {
				flags |= ES_SYSTEM_REQUIRED;
			}
			if display {
				flags |= ES_DISPLAY_REQUIRED;
			}
			Ok(Self { inners: vec![platform::AssertionInner::start(flags)?] })
		}
		#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
		{
			let _ = (reason, effective_idle, system, user, display);
			Ok(Self {})
		}
	}

	/// Release every assertion held by this handle. Safe to call multiple
	/// times; subsequent calls are a no-op.
	#[napi]
	#[allow(clippy::missing_const_for_fn, reason = "not const on supported platforms")]
	pub fn stop(&mut self) -> napi::Result<()> {
		#[cfg(target_os = "macos")]
		{
			let mut first_err: Option<napi::Error> = None;
			for mut inner in self.inners.drain(..) {
				if let Err(err) = inner.stop()
					&& first_err.is_none()
				{
					first_err = Some(err);
				}
			}
			if let Some(err) = first_err {
				return Err(err);
			}
		}
		#[cfg(any(target_os = "linux", target_os = "windows"))]
		for mut inner in self.inners.drain(..) {
			inner.stop();
		}
		Ok(())
	}
}
