//! Cross-platform, non-blocking advisory file locks.
//!
//! The lock path is a permanent coordination inode: this module creates it
//! with owner-only permissions when absent, but never truncates, renames, or
//! removes it. Ownership lives only in the open operating-system handle, so it
//! is released by [`AdvisoryLock::release`], the N-API object finalizer, or the
//! kernel when the process exits unexpectedly.

use std::{io, path::Path};

use napi::{Error, Result};
use napi_derive::napi;

enum TryAcquire {
	Acquired(platform::Lock),
	Busy,
}

/// An exclusive advisory lock held by an open native file handle.
///
/// Use [`AdvisoryLock::try_acquire`] for synchronous, non-blocking acquisition.
/// A returned `None` means another process or handle currently owns the lock;
/// path validation and I/O failures are reported as exceptions instead.
#[napi]
pub struct AdvisoryLock {
	inner: Option<platform::Lock>,
}

#[napi]
#[allow(clippy::use_self, reason = "napi return types must name the exported class")]
impl AdvisoryLock {
	/// Try to acquire an exclusive advisory lock without waiting.
	///
	/// The path must name a regular file (or be absent so one can be created).
	/// Returns `null` only when the lock is already held.
	#[napi]
	pub fn try_acquire(path: String) -> Result<Option<AdvisoryLock>> {
		match platform::try_acquire(Path::new(&path)).map_err(lock_error)? {
			TryAcquire::Acquired(inner) => Ok(Some(Self { inner: Some(inner) })),
			TryAcquire::Busy => Ok(None),
		}
	}

	/// Release this lock. Safe to call more than once.
	#[napi]
	pub fn release(&mut self) {
		if let Some(mut inner) = self.inner.take() {
			// Closing the owned handle releases the lock even if the explicit unlock
			// reports an error. There is no useful caller recovery, so `release()` is
			// deliberately idempotent and non-throwing for `finally` blocks.
			let _ = inner.release();
		}
	}
}

impl Drop for AdvisoryLock {
	fn drop(&mut self) {
		if let Some(mut inner) = self.inner.take() {
			let _ = inner.release();
		}
	}
}

fn lock_error(error: io::Error) -> Error {
	Error::from_reason(format!("Failed to acquire advisory lock: {error}"))
}

#[cfg(unix)]
mod platform {
	use std::{
		ffi::CString,
		fs::File,
		io,
		os::{
			fd::{AsRawFd, FromRawFd},
			unix::ffi::OsStrExt,
		},
		path::Path,
	};

	use super::TryAcquire;

	pub struct Lock {
		file:   File,
		locked: bool,
	}

	impl Lock {
		pub fn release(&mut self) -> io::Result<()> {
			if !self.locked {
				return Ok(());
			}
			// SAFETY: `self.file` owns a live file descriptor and `LOCK_UN` only
			// releases this handle's advisory lock.
			if unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) } != 0 {
				return Err(io::Error::last_os_error());
			}
			self.locked = false;
			Ok(())
		}
	}

	impl Drop for Lock {
		fn drop(&mut self) {
			let _ = self.release();
		}
	}

	fn validate_guard_security(
		owner_uid: u64,
		permission_bits: u64,
		effective_uid: u64,
	) -> io::Result<()> {
		if owner_uid != effective_uid {
			return Err(io::Error::new(
				io::ErrorKind::PermissionDenied,
				"advisory lock path is not owned by the current effective user",
			));
		}
		if permission_bits != 0o600 {
			return Err(io::Error::new(
				io::ErrorKind::PermissionDenied,
				"advisory lock path permissions must be exactly 0600",
			));
		}
		Ok(())
	}

	pub fn try_acquire(path: &Path) -> io::Result<TryAcquire> {
		let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
			io::Error::new(io::ErrorKind::InvalidInput, "lock path contains a NUL byte")
		})?;
		let common_flags = libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
		// First attempt an exclusive create so we know whether owner-only mode must
		// be applied independent of the caller's umask. If the permanent inode
		// already exists, reopen it without create or truncate semantics.
		let (fd, created) = {
			// SAFETY: `path` is NUL-terminated and the mode argument is present for
			// `O_CREAT`. A successful descriptor is immediately moved into `File`.
			let created_fd = unsafe {
				libc::open(
					path.as_ptr(),
					common_flags | libc::O_CREAT | libc::O_EXCL,
					libc::S_IRUSR | libc::S_IWUSR,
				)
			};
			if created_fd >= 0 {
				(created_fd, true)
			} else {
				let create_error = io::Error::last_os_error();
				if create_error.raw_os_error() != Some(libc::EEXIST) {
					return Err(create_error);
				}
				// SAFETY: `path` is NUL-terminated. `O_NOFOLLOW` prevents a final
				// symlink from redirecting this open to another inode.
				let existing_fd = unsafe { libc::open(path.as_ptr(), common_flags) };
				if existing_fd < 0 {
					return Err(io::Error::last_os_error());
				}
				(existing_fd, false)
			}
		};
		// SAFETY: `fd` is uniquely owned after a successful `open` above.
		let file = unsafe { File::from_raw_fd(fd) };

		if created {
			// `open(..., 0600)` is filtered by umask. Set the exact owner-only mode
			// through the already-open, no-follow descriptor.
			// SAFETY: `file` owns a live descriptor and 0600 contains only valid
			// permission bits.
			if unsafe { libc::fchmod(file.as_raw_fd(), libc::S_IRUSR | libc::S_IWUSR) } != 0 {
				return Err(io::Error::last_os_error());
			}
		}

		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `stat` points to writable storage and `file` owns a live fd.
		if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: successful `fstat` initialized the entire structure.
		let stat = unsafe { stat.assume_init() };
		if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"advisory lock path is not a regular file",
			));
		}
		// Existing guard inodes are trust boundaries. Never repair an inode that
		// another user created or made group/world-accessible: only the exclusive
		// creator path above may normalize permissions. Validate through the open
		// no-follow descriptor so a pathname swap cannot change what is checked.
		// SAFETY: `geteuid` has no preconditions and only reads process credentials.
		let effective_uid = unsafe { libc::geteuid() };
		validate_guard_security(
			u64::from(stat.st_uid),
			u64::from(stat.st_mode) & 0o7777,
			u64::from(effective_uid),
		)?;

		// `LOCK_NB` is the contract that keeps this synchronous N-API method from
		// ever parking the JavaScript thread behind another owner.
		// SAFETY: `file` owns a live descriptor and the flags are valid for flock.
		if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
			let error = io::Error::last_os_error();
			if matches!(error.raw_os_error(), Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN)
			{
				return Ok(TryAcquire::Busy);
			}
			return Err(error);
		}

		Ok(TryAcquire::Acquired(Lock { file, locked: true }))
	}

	#[cfg(test)]
	mod tests {
		use super::validate_guard_security;

		#[test]
		fn rejects_foreign_owner_and_non_private_modes() {
			assert!(validate_guard_security(1000, 0o600, 1001).is_err());
			for mode in [0o400, 0o600 | 0o040, 0o600 | 0o004, 0o4600] {
				assert!(validate_guard_security(1000, mode, 1000).is_err(), "mode {mode:o}");
			}
			assert!(validate_guard_security(1000, 0o600, 1000).is_ok());
		}
	}
}

#[cfg(windows)]
mod platform {
	use std::{
		fs::File,
		io,
		os::windows::{
			ffi::OsStrExt,
			io::{AsRawHandle, FromRawHandle},
		},
		path::Path,
		ptr,
	};

	use windows_sys::Win32::{
		Foundation::{
			CloseHandle, ERROR_IO_PENDING, ERROR_LOCK_VIOLATION, GENERIC_READ, GENERIC_WRITE,
			INVALID_HANDLE_VALUE,
		},
		Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
			FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
			FILE_SHARE_WRITE, GetFileInformationByHandle, LOCKFILE_EXCLUSIVE_LOCK,
			LOCKFILE_FAIL_IMMEDIATELY, LockFileEx, OPEN_ALWAYS, UnlockFileEx,
		},
		System::IO::OVERLAPPED,
	};

	use super::TryAcquire;

	// A single byte is sufficient because every participant uses this primitive
	// and the permanent guard file has no data protocol of its own.
	const LOCK_RANGE_LOW: u32 = 1;
	const LOCK_RANGE_HIGH: u32 = 0;

	pub struct Lock {
		file:   File,
		locked: bool,
	}

	impl Lock {
		pub fn release(&mut self) -> io::Result<()> {
			if !self.locked {
				return Ok(());
			}
			let mut overlapped = OVERLAPPED::default();
			// SAFETY: `self.file` owns a live Windows file handle, `overlapped`
			// describes offset zero for the same byte range used at acquisition, and
			// this handle owns that exclusive lock while `self.locked` is true.
			if unsafe {
				UnlockFileEx(
					self.file.as_raw_handle().cast(),
					0,
					LOCK_RANGE_LOW,
					LOCK_RANGE_HIGH,
					&raw mut overlapped,
				)
			} == 0
			{
				return Err(io::Error::last_os_error());
			}
			self.locked = false;
			Ok(())
		}
	}

	impl Drop for Lock {
		fn drop(&mut self) {
			let _ = self.release();
		}
	}

	pub fn try_acquire(path: &Path) -> io::Result<TryAcquire> {
		let mut path: Vec<u16> = path.as_os_str().encode_wide().collect();
		if path.contains(&0) {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "lock path contains a NUL byte"));
		}
		path.push(0);

		// No `FILE_SHARE_DELETE`: Windows keeps the permanent guard file at this
		// path for the full handle lifetime, preventing rename/unlink split-brain.
		// `FILE_FLAG_OPEN_REPARSE_POINT` opens a final reparse point itself so it
		// can be rejected below rather than followed.
		// SAFETY: `path` is NUL-terminated, the security/template pointers are
		// null, and a successful handle is moved into `File` exactly once.
		let handle = unsafe {
			CreateFileW(
				path.as_ptr(),
				GENERIC_READ | GENERIC_WRITE,
				FILE_SHARE_READ | FILE_SHARE_WRITE,
				ptr::null(),
				OPEN_ALWAYS,
				FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
				ptr::null_mut(),
			)
		};
		if handle == INVALID_HANDLE_VALUE {
			return Err(io::Error::last_os_error());
		}
		// Convert only after validation so every early-return path closes the raw
		// handle, including rejected directories and reparse points.
		struct PendingHandle(windows_sys::Win32::Foundation::HANDLE);
		impl Drop for PendingHandle {
			fn drop(&mut self) {
				// SAFETY: this wrapper uniquely owns the successful CreateFileW handle.
				let _ = unsafe { CloseHandle(self.0) };
			}
		}
		let handle = PendingHandle(handle);
		let mut info = BY_HANDLE_FILE_INFORMATION::default();
		// SAFETY: `handle` is live and `info` is writable output storage.
		if unsafe { GetFileInformationByHandle(handle.0, &raw mut info) } == 0 {
			return Err(io::Error::last_os_error());
		}
		if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"advisory lock path is a directory or reparse point",
			));
		}

		let mut overlapped = OVERLAPPED::default();
		// `LOCKFILE_FAIL_IMMEDIATELY` guarantees this call does not wait behind an
		// existing owner on the JavaScript thread.
		// SAFETY: `handle` is a live disk-file handle and `overlapped` describes
		// offset zero for the requested range.
		if unsafe {
			LockFileEx(
				handle.0,
				LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
				0,
				LOCK_RANGE_LOW,
				LOCK_RANGE_HIGH,
				&raw mut overlapped,
			)
		} == 0
		{
			let error = io::Error::last_os_error();
			if matches!(error.raw_os_error(), Some(code) if code as u32 == ERROR_LOCK_VIOLATION || code as u32 == ERROR_IO_PENDING)
			{
				return Ok(TryAcquire::Busy);
			}
			return Err(error);
		}

		let raw = handle.0;
		std::mem::forget(handle);
		// SAFETY: ownership was removed from `PendingHandle` above and is moved
		// exactly once into `File` here.
		let file = unsafe { File::from_raw_handle(raw.cast()) };
		Ok(TryAcquire::Acquired(Lock { file, locked: true }))
	}
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::PathBuf,
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::AdvisoryLock;

	static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

	struct Fixture {
		root: PathBuf,
	}

	impl Fixture {
		fn new() -> Self {
			let nonce = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
			let now = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system clock predates epoch")
				.as_nanos();
			let root = std::env::temp_dir()
				.join(format!("pi-advisory-lock-{}-{now}-{nonce}", std::process::id()));
			fs::create_dir(&root).expect("create fixture directory");
			Self { root }
		}

		fn path(&self, name: &str) -> PathBuf {
			self.root.join(name)
		}
	}

	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	#[test]
	fn contention_is_nonblocking_and_release_is_idempotent() {
		let fixture = Fixture::new();
		let path = fixture.path("session.guard");
		let mut first = AdvisoryLock::try_acquire(path.to_string_lossy().into_owned())
			.expect("first acquisition")
			.expect("lock should be available");
		assert!(
			AdvisoryLock::try_acquire(path.to_string_lossy().into_owned())
				.expect("contended acquisition")
				.is_none(),
			"contended acquisition must return None"
		);
		first.release();
		first.release();
		let _next = AdvisoryLock::try_acquire(path.to_string_lossy().into_owned())
			.expect("acquisition after release")
			.expect("released lock should be available");
		assert!(path.is_file(), "guard path remains a stable regular file");
	}

	#[cfg(unix)]
	#[test]
	fn created_file_is_owner_only_and_final_symlink_is_rejected() {
		use std::os::unix::fs::{MetadataExt, symlink};

		let fixture = Fixture::new();
		let path = fixture.path("mode.guard");
		let _lock = AdvisoryLock::try_acquire(path.to_string_lossy().into_owned())
			.expect("acquire new guard")
			.expect("new guard should be available");
		assert_eq!(fs::metadata(&path).expect("guard metadata").mode() & 0o777, 0o600);

		let target = fixture.path("target.guard");
		fs::write(&target, []).expect("create symlink target");
		let link = fixture.path("link.guard");
		symlink(&target, &link).expect("create symlink");
		let error = AdvisoryLock::try_acquire(link.to_string_lossy().into_owned())
			.err()
			.expect("final symlink must be rejected");
		assert!(error.to_string().contains("advisory lock"));
	}

	#[cfg(unix)]
	#[test]
	fn permissive_existing_file_is_rejected_without_normalization() {
		use std::os::unix::fs::{MetadataExt, PermissionsExt};

		let fixture = Fixture::new();
		let path = fixture.path("permissive.guard");
		fs::write(&path, []).expect("create existing guard");
		fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).expect("make guard permissive");

		let error = AdvisoryLock::try_acquire(path.to_string_lossy().into_owned())
			.err()
			.expect("permissive existing guard must be rejected");
		assert!(error.to_string().contains("0600"));
		assert_eq!(fs::metadata(&path).expect("guard metadata").mode() & 0o777, 0o640);
	}

	#[test]
	fn directory_is_rejected() {
		let fixture = Fixture::new();
		assert!(AdvisoryLock::try_acquire(fixture.root.to_string_lossy().into_owned()).is_err());
	}
}
