//! Race-resistant file-jail operations for local desktop appserver clients.
//!
//! Unix builds keep a directory fd for the root and every traversed parent.
//! Every pathname operation is then relative to one of those stable fds; no
//! realpath-then-use check is used. Windows deliberately exposes the API with
//! an explicit `UNSUPPORTED` error until an equivalent handle-relative
//! primitive exists there.
//! Atomic replacements intentionally use mode `0600`; existing modes are not
//! preserved because the temporary is a newly-created private inode.
//! The process-wide writer mutex plus an advisory lock on the stable parent
//! directory fd linearizes writers that use this API, including across
//! processes. Arbitrary filesystem writers cannot be forced to participate in
//! advisory locking and therefore remain outside the revision protocol.

use napi::bindgen_prelude::{Buffer, Error, Result};
use napi_derive::napi;

const MAX_COMPONENT_BYTES: usize = 255;
const MAX_PATH_COMPONENTS: usize = 64;
const MAX_OPERATION_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: u64 = 100_000;
const READ_CHUNK: usize = 8 * 1024;

#[napi(object)]
pub struct SecureReadFileResult {
	pub data:            Buffer,
	pub size:            u32,
	pub revision_sha256: String,
}
#[derive(Debug)]
#[napi(object)]
pub struct SecureDirectoryEntry {
	pub name: String,
	pub path: String,
	pub kind: String,
	pub size: Option<f64>,
}

#[derive(Debug)]
#[napi(object)]
pub struct SecureListDirectoryResult {
	pub entries: Vec<SecureDirectoryEntry>,
}

#[napi(object)]
pub struct SecureWriteFileResult {
	pub size:            u32,
	pub revision_sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ErrorCode {
	UnsafePath,
	NotFound,
	NotFile,
	Conflict,
	Bounds,
	Unsupported,
	Io,
}

impl ErrorCode {
	const fn as_str(self) -> &'static str {
		match self {
			Self::UnsafePath => "UNSAFE_PATH",
			Self::NotFound => "NOT_FOUND",
			Self::NotFile => "NOT_FILE",
			Self::Conflict => "CONFLICT",
			Self::Bounds => "BOUNDS",
			Self::Unsupported => "UNSUPPORTED",
			Self::Io => "IO_ERROR",
		}
	}
}

fn native_error(code: ErrorCode) -> Error {
	Error::from_reason(format!("{}: secure file operation failed", code.as_str()))
}

fn validate_limits(max_bytes: u64) -> Result<usize> {
	if max_bytes == 0 || max_bytes > MAX_OPERATION_BYTES {
		return Err(native_error(ErrorCode::Bounds));
	}
	usize::try_from(max_bytes).map_err(|_| native_error(ErrorCode::Bounds))
}

fn validate_entries(max_entries: u64) -> Result<usize> {
	if max_entries == 0 || max_entries > MAX_DIRECTORY_ENTRIES {
		return Err(native_error(ErrorCode::Bounds));
	}
	usize::try_from(max_entries).map_err(|_| native_error(ErrorCode::Bounds))
}

fn validate_revision(revision: Option<&str>) -> Result<()> {
	if let Some(value) = revision
		&& (value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
	{
		return Err(native_error(ErrorCode::Bounds));
	}
	Ok(())
}

#[cfg(unix)]
mod unix {
	use std::{
		ffi::{CStr, CString},
		fmt::Write as _,
		os::fd::RawFd,
		sync::{LazyLock, Mutex},
	};

	use sha2::{Digest, Sha256};

	use super::*;

	struct Fd(RawFd);

	impl Fd {
		fn open_root(root: &str) -> Result<Self> {
			let root = c_string(root, ErrorCode::Io)?;
			// SAFETY: root is a valid NUL-terminated path and flags request a directory fd.
			let fd = retry_fd(|| unsafe {
				libc::open(
					root.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			})
			.map_err(|errno| errno_error(errno, false))?;
			Ok(Self(fd))
		}

		fn duplicate(&self) -> Result<Self> {
			// SAFETY: self.0 is an open fd owned by this guard.
			let fd =
				retry_fd(|| unsafe { libc::dup(self.0) }).map_err(|errno| errno_error(errno, false))?;
			Ok(Self(fd))
		}
	}
	impl Drop for Fd {
		fn drop(&mut self) {
			if self.0 >= 0 {
				// SAFETY: self.0 is owned by this guard and is closed at most once.
				let _ = unsafe { libc::close(self.0) };
			}
		}
	}

	struct Directory(*mut libc::DIR);

	impl Drop for Directory {
		fn drop(&mut self) {
			if !self.0.is_null() {
				// SAFETY: fdopendir returned this owned DIR pointer.
				unsafe { libc::closedir(self.0) };
			}
		}
	}

	struct DirectoryWriteLock(RawFd);

	impl DirectoryWriteLock {
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		fn acquire(directory: RawFd) -> Result<Self> {
			retry_rc(|| {
				// SAFETY: directory is a live directory fd held by the caller.
				unsafe { libc::flock(directory, libc::LOCK_EX) }
			})
			.map_err(|_| native_error(ErrorCode::Io))?;
			Ok(Self(directory))
		}

		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		fn acquire(_directory: RawFd) -> Result<Self> {
			Err(native_error(ErrorCode::Unsupported))
		}
	}

	impl Drop for DirectoryWriteLock {
		fn drop(&mut self) {
			#[cfg(any(target_os = "linux", target_os = "macos"))]
			loop {
				// SAFETY: the parent directory outlives this guard.
				if unsafe { libc::flock(self.0, libc::LOCK_UN) } == 0 || errno() != libc::EINTR {
					break;
				}
			}
		}
	}

	struct TempFile<'a> {
		parent:  RawFd,
		name:    CString,
		fd:      Option<Fd>,
		renamed: bool,
		_marker: std::marker::PhantomData<&'a ()>,
	}

	impl TempFile<'_> {
		fn disarm(mut self) {
			self.renamed = true;
			self.fd.take();
		}
	}

	impl Drop for TempFile<'_> {
		fn drop(&mut self) {
			if self.renamed {
				return;
			}
			// unlinkat is safe while the temporary fd is still open and makes
			// cleanup happen on every error path.
			loop {
				// SAFETY: parent and name remain valid for the guard lifetime.
				let rc = unsafe { libc::unlinkat(self.parent, self.name.as_ptr(), 0) };
				if rc == 0 || errno() != libc::EINTR {
					break;
				}
			}
		}
	}

	#[derive(Clone, Copy, Debug, Eq, PartialEq)]
	struct Signature {
		dev:        u64,
		ino:        u64,
		size:       u64,
		mtime_sec:  i64,
		mtime_nsec: i64,
		ctime_sec:  i64,
		ctime_nsec: i64,
	}

	// One process-wide lock avoids same-process flock edge cases without
	// attacker-controlled lock-map growth. DirectoryWriteLock extends the same
	// serialization contract to cooperating processes.
	static SECURE_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

	#[cfg(test)]
	fn write_test_marker(variable: &str) {
		if let Ok(path) = std::env::var(variable) {
			std::fs::write(path, b"ready").expect("write secure-fs test marker");
		}
	}

	#[cfg(test)]
	fn final_window_test_hook() {
		let (Ok(marker), Ok(release)) = (
			std::env::var("OMP_SECURE_FS_TEST_FINAL_MARKER"),
			std::env::var("OMP_SECURE_FS_TEST_FINAL_RELEASE"),
		) else {
			return;
		};
		std::fs::write(marker, b"ready").expect("write secure-fs final-window marker");
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
		while !std::path::Path::new(&release).exists() {
			assert!(
				std::time::Instant::now() < deadline,
				"timed out waiting to release secure-fs final-window hook"
			);
			std::thread::sleep(std::time::Duration::from_millis(5));
		}
	}

	fn errno() -> i32 {
		std::io::Error::last_os_error()
			.raw_os_error()
			.unwrap_or(libc::EIO)
	}

	fn clear_errno() {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		// SAFETY: libc exposes the thread-local errno slot for this process.
		unsafe {
			*libc::__errno_location() = 0;
		}
		#[cfg(target_os = "macos")]
		unsafe {
			*libc::__error() = 0;
		}
	}

	fn retry_fd<F>(mut operation: F) -> std::result::Result<RawFd, i32>
	where
		F: FnMut() -> RawFd,
	{
		loop {
			let fd = operation();
			if fd >= 0 {
				return Ok(fd);
			}
			let error = errno();
			if error != libc::EINTR {
				return Err(error);
			}
		}
	}

	fn retry_rc<F>(mut operation: F) -> std::result::Result<(), i32>
	where
		F: FnMut() -> libc::c_int,
	{
		loop {
			if operation() == 0 {
				return Ok(());
			}
			let error = errno();
			if error != libc::EINTR {
				return Err(error);
			}
		}
	}

	fn c_string(value: &str, code: ErrorCode) -> Result<CString> {
		CString::new(value.as_bytes()).map_err(|_| native_error(code))
	}

	fn errno_error(error: i32, final_component: bool) -> Error {
		let code = match error {
			libc::ELOOP => ErrorCode::UnsafePath,
			libc::ENOENT => ErrorCode::NotFound,
			libc::ENOTDIR | libc::EISDIR => ErrorCode::NotFile,
			libc::EEXIST => ErrorCode::Conflict,
			libc::EFBIG | libc::ENOSPC => ErrorCode::Bounds,
			_ if final_component && error == libc::EPERM => ErrorCode::NotFile,
			_ => ErrorCode::Io,
		};
		native_error(code)
	}

	fn parse_path(path: &str, allow_empty: bool) -> Result<Vec<CString>> {
		if path.is_empty() {
			if allow_empty {
				return Ok(Vec::new());
			}
			return Err(native_error(ErrorCode::UnsafePath));
		}
		if path.as_bytes().contains(&0)
			|| path.starts_with('/')
			|| path.contains('\\')
			|| path.contains(':')
			|| path.len() > MAX_COMPONENT_BYTES.saturating_mul(MAX_PATH_COMPONENTS)
		{
			return Err(native_error(ErrorCode::UnsafePath));
		}
		let mut components = Vec::new();
		for component in path.split('/') {
			if component.is_empty() || component == "." || component == ".." {
				return Err(native_error(ErrorCode::UnsafePath));
			}
			if component.len() > MAX_COMPONENT_BYTES {
				return Err(native_error(ErrorCode::Bounds));
			}
			components.push(c_string(component, ErrorCode::UnsafePath)?);
			if components.len() > MAX_PATH_COMPONENTS {
				return Err(native_error(ErrorCode::Bounds));
			}
		}
		Ok(components)
	}

	fn traverse_parent(root: &Fd, components: &[CString]) -> Result<Fd> {
		let mut current = root.duplicate()?;
		for component in components {
			let stat = fstatat(current.0, component).map_err(|error| errno_error(error, false))?;
			if (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK {
				return Err(native_error(ErrorCode::UnsafePath));
			}
			if !directory_mode(&stat) {
				return Err(native_error(ErrorCode::NotFile));
			}
			// SAFETY: component is NUL-terminated and current.0 is an open directory fd.
			let next = retry_fd(|| unsafe {
				libc::openat(
					current.0,
					component.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			})
			.map_err(|errno| errno_error(errno, false))?;
			current = Fd(next);
		}
		Ok(current)
	}

	fn fstat(fd: RawFd) -> Result<libc::stat> {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: stat points to writable MaybeUninit storage and fd is an open fd.
		retry_rc(|| unsafe { libc::fstat(fd, stat.as_mut_ptr()) })
			.map_err(|errno| errno_error(errno, false))?;
		// SAFETY: fstat initialized stat after returning zero.
		Ok(unsafe { stat.assume_init() })
	}

	fn fstatat(parent: RawFd, name: &CStr) -> std::result::Result<libc::stat, i32> {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		loop {
			// SAFETY: parent is an open directory fd and name is NUL terminated.
			let rc = unsafe {
				libc::fstatat(parent, name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
			};
			if rc == 0 {
				// SAFETY: fstatat initialized stat after returning zero.
				return Ok(unsafe { stat.assume_init() });
			}
			let error = errno();
			if error != libc::EINTR {
				return Err(error);
			}
		}
	}

	#[allow(clippy::unnecessary_cast, reason = "libc stat field widths differ across Unix targets")]
	fn signature(stat: &libc::stat) -> Signature {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		{
			Signature {
				dev:        stat.st_dev as u64,
				ino:        stat.st_ino as u64,
				size:       stat.st_size.max(0) as u64,
				mtime_sec:  stat.st_mtime,
				mtime_nsec: stat.st_mtime_nsec,
				ctime_sec:  stat.st_ctime,
				ctime_nsec: stat.st_ctime_nsec,
			}
		}
		#[cfg(target_os = "macos")]
		{
			Signature {
				dev:        stat.st_dev as u64,
				ino:        stat.st_ino as u64,
				size:       stat.st_size.max(0) as u64,
				mtime_sec:  stat.st_mtime as i64,
				mtime_nsec: stat.st_mtime_nsec as i64,
				ctime_sec:  stat.st_ctime as i64,
				ctime_nsec: stat.st_ctime_nsec as i64,
			}
		}
	}
	const fn directory_mode(stat: &libc::stat) -> bool {
		(stat.st_mode & libc::S_IFMT) == libc::S_IFDIR
	}

	const fn regular(stat: &libc::stat) -> bool {
		(stat.st_mode & libc::S_IFMT) == libc::S_IFREG
	}

	const fn mode_kind(stat: &libc::stat) -> &'static str {
		match stat.st_mode & libc::S_IFMT {
			libc::S_IFREG => "file",
			libc::S_IFDIR => "directory",
			libc::S_IFLNK => "symlink",
			_ => "other",
		}
	}

	fn read_loop(
		fd: RawFd,
		output: &mut Vec<u8>,
		cap: usize,
		capture: bool,
		hash: &mut Sha256,
	) -> Result<()> {
		let mut chunk = [0u8; READ_CHUNK];
		let mut total = 0usize;
		loop {
			let read = loop {
				// SAFETY: chunk is valid writable storage and fd is open for reading.
				let read = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
				if read >= 0 {
					break read as usize;
				}
				if errno() != libc::EINTR {
					return Err(native_error(ErrorCode::Io));
				}
			};
			if read == 0 {
				return Ok(());
			}
			if total.saturating_add(read) > cap {
				return Err(native_error(ErrorCode::Bounds));
			}
			total += read;
			hash.update(&chunk[..read]);
			if capture {
				output.extend_from_slice(&chunk[..read]);
			}
		}
	}

	fn finish_hash(hash: Sha256) -> String {
		let digest = hash.finalize();
		let mut output = String::with_capacity(64);
		for byte in digest {
			let _ = write!(output, "{byte:02x}");
		}
		output
	}

	fn read_file_fd(fd: RawFd, cap: usize) -> Result<(Vec<u8>, Signature, String)> {
		let before = fstat(fd)?;
		if !regular(&before) {
			return Err(native_error(ErrorCode::NotFile));
		}
		if signature(&before).size > cap as u64 {
			return Err(native_error(ErrorCode::Bounds));
		}
		let mut bytes = Vec::with_capacity(signature(&before).size.min(cap as u64) as usize);
		let mut hash = Sha256::new();
		read_loop(fd, &mut bytes, cap, true, &mut hash)?;
		let after = fstat(fd)?;
		if signature(&before) != signature(&after) {
			return Err(native_error(ErrorCode::Conflict));
		}
		Ok((bytes, signature(&after), finish_hash(hash)))
	}

	fn hash_file_fd(fd: RawFd, cap: usize) -> Result<(String, Signature)> {
		let before = fstat(fd)?;
		if !regular(&before) {
			return Err(native_error(ErrorCode::NotFile));
		}
		if signature(&before).size > cap as u64 {
			return Err(native_error(ErrorCode::Bounds));
		}
		let mut ignored = Vec::new();
		let mut hash = Sha256::new();
		read_loop(fd, &mut ignored, cap, false, &mut hash)?;
		let after = fstat(fd)?;
		if signature(&before) != signature(&after) {
			return Err(native_error(ErrorCode::Conflict));
		}
		Ok((finish_hash(hash), signature(&after)))
	}

	fn open_target(parent: RawFd, name: &CStr) -> Result<Fd> {
		let fd = retry_fd(|| {
			// SAFETY: name is NUL-terminated and parent is an open directory fd.
			unsafe {
				libc::openat(parent, name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
			}
		})
		.map_err(|errno| errno_error(errno, true))?;
		let fd = Fd(fd);
		if !regular(&fstat(fd.0)?) {
			return Err(native_error(ErrorCode::NotFile));
		}
		Ok(fd)
	}

	fn random_bytes(bytes: &mut [u8]) -> Result<()> {
		#[cfg(target_os = "macos")]
		{
			// SAFETY: arc4random_buf accepts any valid writable byte slice.
			unsafe { libc::arc4random_buf(bytes.as_mut_ptr().cast(), bytes.len()) };
			return Ok(());
		}
		#[cfg(target_os = "linux")]
		{
			let mut offset = 0;
			while offset < bytes.len() {
				// SAFETY: bytes range is valid and writable.
				let count = unsafe {
					libc::syscall(
						libc::SYS_getrandom,
						bytes[offset..].as_mut_ptr().cast::<libc::c_void>(),
						bytes.len() - offset,
						0,
					)
				};
				if count >= 0 {
					offset += count as usize;
				} else if errno() != libc::EINTR {
					return Err(native_error(ErrorCode::Io));
				}
			}
			return Ok(());
		}
		#[allow(unreachable_code, reason = "cfg branches cover supported Unix targets")]
		Err(native_error(ErrorCode::Unsupported))
	}

	fn create_temp(parent: RawFd) -> Result<TempFile<'static>> {
		for _ in 0..32 {
			let mut random = [0u8; 16];
			random_bytes(&mut random)?;
			let mut name = String::from(".omp-secure-");
			for byte in random {
				let _ = write!(name, "{byte:02x}");
			}
			let name = c_string(&name, ErrorCode::Io)?;
			// SAFETY: name is NUL-terminated and parent is an open directory fd.
			let fd = retry_fd(|| {
				// SAFETY: name is NUL-terminated and parent is an open directory fd.
				unsafe {
					libc::openat(
						parent,
						name.as_ptr(),
						libc::O_WRONLY
							| libc::O_CREAT
							| libc::O_EXCL | libc::O_CLOEXEC
							| libc::O_NOFOLLOW,
						0o600,
					)
				}
			});
			let fd = match fd {
				Ok(fd) => fd,
				Err(error) if error == libc::EEXIST => continue,
				Err(error) => return Err(errno_error(error, false)),
			};
			return Ok(TempFile {
				parent,
				name,
				fd: Some(Fd(fd)),
				renamed: false,
				_marker: std::marker::PhantomData,
			});
		}
		Err(native_error(ErrorCode::Io))
	}

	fn write_all(fd: RawFd, bytes: &[u8]) -> Result<()> {
		let mut offset = 0;
		while offset < bytes.len() {
			let count = loop {
				// SAFETY: bytes range is valid for reading and fd is writable.
				let count =
					unsafe { libc::write(fd, bytes[offset..].as_ptr().cast(), bytes.len() - offset) };
				if count >= 0 {
					break count as usize;
				}
				if errno() != libc::EINTR {
					return Err(native_error(ErrorCode::Io));
				}
			};
			if count == 0 {
				return Err(native_error(ErrorCode::Io));
			}
			offset += count;
		}
		Ok(())
	}

	fn fsync(fd: RawFd) -> Result<()> {
		retry_rc(|| {
			// SAFETY: fd is an open file descriptor.
			unsafe { libc::fsync(fd) }
		})
		.map_err(|_| native_error(ErrorCode::Io))
	}

	fn install_temp(parent: RawFd, temp: &CStr, leaf: &CStr, replace: bool) -> Result<()> {
		if replace {
			return retry_rc(|| unsafe {
				// SAFETY: all fds are open directories and names are NUL-terminated.
				libc::renameat(parent, temp.as_ptr(), parent, leaf.as_ptr())
			})
			.map_err(|error| errno_error(error, true));
		}
		#[cfg(target_os = "linux")]
		{
			loop {
				// SAFETY: all fds are open directories and names are NUL-terminated.
				let rc = unsafe {
					libc::syscall(
						libc::SYS_renameat2,
						parent,
						temp.as_ptr(),
						parent,
						leaf.as_ptr(),
						1u32,
					)
				};
				if rc == 0 {
					return Ok(());
				}
				let error = errno();
				if error != libc::EINTR {
					return Err(errno_error(error, true));
				}
			}
		}
		#[cfg(target_os = "macos")]
		{
			return retry_rc(|| {
				// SAFETY: all fds are open directories and names are NUL-terminated.
				unsafe {
					libc::renameatx_np(parent, temp.as_ptr(), parent, leaf.as_ptr(), libc::RENAME_EXCL)
				}
			})
			.map_err(|error| errno_error(error, true));
		}
		#[allow(unreachable_code, reason = "Unix targets are Linux or macOS here")]
		Err(native_error(ErrorCode::Unsupported))
	}

	fn target_stat(parent: RawFd, name: &CStr) -> Result<Option<libc::stat>> {
		match fstatat(parent, name) {
			Ok(stat) => Ok(Some(stat)),
			Err(libc::ENOENT) => Ok(None),
			Err(error) => Err(errno_error(error, true)),
		}
	}

	fn revision_at(parent: RawFd, name: &CStr, cap: usize) -> Result<Option<(String, Signature)>> {
		let stat = target_stat(parent, name)?.ok_or_else(|| native_error(ErrorCode::NotFound))?;
		if !regular(&stat) {
			if (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK {
				return Err(native_error(ErrorCode::UnsafePath));
			}
			return Err(native_error(ErrorCode::NotFile));
		}
		let fd = open_target(parent, name)?;
		let (revision, fd_signature) = hash_file_fd(fd.0, cap)?;
		if signature(&stat) != fd_signature {
			return Err(native_error(ErrorCode::Conflict));
		}
		Ok(Some((revision, fd_signature)))
	}

	pub fn read(root: &str, path: &str, max_bytes: u64) -> Result<SecureReadFileResult> {
		let cap = validate_limits(max_bytes)?;
		let components = parse_path(path, false)?;
		let root = Fd::open_root(root)?;
		let parent = traverse_parent(&root, &components[..components.len() - 1])?;
		let leaf = components.last().expect("non-empty path");
		let fd = open_target(parent.0, leaf.as_c_str())?;
		let (bytes, _signature, revision_sha256) = read_file_fd(fd.0, cap)?;
		Ok(SecureReadFileResult {
			size: u32::try_from(bytes.len()).map_err(|_| native_error(ErrorCode::Bounds))?,
			data: Buffer::from(bytes),
			revision_sha256,
		})
	}

	pub fn list(
		root: &str,
		path: Option<&str>,
		max_entries: u64,
	) -> Result<SecureListDirectoryResult> {
		let cap = validate_entries(max_entries)?;
		let components = parse_path(path.unwrap_or(""), true)?;
		let root = Fd::open_root(root)?;
		let directory_fd = traverse_parent(&root, &components)?;
		let duplicate = directory_fd.duplicate()?;
		let raw = duplicate.0;
		std::mem::forget(duplicate);
		// SAFETY: raw is a duplicate fd and fdopendir assumes ownership of it.
		let directory = unsafe { libc::fdopendir(raw) };
		if directory.is_null() {
			// SAFETY: raw is the duplicate fd not transferred to fdopendir after failure.
			let _ = unsafe { libc::close(raw) };
			return Err(native_error(ErrorCode::Io));
		}
		let directory = Directory(directory);
		let prefix = path.unwrap_or("");
		let mut entries = Vec::with_capacity(cap.min(256));
		loop {
			clear_errno();
			// SAFETY: directory is a valid DIR pointer owned by the guard.
			let entry = unsafe { libc::readdir(directory.0) };
			if entry.is_null() {
				let error = errno();
				if error != 0 && error != libc::ENOENT {
					return Err(native_error(ErrorCode::Io));
				}
				break;
			}
			// SAFETY: d_name is a NUL-terminated array owned by readdir.
			let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
			if name.to_bytes() == b"." || name.to_bytes() == b".." {
				continue;
			}
			if entries.len() >= cap {
				return Err(native_error(ErrorCode::Bounds));
			}
			let stat = fstatat(directory_fd.0, name).map_err(|error| errno_error(error, true))?;
			let name_bytes = name.to_bytes();
			let name_string = std::str::from_utf8(name_bytes)
				.map_err(|_| native_error(ErrorCode::Io))?
				.to_owned();
			let entry_path = if prefix.is_empty() {
				name_string.clone()
			} else {
				format!("{prefix}/{name_string}")
			};
			entries.push(SecureDirectoryEntry {
				name: name_string,
				path: entry_path,
				kind: mode_kind(&stat).to_owned(),
				size: regular(&stat).then_some(signature(&stat).size as f64),
			});
		}
		entries.sort_unstable_by(|left, right| left.name.cmp(&right.name));
		entries.dedup_by(|left, right| left.name == right.name);
		Ok(SecureListDirectoryResult { entries })
	}

	pub fn write(
		root: &str,
		path: &str,
		data: &[u8],
		expected_revision: Option<&str>,
		max_bytes: u64,
	) -> Result<SecureWriteFileResult> {
		let cap = validate_limits(max_bytes)?;
		if data.len() > cap {
			return Err(native_error(ErrorCode::Bounds));
		}
		validate_revision(expected_revision)?;
		let components = parse_path(path, false)?;
		let root = Fd::open_root(root)?;
		let parent = traverse_parent(&root, &components[..components.len() - 1])?;
		let leaf = components.last().expect("non-empty path");
		let _guard = SECURE_WRITE_LOCK
			.lock()
			.map_err(|_| native_error(ErrorCode::Io))?;
		#[cfg(test)]
		write_test_marker("OMP_SECURE_FS_TEST_BEFORE_DIRECTORY_LOCK_MARKER");
		let _directory_guard = DirectoryWriteLock::acquire(parent.0)?;

		if let Some(expected) = expected_revision {
			let initial = revision_at(parent.0, leaf.as_c_str(), cap)?;
			match initial {
				Some((actual, _)) if actual == expected => {},
				Some(_) => return Err(native_error(ErrorCode::Conflict)),
				None => return Err(native_error(ErrorCode::NotFound)),
			}
		} else if let Some(stat) = target_stat(parent.0, leaf.as_c_str())? {
			if (stat.st_mode & libc::S_IFMT) == libc::S_IFLNK {
				return Err(native_error(ErrorCode::UnsafePath));
			}
			return Err(if regular(&stat) {
				native_error(ErrorCode::Conflict)
			} else {
				native_error(ErrorCode::NotFile)
			});
		}

		let mut temp = create_temp(parent.0)?;
		let temp_fd = temp.fd.as_ref().expect("new temp has fd").0;
		write_all(temp_fd, data).and_then(|()| fsync(temp_fd))?;
		drop(temp.fd.take());

		if let Some(expected) = expected_revision {
			let current = revision_at(parent.0, leaf.as_c_str(), cap)?;
			match current {
				Some((actual, _)) if actual == expected => {},
				Some(_) => return Err(native_error(ErrorCode::Conflict)),
				None => return Err(native_error(ErrorCode::Conflict)),
			}
		}
		#[cfg(test)]
		final_window_test_hook();
		install_temp(parent.0, temp.name.as_c_str(), leaf.as_c_str(), expected_revision.is_some())?;
		temp.disarm();
		fsync(parent.0)?;
		let mut hash = Sha256::new();
		hash.update(data);
		Ok(SecureWriteFileResult {
			size:            u32::try_from(data.len()).map_err(|_| native_error(ErrorCode::Bounds))?,
			revision_sha256: finish_hash(hash),
		})
	}
}

#[cfg(not(unix))]
mod unix {
	use super::*;

	pub fn read(_root: &str, _path: &str, _max_bytes: u64) -> Result<SecureReadFileResult> {
		Err(native_error(ErrorCode::Unsupported))
	}

	pub fn list(
		_root: &str,
		_path: Option<&str>,
		_max_entries: u64,
	) -> Result<SecureListDirectoryResult> {
		Err(native_error(ErrorCode::Unsupported))
	}

	pub fn write(
		_root: &str,
		_path: &str,
		_data: &[u8],
		_expected_revision: Option<&str>,
		_max_bytes: u64,
	) -> Result<SecureWriteFileResult> {
		Err(native_error(ErrorCode::Unsupported))
	}
}

/// Read one regular file beneath `root` without following symlinks.
#[napi(js_name = "secureReadFile")]
pub fn secure_read_file(
	root: String,
	relative_path: String,
	max_bytes: u32,
) -> Result<SecureReadFileResult> {
	unix::read(&root, &relative_path, u64::from(max_bytes))
}

/// List a directory beneath `root`, sorted by entry name.
#[napi(js_name = "secureListDirectory")]
pub fn secure_list_directory(
	root: String,
	relative_path: Option<String>,
	max_entries: u32,
) -> Result<SecureListDirectoryResult> {
	unix::list(&root, relative_path.as_deref(), u64::from(max_entries))
}

/// Atomically create or replace one regular file beneath `root`.
///
/// Calls through this API serialize on the stable parent directory fd across
/// processes. Direct filesystem writers do not honor that advisory lock and
/// cannot participate in the revision guarantee.
#[napi(js_name = "secureWriteFileAtomic")]
pub fn secure_write_file_atomic(
	root: String,
	relative_path: String,
	data: Buffer,
	expected_revision: Option<String>,
	max_bytes: u32,
) -> Result<SecureWriteFileResult> {
	unix::write(
		&root,
		&relative_path,
		data.as_ref(),
		expected_revision.as_deref(),
		u64::from(max_bytes),
	)
}

#[cfg(test)]
mod tests {
	#[cfg(unix)]
	#[test]
	fn jail_read_list_and_atomic_revisions() {
		use std::{
			fs,
			os::unix::fs::PermissionsExt,
			time::{SystemTime, UNIX_EPOCH},
		};

		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("omp-secure-fs-{suffix}"));
		fs::create_dir(&root).expect("root");
		fs::create_dir(root.join("nested")).expect("nested");
		let root_string = root.to_str().expect("utf8 root");

		let created =
			super::unix::write(root_string, "nested/blob", b"\0binary", None, 1024).expect("create");
		assert_eq!(created.size, 7);
		let read = super::unix::read(root_string, "nested/blob", 1024).expect("read");
		assert_eq!(read.data.as_ref(), b"\0binary");
		assert_eq!(read.size, 7);
		let listed = super::unix::list(root_string, Some("nested"), 10).expect("list");
		assert_eq!(listed.entries.len(), 1);
		assert_eq!(listed.entries[0].name, "blob");
		assert_eq!(listed.entries[0].path, "nested/blob");
		assert_eq!(listed.entries[0].kind, "file");
		assert_eq!(
			fs::metadata(root.join("nested/blob"))
				.expect("metadata")
				.permissions()
				.mode() & 0o777,
			0o600
		);

		assert!(super::unix::write(root_string, "nested/blob", b"new", None, 1024).is_err());
		let replaced = super::unix::write(
			root_string,
			"nested/blob",
			b"new",
			Some(&created.revision_sha256),
			1024,
		)
		.expect("replace");
		assert_eq!(replaced.size, 3);
		assert!(
			super::unix::write(
				root_string,
				"nested/blob",
				b"stale",
				Some(&created.revision_sha256),
				1024
			)
			.is_err()
		);

		#[cfg(target_os = "linux")]
		std::os::unix::fs::symlink("nested/blob", root.join("link")).expect("symlink");
		#[cfg(target_os = "linux")]
		assert!(super::unix::read(root_string, "link", 1024).is_err());

		fs::remove_dir_all(root).expect("cleanup");
	}
	#[cfg(unix)]
	#[test]
	fn stale_errno_does_not_poison_list_eof() {
		use std::{
			fs,
			time::{SystemTime, UNIX_EPOCH},
		};
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("omp-secure-errno-{suffix}"));
		fs::create_dir(&root).expect("root");
		fs::write(root.join("notdir"), b"x").expect("file");
		let root_string = root.to_str().expect("utf8 root");
		assert!(super::unix::read(root_string, "notdir/x", 1024).is_err());
		assert!(super::unix::list(root_string, None, 10).is_ok());
		fs::remove_dir_all(root).expect("cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn in_process_revision_race_has_one_winner() {
		use std::{
			fs,
			sync::{Arc, Barrier},
			thread,
			time::{SystemTime, UNIX_EPOCH},
		};
		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("omp-secure-race-{suffix}"));
		fs::create_dir(&root).expect("root");
		let root_string = root.to_str().expect("utf8 root").to_owned();
		let initial = super::unix::write(&root_string, "race", &[7], None, 1024).expect("initial");
		let expected = initial.revision_sha256;
		let root = Arc::new(root_string);
		let barrier = Arc::new(Barrier::new(2));
		#[allow(clippy::needless_collect, reason = "collect keeps both racers alive before joining")]
		let handles = (0..2)
			.map(|index| {
				let root = Arc::clone(&root);
				let barrier = Arc::clone(&barrier);
				let expected = expected.clone();
				thread::spawn(move || {
					barrier.wait();
					super::unix::write(&root, "race", &[index], Some(&expected), 1024)
				})
			})
			.collect::<Vec<_>>();
		#[allow(
			clippy::needless_collect,
			reason = "collect stores both outcomes for deterministic assertions"
		)]
		let outcomes = handles
			.into_iter()
			.map(|handle| handle.join().expect("join"))
			.collect::<Vec<_>>();
		assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
		assert_eq!(outcomes.iter().filter(|result| result.is_err()).count(), 1);
		let winner = outcomes
			.iter()
			.find_map(|result| result.as_ref().ok())
			.expect("winner");
		let read = super::unix::read(&root, "race", 1024).expect("read winner");
		assert_eq!(read.revision_sha256, winner.revision_sha256);
		fs::remove_dir_all(root.as_str()).expect("cleanup");
	}

	#[cfg(unix)]
	#[test]
	fn cross_process_revision_writer_helper() {
		let Ok(root) = std::env::var("OMP_SECURE_FS_TEST_CHILD_ROOT") else {
			return;
		};
		let revision = std::env::var("OMP_SECURE_FS_TEST_CHILD_REVISION").expect("child revision");
		let data = std::env::var("OMP_SECURE_FS_TEST_CHILD_DATA").expect("child data");
		let expected_outcome =
			std::env::var("OMP_SECURE_FS_TEST_CHILD_OUTCOME").expect("child outcome");
		let outcome = super::unix::write(&root, "race", data.as_bytes(), Some(&revision), 1024);
		match (expected_outcome.as_str(), outcome) {
			("success", Ok(_)) => {},
			("conflict", Err(error)) => assert!(error.to_string().contains("CONFLICT")),
			("success", Err(error)) => panic!("expected write success, got {error}"),
			("conflict", Ok(_)) => panic!("expected revision conflict, got success"),
			(other, _) => panic!("unknown expected child outcome: {other}"),
		}
	}

	#[cfg(unix)]
	#[test]
	fn cross_process_lock_covers_final_revision_window() {
		use std::{
			fs,
			process::{Child, Command, Stdio},
			thread,
			time::{Duration, Instant, SystemTime, UNIX_EPOCH},
		};

		let suffix = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("omp-secure-cross-process-{suffix}"));
		fs::create_dir(&root).expect("root");
		let root_string = root.to_str().expect("utf8 root");
		let initial =
			super::unix::write(root_string, "race", b"initial", None, 1024).expect("initial write");
		let final_marker = root.join("first-final-window");
		let final_release = root.join("release-first");
		let second_before_lock = root.join("second-before-lock");

		let spawn_writer = |data: &str,
		                    expected_outcome: &str,
		                    before_lock: Option<&std::path::Path>,
		                    final_window: Option<(&std::path::Path, &std::path::Path)>|
		 -> Child {
			let mut command = Command::new(std::env::current_exe().expect("test binary"));
			command
				.args([
					"--exact",
					"secure_fs::tests::cross_process_revision_writer_helper",
					"--nocapture",
				])
				.env("OMP_SECURE_FS_TEST_CHILD_ROOT", root_string)
				.env("OMP_SECURE_FS_TEST_CHILD_REVISION", &initial.revision_sha256)
				.env("OMP_SECURE_FS_TEST_CHILD_DATA", data)
				.env("OMP_SECURE_FS_TEST_CHILD_OUTCOME", expected_outcome)
				.env_remove("OMP_SECURE_FS_TEST_BEFORE_DIRECTORY_LOCK_MARKER")
				.env_remove("OMP_SECURE_FS_TEST_FINAL_MARKER")
				.env_remove("OMP_SECURE_FS_TEST_FINAL_RELEASE")
				.stdout(Stdio::piped())
				.stderr(Stdio::piped());
			if let Some(marker) = before_lock {
				command.env("OMP_SECURE_FS_TEST_BEFORE_DIRECTORY_LOCK_MARKER", marker);
			}
			if let Some((marker, release)) = final_window {
				command
					.env("OMP_SECURE_FS_TEST_FINAL_MARKER", marker)
					.env("OMP_SECURE_FS_TEST_FINAL_RELEASE", release);
			}
			command.spawn().expect("spawn revision writer")
		};

		let wait_for_marker = |path: &std::path::Path, child: &mut Child| {
			let deadline = Instant::now() + Duration::from_secs(10);
			while !path.exists() {
				if let Some(status) = child.try_wait().expect("poll child") {
					panic!("writer exited before marker {path:?}: {status}");
				}
				assert!(Instant::now() < deadline, "timed out waiting for marker {path:?}");
				thread::sleep(Duration::from_millis(5));
			}
		};

		let mut first = spawn_writer("first", "success", None, Some((&final_marker, &final_release)));
		// The first writer pauses after its final revision check while still
		// holding the directory lock.
		wait_for_marker(&final_marker, &mut first);

		let mut second = spawn_writer("second", "conflict", Some(&second_before_lock), None);
		wait_for_marker(&second_before_lock, &mut second);
		thread::sleep(Duration::from_millis(100));
		let second_was_blocked = second.try_wait().expect("poll blocked writer").is_none();

		fs::write(&final_release, b"go").expect("release first writer");
		let first_output = first.wait_with_output().expect("wait for first writer");
		let second_output = second.wait_with_output().expect("wait for second writer");
		assert!(second_was_blocked, "second writer did not wait for the directory lock");
		assert!(
			first_output.status.success(),
			"first writer failed: {}{}",
			String::from_utf8_lossy(&first_output.stdout),
			String::from_utf8_lossy(&first_output.stderr)
		);
		assert!(
			second_output.status.success(),
			"second writer failed: {}{}",
			String::from_utf8_lossy(&second_output.stdout),
			String::from_utf8_lossy(&second_output.stderr)
		);
		assert_eq!(fs::read(root.join("race")).expect("read winner"), b"first");
		fs::remove_dir_all(root).expect("cleanup");
	}
}
