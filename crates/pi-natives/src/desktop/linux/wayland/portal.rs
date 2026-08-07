use std::sync::LazyLock;
#[cfg(feature = "wayland-pipewire")]
use std::{fs, path::PathBuf};

use tokio::runtime::{Builder, Runtime};

use crate::desktop::error::{CoreResult, DesktopError};

/// Process-wide Tokio runtime shared by every xdg-desktop-portal call.
///
/// `ashpd` caches a process-global D-Bus connection whose I/O tasks are bound
/// to the runtime that first creates it. A long-lived multi-thread runtime
/// keeps that connection alive and drives it while portal callers block.
static PORTAL_RUNTIME: LazyLock<Result<Runtime, String>> = LazyLock::new(|| {
	Builder::new_multi_thread()
		.worker_threads(1)
		.enable_all()
		.build()
		.map_err(|err| err.to_string())
});

/// Borrow the shared portal runtime, surfacing a one-time build failure.
pub(super) fn portal_runtime() -> CoreResult<&'static Runtime> {
	PORTAL_RUNTIME
		.as_ref()
		.map_err(|err| DesktopError::internal(format!("xdg-desktop-portal runtime: {err}")))
}

#[cfg(feature = "wayland-pipewire")]
fn token_path(name: &str) -> Option<PathBuf> {
	let base = std::env::var_os("XDG_STATE_HOME")
		.map(PathBuf::from)
		.or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))?;
	Some(base.join("omp").join(name))
}

#[cfg(feature = "wayland-pipewire")]
pub(super) fn read_token(name: &str) -> Option<String> {
	fs::read_to_string(token_path(name)?)
		.ok()
		.map(|token| token.trim().to_string())
		.filter(|token| !token.is_empty())
}

#[cfg(feature = "wayland-pipewire")]
pub(super) fn store_token(name: &str, token: Option<&str>) {
	let (Some(path), Some(token)) = (token_path(name), token) else {
		return;
	};
	let Some(parent) = path.parent() else {
		return;
	};
	if fs::create_dir_all(parent).is_ok() {
		let _ = fs::write(path, token);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Every portal caller (libei input init and PipeWire capture) must borrow
	/// one persistent runtime; a regression to per-call runtimes would return
	/// distinct instances and re-open the orphaned-connection bug (#7886).
	#[test]
	fn portal_runtime_is_shared_across_calls() {
		let first = portal_runtime().expect("portal runtime builds");
		let second = portal_runtime().expect("portal runtime builds");
		assert!(
			std::ptr::eq(first, second),
			"portal_runtime must hand back one long-lived runtime, not a fresh per-call instance"
		);
	}
}
