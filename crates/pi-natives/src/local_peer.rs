//! Opaque, fail-closed capabilities used by the ChatGPT Web integration.
//!
//! Platform operations that cannot preserve native identity are explicit
//! errors; this module never substitutes pathname, PID-only, TCP, or
//! caller-argv fallbacks.

#[cfg(windows)]
use std::os::windows::{
	fs::{MetadataExt, OpenOptionsExt},
	io::{AsRawHandle, FromRawHandle, RawHandle},
	process::CommandExt,
};
use std::{
	collections::{BTreeMap, HashMap},
	fs::{self, File, OpenOptions},
	io::{Read, Seek, SeekFrom, Write},
	mem::size_of,
	path::{Path, PathBuf},
	process::{Child, Command, Stdio},
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};
#[cfg(unix)]
use std::{
	ffi::{CStr, CString, OsStr},
	os::unix::{
		ffi::OsStrExt,
		fs::{DirBuilderExt, PermissionsExt},
		io::{AsRawFd, FromRawFd, IntoRawFd, RawFd},
		net::{UnixListener, UnixStream},
		process::CommandExt,
	},
};

use napi::{
	Result,
	bindgen_prelude::{ClassInstance, Either, JsObjectValue, Object, Uint8Array},
};
use napi_derive::napi;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
#[cfg(windows)]
use windows_sys::Win32::{
	Foundation::{
		CloseHandle, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING, FILETIME, GENERIC_ALL, GENERIC_READ,
		GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
	},
	Security::{
		ACL, ACL_REVISION, AddAccessAllowedAce, GetLengthSid, GetTokenInformation, InitializeAcl,
		InitializeSecurityDescriptor, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR,
		SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TOKEN_QUERY, TOKEN_USER, TokenUser,
	},
	Storage::FileSystem::{
		BY_HANDLE_FILE_INFORMATION, CreateFileW, DELETE, FILE_ATTRIBUTE_NORMAL,
		FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
		FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
		FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_PIPE, FileDispositionInfo,
		GetFileInformationByHandle, GetFileType, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
		LockFileEx, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SetFileInformationByHandle, WRITE_DAC,
	},
	System::{
		Diagnostics::ToolHelp::{
			CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
			TH32CS_SNAPPROCESS,
		},
		IO::OVERLAPPED,
		JobObjects::{
			AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
			JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
			SetInformationJobObject, TerminateJobObject,
		},
		Pipes::{
			ConnectNamedPipe, CreateNamedPipeW, CreatePipe, GetNamedPipeClientProcessId,
			GetNamedPipeServerProcessId, PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
			PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, SetNamedPipeHandleState,
		},
		SystemServices::SECURITY_DESCRIPTOR_REVISION,
		Threading::{
			CREATE_NO_WINDOW, CREATE_SUSPENDED, GetCurrentProcess, GetCurrentProcessId,
			GetProcessTimes, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
			QueryFullProcessImageNameW,
		},
	},
};
#[cfg(windows)]
const PROCESS_SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

#[cfg(windows)]
struct WinHandle(HANDLE);

// Windows kernel handles are process-wide values and may be closed from any
// thread.
#[cfg(windows)]
unsafe impl Send for WinHandle {}

#[cfg(windows)]
#[repr(C)]
struct NtUnicodeString {
	length:         u16,
	maximum_length: u16,
	buffer:         *mut u16,
}

#[cfg(windows)]
#[repr(C)]
struct NtObjectAttributes {
	length: u32,
	root_directory: HANDLE,
	object_name: *mut NtUnicodeString,
	attributes: u32,
	security_descriptor: *mut std::ffi::c_void,
	security_quality_of_service: *mut std::ffi::c_void,
}

#[cfg(windows)]
#[repr(C)]
struct NtIoStatusBlock {
	status:      isize,
	information: usize,
}

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
	fn NtCreateFile(
		file_handle: *mut HANDLE,
		desired_access: u32,
		object_attributes: *mut NtObjectAttributes,
		io_status_block: *mut NtIoStatusBlock,
		allocation_size: *const i64,
		file_attributes: u32,
		share_access: u32,
		create_disposition: u32,
		create_options: u32,
		ea_buffer: *const std::ffi::c_void,
		ea_length: u32,
	) -> i32;
	fn NtQueryDirectoryFile(
		file_handle: HANDLE,
		event: HANDLE,
		apc_routine: *mut std::ffi::c_void,
		apc_context: *mut std::ffi::c_void,
		io_status_block: *mut NtIoStatusBlock,
		file_information: *mut std::ffi::c_void,
		length: u32,
		file_information_class: i32,
		return_single_entry: u8,
		file_name: *mut NtUnicodeString,
		restart_scan: u8,
	) -> i32;
	fn NtSetInformationFile(
		file_handle: HANDLE,
		io_status_block: *mut NtIoStatusBlock,
		file_information: *const std::ffi::c_void,
		length: u32,
		file_information_class: i32,
	) -> i32;
	fn NtResumeProcess(process: HANDLE) -> i32;
	fn RtlNtStatusToDosError(status: i32) -> u32;
}

#[cfg(windows)]
#[link(name = "advapi32")]
unsafe extern "system" {
	fn SetSecurityInfo(
		handle: HANDLE,
		object_type: i32,
		security_information: u32,
		owner: *mut std::ffi::c_void,
		group: *mut std::ffi::c_void,
		dacl: *mut ACL,
		sacl: *mut ACL,
	) -> u32;
	fn GetSecurityInfo(
		handle: HANDLE,
		object_type: i32,
		security_information: u32,
		owner: *mut *mut std::ffi::c_void,
		group: *mut *mut std::ffi::c_void,
		dacl: *mut *mut ACL,
		sacl: *mut *mut ACL,
		security_descriptor: *mut *mut std::ffi::c_void,
	) -> u32;
	fn GetAce(acl: *const ACL, ace_index: u32, ace: *mut *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
	fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

#[cfg(windows)]
impl Drop for WinHandle {
	fn drop(&mut self) {
		if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
			unsafe {
				CloseHandle(self.0);
			}
		}
	}
}

#[cfg(windows)]
fn windows_open(path: &Path, directory: bool, write: bool) -> std::io::Result<File> {
	let mut options = OpenOptions::new();
	options
		.read(true)
		.write(write)
		.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
		.custom_flags(
			FILE_FLAG_OPEN_REPARSE_POINT
				| if directory {
					FILE_FLAG_BACKUP_SEMANTICS
				} else {
					0
				},
		);
	options.open(path)
}

#[cfg(windows)]
fn windows_executable_open(path: &Path) -> std::io::Result<File> {
	let mut options = OpenOptions::new();
	options
		.read(true)
		.share_mode(FILE_SHARE_READ)
		.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
	options.open(path)
}

#[cfg(windows)]
fn windows_owned_open(path: &Path, directory: bool, write: bool) -> std::io::Result<File> {
	let mut options = OpenOptions::new();
	options
		.access_mode(GENERIC_READ | DELETE | if write { GENERIC_WRITE } else { 0 })
		.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
		.custom_flags(
			FILE_FLAG_OPEN_REPARSE_POINT
				| if directory {
					FILE_FLAG_BACKUP_SEMANTICS
				} else {
					0
				},
		);
	options.open(path)
}
#[cfg(windows)]
fn reject_reparse(file: &File) -> Result<()> {
	if file
		.metadata()
		.map_err(|err| error(err.to_string()))?
		.file_attributes()
		& FILE_ATTRIBUTE_REPARSE_POINT
		!= 0
	{
		Err(error("refusing Windows reparse point"))
	} else {
		Ok(())
	}
}

#[cfg(windows)]
fn windows_file_information(file: &File) -> std::io::Result<BY_HANDLE_FILE_INFORMATION> {
	let mut information = BY_HANDLE_FILE_INFORMATION::default();
	if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut information) } == 0 {
		Err(std::io::Error::last_os_error())
	} else {
		Ok(information)
	}
}

#[cfg(windows)]
fn windows_file_index(information: &BY_HANDLE_FILE_INFORMATION) -> u64 {
	((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64
}

#[cfg(windows)]
fn windows_file_time(time: &FILETIME) -> u64 {
	((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64
}

#[cfg(windows)]
fn windows_mark_delete(file: &File) -> Result<()> {
	let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
	if unsafe {
		SetFileInformationByHandle(
			file.as_raw_handle() as HANDLE,
			FileDispositionInfo,
			&disposition as *const _ as *const _,
			size_of::<FILE_DISPOSITION_INFO>() as u32,
		)
	} == 0
	{
		return Err(last_error("SetFileInformationByHandle(FileDispositionInfo) failed"));
	}
	Ok(())
}

#[cfg(windows)]
fn windows_create_private_at(root: &File, name: &str) -> Result<File> {
	const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
	const OBJ_DONT_REPARSE: u32 = 0x0000_1000;
	const FILE_CREATE: u32 = 2;
	const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
	const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
	const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

	let mut security = owner_only_pipe_security()?;
	let mut wide_name: Vec<u16> = name.encode_utf16().collect();
	let name_bytes = u16::try_from(wide_name.len().saturating_mul(size_of::<u16>()))
		.map_err(|_| error("private file name is too long"))?;
	let mut unicode_name = NtUnicodeString {
		length:         name_bytes,
		maximum_length: name_bytes,
		buffer:         wide_name.as_mut_ptr(),
	};
	let mut attributes = NtObjectAttributes {
		length: size_of::<NtObjectAttributes>() as u32,
		root_directory: root.as_raw_handle() as HANDLE,
		object_name: &mut unicode_name,
		attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
		security_descriptor: security.descriptor.as_mut() as *mut _ as *mut _,
		security_quality_of_service: std::ptr::null_mut(),
	};
	let mut status_block = NtIoStatusBlock { status: 0, information: 0 };
	let mut handle = std::ptr::null_mut();
	let status = unsafe {
		NtCreateFile(
			&mut handle,
			GENERIC_READ | GENERIC_WRITE | DELETE | PROCESS_SYNCHRONIZE_ACCESS,
			&mut attributes,
			&mut status_block,
			std::ptr::null(),
			FILE_ATTRIBUTE_NORMAL,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
			FILE_CREATE,
			FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
			std::ptr::null(),
			0,
		)
	};
	if status < 0 {
		let code = unsafe { RtlNtStatusToDosError(status) };
		return Err(error(format!(
			"atomic private file creation failed: {}",
			std::io::Error::from_raw_os_error(code as i32),
		)));
	}
	let file = unsafe { File::from_raw_handle(handle as RawHandle) };
	reject_reparse(&file)?;
	Ok(file)
}

#[cfg(unix)]
fn unix_component(component: &OsStr) -> std::io::Result<CString> {
	CString::new(component.as_bytes()).map_err(|_| {
		std::io::Error::new(std::io::ErrorKind::InvalidInput, "path component contains NUL")
	})
}

#[cfg(unix)]
fn unix_openat(parent: RawFd, name: &CString, flags: libc::c_int) -> std::io::Result<File> {
	let fd =
		unsafe { libc::openat(parent, name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW, 0) };
	if fd < 0 {
		Err(std::io::Error::last_os_error())
	} else {
		Ok(unsafe { File::from_raw_fd(fd) })
	}
}

#[cfg(unix)]
fn unix_open_held(
	path: &Path,
	directory: bool,
	write: bool,
) -> std::io::Result<(File, Option<File>, Option<CString>)> {
	use std::path::Component;

	let start = if path.is_absolute() { c"/" } else { c"." };
	let start_fd =
		unsafe { libc::open(start.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY) };
	if start_fd < 0 {
		return Err(std::io::Error::last_os_error());
	}
	let mut current = unsafe { File::from_raw_fd(start_fd) };
	let mut components = Vec::new();
	for component in path.components() {
		match component {
			Component::RootDir | Component::CurDir => {},
			Component::Normal(name) => components.push(unix_component(name)?),
			Component::ParentDir | Component::Prefix(_) => {
				return Err(std::io::Error::new(
					std::io::ErrorKind::InvalidInput,
					"native-owned paths may not contain parent traversal",
				));
			},
		}
	}
	if components.is_empty() {
		if !directory {
			return Err(std::io::Error::new(
				std::io::ErrorKind::InvalidInput,
				"file path has no final component",
			));
		}
		return Ok((current, None, None));
	}
	for component in &components[..components.len() - 1] {
		current = unix_openat(current.as_raw_fd(), component, libc::O_RDONLY | libc::O_DIRECTORY)?;
	}
	let name = components.pop().expect("non-empty path components");
	let flags = if directory {
		libc::O_RDONLY | libc::O_DIRECTORY
	} else if write {
		libc::O_RDWR
	} else {
		libc::O_RDONLY
	};
	let file = unix_openat(current.as_raw_fd(), &name, flags)?;
	Ok((file, Some(current), Some(name)))
}

#[cfg(unix)]
fn unix_create_private_at(parent: RawFd, name: &CString) -> std::io::Result<File> {
	let fd = unsafe {
		libc::openat(
			parent,
			name.as_ptr(),
			libc::O_CLOEXEC | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_RDWR,
			0o600,
		)
	};
	if fd < 0 {
		Err(std::io::Error::last_os_error())
	} else {
		Ok(unsafe { File::from_raw_fd(fd) })
	}
}

#[cfg(unix)]
fn unix_cleanup_owned(state: &OwnedFileState) -> Result<()> {
	let parent = state
		.parent
		.as_ref()
		.ok_or_else(|| error("native-owned root directory cannot be removed"))?;
	let name = state
		.name
		.as_ref()
		.ok_or_else(|| error("native-owned path has no removable name"))?;
	let flags = if state.directory {
		libc::O_RDONLY | libc::O_DIRECTORY
	} else {
		libc::O_RDONLY
	};
	let current = match unix_openat(parent.as_raw_fd(), name, flags) {
		Ok(file) => file,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
		Err(err) => return Err(error(err.to_string())),
	};
	let held_guard = state.file.lock();
	let held = held_guard
		.as_ref()
		.ok_or_else(|| error("native-owned file is closed"))?;
	use std::os::unix::fs::MetadataExt;
	let held_metadata = held.metadata().map_err(|err| error(err.to_string()))?;
	let current_metadata = current.metadata().map_err(|err| error(err.to_string()))?;
	if held_metadata.dev() != current_metadata.dev() || held_metadata.ino() != current_metadata.ino()
	{
		return Err(error("refusing cleanup after native-owned path replacement"));
	}
	let unlink_flags = if state.directory {
		libc::AT_REMOVEDIR
	} else {
		0
	};
	if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), unlink_flags) } != 0 {
		return Err(error(std::io::Error::last_os_error().to_string()));
	}
	Ok(())
}

const PRIVATE_FILE_NAME_MAX: usize = 64;
static PRIVATE_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn private_file_name(name_hint: Option<&str>) -> Result<String> {
	let name = match name_hint {
		Some(name) => name.to_owned(),
		None => format!(
			"private-{:x}-{:016x}",
			std::process::id(),
			PRIVATE_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
		),
	};
	if name.is_empty()
		|| name.len() > PRIVATE_FILE_NAME_MAX
		|| name == "."
		|| name == ".."
		|| !name
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
	{
		return Err(error("private file name hint must be a bounded safe filename"));
	}
	Ok(name)
}

const UNSUPPORTED: &str =
	"native operation unavailable: this build has no identity-preserving platform implementation";

fn error(message: impl Into<String>) -> napi::Error {
	napi::Error::from_reason(message.into())
}
#[cfg(windows)]
fn last_error(context: &str) -> napi::Error {
	error(format!("{context}: {}", std::io::Error::last_os_error()))
}

fn hex(bytes: &[u8]) -> String {
	const DIGITS: &[u8; 16] = b"0123456789abcdef";
	let mut output = String::with_capacity(bytes.len() * 2);
	for byte in bytes {
		output.push(DIGITS[(byte >> 4) as usize] as char);
		output.push(DIGITS[(byte & 15) as usize] as char);
	}
	output
}

fn opened_identity(file: &File) -> std::io::Result<String> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		let metadata = file.metadata()?;
		return Ok(format!(
			"{}:{}:{}:{}",
			metadata.dev(),
			metadata.ino(),
			metadata.mode(),
			metadata.ctime_nsec()
		));
	}
	#[cfg(windows)]
	{
		let information = windows_file_information(file)?;
		return Ok(format!(
			"{}:{:016x}:{}",
			information.dwVolumeSerialNumber,
			windows_file_index(&information),
			windows_file_time(&information.ftCreationTime),
		));
	}
	#[allow(unreachable_code)]
	Err(std::io::Error::new(std::io::ErrorKind::Unsupported, UNSUPPORTED))
}

fn sha256(file: &File) -> std::io::Result<String> {
	let mut reader = file.try_clone()?;
	reader.seek(SeekFrom::Start(0))?;
	let mut digest = Sha256::new();
	let mut buffer = [0_u8; 64 * 1024];
	loop {
		let count = reader.read(&mut buffer)?;
		if count == 0 {
			break;
		}
		digest.update(&buffer[..count]);
	}
	Ok(hex(&digest.finalize()))
}

struct OwnedFileState {
	path:          PathBuf,
	file:          Mutex<Option<File>>,
	identity:      String,
	directory:     bool,
	consumed:      AtomicBool,
	mutation_lock: Arc<Mutex<()>>,
	#[cfg(unix)]
	parent:        Option<File>,
	#[cfg(unix)]
	name:          Option<CString>,
}

/// Stable already-open file or directory capability.
#[napi]
#[derive(Clone)]
pub struct NativeOwnedFile {
	state: Arc<OwnedFileState>,
}

#[cfg(unix)]
fn unix_revalidate_private_root(state: &OwnedFileState, held: &File) -> Result<()> {
	use std::os::unix::fs::MetadataExt;

	let parent = state
		.parent
		.as_ref()
		.ok_or_else(|| error("private file root has no pinned parent"))?;
	let name = state
		.name
		.as_ref()
		.ok_or_else(|| error("private file root has no pinned name"))?;
	let current = unix_openat(parent.as_raw_fd(), name, libc::O_RDONLY | libc::O_DIRECTORY)
		.map_err(|err| error(format!("revalidate private file root: {err}")))?;
	let held_metadata = held.metadata().map_err(|err| error(err.to_string()))?;
	let current_metadata = current.metadata().map_err(|err| error(err.to_string()))?;
	if held_metadata.dev() != current_metadata.dev() || held_metadata.ino() != current_metadata.ino()
	{
		return Err(error("private file root was replaced"));
	}
	Ok(())
}

#[cfg(windows)]
fn windows_revalidate_private_root(state: &OwnedFileState, held: &File) -> Result<()> {
	let current = windows_owned_open(&state.path, true, false)
		.map_err(|err| error(format!("revalidate private file root: {err}")))?;
	let held_information = windows_file_information(held)
		.map_err(|err| error(format!("inspect private file root identity: {err}")))?;
	let current_information = windows_file_information(&current)
		.map_err(|err| error(format!("inspect current private file root identity: {err}")))?;
	if held_information.dwVolumeSerialNumber != current_information.dwVolumeSerialNumber
		|| windows_file_index(&held_information) != windows_file_index(&current_information)
	{
		return Err(error("private file root was replaced"));
	}
	Ok(())
}

#[cfg(unix)]
fn create_private_owned(
	root: &NativeOwnedFile,
	name: String,
	bytes: &[u8],
) -> Result<NativeOwnedFile> {
	use std::os::unix::fs::MetadataExt;

	if !root.state.directory {
		return Err(error("private file root is not a directory"));
	}
	let root_guard = root.state.file.lock();
	let root_file = root_guard
		.as_ref()
		.ok_or_else(|| error("private file root is closed"))?;
	let root_metadata = root_file.metadata().map_err(|err| error(err.to_string()))?;
	if !root_metadata.is_dir()
		|| root_metadata.uid() != unsafe { libc::geteuid() }
		|| root_metadata.mode() & 0o077 != 0
	{
		return Err(error("private file root is not an owner-private directory"));
	}
	unix_revalidate_private_root(&root.state, root_file)?;
	let component = unix_component(OsStr::new(&name)).map_err(|err| error(err.to_string()))?;
	let parent = root_file
		.try_clone()
		.map_err(|err| error(err.to_string()))?;
	let mut file = unix_create_private_at(root_file.as_raw_fd(), &component)
		.map_err(|err| error(format!("atomic private file creation failed: {err}")))?;
	let created = (|| -> Result<String> {
		let metadata = file.metadata().map_err(|err| error(err.to_string()))?;
		if !metadata.is_file()
			|| metadata.uid() != unsafe { libc::geteuid() }
			|| metadata.nlink() != 1
			|| metadata.mode() & 0o777 != 0o600
		{
			return Err(error(
				"created private file failed ownership, type, link-count, or mode verification",
			));
		}
		file
			.write_all(bytes)
			.map_err(|err| error(err.to_string()))?;
		file.sync_all().map_err(|err| error(err.to_string()))?;
		unix_revalidate_private_root(&root.state, root_file)?;
		opened_identity(&file).map_err(|err| error(err.to_string()))
	})();
	let identity = match created {
		Ok(identity) => identity,
		Err(err) => {
			unsafe {
				libc::unlinkat(root_file.as_raw_fd(), component.as_ptr(), 0);
			}
			return Err(err);
		},
	};
	Ok(NativeOwnedFile {
		state: Arc::new(OwnedFileState {
			path: root.state.path.join(&name),
			file: Mutex::new(Some(file)),
			identity,
			directory: false,
			consumed: AtomicBool::new(false),
			mutation_lock: Arc::clone(&root.state.mutation_lock),
			parent: Some(parent),
			name: Some(component),
		}),
	})
}

#[cfg(windows)]
fn create_private_owned(
	root: &NativeOwnedFile,
	name: String,
	bytes: &[u8],
) -> Result<NativeOwnedFile> {
	if !root.state.directory {
		return Err(error("private file root is not a directory"));
	}
	let root_guard = root.state.file.lock();
	let root_file = root_guard
		.as_ref()
		.ok_or_else(|| error("private file root is closed"))?;
	reject_reparse(root_file)?;
	if !root_file
		.metadata()
		.map_err(|err| error(err.to_string()))?
		.is_dir()
	{
		return Err(error("private file root is not a directory"));
	}
	windows_revalidate_private_root(&root.state, root_file)?;
	let mut file = windows_create_private_at(root_file, &name)?;
	let created = (|| -> Result<String> {
		let metadata = file.metadata().map_err(|err| error(err.to_string()))?;
		let information = windows_file_information(&file)
			.map_err(|err| error(format!("inspect created private file identity: {err}")))?;
		if !metadata.is_file() || information.nNumberOfLinks != 1 {
			return Err(error("created private file failed type or link-count verification"));
		}
		file
			.write_all(bytes)
			.map_err(|err| error(err.to_string()))?;
		file.sync_all().map_err(|err| error(err.to_string()))?;
		windows_revalidate_private_root(&root.state, root_file)?;
		opened_identity(&file).map_err(|err| error(err.to_string()))
	})();
	let identity = match created {
		Ok(identity) => identity,
		Err(err) => {
			let _ = windows_mark_delete(&file);
			return Err(err);
		},
	};
	Ok(NativeOwnedFile {
		state: Arc::new(OwnedFileState {
			path: root.state.path.join(&name),
			file: Mutex::new(Some(file)),
			identity,
			directory: false,
			consumed: AtomicBool::new(false),
			mutation_lock: Arc::clone(&root.state.mutation_lock),
		}),
	})
}

#[cfg(all(not(windows), not(unix)))]
fn create_private_owned(
	_root: &NativeOwnedFile,
	_name: String,
	_bytes: &[u8],
) -> Result<NativeOwnedFile> {
	Err(error(UNSUPPORTED))
}

#[napi]
impl NativeOwnedFile {
	/// Open a regular file or directory after rejecting symbolic links.
	#[napi(factory)]
	pub fn open(path: String, directory: Option<bool>) -> Result<Self> {
		let path = PathBuf::from(path);
		let directory = directory.unwrap_or(false);
		#[cfg(windows)]
		let file =
			windows_owned_open(&path, directory, !directory).map_err(|err| error(err.to_string()))?;
		#[cfg(unix)]
		let (file, parent, name) =
			unix_open_held(&path, directory, !directory).map_err(|err| error(err.to_string()))?;
		#[cfg(all(not(windows), not(unix)))]
		let file = {
			let link_metadata = fs::symlink_metadata(&path).map_err(|err| error(err.to_string()))?;
			if link_metadata.file_type().is_symlink() {
				return Err(error("refusing symbolic-link native-owned path"));
			}
			let mut options = OpenOptions::new();
			options.read(true).write(!directory);
			options.open(&path).map_err(|err| error(err.to_string()))?
		};
		#[cfg(windows)]
		reject_reparse(&file)?;
		let metadata = file.metadata().map_err(|err| error(err.to_string()))?;
		if metadata.is_dir() != directory || (!directory && !metadata.is_file()) {
			return Err(error("native-owned path has the wrong file type"));
		}
		let identity = opened_identity(&file).map_err(|err| error(err.to_string()))?;
		Ok(Self {
			state: Arc::new(OwnedFileState {
				path,
				file: Mutex::new(Some(file)),
				identity,
				directory,
				consumed: AtomicBool::new(false),
				mutation_lock: Arc::new(Mutex::new(())),
				#[cfg(unix)]
				parent,
				#[cfg(unix)]
				name,
			}),
		})
	}

	/// Atomically create an owner-private regular file beneath a held directory
	/// capability.
	#[napi(factory, js_name = "createPrivate")]
	pub fn create_private(
		root: &NativeOwnedFile,
		name_hint: Option<String>,
		bytes: Uint8Array,
	) -> Result<Self> {
		let name = private_file_name(name_hint.as_deref())?;
		create_private_owned(root, name, &bytes)
	}

	#[napi(getter)]
	pub fn identity(&self) -> String {
		self.state.identity.clone()
	}

	#[napi(getter)]
	pub fn directory(&self) -> bool {
		self.state.directory
	}

	/// Read the held handle; never reopen the pathname.
	#[napi]
	pub fn read(&self) -> Result<Uint8Array> {
		if self.state.directory {
			return Err(error("cannot read a native-owned directory"));
		}
		if self.state.consumed.load(Ordering::Acquire) {
			return Err(error("native-owned file is consumed"));
		}
		let guard = self.state.file.lock();
		let file = guard
			.as_ref()
			.ok_or_else(|| error("native-owned file is closed"))?;
		let mut reader = file.try_clone().map_err(|err| error(err.to_string()))?;
		if !self.state.path.as_os_str().is_empty() {
			reader
				.seek(SeekFrom::Start(0))
				.map_err(|err| error(err.to_string()))?;
		}
		let mut bytes = Vec::new();
		reader
			.read_to_end(&mut bytes)
			.map_err(|err| error(err.to_string()))?;
		Ok(Uint8Array::from(bytes))
	}

	/// One-way consume and zeroize through the held handle.
	#[napi]
	pub fn consume(&self) -> Result<()> {
		if self.state.directory {
			return Err(error("cannot consume a native-owned directory"));
		}
		if self.state.consumed.swap(true, Ordering::AcqRel) {
			return Err(error("native-owned file is already consumed"));
		}
		if self.state.path.as_os_str().is_empty() {
			self.state.file.lock().take();
			return Ok(());
		}
		let mut guard = self.state.file.lock();
		let file = guard
			.as_mut()
			.ok_or_else(|| error("native-owned file is closed"))?;
		let length = file.metadata().map_err(|err| error(err.to_string()))?.len();
		file
			.seek(SeekFrom::Start(0))
			.map_err(|err| error(err.to_string()))?;
		let zeros = [0_u8; 4096];
		let mut remaining = length;
		while remaining > 0 {
			let count = remaining.min(zeros.len() as u64) as usize;
			file
				.write_all(&zeros[..count])
				.map_err(|err| error(err.to_string()))?;
			remaining -= count as u64;
		}
		file.sync_all().map_err(|err| error(err.to_string()))
	}

	/// Delete the object named by the held handle; never reopen or delete a
	/// replacement pathname.
	#[napi]
	pub fn cleanup(&self) -> Result<()> {
		#[cfg(windows)]
		{
			let guard = self.state.file.lock();
			let file = guard
				.as_ref()
				.ok_or_else(|| error("native-owned file is closed"))?;
			let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
			if unsafe {
				SetFileInformationByHandle(
					file.as_raw_handle() as HANDLE,
					FileDispositionInfo,
					&disposition as *const _ as *const _,
					size_of::<FILE_DISPOSITION_INFO>() as u32,
				)
			} == 0
			{
				return Err(last_error("SetFileInformationByHandle(FileDispositionInfo) failed"));
			}
			return Ok(());
		}
		#[cfg(unix)]
		{
			unix_cleanup_owned(&self.state)
		}
		#[cfg(all(not(windows), not(unix)))]
		{
			let current = OpenOptions::new().read(true).open(&self.state.path);
			let Ok(current) = current else {
				return Ok(());
			};
			if opened_identity(&current).map_err(|err| error(err.to_string()))? != self.state.identity
			{
				return Err(error("refusing cleanup after native-owned path replacement"));
			}
			if self.state.directory {
				fs::remove_dir(&self.state.path)
			} else {
				fs::remove_file(&self.state.path)
			}
			.map_err(|err| error(err.to_string()))
		}
	}

	#[napi]
	pub fn close(&self) {
		self.state.file.lock().take();
	}
}

fn owned_child(
	root: &NativeOwnedFile,
	name: &str,
	file: File,
	directory: bool,
) -> Result<NativeOwnedFile> {
	let identity = opened_identity(&file).map_err(|err| error(err.to_string()))?;
	Ok(NativeOwnedFile {
		state: Arc::new(OwnedFileState {
			path: root.state.path.join(name),
			file: Mutex::new(Some(file)),
			identity,
			directory,
			consumed: AtomicBool::new(false),
			mutation_lock: Arc::clone(&root.state.mutation_lock),
			#[cfg(unix)]
			parent: Some(
				root
					.state
					.file
					.lock()
					.as_ref()
					.ok_or_else(|| error("native-owned directory is closed"))?
					.try_clone()
					.map_err(|err| error(err.to_string()))?,
			),
			#[cfg(unix)]
			name: Some(unix_component(OsStr::new(name)).map_err(|err| error(err.to_string()))?),
		}),
	})
}

fn owned_root(path: PathBuf, file: File) -> Result<NativeOwnedFile> {
	#[cfg(unix)]
	let name = unix_component(
		path
			.file_name()
			.ok_or_else(|| error("private root must have a final path component"))?,
	)
	.map_err(|err| error(err.to_string()))?;
	#[cfg(unix)]
	let parent_name = CString::new("..").unwrap();
	#[cfg(unix)]
	let parent = unix_openat(file.as_raw_fd(), &parent_name, libc::O_RDONLY | libc::O_DIRECTORY)
		.map_err(|err| error(format!("pin private root parent: {err}")))?;
	let identity = opened_identity(&file).map_err(|err| error(err.to_string()))?;
	Ok(NativeOwnedFile {
		state: Arc::new(OwnedFileState {
			path,
			file: Mutex::new(Some(file)),
			identity,
			directory: true,
			consumed: AtomicBool::new(false),
			mutation_lock: Arc::new(Mutex::new(())),
			#[cfg(unix)]
			parent: Some(parent),
			#[cfg(unix)]
			name: Some(name),
		}),
	})
}

fn validate_owned_directory(root: &NativeOwnedFile) -> Result<File> {
	if !root.state.directory {
		return Err(error("native-owned capability is not a directory"));
	}
	let guard = root.state.file.lock();
	let file = guard
		.as_ref()
		.ok_or_else(|| error("native-owned directory is closed"))?;
	let metadata = file.metadata().map_err(|err| error(err.to_string()))?;
	if !metadata.is_dir() {
		return Err(error("native-owned directory changed type"));
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
			return Err(error("native-owned directory is not owner-private"));
		}
	}
	#[cfg(windows)]
	windows_make_runtime_directory_private(file)?;
	file.try_clone().map_err(|err| error(err.to_string()))
}

fn open_owned_child_optional(
	root: &NativeOwnedFile,
	name: &str,
	directory: bool,
) -> Result<Option<NativeOwnedFile>> {
	let name = private_file_name(Some(name))?;
	let parent = validate_owned_directory(root)?;
	#[cfg(unix)]
	let file = {
		let component = unix_component(OsStr::new(&name)).map_err(|err| error(err.to_string()))?;
		let flags = libc::O_RDONLY | if directory { libc::O_DIRECTORY } else { 0 };
		match unix_openat(parent.as_raw_fd(), &component, flags) {
			Ok(file) => Some(file),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
			Err(err) => return Err(error(format!("open native-owned child: {err}"))),
		}
	};
	#[cfg(windows)]
	let file = match windows_runtime_open_at(&parent, &name, directory, true) {
		Ok(file) => Some(file),
		Err(err)
			if err.reason.starts_with("native-open-error-2:")
				|| err.reason.starts_with("native-open-error-3:") =>
		{
			None
		},
		Err(err) => return Err(err),
	};
	#[cfg(all(not(windows), not(unix)))]
	let file: Option<File> = return Err(error(UNSUPPORTED));
	file
		.map(|file| owned_child(root, &name, file, directory))
		.transpose()
}

#[cfg(windows)]
fn windows_rename_at(
	parent: &File,
	file: &File,
	new_name: &str,
	replace_if_exists: bool,
	operation: &str,
) -> Result<()> {
	#[repr(C)]
	struct FileRenameHeader {
		replace_if_exists: u8,
		root_directory:    HANDLE,
		file_name_length:  u32,
		file_name:         [u16; 1],
	}
	const FILE_RENAME_INFORMATION_CLASS: i32 = 10;

	let wide_name: Vec<u16> = new_name.encode_utf16().collect();
	let file_name_offset = std::mem::offset_of!(FileRenameHeader, file_name);
	let byte_length = wide_name
		.len()
		.checked_mul(size_of::<u16>())
		.ok_or_else(|| error(format!("{operation} name is too long")))?;
	let total = file_name_offset
		.checked_add(byte_length)
		.ok_or_else(|| error(format!("{operation} name is too long")))?;
	let mut storage = vec![0_u64; total.div_ceil(size_of::<u64>())];
	let header = storage.as_mut_ptr().cast::<FileRenameHeader>();
	unsafe {
		(*header).replace_if_exists = u8::from(replace_if_exists);
		(*header).root_directory = parent.as_raw_handle() as HANDLE;
		(*header).file_name_length =
			u32::try_from(byte_length).map_err(|_| error(format!("{operation} name is too long")))?;
		std::ptr::copy_nonoverlapping(
			wide_name.as_ptr().cast::<u8>(),
			storage.as_mut_ptr().cast::<u8>().add(file_name_offset),
			byte_length,
		);
	}
	let mut status_block = NtIoStatusBlock { status: 0, information: 0 };
	let status = unsafe {
		NtSetInformationFile(
			file.as_raw_handle() as HANDLE,
			&mut status_block,
			storage.as_ptr().cast(),
			u32::try_from(total).map_err(|_| error(format!("{operation} name is too long")))?,
			FILE_RENAME_INFORMATION_CLASS,
		)
	};
	if status < 0 {
		let code = unsafe { RtlNtStatusToDosError(status) };
		return Err(error(format!(
			"{operation} failed (NTSTATUS {status:#010x}): {}",
			std::io::Error::from_raw_os_error(code as i32),
		)));
	}
	Ok(())
}

fn publish_owned_file(
	root: &NativeOwnedFile,
	name: &str,
	temporary: &NativeOwnedFile,
) -> Result<()> {
	let parent = validate_owned_directory(root)?;
	#[cfg(unix)]
	let temp_name = temporary
		.state
		.path
		.file_name()
		.and_then(|value| value.to_str())
		.ok_or_else(|| error("temporary native-owned file name is unavailable"))?;
	let temporary_guard = temporary.state.file.lock();
	let temporary_file = temporary_guard
		.as_ref()
		.ok_or_else(|| error("temporary native-owned file is closed"))?;
	#[cfg(unix)]
	{
		let old_name = unix_component(OsStr::new(temp_name)).map_err(|err| error(err.to_string()))?;
		let new_name = unix_component(OsStr::new(name)).map_err(|err| error(err.to_string()))?;
		temporary_file
			.sync_all()
			.map_err(|err| error(format!("sync private replacement: {err}")))?;
		if unsafe {
			libc::renameat(
				parent.as_raw_fd(),
				old_name.as_ptr(),
				parent.as_raw_fd(),
				new_name.as_ptr(),
			)
		} != 0
		{
			return Err(error(format!(
				"publish private replacement: {}",
				std::io::Error::last_os_error()
			)));
		}
		parent
			.sync_all()
			.map_err(|err| error(format!("sync private replacement directory: {err}")))?;
		return Ok(());
	}
	#[cfg(windows)]
	{
		windows_rename_at(&parent, temporary_file, name, true, "publish private replacement")
	}
	#[cfg(all(not(windows), not(unix)))]
	Err(error(UNSUPPORTED))
}

#[cfg(windows)]
fn windows_open_existing_private_directory(path: &Path) -> Result<File> {
	use std::path::Component;
	if !path.is_absolute() {
		return Err(error("private directory must be absolute"));
	}
	let mut components = path.components();
	let Some(Component::Prefix(prefix)) = components.next() else {
		return Err(error("private directory has no Windows volume prefix"));
	};
	if !matches!(components.next(), Some(Component::RootDir)) {
		return Err(error("private directory is not rooted"));
	}
	let names: Vec<String> = components
		.map(|component| match component {
			Component::Normal(name) => name
				.to_str()
				.map(ToOwned::to_owned)
				.ok_or_else(|| error("private directory path is not valid Unicode")),
			_ => Err(error("private directory contains unsafe traversal")),
		})
		.collect::<Result<_>>()?;
	if names.is_empty() {
		return Err(error("private directory cannot be a filesystem root"));
	}
	let mut anchor = PathBuf::from(prefix.as_os_str());
	anchor.push("\\");
	let mut current = windows_open(&anchor, true, false)
		.map_err(|err| error(format!("open private directory volume: {err}")))?;
	reject_reparse(&current)?;
	let last = names.len() - 1;
	for (index, name) in names.into_iter().enumerate() {
		current = windows_runtime_open_at(&current, &name, true, index == last)?;
	}
	Ok(current)
}

#[napi(js_name = "currentProcessIdentity")]
pub fn current_process_identity() -> Result<NativeProcessIdentity> {
	process_identity(std::process::id())
}

#[napi(js_name = "openPrivateDirectory")]
pub fn open_private_directory(path: String) -> Result<NativeOwnedFile> {
	let path = PathBuf::from(path);
	#[cfg(windows)]
	let file = windows_open_existing_private_directory(&path)?;
	#[cfg(not(windows))]
	let file = runtime_open_absolute_directory(&path)?;
	let root = owned_root(path, file)?;
	validate_owned_directory(&root)?;
	Ok(root)
}

#[napi(js_name = "openOrCreatePrivateDirectory")]
pub fn open_or_create_private_directory(path: String) -> Result<NativeOwnedFile> {
	let path = PathBuf::from(path);
	let file = runtime_open_or_create_private_directory(&path)?;
	owned_root(path, file)
}

#[cfg(unix)]
#[napi(js_name = "openOwnerPrivateFile")]
pub fn open_owner_private_file(path: String) -> Result<NativeOwnedFile> {
	let file = NativeOwnedFile::open(path, Some(false))?;
	let guard = file.state.file.lock();
	let held = guard
		.as_ref()
		.ok_or_else(|| error("native-owned file is closed"))?;
	let metadata = held.metadata().map_err(|err| error(err.to_string()))?;
	use std::os::unix::fs::MetadataExt;
	if metadata.uid() != unsafe { libc::geteuid() }
		|| metadata.mode() & 0o077 != 0
		|| metadata.nlink() != 1
	{
		return Err(error("external native-owned file is not owner-private"));
	}
	drop(guard);
	Ok(file)
}

#[cfg(windows)]
#[napi(js_name = "openOwnerPrivateFile")]
pub fn open_owner_private_file(path: String) -> Result<NativeOwnedFile> {
	let file = NativeOwnedFile::open(path, Some(false))?;
	let guard = file.state.file.lock();
	let held = guard
		.as_ref()
		.ok_or_else(|| error("native-owned file is closed"))?;
	let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
	if unsafe { GetFileInformationByHandle(held.as_raw_handle() as HANDLE, &mut information) } == 0 {
		return Err(last_error("read external native-owned file link count"));
	}
	if information.nNumberOfLinks != 1 {
		return Err(error("external native-owned file is not singly linked"));
	}
	windows_validate_owner_private_acl(held)?;
	drop(guard);
	Ok(file)
}

#[cfg(all(not(windows), not(unix)))]
#[napi(js_name = "openOwnerPrivateFile")]
pub fn open_owner_private_file(_path: String) -> Result<NativeOwnedFile> {
	Err(error("external owner-private file verification is unavailable on this platform"))
}

#[napi(js_name = "openOwnedChild")]
pub fn open_owned_child(
	root: &NativeOwnedFile,
	name: String,
	directory: Option<bool>,
) -> Result<Option<NativeOwnedFile>> {
	open_owned_child_optional(root, &name, directory.unwrap_or(false))
}

#[napi(js_name = "openOrCreateOwnedDirectory")]
pub fn open_or_create_owned_directory(
	root: &NativeOwnedFile,
	name: String,
) -> Result<NativeOwnedFile> {
	if let Some(existing) = open_owned_child_optional(root, &name, true)? {
		return Ok(existing);
	}
	let name = private_file_name(Some(&name))?;
	let parent = validate_owned_directory(root)?;
	let directory = runtime_create_directory_at(&parent, &name)?;
	owned_child(root, &name, directory, true)
}

fn validate_owned_replacement_state(
	root: &NativeOwnedFile,
	name: &str,
	expected_identity: Option<&str>,
) -> Result<()> {
	let current = open_owned_child_optional(root, name, false)?;
	match (current.as_ref(), expected_identity) {
		(None, None) => Ok(()),
		(Some(_), None) => Err(error("private replacement destination already exists")),
		(None, Some(_)) => Err(error("private replacement destination is absent")),
		(Some(current), Some(expected)) if current.state.identity == expected => Ok(()),
		(Some(_), Some(_)) => Err(error("private replacement destination identity changed")),
	}
}

#[napi(js_name = "replaceOwnedFileAtomic")]
pub fn replace_owned_file_atomic(
	root: &NativeOwnedFile,
	name: String,
	bytes: Uint8Array,
	expected_identity: Option<String>,
) -> Result<NativeOwnedFile> {
	let _mutation = root.state.mutation_lock.lock();
	let name = private_file_name(Some(&name))?;
	validate_owned_replacement_state(root, &name, expected_identity.as_deref())?;
	let temp_name = private_file_name(None)?;
	let temporary = create_private_owned(root, temp_name, &bytes)?;
	if let Err(err) = validate_owned_replacement_state(root, &name, expected_identity.as_deref()) {
		let _ = temporary.cleanup();
		return Err(err);
	}
	if let Err(err) = publish_owned_file(root, &name, &temporary) {
		let _ = temporary.cleanup();
		return Err(err);
	}
	open_owned_child_optional(root, &name, false)?
		.ok_or_else(|| error("published private replacement is unavailable"))
}

#[napi(js_name = "removeOwnedFileAtomic")]
pub fn remove_owned_file_atomic(
	root: &NativeOwnedFile,
	name: String,
	expected_identity: String,
) -> Result<()> {
	let _mutation = root.state.mutation_lock.lock();
	let current = open_owned_child_optional(root, &name, false)?
		.ok_or_else(|| error("private removal destination is absent"))?;
	if current.state.identity != expected_identity {
		return Err(error("private removal destination identity changed"));
	}
	current.cleanup()
}

#[cfg(unix)]
fn remove_owned_tree_contents(directory: &File, depth: usize, entries: &mut usize) -> Result<()> {
	const MAX_TREE_DEPTH: usize = 64;
	const MAX_TREE_ENTRIES: usize = 100_000;
	if depth > MAX_TREE_DEPTH {
		return Err(error("native-owned tree exceeds cleanup depth limit"));
	}
	let descriptor = unsafe { libc::dup(directory.as_raw_fd()) };
	if descriptor < 0 {
		return Err(error(format!(
			"duplicate native-owned directory: {}",
			std::io::Error::last_os_error()
		)));
	}
	let stream = unsafe { libc::fdopendir(descriptor) };
	if stream.is_null() {
		unsafe {
			libc::close(descriptor);
		}
		return Err(error(format!(
			"enumerate native-owned directory: {}",
			std::io::Error::last_os_error()
		)));
	}
	loop {
		let entry = unsafe { libc::readdir(stream) };
		if entry.is_null() {
			break;
		}
		let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
		if name.to_bytes() == b"." || name.to_bytes() == b".." {
			continue;
		}
		*entries += 1;
		if *entries > MAX_TREE_ENTRIES {
			unsafe {
				libc::closedir(stream);
			}
			return Err(error("native-owned tree exceeds cleanup entry limit"));
		}
		let name = name.to_owned();
		match unix_openat(directory.as_raw_fd(), &name, libc::O_RDONLY | libc::O_DIRECTORY) {
			Ok(child) => {
				if let Err(err) = remove_owned_tree_contents(&child, depth + 1, entries) {
					unsafe {
						libc::closedir(stream);
					}
					return Err(err);
				}
				if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
					!= 0
				{
					unsafe {
						libc::closedir(stream);
					}
					return Err(error(format!(
						"remove native-owned directory: {}",
						std::io::Error::last_os_error()
					)));
				}
			},
			Err(_) => {
				if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
					unsafe {
						libc::closedir(stream);
					}
					return Err(error(format!(
						"remove native-owned entry: {}",
						std::io::Error::last_os_error()
					)));
				}
			},
		}
	}
	if unsafe { libc::closedir(stream) } != 0 {
		return Err(error(format!(
			"close native-owned directory enumeration: {}",
			std::io::Error::last_os_error()
		)));
	}
	Ok(())
}
#[cfg(windows)]
fn windows_open_tree_entry_at(parent: &File, name: &str, directory: bool) -> Result<File> {
	const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
	const OBJ_DONT_REPARSE: u32 = 0x0000_1000;
	const FILE_OPEN: u32 = 1;
	const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
	const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
	const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
	const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
	let mut wide_name: Vec<u16> = name.encode_utf16().collect();
	let name_bytes = u16::try_from(wide_name.len().saturating_mul(size_of::<u16>()))
		.map_err(|_| error("native-owned tree entry name is too long"))?;
	let mut unicode_name = NtUnicodeString {
		length:         name_bytes,
		maximum_length: name_bytes,
		buffer:         wide_name.as_mut_ptr(),
	};
	let mut attributes = NtObjectAttributes {
		length: size_of::<NtObjectAttributes>() as u32,
		root_directory: parent.as_raw_handle() as HANDLE,
		object_name: &mut unicode_name,
		attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
		security_descriptor: std::ptr::null_mut(),
		security_quality_of_service: std::ptr::null_mut(),
	};
	let mut status_block = NtIoStatusBlock { status: 0, information: 0 };
	let mut handle = std::ptr::null_mut();
	let status = unsafe {
		NtCreateFile(
			&mut handle,
			GENERIC_READ | DELETE | PROCESS_SYNCHRONIZE_ACCESS,
			&mut attributes,
			&mut status_block,
			std::ptr::null(),
			FILE_ATTRIBUTE_NORMAL,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
			FILE_OPEN,
			(if directory {
				FILE_DIRECTORY_FILE
			} else {
				FILE_NON_DIRECTORY_FILE
			}) | FILE_SYNCHRONOUS_IO_NONALERT
				| FILE_OPEN_REPARSE_POINT,
			std::ptr::null(),
			0,
		)
	};
	if status < 0 {
		let code = unsafe { RtlNtStatusToDosError(status) };
		return Err(error(format!(
			"open native-owned tree entry: {}",
			std::io::Error::from_raw_os_error(code as i32)
		)));
	}
	Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
}

#[cfg(windows)]
fn windows_owned_tree_entry_names(directory: &File) -> Result<Vec<String>> {
	const FILE_NAMES_INFORMATION: i32 = 12;
	const STATUS_NO_MORE_FILES: i32 = 0x8000_0006_u32 as i32;
	const MAX_TREE_ENTRIES: usize = 100_000;
	let mut names = Vec::new();
	let mut restart_scan = 1;
	loop {
		let mut buffer = vec![0_u8; 65_536];
		let mut status_block = NtIoStatusBlock { status: 0, information: 0 };
		let status = unsafe {
			NtQueryDirectoryFile(
				directory.as_raw_handle() as HANDLE,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				&mut status_block,
				buffer.as_mut_ptr().cast(),
				buffer.len() as u32,
				FILE_NAMES_INFORMATION,
				1,
				std::ptr::null_mut(),
				restart_scan,
			)
		};
		restart_scan = 0;
		if status == STATUS_NO_MORE_FILES {
			break;
		}
		if status < 0 {
			let code = unsafe { RtlNtStatusToDosError(status) };
			return Err(error(format!(
				"enumerate native-owned directory: {}",
				std::io::Error::from_raw_os_error(code as i32)
			)));
		}
		let used = status_block.information.min(buffer.len());
		if used < 12 {
			return Err(error("native-owned directory returned a malformed entry"));
		}
		let name_length = u32::from_le_bytes(buffer[8..12].try_into().unwrap()) as usize;
		if name_length % size_of::<u16>() != 0 || 12 + name_length > used {
			return Err(error("native-owned directory returned an invalid entry name"));
		}
		let wide_name = buffer[12..12 + name_length]
			.chunks_exact(2)
			.map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
			.collect::<Vec<_>>();
		let name = String::from_utf16(&wide_name)
			.map_err(|_| error("native-owned directory entry name is not valid UTF-16"))?;
		if name == "." || name == ".." {
			continue;
		}
		names.push(name);
		if names.len() > MAX_TREE_ENTRIES {
			return Err(error("native-owned tree exceeds cleanup entry limit"));
		}
	}
	Ok(names)
}

#[cfg(windows)]
fn remove_owned_tree_contents_windows(
	directory: &File,
	depth: usize,
	entries: &mut usize,
) -> Result<()> {
	const MAX_TREE_DEPTH: usize = 64;
	const MAX_TREE_ENTRIES: usize = 100_000;
	if depth > MAX_TREE_DEPTH {
		return Err(error("native-owned tree exceeds cleanup depth limit"));
	}
	for name in windows_owned_tree_entry_names(directory)? {
		*entries += 1;
		if *entries > MAX_TREE_ENTRIES {
			return Err(error("native-owned tree exceeds cleanup entry limit"));
		}
		match windows_open_tree_entry_at(directory, &name, true) {
			Ok(child) => {
				if reject_reparse(&child).is_ok() {
					remove_owned_tree_contents_windows(&child, depth + 1, entries)?;
				}
				windows_mark_delete(&child)?;
			},
			Err(_) => {
				let child = windows_open_tree_entry_at(directory, &name, false)?;
				windows_mark_delete(&child)?;
			},
		}
	}
	Ok(())
}

#[napi(js_name = "removeOwnedTreeAtomic")]
pub fn remove_owned_tree_atomic(
	root: &NativeOwnedFile,
	name: String,
	expected_identity: String,
) -> Result<()> {
	let _mutation = root.state.mutation_lock.lock();
	let current = open_owned_child_optional(root, &name, true)?
		.ok_or_else(|| error("private tree removal destination is absent"))?;
	if current.state.identity != expected_identity {
		return Err(error("private tree removal destination identity changed"));
	}
	#[cfg(unix)]
	{
		let directory = current
			.state
			.file
			.lock()
			.as_ref()
			.ok_or_else(|| error("private tree removal destination is closed"))?
			.try_clone()
			.map_err(|err| error(err.to_string()))?;
		remove_owned_tree_contents(&directory, 0, &mut 0)?;
		return current.cleanup();
	}
	#[cfg(windows)]
	{
		let directory = current
			.state
			.file
			.lock()
			.as_ref()
			.ok_or_else(|| error("private tree removal destination is closed"))?
			.try_clone()
			.map_err(|err| error(err.to_string()))?;
		remove_owned_tree_contents_windows(&directory, 0, &mut 0)?;
		return current.cleanup();
	}
	#[cfg(all(not(windows), not(unix)))]
	Err(error(UNSUPPORTED))
}

#[napi(js_name = "matchesOwnedChild")]
pub fn matches_owned_child(
	root: &NativeOwnedFile,
	name: String,
	expected_identity: String,
	directory: Option<bool>,
) -> bool {
	open_owned_child_optional(root, &name, directory.unwrap_or(false))
		.is_ok_and(|current| current.is_some_and(|entry| entry.state.identity == expected_identity))
}

#[napi(js_name = "acquireOwnedFileLock")]
pub fn acquire_owned_file_lock(root: &NativeOwnedFile, name: String) -> Result<NativeOwnedFile> {
	let _mutation = root.state.mutation_lock.lock();
	let name = private_file_name(Some(&name))?;
	let lock = match open_owned_child_optional(root, &name, false)? {
		Some(lock) => lock,
		None => match create_private_owned(root, name.clone(), &[]) {
			Ok(lock) => lock,
			Err(_) => open_owned_child_optional(root, &name, false)?
				.ok_or_else(|| error("native-owned lock creation raced with removal"))?,
		},
	};
	let guard = lock.state.file.lock();
	let file = guard
		.as_ref()
		.ok_or_else(|| error("native-owned lock is closed"))?;
	#[cfg(unix)]
	if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
		return Err(error(format!(
			"native-owned state is locked: {}",
			std::io::Error::last_os_error()
		)));
	}
	#[cfg(windows)]
	{
		let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
		if unsafe {
			LockFileEx(
				file.as_raw_handle() as HANDLE,
				LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
				0,
				1,
				0,
				&mut overlapped,
			)
		} == 0
		{
			return Err(last_error("native-owned state is locked"));
		}
	}
	let current = open_owned_child_optional(root, &name, false)?
		.ok_or_else(|| error("native-owned lock was replaced after acquisition"))?;
	if current.state.identity != lock.state.identity {
		return Err(error("native-owned lock was replaced after acquisition"));
	}
	drop(guard);
	Ok(lock)
}

const RUNTIME_METADATA_MAX_BYTES: u64 = 1024 * 1024;
const RUNTIME_PATH_MAX_BYTES: usize = 512;
const RUNTIME_FILE_MAX_COUNT: usize = 65_536;
const RUNTIME_EXTERNALS: [&str; 3] =
	["@modelcontextprotocol/sdk", "@oh-my-pi/pi-natives", "playwright-core"];

#[napi(object)]
#[derive(Clone)]
pub struct RuntimeExpectedIdentity {
	pub version:  String,
	pub platform: String,
	pub arch:     String,
}

#[napi(object)]
pub struct OpenRuntimeBundleSpec {
	pub root:     String,
	pub expected: RuntimeExpectedIdentity,
}

#[napi(object)]
pub struct RuntimeBundleInspection {
	pub manifest:        serde_json::Value,
	pub checksums:       serde_json::Value,
	pub metadata_digest: String,
}

struct RuntimeBundleHandles {
	root:  File,
	files: BTreeMap<String, File>,
}

struct RuntimeBundleState {
	root_path:       PathBuf,
	expected:        RuntimeExpectedIdentity,
	manifest:        serde_json::Value,
	checksums:       serde_json::Value,
	checksum_files:  BTreeMap<String, String>,
	checksums_bytes: Vec<u8>,
	metadata_digest: String,
	handles:         Mutex<Option<RuntimeBundleHandles>>,
}

/// Opaque authority over a validated runtime bundle. No pathname is exposed.
#[napi]
#[derive(Clone)]
pub struct NativeRuntimeBundle {
	state: Arc<RuntimeBundleState>,
}

#[napi]
impl NativeRuntimeBundle {
	#[napi]
	pub fn close(&self) {
		self.state.handles.lock().take();
	}
}

fn runtime_safe_relative_path(value: &str) -> bool {
	if value.is_empty()
		|| value.len() > RUNTIME_PATH_MAX_BYTES
		|| value.contains('\0')
		|| value.contains('\\')
		|| value.starts_with('/')
	{
		return false;
	}
	let mut count = 0_usize;
	for component in value.split('/') {
		if component.is_empty() || component == "." || component == ".." {
			return false;
		}
		count += 1;
	}
	count > 0
}

fn validate_runtime_expected(expected: &RuntimeExpectedIdentity) -> Result<()> {
	if expected.version.is_empty()
		|| expected.version.len() > 128
		|| !expected
			.version
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
	{
		return Err(error("runtime version is invalid"));
	}
	if !matches!(expected.platform.as_str(), "darwin" | "linux" | "win32")
		|| !matches!(expected.arch.as_str(), "arm64" | "x64")
	{
		return Err(error("runtime target is unsupported"));
	}
	Ok(())
}

fn json_object<'a>(
	value: &'a serde_json::Value,
	label: &str,
) -> Result<&'a serde_json::Map<String, serde_json::Value>> {
	value
		.as_object()
		.ok_or_else(|| error(format!("{label} must be an object")))
}

fn json_string<'a>(
	object: &'a serde_json::Map<String, serde_json::Value>,
	key: &str,
	label: &str,
) -> Result<&'a str> {
	object
		.get(key)
		.and_then(serde_json::Value::as_str)
		.ok_or_else(|| error(format!("{label}.{key} must be a string")))
}

fn validate_runtime_metadata(
	manifest: &serde_json::Value,
	checksums: &serde_json::Value,
	expected: &RuntimeExpectedIdentity,
) -> Result<BTreeMap<String, String>> {
	let manifest = json_object(manifest, "runtime manifest")?;
	if manifest
		.get("schemaVersion")
		.and_then(serde_json::Value::as_u64)
		!= Some(1)
		|| json_string(manifest, "appVersion", "runtime manifest")? != expected.version
		|| json_string(manifest, "platform", "runtime manifest")? != expected.platform
		|| json_string(manifest, "arch", "runtime manifest")? != expected.arch
	{
		return Err(error("runtime manifest identity mismatch"));
	}

	let entrypoints = manifest
		.get("entrypoints")
		.ok_or_else(|| error("runtime manifest entrypoints are absent"))
		.and_then(|value| json_object(value, "runtime manifest entrypoints"))?;
	if json_string(entrypoints, "cli", "runtime manifest entrypoints")? != "app/cli.js"
		|| json_string(entrypoints, "mcp", "runtime manifest entrypoints")? != "app/mcp-main.js"
	{
		return Err(error("runtime manifest fixed entrypoints are invalid"));
	}

	let executable = if expected.platform == "win32" {
		"runtime/bun.exe"
	} else {
		"runtime/bun"
	};
	let runtime = manifest
		.get("runtime")
		.ok_or_else(|| error("runtime manifest runtime is absent"))
		.and_then(|value| json_object(value, "runtime manifest runtime"))?;
	if json_string(runtime, "kind", "runtime manifest runtime")? != "bun"
		|| json_string(runtime, "executable", "runtime manifest runtime")? != executable
		|| json_string(runtime, "version", "runtime manifest runtime")?.is_empty()
	{
		return Err(error("runtime manifest runtime identity is invalid"));
	}

	let native = manifest
		.get("native")
		.ok_or_else(|| error("runtime manifest native metadata is absent"))
		.and_then(|value| json_object(value, "runtime manifest native metadata"))?;
	let native_addon = json_string(native, "addon", "runtime manifest native metadata")?;
	let native_digest = json_string(native, "sha256", "runtime manifest native metadata")?;
	if json_string(native, "package", "runtime manifest native metadata")? != "@oh-my-pi/pi-natives"
		|| json_string(native, "version", "runtime manifest native metadata")? != expected.version
		|| json_string(native, "platformTag", "runtime manifest native metadata")?
			!= format!("{}-{}", expected.platform, expected.arch)
		|| native
			.get("napiAbi")
			.and_then(serde_json::Value::as_u64)
			.is_none()
		|| !runtime_safe_relative_path(json_string(
			native,
			"packageRoot",
			"runtime manifest native metadata",
		)?) || !runtime_safe_relative_path(json_string(
		native,
		"leafRoot",
		"runtime manifest native metadata",
	)?) || !runtime_safe_relative_path(native_addon)
		|| !is_lower_sha256(native_digest)
	{
		return Err(error("runtime manifest native metadata is invalid"));
	}

	let externals = manifest
		.get("externals")
		.and_then(serde_json::Value::as_array)
		.ok_or_else(|| error("runtime manifest externals are invalid"))?;
	let mut actual_externals = externals
		.iter()
		.map(|value| {
			value
				.as_str()
				.ok_or_else(|| error("runtime manifest externals are invalid"))
		})
		.collect::<Result<Vec<_>>>()?;
	actual_externals.sort_unstable();
	if actual_externals != RUNTIME_EXTERNALS {
		return Err(error("runtime manifest externals are invalid"));
	}

	let checksums_object = json_object(checksums, "runtime checksums")?;
	if json_string(checksums_object, "algorithm", "runtime checksums")? != "sha256" {
		return Err(error("runtime checksum algorithm is invalid"));
	}
	let files_object = checksums_object
		.get("files")
		.ok_or_else(|| error("runtime checksum files are absent"))
		.and_then(|value| json_object(value, "runtime checksum files"))?;
	if files_object.is_empty() || files_object.len() > RUNTIME_FILE_MAX_COUNT {
		return Err(error("runtime checksum file count is invalid"));
	}
	let mut files = BTreeMap::new();
	for (relative_path, digest) in files_object {
		let digest = digest
			.as_str()
			.ok_or_else(|| error("runtime checksum digest must be a string"))?;
		if !runtime_safe_relative_path(relative_path)
			|| relative_path == "checksums.json"
			|| !is_lower_sha256(digest)
		{
			return Err(error("runtime checksum entry is invalid"));
		}
		files.insert(relative_path.clone(), digest.to_owned());
	}
	for required in [executable, "app/cli.js", "app/mcp-main.js", "manifest.json", native_addon] {
		if !files.contains_key(required) {
			return Err(error(format!("runtime required checksum is absent: {required}")));
		}
	}
	if files.get(native_addon).map(String::as_str) != Some(native_digest) {
		return Err(error("runtime native checksum does not match native metadata"));
	}
	Ok(files)
}

fn is_lower_sha256(value: &str) -> bool {
	value.len() == 64
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn read_bounded_runtime_metadata(file: &File, label: &str) -> Result<Vec<u8>> {
	let length = file
		.metadata()
		.map_err(|err| error(format!("{label}: {err}")))?
		.len();
	if length == 0 || length > RUNTIME_METADATA_MAX_BYTES {
		return Err(error(format!("{label} has invalid size")));
	}
	let mut reader = file
		.try_clone()
		.map_err(|err| error(format!("{label}: {err}")))?;
	reader
		.seek(SeekFrom::Start(0))
		.map_err(|err| error(format!("{label}: {err}")))?;
	let mut bytes = Vec::with_capacity(length as usize);
	reader
		.take(RUNTIME_METADATA_MAX_BYTES + 1)
		.read_to_end(&mut bytes)
		.map_err(|err| error(format!("{label}: {err}")))?;
	if bytes.len() as u64 != length || bytes.len() as u64 > RUNTIME_METADATA_MAX_BYTES {
		return Err(error(format!("{label} changed while it was read")));
	}
	Ok(bytes)
}

fn runtime_metadata_digest(manifest: &[u8], checksums: &[u8]) -> String {
	let mut digest = Sha256::new();
	digest.update(b"omp-runtime-metadata-v1\0");
	digest.update((manifest.len() as u64).to_le_bytes());
	digest.update(manifest);
	digest.update((checksums.len() as u64).to_le_bytes());
	digest.update(checksums);
	hex(&digest.finalize())
}

#[cfg(unix)]
fn runtime_open_absolute_directory(path: &Path) -> Result<File> {
	if !path.is_absolute() {
		return Err(error("runtime bundle root must be absolute"));
	}
	let (file, ..) = unix_open_held(path, true, false)
		.map_err(|err| error(format!("open runtime root: {err}")))?;
	Ok(file)
}

#[cfg(windows)]
fn windows_runtime_open_at(
	parent: &File,
	name: &str,
	directory: bool,
	write: bool,
) -> Result<File> {
	const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
	const FILE_OPEN: u32 = 1;
	const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
	const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
	const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
	const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

	let mut wide_name: Vec<u16> = name.encode_utf16().collect();
	let name_bytes = u16::try_from(wide_name.len().saturating_mul(size_of::<u16>()))
		.map_err(|_| error("runtime path component is too long"))?;
	let mut unicode_name = NtUnicodeString {
		length:         name_bytes,
		maximum_length: name_bytes,
		buffer:         wide_name.as_mut_ptr(),
	};
	let mut attributes = NtObjectAttributes {
		length: size_of::<NtObjectAttributes>() as u32,
		root_directory: parent.as_raw_handle() as HANDLE,
		object_name: &mut unicode_name,
		attributes: OBJ_CASE_INSENSITIVE,
		security_descriptor: std::ptr::null_mut(),
		security_quality_of_service: std::ptr::null_mut(),
	};
	let mut status_block = NtIoStatusBlock { status: 0, information: 0 };
	let mut handle = std::ptr::null_mut();
	let status = unsafe {
		NtCreateFile(
			&mut handle,
			if write {
				GENERIC_READ | GENERIC_WRITE | DELETE | PROCESS_SYNCHRONIZE_ACCESS | WRITE_DAC
			} else {
				GENERIC_READ | PROCESS_SYNCHRONIZE_ACCESS
			},
			&mut attributes,
			&mut status_block,
			std::ptr::null(),
			FILE_ATTRIBUTE_NORMAL,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
			FILE_OPEN,
			(if directory {
				FILE_DIRECTORY_FILE
			} else {
				FILE_NON_DIRECTORY_FILE
			}) | FILE_SYNCHRONOUS_IO_NONALERT
				| FILE_OPEN_REPARSE_POINT,
			std::ptr::null(),
			0,
		)
	};
	if status < 0 {
		let code = unsafe { RtlNtStatusToDosError(status) };
		return Err(error(format!(
			"native-open-error-{code}: {}",
			std::io::Error::from_raw_os_error(code as i32)
		)));
	}
	let file = unsafe { File::from_raw_handle(handle as RawHandle) };
	reject_reparse(&file)?;
	let metadata = file.metadata().map_err(|err| error(err.to_string()))?;
	if metadata.is_dir() != directory || (!directory && !metadata.is_file()) {
		return Err(error("runtime path has the wrong file type"));
	}
	Ok(file)
}

#[cfg(windows)]
fn runtime_open_absolute_directory(path: &Path) -> Result<File> {
	use std::path::Component;

	if !path.is_absolute() {
		return Err(error("runtime bundle root must be absolute"));
	}
	let mut components = path.components();
	let Some(Component::Prefix(prefix)) = components.next() else {
		return Err(error("runtime bundle root has no Windows volume prefix"));
	};
	if !matches!(components.next(), Some(Component::RootDir)) {
		return Err(error("runtime bundle root is not rooted"));
	}
	let mut anchor = PathBuf::from(prefix.as_os_str());
	anchor.push("\\");
	let mut current = windows_open(&anchor, true, false)
		.map_err(|err| error(format!("open runtime volume: {err}")))?;
	reject_reparse(&current)?;
	for component in components {
		let Component::Normal(name) = component else {
			return Err(error("runtime bundle root contains unsafe traversal"));
		};
		let name = name
			.to_str()
			.ok_or_else(|| error("runtime path is not valid Unicode"))?;
		current = windows_runtime_open_at(&current, name, true, false)?;
	}
	Ok(current)
}

#[cfg(all(not(windows), not(unix)))]
fn runtime_open_absolute_directory(_path: &Path) -> Result<File> {
	Err(error(UNSUPPORTED))
}

#[cfg(unix)]
fn runtime_open_file_at(root: &File, relative_path: &str) -> Result<File> {
	let mut current = root.try_clone().map_err(|err| error(err.to_string()))?;
	let mut components = relative_path.split('/').peekable();
	while let Some(component) = components.next() {
		let component =
			unix_component(OsStr::new(component)).map_err(|err| error(err.to_string()))?;
		current = unix_openat(
			current.as_raw_fd(),
			&component,
			if components.peek().is_some() {
				libc::O_RDONLY | libc::O_DIRECTORY
			} else {
				libc::O_RDONLY
			},
		)
		.map_err(|err| error(format!("open runtime file {relative_path}: {err}")))?;
	}
	Ok(current)
}

#[cfg(windows)]
fn runtime_open_file_at(root: &File, relative_path: &str) -> Result<File> {
	let mut current = root.try_clone().map_err(|err| error(err.to_string()))?;
	let mut components = relative_path.split('/').peekable();
	while let Some(component) = components.next() {
		current = windows_runtime_open_at(&current, component, components.peek().is_some(), false)?;
	}
	Ok(current)
}

#[cfg(all(not(windows), not(unix)))]
fn runtime_open_file_at(_root: &File, _relative_path: &str) -> Result<File> {
	Err(error(UNSUPPORTED))
}

fn validate_runtime_regular_file(file: &File, relative_path: &str) -> Result<()> {
	let metadata = file
		.metadata()
		.map_err(|err| error(format!("inspect runtime file {relative_path}: {err}")))?;
	if !metadata.is_file() {
		return Err(error(format!("runtime resource is not a regular file: {relative_path}")));
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		if metadata.nlink() != 1 {
			return Err(error(format!("runtime resource has an unsafe link count: {relative_path}")));
		}
	}
	#[cfg(windows)]
	if windows_file_information(file)
		.map_err(|err| error(format!("inspect runtime file identity {relative_path}: {err}")))?
		.nNumberOfLinks
		!= 1
	{
		return Err(error(format!("runtime resource has an unsafe link count: {relative_path}")));
	}
	Ok(())
}

fn verify_runtime_handles(
	state: &RuntimeBundleState,
	handles: &RuntimeBundleHandles,
) -> Result<()> {
	for (relative_path, expected_digest) in &state.checksum_files {
		let file = handles
			.files
			.get(relative_path)
			.ok_or_else(|| error(format!("runtime held file is absent: {relative_path}")))?;
		validate_runtime_regular_file(file, relative_path)?;
		let actual =
			sha256(file).map_err(|err| error(format!("hash runtime file {relative_path}: {err}")))?;
		if &actual != expected_digest {
			return Err(error(format!("runtime SHA-256 mismatch: {relative_path}")));
		}
	}
	Ok(())
}

fn open_runtime_bundle_from_root(
	root_path: PathBuf,
	root: File,
	expected: RuntimeExpectedIdentity,
) -> Result<NativeRuntimeBundle> {
	let manifest_file = runtime_open_file_at(&root, "manifest.json")?;
	let checksums_file = runtime_open_file_at(&root, "checksums.json")?;
	validate_runtime_regular_file(&manifest_file, "manifest.json")?;
	validate_runtime_regular_file(&checksums_file, "checksums.json")?;
	let manifest_bytes = read_bounded_runtime_metadata(&manifest_file, "runtime manifest")?;
	let checksums_bytes = read_bounded_runtime_metadata(&checksums_file, "runtime checksums")?;
	if manifest_bytes.len() as u64 + checksums_bytes.len() as u64 > RUNTIME_METADATA_MAX_BYTES {
		return Err(error("runtime metadata is oversized"));
	}
	let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
		.map_err(|err| error(format!("parse runtime manifest: {err}")))?;
	let checksums: serde_json::Value = serde_json::from_slice(&checksums_bytes)
		.map_err(|err| error(format!("parse runtime checksums: {err}")))?;
	let checksum_files = validate_runtime_metadata(&manifest, &checksums, &expected)?;
	let metadata_digest = runtime_metadata_digest(&manifest_bytes, &checksums_bytes);
	let mut files = BTreeMap::new();
	for relative_path in checksum_files.keys() {
		let file = if relative_path == "manifest.json" {
			manifest_file
				.try_clone()
				.map_err(|err| error(err.to_string()))?
		} else {
			runtime_open_file_at(&root, relative_path)?
		};
		validate_runtime_regular_file(&file, relative_path)?;
		files.insert(relative_path.clone(), file);
	}
	let state = RuntimeBundleState {
		root_path,
		expected,
		manifest,
		checksums,
		checksum_files,
		checksums_bytes,
		metadata_digest,
		handles: Mutex::new(Some(RuntimeBundleHandles { root, files })),
	};
	let capability = NativeRuntimeBundle { state: Arc::new(state) };
	{
		let guard = capability.state.handles.lock();
		verify_runtime_handles(
			&capability.state,
			guard
				.as_ref()
				.ok_or_else(|| error("runtime bundle capability is closed"))?,
		)?;
	}
	Ok(capability)
}

#[napi(js_name = "openRuntimeBundle")]
pub fn open_runtime_bundle(spec: OpenRuntimeBundleSpec) -> Result<NativeRuntimeBundle> {
	validate_runtime_expected(&spec.expected)?;
	let root_path = PathBuf::from(spec.root);
	let root = runtime_open_absolute_directory(&root_path)?;
	if !root
		.metadata()
		.map_err(|err| error(err.to_string()))?
		.is_dir()
	{
		return Err(error("runtime bundle root is not a directory"));
	}
	open_runtime_bundle_from_root(root_path, root, spec.expected)
}

#[napi(js_name = "verifyRuntimeBundle")]
pub fn verify_runtime_bundle(spec: Object<'_>) -> Result<RuntimeBundleInspection> {
	let bundle: ClassInstance<NativeRuntimeBundle> = spec.get_named_property("bundle")?;
	let expected: RuntimeExpectedIdentity = spec.get_named_property("expected")?;
	validate_runtime_expected(&expected)?;
	if bundle.state.expected.version != expected.version
		|| bundle.state.expected.platform != expected.platform
		|| bundle.state.expected.arch != expected.arch
	{
		return Err(error("runtime bundle capability identity mismatch"));
	}
	let guard = bundle.state.handles.lock();
	let handles = guard
		.as_ref()
		.ok_or_else(|| error("runtime bundle capability is closed"))?;
	verify_runtime_handles(&bundle.state, handles)?;
	Ok(RuntimeBundleInspection {
		manifest:        bundle.state.manifest.clone(),
		checksums:       bundle.state.checksums.clone(),
		metadata_digest: bundle.state.metadata_digest.clone(),
	})
}

#[cfg(unix)]
fn runtime_open_or_create_private_directory(path: &Path) -> Result<File> {
	use std::{os::unix::fs::MetadataExt, path::Component};

	if !path.is_absolute() {
		return Err(error("runtime versions root must be absolute"));
	}
	let start_fd =
		unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY) };
	if start_fd < 0 {
		return Err(error(format!(
			"open runtime versions volume: {}",
			std::io::Error::last_os_error()
		)));
	}
	let mut current = unsafe { File::from_raw_fd(start_fd) };
	let mut saw_component = false;
	for component in path.components() {
		match component {
			Component::RootDir => {},
			Component::Normal(name) => {
				saw_component = true;
				let name = unix_component(name).map_err(|err| error(err.to_string()))?;
				current =
					match unix_openat(current.as_raw_fd(), &name, libc::O_RDONLY | libc::O_DIRECTORY) {
						Ok(directory) => directory,
						Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
							if unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
								return Err(error(format!(
									"create private runtime directory: {}",
									std::io::Error::last_os_error()
								)));
							}
							unix_openat(current.as_raw_fd(), &name, libc::O_RDONLY | libc::O_DIRECTORY)
								.map_err(|err| error(format!("open created runtime directory: {err}")))?
						},
						Err(err) => return Err(error(format!("open runtime versions directory: {err}"))),
					};
			},
			Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
				return Err(error("runtime versions root contains unsafe traversal"));
			},
		}
	}
	if !saw_component {
		return Err(error("runtime versions root cannot be a filesystem root"));
	}
	let metadata = current.metadata().map_err(|err| error(err.to_string()))?;
	if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
		return Err(error("runtime versions root is not an owner-controlled directory"));
	}
	if unsafe { libc::fchmod(current.as_raw_fd(), 0o700) } != 0 {
		return Err(error(format!(
			"make runtime versions root private: {}",
			std::io::Error::last_os_error()
		)));
	}
	let metadata = current.metadata().map_err(|err| error(err.to_string()))?;
	if metadata.mode() & 0o077 != 0 {
		return Err(error("runtime versions root is not owner-private"));
	}
	Ok(current)
}

#[cfg(windows)]
fn windows_runtime_create_private_directory_at(parent: &File, name: &str) -> Result<File> {
	const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
	const OBJ_DONT_REPARSE: u32 = 0x0000_1000;
	const FILE_CREATE: u32 = 2;
	const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
	const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
	const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

	let mut security = owner_only_pipe_security()?;
	let mut wide_name: Vec<u16> = name.encode_utf16().collect();
	let name_bytes = u16::try_from(wide_name.len().saturating_mul(size_of::<u16>()))
		.map_err(|_| error("runtime directory name is too long"))?;
	let mut unicode_name = NtUnicodeString {
		length:         name_bytes,
		maximum_length: name_bytes,
		buffer:         wide_name.as_mut_ptr(),
	};
	let mut attributes = NtObjectAttributes {
		length: size_of::<NtObjectAttributes>() as u32,
		root_directory: parent.as_raw_handle() as HANDLE,
		object_name: &mut unicode_name,
		attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
		security_descriptor: security.descriptor.as_mut() as *mut _ as *mut _,
		security_quality_of_service: std::ptr::null_mut(),
	};
	let mut status_block = NtIoStatusBlock { status: 0, information: 0 };
	let mut handle = std::ptr::null_mut();
	let status = unsafe {
		NtCreateFile(
			&mut handle,
			GENERIC_READ | GENERIC_WRITE | DELETE | PROCESS_SYNCHRONIZE_ACCESS | WRITE_DAC,
			&mut attributes,
			&mut status_block,
			std::ptr::null(),
			FILE_ATTRIBUTE_NORMAL,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
			FILE_CREATE,
			FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
			std::ptr::null(),
			0,
		)
	};
	if status < 0 {
		let code = unsafe { RtlNtStatusToDosError(status) };
		return Err(error(format!(
			"create private runtime directory: {}",
			std::io::Error::from_raw_os_error(code as i32)
		)));
	}
	let directory = unsafe { File::from_raw_handle(handle as RawHandle) };
	reject_reparse(&directory)?;
	if !directory
		.metadata()
		.map_err(|err| error(err.to_string()))?
		.is_dir()
	{
		return Err(error("created runtime path is not a directory"));
	}
	windows_make_runtime_directory_private(&directory)?;
	Ok(directory)
}

#[cfg(windows)]
fn windows_validate_current_owner(handle: &File, expected_sid: &[u8]) -> Result<()> {
	const SE_FILE_OBJECT: i32 = 1;
	const OWNER_SECURITY_INFORMATION: u32 = 0x0000_0001;
	let mut owner = std::ptr::null_mut();
	let mut descriptor = std::ptr::null_mut();
	let result = unsafe {
		GetSecurityInfo(
			handle.as_raw_handle() as HANDLE,
			SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION,
			&mut owner,
			std::ptr::null_mut(),
			std::ptr::null_mut(),
			std::ptr::null_mut(),
			&mut descriptor,
		)
	};
	if result != 0 {
		return Err(error(format!(
			"read runtime directory owner: {}",
			std::io::Error::from_raw_os_error(result as i32),
		)));
	}
	let matches = if owner.is_null() {
		false
	} else {
		let owner_len = unsafe { GetLengthSid(owner) } as usize;
		owner_len == expected_sid.len()
			&& unsafe { std::slice::from_raw_parts(owner.cast::<u8>(), owner_len) == expected_sid }
	};
	if !descriptor.is_null() {
		unsafe {
			LocalFree(descriptor);
		}
	}
	if matches {
		Ok(())
	} else {
		Err(error("runtime directory is owned by a different Windows account"))
	}
}

#[cfg(windows)]
fn windows_validate_owner_private_acl(file: &File) -> Result<()> {
	const SE_FILE_OBJECT: i32 = 1;
	const OWNER_SECURITY_INFORMATION: u32 = 0x0000_0001;
	const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
	const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

	let expected = owner_only_pipe_security()?;
	let mut owner = std::ptr::null_mut();
	let mut dacl = std::ptr::null_mut();
	let mut descriptor = std::ptr::null_mut();
	let status = unsafe {
		GetSecurityInfo(
			file.as_raw_handle() as HANDLE,
			SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
			&mut owner,
			std::ptr::null_mut(),
			&mut dacl,
			std::ptr::null_mut(),
			&mut descriptor,
		)
	};
	if status != 0 {
		return Err(error(format!(
			"read external file security: {}",
			std::io::Error::from_raw_os_error(status as i32),
		)));
	}

	let valid = unsafe {
		let owner_len = if owner.is_null() {
			0
		} else {
			GetLengthSid(owner) as usize
		};
		let owner_matches = owner_len == expected.sid.len()
			&& std::slice::from_raw_parts(owner.cast::<u8>(), owner_len) == expected.sid;
		if !owner_matches || dacl.is_null() || (*dacl).AceCount != 1 {
			false
		} else {
			let mut raw_ace = std::ptr::null_mut();
			if GetAce(dacl, 0, &mut raw_ace) == 0 || raw_ace.is_null() {
				false
			} else {
				let ace = &*raw_ace.cast::<windows_sys::Win32::Security::ACCESS_ALLOWED_ACE>();
				let sid = std::ptr::addr_of!(ace.SidStart)
					.cast_mut()
					.cast::<std::ffi::c_void>();
				let sid_len = GetLengthSid(sid) as usize;
				ace.Header.AceType == ACCESS_ALLOWED_ACE_TYPE
					&& sid_len == expected.sid.len()
					&& std::slice::from_raw_parts(sid.cast::<u8>(), sid_len) == expected.sid
			}
		}
	};
	if !descriptor.is_null() {
		unsafe {
			LocalFree(descriptor);
		}
	}
	if valid {
		Ok(())
	} else {
		Err(error("external native-owned file is not owner-private"))
	}
}

#[cfg(windows)]
fn windows_make_runtime_directory_private(directory: &File) -> Result<()> {
	const SE_FILE_OBJECT: i32 = 1;
	const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
	const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;

	let mut security = owner_only_pipe_security()?;
	windows_validate_current_owner(directory, &security.sid)?;
	let result = unsafe {
		SetSecurityInfo(
			directory.as_raw_handle() as HANDLE,
			SE_FILE_OBJECT,
			DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
			std::ptr::null_mut(),
			std::ptr::null_mut(),
			security.acl.as_mut_ptr().cast(),
			std::ptr::null_mut(),
		)
	};
	if result != 0 {
		return Err(error(format!(
			"make runtime versions root private: {}",
			std::io::Error::from_raw_os_error(result as i32)
		)));
	}
	Ok(())
}

#[cfg(windows)]
fn runtime_open_or_create_private_directory(path: &Path) -> Result<File> {
	use std::path::Component;

	if !path.is_absolute() {
		return Err(error("runtime versions root must be absolute"));
	}
	let mut components = path.components();
	let Some(Component::Prefix(prefix)) = components.next() else {
		return Err(error("runtime versions root has no Windows volume prefix"));
	};
	if !matches!(components.next(), Some(Component::RootDir)) {
		return Err(error("runtime versions root is not rooted"));
	}
	let mut anchor = PathBuf::from(prefix.as_os_str());
	anchor.push("\\");
	let mut current = windows_open(&anchor, true, false)
		.map_err(|err| error(format!("open runtime volume: {err}")))?;
	reject_reparse(&current)?;
	let mut saw_component = false;
	for component in components {
		let Component::Normal(name) = component else {
			return Err(error("runtime versions root contains unsafe traversal"));
		};
		saw_component = true;
		let name = name
			.to_str()
			.ok_or_else(|| error("runtime path is not valid Unicode"))?;
		current = match windows_runtime_open_at(&current, name, true, true) {
			Ok(directory) => directory,
			Err(_) => match windows_runtime_open_at(&current, name, true, false) {
				Ok(directory) => directory,
				Err(_) => windows_runtime_create_private_directory_at(&current, name)?,
			},
		};
	}
	if !saw_component {
		return Err(error("runtime versions root cannot be a filesystem root"));
	}
	windows_make_runtime_directory_private(&current)?;
	Ok(current)
}

#[cfg(all(not(windows), not(unix)))]
fn runtime_open_or_create_private_directory(_path: &Path) -> Result<File> {
	Err(error(UNSUPPORTED))
}

#[cfg(unix)]
fn runtime_open_directory_at(parent: &File, name: &str) -> Result<File> {
	let name = unix_component(OsStr::new(name)).map_err(|err| error(err.to_string()))?;
	unix_openat(parent.as_raw_fd(), &name, libc::O_RDONLY | libc::O_DIRECTORY)
		.map_err(|err| error(format!("open installed runtime: {err}")))
}

#[cfg(windows)]
fn runtime_open_directory_at(parent: &File, name: &str) -> Result<File> {
	windows_runtime_open_at(parent, name, true, false)
}

#[cfg(all(not(windows), not(unix)))]
fn runtime_open_directory_at(_parent: &File, _name: &str) -> Result<File> {
	Err(error(UNSUPPORTED))
}

#[cfg(unix)]
fn runtime_create_directory_at(parent: &File, name: &str) -> Result<File> {
	let name = unix_component(OsStr::new(name)).map_err(|err| error(err.to_string()))?;
	if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
		return Err(error(format!(
			"create runtime install directory: {}",
			std::io::Error::last_os_error()
		)));
	}
	unix_openat(parent.as_raw_fd(), &name, libc::O_RDONLY | libc::O_DIRECTORY)
		.map_err(|err| error(format!("open runtime install directory: {err}")))
}

#[cfg(windows)]
fn runtime_create_directory_at(parent: &File, name: &str) -> Result<File> {
	windows_runtime_create_private_directory_at(parent, name)
}

#[cfg(all(not(windows), not(unix)))]
fn runtime_create_directory_at(_parent: &File, _name: &str) -> Result<File> {
	Err(error(UNSUPPORTED))
}

#[cfg(unix)]
fn runtime_create_file_at(parent: &File, name: &str) -> Result<File> {
	let name = unix_component(OsStr::new(name)).map_err(|err| error(err.to_string()))?;
	unix_create_private_at(parent.as_raw_fd(), &name)
		.map_err(|err| error(format!("create installed runtime file: {err}")))
}

#[cfg(windows)]
fn runtime_create_file_at(parent: &File, name: &str) -> Result<File> {
	windows_create_private_at(parent, name)
}

#[cfg(all(not(windows), not(unix)))]
fn runtime_create_file_at(_parent: &File, _name: &str) -> Result<File> {
	Err(error(UNSUPPORTED))
}

fn runtime_copy_verified_file(
	source: &File,
	destination: &mut File,
	expected_digest: &str,
) -> Result<()> {
	let mut source = source.try_clone().map_err(|err| error(err.to_string()))?;
	source
		.seek(SeekFrom::Start(0))
		.map_err(|err| error(err.to_string()))?;
	let mut digest = Sha256::new();
	let mut buffer = [0_u8; 64 * 1024];
	loop {
		let count = source
			.read(&mut buffer)
			.map_err(|err| error(format!("read runtime source: {err}")))?;
		if count == 0 {
			break;
		}
		destination
			.write_all(&buffer[..count])
			.map_err(|err| error(format!("write installed runtime: {err}")))?;
		digest.update(&buffer[..count]);
	}
	if hex(&digest.finalize()) != expected_digest {
		return Err(error("runtime source changed while it was copied"));
	}
	destination
		.sync_all()
		.map_err(|err| error(format!("sync installed runtime: {err}")))
}

#[cfg(unix)]
fn runtime_make_executable(file: &File) -> Result<()> {
	if unsafe { libc::fchmod(file.as_raw_fd(), 0o700) } != 0 {
		return Err(error(format!(
			"make installed runtime executable: {}",
			std::io::Error::last_os_error()
		)));
	}
	Ok(())
}

#[cfg(not(unix))]
fn runtime_make_executable(_file: &File) -> Result<()> {
	Ok(())
}

#[cfg(unix)]
fn runtime_rename_directory_at(
	parent: &File,
	old_name: &str,
	new_name: &str,
	directory: &File,
) -> Result<()> {
	let old_name = unix_component(OsStr::new(old_name)).map_err(|err| error(err.to_string()))?;
	let new_name = unix_component(OsStr::new(new_name)).map_err(|err| error(err.to_string()))?;
	directory
		.sync_all()
		.map_err(|err| error(format!("sync runtime install directory: {err}")))?;
	parent
		.sync_all()
		.map_err(|err| error(format!("sync runtime versions root: {err}")))?;
	if unsafe {
		libc::renameat(parent.as_raw_fd(), old_name.as_ptr(), parent.as_raw_fd(), new_name.as_ptr())
	} != 0
	{
		return Err(error(format!("publish installed runtime: {}", std::io::Error::last_os_error())));
	}
	parent
		.sync_all()
		.map_err(|err| error(format!("sync published runtime: {err}")))
}

#[cfg(windows)]
fn runtime_rename_directory_at(
	parent: &File,
	_old_name: &str,
	new_name: &str,
	directory: &File,
) -> Result<()> {
	windows_rename_at(parent, directory, new_name, false, "publish installed runtime")
}

#[cfg(all(not(windows), not(unix)))]
fn runtime_rename_directory_at(
	_parent: &File,
	_old: &str,
	_new: &str,
	_directory: &File,
) -> Result<()> {
	Err(error(UNSUPPORTED))
}

fn runtime_parent_and_name(relative_path: &str) -> (&str, &str) {
	relative_path
		.rsplit_once('/')
		.map_or(("", relative_path), |(parent, name)| (parent, name))
}

fn runtime_directory_paths(files: &BTreeMap<String, String>) -> Vec<String> {
	let mut directories = BTreeMap::<String, ()>::new();
	for relative_path in files.keys() {
		let (mut parent, _) = runtime_parent_and_name(relative_path);
		while !parent.is_empty() {
			directories.insert(parent.to_owned(), ());
			parent = runtime_parent_and_name(parent).0;
		}
	}
	let mut paths: Vec<_> = directories.into_keys().collect();
	paths.sort_by(|left, right| {
		left
			.matches('/')
			.count()
			.cmp(&right.matches('/').count())
			.then_with(|| left.cmp(right))
	});
	paths
}

#[napi(js_name = "installRuntimeBundleAtomic")]
pub fn install_runtime_bundle_atomic(spec: Object<'_>) -> Result<NativeRuntimeBundle> {
	let source: ClassInstance<NativeRuntimeBundle> = spec.get_named_property("source")?;
	let versions_root_value: String = spec.get_named_property("versionsRoot")?;
	let version_key: String = spec.get_named_property("versionKey")?;
	let owner_private: bool = spec.get_named_property("ownerPrivate")?;
	let replace_atomically: bool = spec.get_named_property("replaceAtomically")?;
	if !owner_private || !replace_atomically {
		return Err(error("runtime installation requires private atomic mode"));
	}
	if !private_file_name(Some(&version_key)).is_ok()
		|| version_key
			!= format!(
				"{}-{}-{}",
				source.state.expected.version,
				source.state.expected.platform,
				source.state.expected.arch
			) {
		return Err(error("runtime installation version key is invalid"));
	}
	let versions_root_path = PathBuf::from(versions_root_value);
	let versions_root = runtime_open_or_create_private_directory(&versions_root_path)?;
	let source_guard = source.state.handles.lock();
	let source_handles = source_guard
		.as_ref()
		.ok_or_else(|| error("runtime source bundle capability is closed"))?;
	verify_runtime_handles(&source.state, source_handles)?;

	if let Ok(existing_root) = runtime_open_directory_at(&versions_root, &version_key) {
		let existing = open_runtime_bundle_from_root(
			versions_root_path.join(&version_key),
			existing_root,
			source.state.expected.clone(),
		)?;
		if existing.state.metadata_digest != source.state.metadata_digest {
			return Err(error("existing runtime version has a different metadata identity"));
		}
		return Ok(existing);
	}

	let temporary_name = format!(
		".install-{:x}-{:016x}",
		std::process::id(),
		PRIVATE_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
	);
	let temporary_root = runtime_create_directory_at(&versions_root, &temporary_name)?;
	let mut directories = BTreeMap::<String, File>::new();
	directories.insert(
		String::new(),
		temporary_root
			.try_clone()
			.map_err(|err| error(format!("clone runtime install root: {err}")))?,
	);
	for relative_path in runtime_directory_paths(&source.state.checksum_files) {
		let (parent_path, name) = runtime_parent_and_name(&relative_path);
		let parent = directories
			.get(parent_path)
			.ok_or_else(|| error("runtime install parent directory is absent"))?;
		let directory = runtime_create_directory_at(parent, name)?;
		directories.insert(relative_path, directory);
	}

	for (relative_path, expected_digest) in &source.state.checksum_files {
		let (parent_path, name) = runtime_parent_and_name(relative_path);
		let parent = directories
			.get(parent_path)
			.ok_or_else(|| error("runtime install parent directory is absent"))?;
		let mut destination = runtime_create_file_at(parent, name)?;
		let source_file = source_handles
			.files
			.get(relative_path)
			.ok_or_else(|| error(format!("runtime held file is absent: {relative_path}")))?;
		runtime_copy_verified_file(source_file, &mut destination, expected_digest)?;
		let executable = if source.state.expected.platform == "win32" {
			"runtime/bun.exe"
		} else {
			"runtime/bun"
		};
		if relative_path == executable {
			runtime_make_executable(&destination)?;
		}
	}
	let mut checksums_destination = runtime_create_file_at(&temporary_root, "checksums.json")?;
	checksums_destination
		.write_all(&source.state.checksums_bytes)
		.map_err(|err| error(format!("write installed runtime checksums: {err}")))?;
	checksums_destination
		.sync_all()
		.map_err(|err| error(format!("sync installed runtime checksums: {err}")))?;
	#[cfg(unix)]
	for directory in directories.values() {
		directory
			.sync_all()
			.map_err(|err| error(format!("sync runtime install tree: {err}")))?;
	}
	drop(checksums_destination);
	drop(directories);
	runtime_rename_directory_at(&versions_root, &temporary_name, &version_key, &temporary_root)?;
	drop(source_guard);
	drop(temporary_root);

	let installed_root = runtime_open_directory_at(&versions_root, &version_key)?;
	let installed = open_runtime_bundle_from_root(
		versions_root_path.join(&version_key),
		installed_root,
		source.state.expected.clone(),
	)?;
	if installed.state.metadata_digest != source.state.metadata_digest {
		return Err(error("installed runtime metadata identity changed"));
	}
	Ok(installed)
}

/// Opaque complete process identity. Instances are created only by verified
/// native paths.
#[napi]
#[derive(Clone)]
pub struct NativeProcessIdentity {
	pid:        u32,
	start:      String,
	executable: String,
	live:       Arc<AtomicBool>,
}

#[napi]
impl NativeProcessIdentity {
	#[napi(getter)]
	pub fn pid(&self) -> u32 {
		self.pid
	}

	#[napi(getter, js_name = "processStartIdentity")]
	pub fn process_start_identity(&self) -> String {
		self.start.clone()
	}

	#[napi(getter, js_name = "executableIdentity")]
	pub fn executable_identity(&self) -> String {
		self.executable.clone()
	}
}

#[cfg(windows)]
fn process_identity(pid: u32) -> Result<NativeProcessIdentity> {
	let handle = unsafe {
		OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE_ACCESS, 0, pid)
	};
	if handle.is_null() {
		return Err(last_error("OpenProcess identity query failed"));
	}
	let handle = WinHandle(handle);
	let (mut created, mut exited, mut kernel, mut user) =
		(FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
	if unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
		return Err(last_error("GetProcessTimes failed"));
	}
	let mut capacity = 260_u32;
	let image_path = loop {
		let mut buffer = vec![0_u16; capacity as usize];
		let mut length = capacity;
		if unsafe { QueryFullProcessImageNameW(handle.0, 0, buffer.as_mut_ptr(), &mut length) } != 0 {
			buffer.truncate(length as usize);
			break String::from_utf16(&buffer)
				.map_err(|_| error("process image path is invalid UTF-16"))?;
		}
		if capacity >= 32768 {
			return Err(last_error("QueryFullProcessImageNameW failed"));
		}
		capacity *= 2;
	};
	let image =
		windows_open(Path::new(&image_path), false, false).map_err(|err| error(err.to_string()))?;
	reject_reparse(&image)?;
	let start = (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string();
	Ok(NativeProcessIdentity {
		pid,
		start,
		executable: opened_identity(&image).map_err(|err| error(err.to_string()))?,
		live: Arc::new(AtomicBool::new(true)),
	})
}

#[cfg(target_os = "linux")]
fn posix_process_record(pid: u32) -> Result<(u64, u32, String)> {
	let stat_path = format!("/proc/{pid}/stat");
	let read_stat = || -> Result<(u64, u32)> {
		let stat =
			fs::read_to_string(&stat_path).map_err(|err| error(format!("read {stat_path}: {err}")))?;
		let close = stat
			.rfind(')')
			.ok_or_else(|| error("malformed Linux process stat"))?;
		let mut fields = stat[close + 1..].split_whitespace();
		let _state = fields
			.next()
			.ok_or_else(|| error("Linux process stat has no state"))?;
		let parent = fields
			.next()
			.ok_or_else(|| error("Linux process stat has no parent"))?
			.parse::<u32>()
			.map_err(|_| error("Linux process parent is malformed"))?;
		let start = fields
			.nth(17)
			.ok_or_else(|| error("Linux process stat has no start identity"))?
			.parse::<u64>()
			.map_err(|_| error("Linux process start identity is malformed"))?;
		Ok((start, parent))
	};
	let before = read_stat()?;
	let image = File::open(format!("/proc/{pid}/exe"))
		.map_err(|err| error(format!("open Linux process executable: {err}")))?;
	let executable = opened_identity(&image).map_err(|err| error(err.to_string()))?;
	let after = read_stat()?;
	if before != after {
		return Err(error("process identity changed during Linux capture"));
	}
	Ok((before.0, before.1, executable))
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct MacProcessBsdInfo {
	flags:              u32,
	status:             u32,
	xstatus:            u32,
	pid:                u32,
	ppid:               u32,
	uid:                u32,
	gid:                u32,
	ruid:               u32,
	rgid:               u32,
	svuid:              u32,
	svgid:              u32,
	reserved:           u32,
	comm:               [libc::c_char; 16],
	name:               [libc::c_char; 32],
	nfiles:             u32,
	pgid:               u32,
	pjobc:              u32,
	tdev:               u32,
	tpgid:              u32,
	nice:               i32,
	start_seconds:      u64,
	start_microseconds: u64,
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
unsafe extern "C" {
	fn proc_pidinfo(
		pid: libc::c_int,
		flavor: libc::c_int,
		arg: u64,
		buffer: *mut libc::c_void,
		buffer_size: libc::c_int,
	) -> libc::c_int;
	fn proc_pidpath(pid: libc::c_int, buffer: *mut libc::c_void, buffer_size: u32) -> libc::c_int;
}

#[cfg(target_os = "macos")]
fn mac_process_bsd_info(pid: u32) -> Result<MacProcessBsdInfo> {
	const PROC_PIDTBSDINFO: libc::c_int = 3;
	let mut info = unsafe { std::mem::zeroed::<MacProcessBsdInfo>() };
	let expected = size_of::<MacProcessBsdInfo>() as libc::c_int;
	let read = unsafe {
		proc_pidinfo(
			pid as libc::c_int,
			PROC_PIDTBSDINFO,
			0,
			(&mut info as *mut MacProcessBsdInfo).cast(),
			expected,
		)
	};
	if read != expected {
		return Err(error(format!("proc_pidinfo failed: {}", std::io::Error::last_os_error())));
	}
	if info.pid != pid {
		return Err(error("proc_pidinfo returned a different process"));
	}
	Ok(info)
}

#[cfg(target_os = "macos")]
fn posix_process_record(pid: u32) -> Result<(u64, u32, String)> {
	let before = mac_process_bsd_info(pid)?;
	let mut path = [0_u8; 4096];
	let count =
		unsafe { proc_pidpath(pid as libc::c_int, path.as_mut_ptr().cast(), path.len() as u32) };
	if count <= 0 {
		return Err(error(format!("proc_pidpath failed: {}", std::io::Error::last_os_error())));
	}
	let count = count as usize;
	let length = path[..count.min(path.len())]
		.iter()
		.position(|byte| *byte == 0)
		.unwrap_or(count.min(path.len()));
	if length == 0 {
		return Err(error("proc_pidpath returned an empty executable path"));
	}
	let executable_path = Path::new(OsStr::from_bytes(&path[..length]));
	let (image, ..) =
		unix_open_held(executable_path, false, false).map_err(|err| error(err.to_string()))?;
	let executable = opened_identity(&image).map_err(|err| error(err.to_string()))?;
	let after = mac_process_bsd_info(pid)?;
	let before_start = before
		.start_seconds
		.checked_mul(1_000_000)
		.and_then(|value| value.checked_add(before.start_microseconds))
		.ok_or_else(|| error("macOS process start identity overflow"))?;
	let after_start = after
		.start_seconds
		.checked_mul(1_000_000)
		.and_then(|value| value.checked_add(after.start_microseconds))
		.ok_or_else(|| error("macOS process start identity overflow"))?;
	if before_start != after_start || before.ppid != after.ppid {
		return Err(error("process identity changed during macOS capture"));
	}
	Ok((before_start, before.ppid, executable))
}
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn posix_process_record(_pid: u32) -> Result<(u64, u32, String)> {
	Err(error(UNSUPPORTED))
}

#[cfg(unix)]
fn process_identity(pid: u32) -> Result<NativeProcessIdentity> {
	let (start, _, executable) = posix_process_record(pid)?;
	Ok(NativeProcessIdentity {
		pid,
		start: start.to_string(),
		executable,
		live: Arc::new(AtomicBool::new(true)),
	})
}

#[cfg(all(not(windows), not(unix)))]
fn process_identity(_pid: u32) -> Result<NativeProcessIdentity> {
	Err(error(UNSUPPORTED))
}

fn same_identity(expected: &NativeProcessIdentity, actual: &NativeProcessIdentity) -> bool {
	expected.pid == actual.pid
		&& expected.start == actual.start
		&& expected.executable == actual.executable
}

#[cfg(windows)]
fn process_parents() -> Result<HashMap<u32, u32>> {
	let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
	if snapshot == INVALID_HANDLE_VALUE {
		return Err(last_error("CreateToolhelp32Snapshot failed"));
	}
	let snapshot = WinHandle(snapshot);
	let mut entry =
		PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
	if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
		return Err(last_error("Process32FirstW failed"));
	}
	let mut parents = HashMap::new();
	loop {
		parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
		if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
			break;
		}
	}
	Ok(parents)
}

#[napi(js_name = "matchesProcessIdentity")]
pub fn matches_process_identity(
	expected: &NativeProcessIdentity,
	actual: &NativeProcessIdentity,
) -> bool {
	expected.live.load(Ordering::Acquire)
		&& actual.live.load(Ordering::Acquire)
		&& same_identity(expected, actual)
		&& process_identity(expected.pid).is_ok_and(|current| same_identity(expected, &current))
}

#[napi(js_name = "isProcessIdentityLive")]
pub fn is_process_identity_live(pid: u32, process_start_identity: String) -> bool {
	if pid == 0 || process_start_identity.is_empty() {
		return false;
	}
	process_identity(pid).is_ok_and(|identity| identity.start == process_start_identity)
}

/// Native ancestry verification; every PID edge is recaptured with start and
/// executable identity.
#[napi(js_name = "verifyPeerDescendant")]
pub fn verify_peer_descendant(
	peer: &NativeProcessIdentity,
	ancestor: &NativeProcessIdentity,
) -> bool {
	#[cfg(windows)]
	{
		if !matches_process_identity(peer, peer) || !matches_process_identity(ancestor, ancestor) {
			return false;
		}
		let Ok(parents) = process_parents() else {
			return false;
		};
		let mut child = peer.clone();
		for _ in 0..parents.len() {
			let Some(&parent_pid) = parents.get(&child.pid) else {
				return false;
			};
			if parent_pid == 0 || parent_pid == child.pid {
				return false;
			}
			let Ok(parent) = process_identity(parent_pid) else {
				return false;
			};
			if parent.start.parse::<u64>().ok() > child.start.parse::<u64>().ok() {
				return false;
			}
			if same_identity(&parent, ancestor) {
				return matches_process_identity(ancestor, &parent);
			}
			child = parent;
		}
		false
	}
	#[cfg(unix)]
	{
		if !matches_process_identity(peer, peer) || !matches_process_identity(ancestor, ancestor) {
			return false;
		}
		let mut child = peer.clone();
		for _ in 0..4096 {
			let Ok((child_start, parent_pid, _)) = posix_process_record(child.pid) else {
				return false;
			};
			if child_start.to_string() != child.start || parent_pid == 0 || parent_pid == child.pid {
				return false;
			}
			let Ok(parent) = process_identity(parent_pid) else {
				return false;
			};
			let Some(parent_start) = parent.start.parse::<u64>().ok() else {
				return false;
			};
			let Some(child_start) = child.start.parse::<u64>().ok() else {
				return false;
			};
			if parent_start > child_start {
				return false;
			}
			if same_identity(&parent, ancestor) {
				return matches_process_identity(ancestor, &parent);
			}
			child = parent;
		}
		false
	}
	#[cfg(all(not(windows), not(unix)))]
	{
		let _ = (peer, ancestor);
		false
	}
}

struct VerifiedExecutableState {
	path:            PathBuf,
	file:            Mutex<Option<File>>,
	identity:        String,
	launch_identity: String,
	sha256:          String,
	version:         String,
}

#[napi]
#[derive(Clone)]
pub struct NativeVerifiedExecutable {
	state: Arc<VerifiedExecutableState>,
}

#[napi]
impl NativeVerifiedExecutable {
	#[napi(getter)]
	pub fn identity(&self) -> String {
		self.state.identity.clone()
	}

	#[napi(getter)]
	pub fn sha256(&self) -> String {
		self.state.sha256.clone()
	}

	#[napi(getter)]
	pub fn version(&self) -> String {
		self.state.version.clone()
	}

	#[napi]
	pub fn close(&self) {
		self.state.file.lock().take();
	}
}

#[napi(object)]
pub struct OpenVerifiedExecutableSpec {
	pub path:    String,
	pub sha256:  String,
	pub version: String,
}

#[cfg(any(windows, unix))]
fn is_known_browser_executable(path: &Path) -> bool {
	let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
		return false;
	};
	let lowercase = name.to_ascii_lowercase();
	let basename = lowercase.strip_suffix(".exe").unwrap_or(&lowercase);
	matches!(
		basename,
		"google-chrome-stable"
			| "google-chrome"
			| "chromium"
			| "chromium-browser"
			| "chrome"
			| "google chrome"
	)
}

#[cfg(windows)]
fn windows_browser_executable_path_is_trusted(path: &Path) -> bool {
	if !path.is_absolute()
		|| path.components().any(|component| {
			matches!(component, std::path::Component::CurDir | std::path::Component::ParentDir)
		}) {
		return false;
	}
	let normalized = path
		.to_string_lossy()
		.replace('/', "\\")
		.to_ascii_lowercase();
	normalized.starts_with(r"c:\program files\")
		|| normalized.starts_with(r"c:\program files (x86)\")
}

#[cfg(windows)]
fn validate_browser_executable_immutability(path: &Path, _file: &File) -> Result<()> {
	if is_known_browser_executable(path) && !windows_browser_executable_path_is_trusted(path) {
		return Err(error("browser executable must be installed under protected Program Files"));
	}
	Ok(())
}

#[cfg(unix)]
fn validate_browser_executable_immutability(path: &Path, file: &File) -> Result<()> {
	if !is_known_browser_executable(path) {
		return Ok(());
	}
	use std::os::unix::fs::MetadataExt;
	let metadata = file.metadata().map_err(|err| error(err.to_string()))?;
	if metadata.mode() & 0o222 != 0 {
		return Err(error("browser executable must be non-writable"));
	}
	Ok(())
}
#[cfg(target_os = "linux")]
fn create_executable_snapshot_file() -> Result<File> {
	let name = CString::new("omp-verified-executable").unwrap();
	let descriptor = unsafe {
		libc::syscall(
			libc::SYS_memfd_create,
			name.as_ptr(),
			libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
		)
	} as libc::c_int;
	if descriptor < 0 {
		return Err(error(format!(
			"create sealed executable snapshot: {}",
			std::io::Error::last_os_error()
		)));
	}
	Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(target_os = "macos")]
fn create_executable_snapshot_file() -> Result<File> {
	let mut template = std::env::temp_dir()
		.join(".omp-verified-executable-XXXXXX")
		.as_os_str()
		.as_bytes()
		.to_vec();
	template.push(0);
	let descriptor = unsafe { libc::mkstemp(template.as_mut_ptr().cast()) };
	if descriptor < 0 {
		return Err(error(format!(
			"create executable snapshot: {}",
			std::io::Error::last_os_error()
		)));
	}
	if unsafe { libc::unlink(template.as_ptr().cast()) } != 0 {
		let unlink_error = std::io::Error::last_os_error();
		unsafe {
			libc::close(descriptor);
		}
		return Err(error(format!("unlink executable snapshot: {unlink_error}")));
	}
	Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn create_executable_snapshot_file() -> Result<File> {
	Err(error(UNSUPPORTED))
}

#[cfg(unix)]
fn snapshot_executable(source: &File) -> Result<(File, String, String)> {
	use std::os::unix::fs::MetadataExt;
	let mut reader = source.try_clone().map_err(|err| error(err.to_string()))?;
	reader
		.seek(SeekFrom::Start(0))
		.map_err(|err| error(err.to_string()))?;
	let mut snapshot = create_executable_snapshot_file()?;
	let mut digest = Sha256::new();
	let mut buffer = [0_u8; 64 * 1024];
	loop {
		let count = reader
			.read(&mut buffer)
			.map_err(|err| error(err.to_string()))?;
		if count == 0 {
			break;
		}
		snapshot
			.write_all(&buffer[..count])
			.map_err(|err| error(err.to_string()))?;
		digest.update(&buffer[..count]);
	}
	snapshot.flush().map_err(|err| error(err.to_string()))?;
	if unsafe { libc::fchmod(snapshot.as_raw_fd(), 0o500) } != 0 {
		return Err(error(format!(
			"make executable snapshot read-only: {}",
			std::io::Error::last_os_error()
		)));
	}
	#[cfg(target_os = "linux")]
	{
		let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
		if unsafe { libc::fcntl(snapshot.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
			return Err(error(format!(
				"seal executable snapshot: {}",
				std::io::Error::last_os_error()
			)));
		}
	}
	let metadata = snapshot.metadata().map_err(|err| error(err.to_string()))?;
	if !metadata.is_file() || metadata.nlink() != 0 {
		return Err(error("executable snapshot is not an anonymous regular file"));
	}
	snapshot
		.seek(SeekFrom::Start(0))
		.map_err(|err| error(err.to_string()))?;
	let identity = opened_identity(&snapshot).map_err(|err| error(err.to_string()))?;
	Ok((snapshot, identity, hex(&digest.finalize())))
}
fn verified_executable_from_held(
	path: PathBuf,
	source: &File,
	expected_sha256: String,
	version: String,
) -> Result<NativeVerifiedExecutable> {
	if !is_lower_sha256(&expected_sha256) {
		return Err(error("expected lowercase SHA-256"));
	}
	if !valid_launch_identity(&version) {
		return Err(error("verified executable version is invalid"));
	}
	if !source
		.metadata()
		.map_err(|err| error(err.to_string()))?
		.is_file()
	{
		return Err(error("executable is not a regular file"));
	}
	let identity = opened_identity(source).map_err(|err| error(err.to_string()))?;
	#[cfg(unix)]
	let (file, launch_identity, actual) = snapshot_executable(source)?;
	#[cfg(not(unix))]
	let (file, launch_identity, actual) = {
		let file = source.try_clone().map_err(|err| error(err.to_string()))?;
		let launch_identity = identity.clone();
		let actual = sha256(&file).map_err(|err| error(err.to_string()))?;
		(file, launch_identity, actual)
	};
	if actual != expected_sha256 {
		return Err(error("verified executable SHA-256 mismatch"));
	}
	Ok(NativeVerifiedExecutable {
		state: Arc::new(VerifiedExecutableState {
			path,
			file: Mutex::new(Some(file)),
			identity,
			launch_identity,
			sha256: expected_sha256,
			version,
		}),
	})
}

fn open_executable_path_sync(path: PathBuf) -> Result<(File, String, String, String)> {
	#[cfg(windows)]
	{
		let file = windows_executable_open(&path).map_err(|err| error(err.to_string()))?;
		reject_reparse(&file)?;
		if !file
			.metadata()
			.map_err(|err| error(err.to_string()))?
			.is_file()
		{
			return Err(error("executable is not a regular file"));
		}
		validate_browser_executable_immutability(&path, &file)?;
		let identity = opened_identity(&file).map_err(|err| error(err.to_string()))?;
		let digest = sha256(&file).map_err(|err| error(err.to_string()))?;
		return Ok((file, identity.clone(), identity, digest));
	}
	#[cfg(unix)]
	{
		let (source, ..) =
			unix_open_held(&path, false, false).map_err(|err| error(err.to_string()))?;
		if !source
			.metadata()
			.map_err(|err| error(err.to_string()))?
			.is_file()
		{
			return Err(error("executable is not a regular file"));
		}
		validate_browser_executable_immutability(&path, &source)?;
		let source_identity = opened_identity(&source).map_err(|err| error(err.to_string()))?;
		let (snapshot, launch_identity, digest) = snapshot_executable(&source)?;
		return Ok((snapshot, source_identity, launch_identity, digest));
	}
	#[cfg(all(not(windows), not(unix)))]
	{
		let file = {
			if fs::symlink_metadata(&path)
				.map_err(|err| error(err.to_string()))?
				.file_type()
				.is_symlink()
			{
				return Err(error("refusing symbolic-link executable"));
			}
			File::open(&path).map_err(|err| error(err.to_string()))?
		};
		if !file
			.metadata()
			.map_err(|err| error(err.to_string()))?
			.is_file()
		{
			return Err(error("executable is not a regular file"));
		}
		let identity = opened_identity(&file).map_err(|err| error(err.to_string()))?;
		let digest = sha256(&file).map_err(|err| error(err.to_string()))?;
		Ok((file, identity.clone(), identity, digest))
	}
}

fn open_executable_sync(path: String) -> Result<NativeVerifiedExecutable> {
	let path = PathBuf::from(path);
	let (file, identity, launch_identity, digest) = open_executable_path_sync(path.clone())?;
	let version = format!("sha256:{digest}");
	Ok(NativeVerifiedExecutable {
		state: Arc::new(VerifiedExecutableState {
			path,
			file: Mutex::new(Some(file)),
			identity,
			launch_identity,
			sha256: digest,
			version,
		}),
	})
}

#[napi(js_name = "openExecutable")]
pub fn open_executable(path: String) -> crate::task::Promise<NativeVerifiedExecutable> {
	crate::task::blocking("local_peer.executable.discover", (), move |_| open_executable_sync(path))
}

#[napi(js_name = "openVerifiedExecutable")]
pub fn open_verified_executable(
	spec: OpenVerifiedExecutableSpec,
) -> crate::task::Promise<NativeVerifiedExecutable> {
	crate::task::blocking("local_peer.executable.open", (), move |_| {
		open_verified_executable_sync(spec)
	})
}

fn open_verified_executable_sync(
	spec: OpenVerifiedExecutableSpec,
) -> Result<NativeVerifiedExecutable> {
	if spec.sha256.len() != 64
		|| !spec
			.sha256
			.bytes()
			.all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
	{
		return Err(error("expected lowercase SHA-256"));
	}
	if !valid_launch_identity(&spec.version) {
		return Err(error("verified executable version is invalid"));
	}
	let path = PathBuf::from(spec.path);
	let (file, identity, launch_identity, actual) = open_executable_path_sync(path.clone())?;
	if actual != spec.sha256 {
		return Err(error("verified executable SHA-256 mismatch"));
	}
	Ok(NativeVerifiedExecutable {
		state: Arc::new(VerifiedExecutableState {
			path,
			file: Mutex::new(Some(file)),
			identity,
			launch_identity,
			sha256: spec.sha256,
			version: spec.version,
		}),
	})
}

#[napi(js_name = "openVerifiedExecutableMatching")]
pub fn open_verified_executable_matching(
	spec: OpenVerifiedExecutableSpec,
	expected_identity: String,
) -> crate::task::Promise<Option<NativeVerifiedExecutable>> {
	crate::task::blocking("local_peer.executable.open_matching", (), move |_| {
		let executable = open_verified_executable_sync(spec)?;
		Ok((executable.state.identity == expected_identity).then_some(executable))
	})
}

const DEFAULT_EXECUTABLE_VERSION_TIMEOUT_MS: u32 = 5_000;
const MAX_EXECUTABLE_VERSION_TIMEOUT_MS: u32 = 60_000;
const MAX_EXECUTABLE_VERSION_OUTPUT_BYTES: usize = 64 * 1024;

fn strict_numeric_version_component(value: &str) -> bool {
	!value.is_empty()
		&& value.bytes().all(|byte| byte.is_ascii_digit())
		&& (value.len() == 1 || !value.starts_with('0'))
}

fn strict_semver_identifiers(value: &str, reject_numeric_leading_zero: bool) -> bool {
	!value.is_empty()
		&& value.split('.').all(|identifier| {
			!identifier.is_empty()
				&& identifier
					.bytes()
					.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
				&& (!reject_numeric_leading_zero
					|| !identifier.bytes().all(|byte| byte.is_ascii_digit())
					|| identifier.len() == 1
					|| !identifier.starts_with('0'))
		})
}

fn is_strict_semver(value: &str) -> bool {
	if value.is_empty() || value.len() > 256 || !value.is_ascii() {
		return false;
	}
	let without_build = match value.split_once('+') {
		Some((version, build)) if !build.contains('+') && strict_semver_identifiers(build, false) => {
			version
		},
		Some(_) => return false,
		None => value,
	};
	let core = match without_build.split_once('-') {
		Some((core, prerelease)) if strict_semver_identifiers(prerelease, true) => core,
		Some(_) => return false,
		None => without_build,
	};
	let mut components = core.split('.');
	components
		.next()
		.is_some_and(strict_numeric_version_component)
		&& components
			.next()
			.is_some_and(strict_numeric_version_component)
		&& components
			.next()
			.is_some_and(strict_numeric_version_component)
		&& components.next().is_none()
}

fn version_output_contains(output: &[u8], expected: &str) -> bool {
	output
		.split(|byte| !byte.is_ascii_alphanumeric() && !matches!(*byte, b'.' | b'-' | b'+'))
		.any(|token| token == expected.as_bytes())
}

fn read_bounded_version_output(
	mut pipe: impl Read,
	overflow: Arc<AtomicBool>,
) -> std::io::Result<Vec<u8>> {
	let mut output = Vec::with_capacity(4096);
	let mut buffer = [0_u8; 4096];
	loop {
		let count = pipe.read(&mut buffer)?;
		if count == 0 {
			return Ok(output);
		}
		let remaining = MAX_EXECUTABLE_VERSION_OUTPUT_BYTES.saturating_sub(output.len());
		let retained = remaining.min(count);
		output.extend_from_slice(&buffer[..retained]);
		if retained != count {
			overflow.store(true, Ordering::Release);
		}
	}
}

fn terminate_version_process(process: &NativeOwnedProcess) -> Result<()> {
	let terminated = process.terminate_sync();
	let mut child = process.state.child.lock();
	if let Some(child) = child.as_mut() {
		if terminated.is_err() {
			let _ = child.kill();
		}
		let _ = child.wait();
	}
	process.state.identity.live.store(false, Ordering::Release);
	terminated
}

fn revalidate_held_executable_after_version(executable: &NativeVerifiedExecutable) -> Result<()> {
	let current = {
		let held = executable.state.file.lock();
		held
			.as_ref()
			.ok_or_else(|| error("verified executable capability is closed after version execution"))?
			.try_clone()
			.map_err(|err| error(err.to_string()))?
	};
	if opened_identity(&current).map_err(|err| error(err.to_string()))?
		!= executable.state.launch_identity
	{
		return Err(error("verified executable capability identity changed after version execution"));
	}
	if sha256(&current).map_err(|err| error(err.to_string()))? != executable.state.sha256 {
		return Err(error("verified executable digest changed after version execution"));
	}
	Ok(())
}

fn run_executable_version(
	executable: &NativeVerifiedExecutable,
	timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>)> {
	let process = spawn_verified(executable, &["--version".to_owned()], |command| {
		command
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		Ok(())
	})?;
	let pipes = {
		let mut child = process.state.child.lock();
		let child = child
			.as_mut()
			.ok_or_else(|| error("version process handle is closed"));
		child.and_then(|child| {
			Ok((
				child
					.stdout
					.take()
					.ok_or_else(|| error("version process stdout pipe is unavailable"))?,
				child
					.stderr
					.take()
					.ok_or_else(|| error("version process stderr pipe is unavailable"))?,
			))
		})
	};
	let (stdout, stderr) = match pipes {
		Ok(pipes) => pipes,
		Err(err) => {
			let _ = terminate_version_process(&process);
			return Err(err);
		},
	};
	let overflow = Arc::new(AtomicBool::new(false));
	let stdout_overflow = overflow.clone();
	let stdout_reader = match std::thread::Builder::new()
		.name("omp-version-stdout".to_owned())
		.spawn(move || read_bounded_version_output(stdout, stdout_overflow))
	{
		Ok(reader) => reader,
		Err(err) => {
			let _ = terminate_version_process(&process);
			return Err(error(format!("start version stdout reader: {err}")));
		},
	};
	let stderr_overflow = overflow.clone();
	let stderr_reader = match std::thread::Builder::new()
		.name("omp-version-stderr".to_owned())
		.spawn(move || read_bounded_version_output(stderr, stderr_overflow))
	{
		Ok(reader) => reader,
		Err(err) => {
			let _ = terminate_version_process(&process);
			drop(stdout_reader);
			return Err(error(format!("start version stderr reader: {err}")));
		},
	};
	let started = Instant::now();
	let status = loop {
		if overflow.load(Ordering::Acquire) {
			let termination = terminate_version_process(&process);
			drop(stdout_reader);
			drop(stderr_reader);
			termination?;
			return Err(error("executable version output exceeded the native limit"));
		}
		let polled = {
			let mut child = process.state.child.lock();
			child
				.as_mut()
				.ok_or_else(|| error("version process handle is closed"))
				.and_then(|child| child.try_wait().map_err(|err| error(err.to_string())))
		};
		let status = match polled {
			Ok(status) => status,
			Err(err) => {
				let _ = terminate_version_process(&process);
				drop(stdout_reader);
				drop(stderr_reader);
				return Err(err);
			},
		};
		if let Some(status) = status {
			process.state.identity.live.store(false, Ordering::Release);
			if stdout_reader.is_finished() && stderr_reader.is_finished() {
				break status;
			}
		}
		if started.elapsed() >= timeout {
			let termination = terminate_version_process(&process);
			drop(stdout_reader);
			drop(stderr_reader);
			termination?;
			return Err(error("executable version check timed out"));
		}
		std::thread::sleep(Duration::from_millis(5));
	};
	let stdout = stdout_reader
		.join()
		.map_err(|_| error("version stdout reader panicked"))?
		.map_err(|err| error(format!("read version stdout: {err}")))?;
	let stderr = stderr_reader
		.join()
		.map_err(|_| error("version stderr reader panicked"))?
		.map_err(|err| error(format!("read version stderr: {err}")))?;
	if overflow.load(Ordering::Acquire) {
		return Err(error("executable version output exceeded the native limit"));
	}
	if !status.success() {
		return Err(error("executable version command failed"));
	}
	Ok((stdout, stderr))
}

fn verify_executable_version_sync(
	executable: NativeVerifiedExecutable,
	expected: String,
	timeout_ms: Option<u32>,
) -> Result<()> {
	if !is_strict_semver(&expected) {
		return Err(error("expected executable version must be a strict semantic version"));
	}
	let timeout_ms = timeout_ms.unwrap_or(DEFAULT_EXECUTABLE_VERSION_TIMEOUT_MS);
	if timeout_ms == 0 || timeout_ms > MAX_EXECUTABLE_VERSION_TIMEOUT_MS {
		return Err(error("executable version timeout must be between 1 and 60000 milliseconds"));
	}
	let execution = run_executable_version(&executable, Duration::from_millis(timeout_ms as u64));
	revalidate_held_executable_after_version(&executable)?;
	let (stdout, stderr) = execution?;
	if !version_output_contains(&stdout, &expected) && !version_output_contains(&stderr, &expected) {
		return Err(error("executable semantic version mismatch"));
	}
	Ok(())
}

#[napi(js_name = "verifyExecutableVersion")]
pub fn verify_executable_version(
	executable: &NativeVerifiedExecutable,
	expected: String,
	timeout_ms: Option<u32>,
) -> crate::task::Promise<()> {
	let executable = executable.clone();
	crate::task::blocking("local_peer.executable.verify_version", (), move |_| {
		verify_executable_version_sync(executable, expected, timeout_ms)
	})
}

const MAX_INHERITED_MATERIAL_BYTES: usize = 64 * 1024;

struct ZeroizingBytes(Vec<u8>);

impl ZeroizingBytes {
	fn as_slice(&self) -> &[u8] {
		&self.0
	}

	fn fill(&mut self, value: u8) {
		self.0.fill(value);
	}
}

impl Drop for ZeroizingBytes {
	fn drop(&mut self) {
		self.0.fill(0);
	}
}

fn snapshot_launch_material(file: &NativeOwnedFile, label: &str) -> Result<ZeroizingBytes> {
	if file.state.directory || file.state.consumed.load(Ordering::Acquire) {
		return Err(error(format!("{label} capability is unavailable")));
	}
	let guard = file.state.file.lock();
	let file = guard
		.as_ref()
		.ok_or_else(|| error(format!("{label} capability is closed")))?;
	let mut reader = file.try_clone().map_err(|err| error(err.to_string()))?;
	reader
		.seek(SeekFrom::Start(0))
		.map_err(|err| error(err.to_string()))?;
	let mut bytes = ZeroizingBytes(Vec::new());
	reader
		.take((MAX_INHERITED_MATERIAL_BYTES + 1) as u64)
		.read_to_end(&mut bytes.0)
		.map_err(|err| error(err.to_string()))?;
	if bytes.0.is_empty() || bytes.0.len() > MAX_INHERITED_MATERIAL_BYTES {
		return Err(error(format!("{label} capability has an invalid size")));
	}
	Ok(bytes)
}

#[napi(js_name = "copyOwnedFilePrivate")]
pub fn copy_owned_file_private(
	root: &NativeOwnedFile,
	source: &NativeOwnedFile,
	name_hint: Option<String>,
) -> Result<NativeOwnedFile> {
	if !root.state.directory
		|| source.state.directory
		|| Arc::ptr_eq(&root.state, &source.state)
		|| source.state.consumed.load(Ordering::Acquire)
	{
		return Err(error("invalid native-owned private copy capabilities"));
	}
	let source_name = source
		.state
		.path
		.file_name()
		.and_then(|name| name.to_str())
		.ok_or_else(|| error("native-owned private copy source has no safe child name"))?;
	private_file_name(Some(source_name))?;
	let destination_name = private_file_name(name_hint.as_deref())?;
	if source_name == destination_name {
		return Err(error("native-owned private copy destination aliases its source"));
	}
	let _mutation = root.state.mutation_lock.lock();
	let current = open_owned_child_optional(root, source_name, false)?
		.ok_or_else(|| error("native-owned private copy source is absent"))?;
	if current.state.identity != source.state.identity {
		return Err(error("native-owned private copy source identity changed"));
	}
	let source_guard = source.state.file.lock();
	let source_file = source_guard
		.as_ref()
		.ok_or_else(|| error("native-owned private copy source is closed"))?;
	if opened_identity(source_file).map_err(|err| error(err.to_string()))? != source.state.identity {
		return Err(error("native-owned private copy held identity changed"));
	}
	let mut reader = source_file
		.try_clone()
		.map_err(|err| error(err.to_string()))?;
	reader
		.seek(SeekFrom::Start(0))
		.map_err(|err| error(err.to_string()))?;
	let mut bytes = ZeroizingBytes(Vec::new());
	reader
		.take((MAX_INHERITED_MATERIAL_BYTES + 1) as u64)
		.read_to_end(&mut bytes.0)
		.map_err(|err| error(err.to_string()))?;
	if bytes.0.is_empty() || bytes.0.len() > MAX_INHERITED_MATERIAL_BYTES {
		return Err(error("native-owned private copy source has an invalid size"));
	}
	create_private_owned(root, destination_name, bytes.as_slice())
}

enum EnvironmentKind {
	Tunnel {
		bootstrap:          Mutex<Option<ZeroizingBytes>>,
		bootstrap_identity: String,
		runtime_key:        Mutex<Option<ZeroizingBytes>>,
		broker:             NativeLocalEndpoint,
		epoch:              String,
	},
	Browser {
		profile_root:       NativeOwnedFile,
		profile_generation: String,
		owner_fence:        String,
	},
}

fn valid_launch_identity(value: &str) -> bool {
	!value.is_empty() && value.len() <= 256 && !value.contains('\0')
}

#[napi]
#[derive(Clone)]
pub struct NativeLaunchEnvironment {
	kind: Arc<EnvironmentKind>,
}

#[napi]
impl NativeLaunchEnvironment {
	#[napi(factory, js_name = "tunnelChild")]
	pub fn tunnel_child(
		bootstrap: &NativeOwnedFile,
		runtime_key: &NativeOwnedFile,
		broker: &NativeLocalEndpoint,
		runtime_epoch: String,
	) -> Result<Self> {
		if !valid_launch_identity(&runtime_epoch)
			|| !valid_launch_identity(&bootstrap.state.identity)
			|| broker.state.name.is_empty()
			|| Arc::ptr_eq(&bootstrap.state, &runtime_key.state)
		{
			return Err(error("invalid tunnel launch environment"));
		}
		let bootstrap_identity = bootstrap.state.identity.clone();
		let bootstrap = snapshot_launch_material(bootstrap, "bootstrap")?;
		let runtime_key = snapshot_launch_material(runtime_key, "runtime-key")?;
		Ok(Self {
			kind: Arc::new(EnvironmentKind::Tunnel {
				bootstrap: Mutex::new(Some(bootstrap)),
				bootstrap_identity,
				runtime_key: Mutex::new(Some(runtime_key)),
				broker: broker.clone(),
				epoch: runtime_epoch,
			}),
		})
	}

	#[napi(factory, js_name = "browserChild")]
	pub fn browser_child(
		profile_root: &NativeOwnedFile,
		profile_generation: String,
		owner_fence: String,
	) -> Result<Self> {
		if !profile_root.state.directory
			|| profile_root.state.file.lock().is_none()
			|| !valid_launch_identity(&profile_generation)
			|| !valid_launch_identity(&owner_fence)
		{
			return Err(error("invalid browser launch environment"));
		}
		Ok(Self {
			kind: Arc::new(EnvironmentKind::Browser {
				profile_root: profile_root.clone(),
				profile_generation,
				owner_fence,
			}),
		})
	}
}
fn reject_named_properties(object: &Object<'_>, names: &[&str], label: &str) -> Result<()> {
	for name in names {
		if object.has_named_property(name)? {
			return Err(error(format!("{label} rejects property {name}")));
		}
	}
	Ok(())
}

#[napi(js_name = "createLaunchEnvironment")]
pub fn create_launch_environment(profile: Object<'_>) -> Result<NativeLaunchEnvironment> {
	let kind: String = profile.get_named_property("kind")?;
	match kind.as_str() {
		"tunnel-child" => {
			reject_named_properties(
				&profile,
				&[
					"profileRoot",
					"profileGeneration",
					"ownerFence",
					"args",
					"argv",
					"profile",
					"profilePath",
					"endpoint",
					"remoteDebuggingPort",
				],
				"tunnel-child",
			)?;
			let bootstrap: ClassInstance<NativeOwnedFile> = profile.get_named_property("bootstrap")?;
			let runtime_key: ClassInstance<NativeOwnedFile> =
				profile.get_named_property("runtimeKey")?;
			let broker: ClassInstance<NativeLocalEndpoint> = profile.get_named_property("broker")?;
			let epoch: String = profile.get_named_property("runtimeEpoch")?;
			NativeLaunchEnvironment::tunnel_child(&bootstrap, &runtime_key, &broker, epoch)
		},
		"browser-child" => {
			reject_named_properties(
				&profile,
				&[
					"bootstrap",
					"runtimeKey",
					"broker",
					"runtimeEpoch",
					"args",
					"argv",
					"profile",
					"profilePath",
					"endpoint",
					"remoteDebuggingPort",
				],
				"browser-child",
			)?;
			let root: ClassInstance<NativeOwnedFile> = profile.get_named_property("profileRoot")?;
			let generation: String = profile.get_named_property("profileGeneration")?;
			let fence: String = profile.get_named_property("ownerFence")?;
			NativeLaunchEnvironment::browser_child(&root, generation, fence)
		},
		_ => Err(error("unknown native launch environment kind")),
	}
}

const RUNTIME_LAUNCH_PACKAGE: &str = "@oh-my-pi/pi-chatgpt-web-launcher";
const RUNTIME_LAUNCH_CLI: &str = "app/cli.js";
const RUNTIME_LAUNCH_MCP: &str = "app/mcp-main.js";
const RUNTIME_LAUNCH_OPERATION: &str = "serve-full-runtime";

fn require_only_properties(object: &Object<'_>, allowed: &[&str], label: &str) -> Result<()> {
	let names = object.get_property_names()?;
	for index in 0..names.get_array_length()? {
		let name: String = names.get_element(index)?;
		if !allowed.contains(&name.as_str()) {
			return Err(error(format!("{label} rejects property {name}")));
		}
	}
	Ok(())
}

fn runtime_host_identity() -> (&'static str, &'static str) {
	let platform = if cfg!(windows) {
		"win32"
	} else if cfg!(target_os = "macos") {
		"darwin"
	} else {
		"linux"
	};
	let arch = if cfg!(target_arch = "aarch64") {
		"arm64"
	} else {
		"x64"
	};
	(platform, arch)
}

struct VerifiedRuntimeLaunchMaterial {
	bundle:      NativeRuntimeBundle,
	executable:  NativeVerifiedExecutable,
	environment: NativeLaunchEnvironment,
	args:        Vec<String>,
}

struct VerifiedRuntimeLaunchState {
	material: Mutex<Option<VerifiedRuntimeLaunchMaterial>>,
}

#[napi]
#[derive(Clone)]
pub struct NativeVerifiedRuntimeLaunch {
	state: Arc<VerifiedRuntimeLaunchState>,
}

impl NativeVerifiedRuntimeLaunch {
	fn close_material(&self) {
		if let Some(material) = self.state.material.lock().take() {
			material.executable.close();
			if let EnvironmentKind::Tunnel { bootstrap, runtime_key, .. } =
				material.environment.kind.as_ref()
			{
				bootstrap.lock().take();
				runtime_key.lock().take();
			}
		}
	}
}

#[napi]
impl NativeVerifiedRuntimeLaunch {
	#[napi]
	pub fn close(&self) {
		self.close_material();
	}
}

#[napi]
pub struct PreparedVerifiedRuntimeLaunch {
	launch_spec:          NativeVerifiedRuntimeLaunch,
	version:              String,
	runtime_epoch:        String,
	lifecycle_generation: u32,
	instance_nonce:       String,
}

#[napi]
impl PreparedVerifiedRuntimeLaunch {
	#[napi(getter, js_name = "launchSpec")]
	pub fn launch_spec(&self) -> NativeVerifiedRuntimeLaunch {
		self.launch_spec.clone()
	}

	#[napi(getter)]
	pub fn version(&self) -> String {
		self.version.clone()
	}

	#[napi(getter, js_name = "runtimeEpoch")]
	pub fn runtime_epoch(&self) -> String {
		self.runtime_epoch.clone()
	}

	#[napi(getter, js_name = "lifecycleGeneration")]
	pub fn lifecycle_generation(&self) -> u32 {
		self.lifecycle_generation
	}

	#[napi(getter, js_name = "instanceNonce")]
	pub fn instance_nonce(&self) -> String {
		self.instance_nonce.clone()
	}

	#[napi]
	pub fn close(&self) {
		self.launch_spec.close_material();
	}
}

#[napi(js_name = "prepareVerifiedRuntimeLaunch")]
pub fn prepare_verified_runtime_launch(spec: Object<'_>) -> Result<PreparedVerifiedRuntimeLaunch> {
	require_only_properties(
		&spec,
		&[
			"bundle",
			"packageName",
			"packageVersion",
			"cliEntrypoint",
			"mcpEntrypoint",
			"operation",
			"environment",
			"instanceNonce",
			"runtimeEpoch",
			"lifecycleGeneration",
		],
		"verified runtime launch",
	)?;
	let bundle: ClassInstance<NativeRuntimeBundle> = spec.get_named_property("bundle")?;
	let package_name: String = spec.get_named_property("packageName")?;
	let package_version: String = spec.get_named_property("packageVersion")?;
	let cli_entrypoint: String = spec.get_named_property("cliEntrypoint")?;
	let mcp_entrypoint: String = spec.get_named_property("mcpEntrypoint")?;
	let operation: String = spec.get_named_property("operation")?;
	let environment: ClassInstance<NativeLaunchEnvironment> =
		spec.get_named_property("environment")?;
	let instance_nonce: String = spec.get_named_property("instanceNonce")?;
	let runtime_epoch: String = spec.get_named_property("runtimeEpoch")?;
	let lifecycle_generation: u32 = spec.get_named_property("lifecycleGeneration")?;
	if package_name != RUNTIME_LAUNCH_PACKAGE
		|| package_version != bundle.state.expected.version
		|| cli_entrypoint != RUNTIME_LAUNCH_CLI
		|| mcp_entrypoint != RUNTIME_LAUNCH_MCP
		|| operation != RUNTIME_LAUNCH_OPERATION
		|| runtime_epoch.len() < 16
		|| !valid_launch_identity(&runtime_epoch)
		|| lifecycle_generation == 0
		|| instance_nonce.len() < 16
		|| !valid_launch_identity(&instance_nonce)
	{
		return Err(error("verified runtime launch identity is invalid"));
	}
	let EnvironmentKind::Tunnel { epoch, .. } = environment.kind.as_ref() else {
		return Err(error("verified runtime launch requires a tunnel environment"));
	};
	if epoch != &runtime_epoch {
		return Err(error("verified runtime launch environment epoch changed"));
	}
	let (host_platform, host_arch) = runtime_host_identity();
	if bundle.state.expected.platform != host_platform || bundle.state.expected.arch != host_arch {
		return Err(error("verified runtime bundle does not match the host"));
	}
	let runtime = bundle
		.state
		.manifest
		.get("runtime")
		.and_then(serde_json::Value::as_object)
		.ok_or_else(|| error("verified runtime manifest has no runtime"))?;
	if runtime.get("kind").and_then(serde_json::Value::as_str) != Some("bun") {
		return Err(error("verified runtime bundle has no held runtime executable"));
	}
	let executable_path = runtime
		.get("executable")
		.and_then(serde_json::Value::as_str)
		.ok_or_else(|| error("verified runtime executable metadata is invalid"))?;
	let runtime_version = runtime
		.get("version")
		.and_then(serde_json::Value::as_str)
		.ok_or_else(|| error("verified runtime executable version is invalid"))?;
	let expected_executable = if host_platform == "win32" {
		"runtime/bun.exe"
	} else {
		"runtime/bun"
	};
	if executable_path != expected_executable {
		return Err(error("verified runtime executable entry is invalid"));
	}
	let handles_guard = bundle.state.handles.lock();
	let handles = handles_guard
		.as_ref()
		.ok_or_else(|| error("verified runtime bundle capability is closed"))?;
	verify_runtime_handles(&bundle.state, handles)?;
	for entrypoint in [RUNTIME_LAUNCH_CLI, RUNTIME_LAUNCH_MCP] {
		if !handles.files.contains_key(entrypoint) {
			return Err(error("verified runtime entrypoint handle is absent"));
		}
	}
	let expected_digest = bundle
		.state
		.checksum_files
		.get(executable_path)
		.ok_or_else(|| error("verified runtime executable checksum is absent"))?
		.clone();
	let executable_file = handles
		.files
		.get(executable_path)
		.ok_or_else(|| error("verified runtime executable handle is absent"))?;
	let executable = verified_executable_from_held(
		bundle.state.root_path.join(executable_path),
		executable_file,
		expected_digest,
		runtime_version.to_owned(),
	)?;
	let cli_launch_path = bundle
		.state
		.root_path
		.join(RUNTIME_LAUNCH_CLI)
		.into_os_string()
		.into_string()
		.map_err(|_| error("verified runtime CLI path is not valid Unicode"))?;
	drop(handles_guard);
	let launch_spec = NativeVerifiedRuntimeLaunch {
		state: Arc::new(VerifiedRuntimeLaunchState {
			material: Mutex::new(Some(VerifiedRuntimeLaunchMaterial {
				bundle: bundle.as_ref().clone(),
				executable,
				environment: environment.as_ref().clone(),
				args: vec![cli_launch_path, "mcp".to_owned(), "--broker-handoff".to_owned()],
			})),
		}),
	};
	Ok(PreparedVerifiedRuntimeLaunch {
		launch_spec,
		version: package_version,
		runtime_epoch,
		lifecycle_generation,
		instance_nonce,
	})
}

#[napi(object)]
pub struct NativeProcessExit {
	#[napi(js_name = "exitCode")]
	pub exit_code: Option<i32>,
	pub signal:    Option<String>,
}

#[cfg(windows)]
fn create_kill_on_close_job() -> Result<WinHandle> {
	let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
	if job.is_null() {
		return Err(last_error("CreateJobObjectW failed"));
	}
	let job = WinHandle(job);
	let mut limits = unsafe { std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() };
	limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
	if unsafe {
		SetInformationJobObject(
			job.0,
			JobObjectExtendedLimitInformation,
			std::ptr::from_ref(&limits).cast(),
			size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
		)
	} == 0
	{
		return Err(last_error("SetInformationJobObject(KILL_ON_JOB_CLOSE) failed"));
	}
	Ok(job)
}

#[cfg(windows)]
fn assign_job_and_resume(job: &WinHandle, child: &Child) -> Result<()> {
	let process = child.as_raw_handle() as HANDLE;
	if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
		return Err(last_error("AssignProcessToJobObject failed"));
	}
	let status = unsafe { NtResumeProcess(process) };
	if status < 0 {
		unsafe {
			TerminateJobObject(job.0, 1);
		}
		return Err(error(format!("NtResumeProcess failed with NTSTATUS 0x{:08x}", status as u32)));
	}
	Ok(())
}

#[cfg(unix)]
struct PosixOwnedProcessGroup {
	pgid:  libc::pid_t,
	#[cfg(target_os = "linux")]
	pidfd: Option<File>,
}

#[cfg(target_os = "linux")]
fn open_pidfd(pid: libc::pid_t) -> Result<Option<File>> {
	let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int;
	if fd >= 0 {
		return Ok(Some(unsafe { File::from_raw_fd(fd) }));
	}
	let io_error = std::io::Error::last_os_error();
	if matches!(
		io_error.raw_os_error(),
		Some(libc::ENOSYS) | Some(libc::EINVAL) | Some(libc::EPERM) | Some(libc::EACCES)
	) {
		Ok(None)
	} else {
		Err(error(io_error.to_string()))
	}
}

#[cfg(unix)]
fn capture_posix_process_group(child: &Child) -> Result<PosixOwnedProcessGroup> {
	let pid = child.id() as libc::pid_t;
	if pid <= 1 {
		return Err(error("spawned process has an invalid process-group identity"));
	}
	let pgid = unsafe { libc::getpgid(pid) };
	if pgid < 0 {
		return Err(error(format!("getpgid failed: {}", std::io::Error::last_os_error())));
	}
	if pgid != pid {
		return Err(error("spawned process did not enter its dedicated session"));
	}
	Ok(PosixOwnedProcessGroup {
		pgid,
		#[cfg(target_os = "linux")]
		pidfd: open_pidfd(pid)?,
	})
}

#[cfg(target_os = "linux")]
fn ensure_pidfd_live(group: &PosixOwnedProcessGroup) -> Result<()> {
	let Some(pidfd) = &group.pidfd else {
		return Ok(());
	};
	let mut descriptor =
		libc::pollfd { fd: pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
	let ready = unsafe { libc::poll(&mut descriptor, 1, 0) };
	if ready < 0 {
		return Err(error(format!("pidfd poll failed: {}", std::io::Error::last_os_error())));
	}
	if ready != 0 {
		return Err(error("refusing process-group termination after leader exit"));
	}
	Ok(())
}

#[cfg(unix)]
fn terminate_posix_process_group(group: &PosixOwnedProcessGroup) -> Result<()> {
	#[cfg(target_os = "linux")]
	ensure_pidfd_live(group)?;
	if group.pgid <= 1 {
		return Err(error("refusing invalid owned process group"));
	}
	if unsafe { libc::kill(-group.pgid, libc::SIGTERM) } != 0 {
		let io_error = std::io::Error::last_os_error();
		if io_error.raw_os_error() != Some(libc::ESRCH) {
			return Err(error(io_error.to_string()));
		}
		return Ok(());
	}
	std::thread::sleep(Duration::from_millis(100));
	if unsafe { libc::kill(-group.pgid, libc::SIGKILL) } != 0 {
		let io_error = std::io::Error::last_os_error();
		if io_error.raw_os_error() != Some(libc::ESRCH) {
			return Err(error(io_error.to_string()));
		}
	}
	Ok(())
}

fn terminate_owned_tree_checked(
	expected: &NativeProcessIdentity,
	recheck: impl FnOnce() -> Result<NativeProcessIdentity>,
	terminate_tree: impl FnOnce() -> Result<()>,
) -> Result<()> {
	if !expected.live.load(Ordering::Acquire) {
		return Err(error("refusing termination of an inactive owned process"));
	}
	let current = recheck()?;
	if !same_identity(expected, &current) {
		return Err(error("refusing termination after owned child identity changed"));
	}
	terminate_tree()
}

struct OwnedProcessState {
	child:         Mutex<Option<Child>>,
	identity:      NativeProcessIdentity,
	#[cfg(windows)]
	job:           Mutex<Option<WinHandle>>,
	#[cfg(unix)]
	process_group: PosixOwnedProcessGroup,
}

#[napi]
#[derive(Clone)]
pub struct NativeOwnedProcess {
	state: Arc<OwnedProcessState>,
}

#[napi]
impl NativeOwnedProcess {
	#[napi(getter)]
	pub fn identity(&self) -> NativeProcessIdentity {
		self.state.identity.clone()
	}

	#[napi]
	pub fn wait(&self, timeout_ms: Option<u32>) -> crate::task::Promise<NativeProcessExit> {
		let process = self.clone();
		crate::task::blocking("local_peer.process.wait", (), move |_| process.wait_sync(timeout_ms))
	}

	#[napi]
	pub fn terminate(&self) -> crate::task::Promise<()> {
		let process = self.clone();
		crate::task::blocking("local_peer.process.terminate", (), move |_| process.terminate_sync())
	}

	#[napi]
	pub fn close(&self) {
		let _ = self.terminate_sync();
		#[cfg(windows)]
		self.state.job.lock().take();
		if let Some(mut child) = self.state.child.lock().take() {
			let _ = child.wait();
		}
		self.state.identity.live.store(false, Ordering::Release);
	}
}

impl NativeOwnedProcess {
	fn wait_sync(&self, timeout_ms: Option<u32>) -> Result<NativeProcessExit> {
		let started = Instant::now();
		loop {
			let status = self
				.state
				.child
				.lock()
				.as_mut()
				.ok_or_else(|| error("native-owned process handle is closed"))?
				.try_wait()
				.map_err(|err| error(err.to_string()))?;
			if let Some(status) = status {
				self.state.identity.live.store(false, Ordering::Release);
				return Ok(NativeProcessExit { exit_code: status.code(), signal: None });
			}
			if timeout_ms.is_some_and(|limit| started.elapsed() >= Duration::from_millis(limit as u64))
			{
				return Ok(NativeProcessExit { exit_code: None, signal: None });
			}
			std::thread::sleep(Duration::from_millis(10));
		}
	}

	fn child_has_exited(&self) -> Result<bool> {
		let mut child = self.state.child.lock();
		let Some(child) = child.as_mut() else {
			return Ok(!self.state.identity.live.load(Ordering::Acquire));
		};
		if child
			.try_wait()
			.map_err(|err| error(err.to_string()))?
			.is_some()
		{
			self.state.identity.live.store(false, Ordering::Release);
			return Ok(true);
		}
		Ok(false)
	}

	fn terminate_sync(&self) -> Result<()> {
		if self.child_has_exited()? || !self.state.identity.live.load(Ordering::Acquire) {
			return Ok(());
		}
		#[cfg(windows)]
		let result = {
			let job = self.state.job.lock();
			let job = job
				.as_ref()
				.ok_or_else(|| error("native-owned process job is closed"))?;
			terminate_owned_tree_checked(
				&self.state.identity,
				|| process_identity(self.state.identity.pid),
				|| {
					if unsafe { TerminateJobObject(job.0, 1) } == 0 {
						Err(last_error("TerminateJobObject failed"))
					} else {
						Ok(())
					}
				},
			)
		};
		#[cfg(unix)]
		let result = terminate_owned_tree_checked(
			&self.state.identity,
			|| process_identity(self.state.identity.pid),
			|| terminate_posix_process_group(&self.state.process_group),
		);
		#[cfg(all(not(windows), not(unix)))]
		let result = Err(error(UNSUPPORTED));
		if result.is_err() && self.child_has_exited()? {
			return Ok(());
		}
		result
	}
}

#[cfg(unix)]
fn duplicate_cloexec(file: &File) -> Result<File> {
	let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
	if fd < 0 {
		Err(error(std::io::Error::last_os_error().to_string()))
	} else {
		Ok(unsafe { File::from_raw_fd(fd) })
	}
}

#[cfg(unix)]
fn configure_dedicated_fds(command: &mut Command, files: Vec<(File, RawFd)>) {
	unsafe {
		command.pre_exec(move || {
			for (source, target) in &files {
				if libc::dup2(source.as_raw_fd(), *target) < 0 {
					return Err(std::io::Error::last_os_error());
				}
				if libc::fcntl(*target, libc::F_SETFD, 0) < 0 {
					return Err(std::io::Error::last_os_error());
				}
			}
			Ok(())
		});
	}
}

#[cfg(unix)]
fn anonymous_inherited_pipe() -> Result<(File, File)> {
	let mut descriptors = [-1; 2];
	if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
		return Err(error(std::io::Error::last_os_error().to_string()));
	}
	let read = unsafe { File::from_raw_fd(descriptors[0]) };
	let write = unsafe { File::from_raw_fd(descriptors[1]) };
	for file in [&read, &write] {
		let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
		if flags < 0
			|| unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0
		{
			return Err(error(std::io::Error::last_os_error().to_string()));
		}
	}
	Ok((read, write))
}

fn spawn_verified(
	executable: &NativeVerifiedExecutable,
	args: &[String],
	configure: impl FnOnce(&mut Command) -> Result<()>,
) -> Result<NativeOwnedProcess> {
	if executable.state.file.lock().is_none() {
		return Err(error("verified executable capability is closed"));
	}
	#[cfg(any(windows, unix))]
	let current = {
		let held = executable.state.file.lock();
		held
			.as_ref()
			.ok_or_else(|| error("verified executable capability is closed"))?
			.try_clone()
			.map_err(|err| error(err.to_string()))?
	};
	#[cfg(all(not(windows), not(unix)))]
	let current = File::open(&executable.state.path).map_err(|err| error(err.to_string()))?;
	if opened_identity(&current).map_err(|err| error(err.to_string()))?
		!= executable.state.launch_identity
	{
		return Err(error("verified executable capability identity changed before launch"));
	}
	if sha256(&current).map_err(|err| error(err.to_string()))? != executable.state.sha256 {
		return Err(error("verified executable digest changed before launch"));
	}
	#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
	let launch_path: PathBuf = return Err(error(UNSUPPORTED));
	#[cfg(windows)]
	let job = create_kill_on_close_job()?;
	#[cfg(unix)]
	let launch_file = duplicate_cloexec(&current)?;
	#[cfg(target_os = "linux")]
	let launch_path = PathBuf::from(format!("/proc/self/fd/{}", launch_file.as_raw_fd()));
	#[cfg(target_os = "macos")]
	let launch_path = PathBuf::from(format!("/dev/fd/{}", launch_file.as_raw_fd()));
	#[cfg(not(unix))]
	let launch_path = executable.state.path.clone();
	let mut command = Command::new(launch_path);
	command.args(args).env_clear();
	#[cfg(windows)]
	command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
	#[cfg(unix)]
	unsafe {
		command.pre_exec(|| {
			if libc::setsid() < 0 {
				Err(std::io::Error::last_os_error())
			} else {
				Ok(())
			}
		});
	}
	configure(&mut command)?;
	let mut child = command
		.spawn()
		.map_err(|err| error(format!("verified process launch failed: {err}")))?;
	#[cfg(unix)]
	let process_group = match capture_posix_process_group(&child) {
		Ok(group) => group,
		Err(err) => {
			let pid = child.id() as libc::pid_t;
			if unsafe { libc::getpgid(pid) } == pid {
				unsafe {
					libc::kill(-pid, libc::SIGKILL);
				}
			}
			return Err(err);
		},
	};
	let identity = match process_identity(child.id()) {
		Ok(identity) if identity.executable == executable.state.launch_identity => identity,
		Ok(_) => {
			#[cfg(windows)]
			let _ = child.kill();
			#[cfg(unix)]
			let _ = terminate_posix_process_group(&process_group);
			#[cfg(all(not(windows), not(unix)))]
			let _ = child.kill();
			return Err(error("spawned executable identity mismatch"));
		},
		Err(err) => {
			#[cfg(windows)]
			let _ = child.kill();
			#[cfg(unix)]
			let _ = terminate_posix_process_group(&process_group);
			#[cfg(all(not(windows), not(unix)))]
			let _ = child.kill();
			return Err(err);
		},
	};
	#[cfg(windows)]
	if let Err(err) = assign_job_and_resume(&job, &child) {
		let _ = child.kill();
		return Err(err);
	}
	Ok(NativeOwnedProcess {
		state: Arc::new(OwnedProcessState {
			child: Mutex::new(Some(child)),
			identity,
			#[cfg(windows)]
			job: Mutex::new(Some(job)),
			#[cfg(unix)]
			process_group,
		}),
	})
}
fn deliver_inherited_material(
	mut bootstrap_write: File,
	bootstrap: &[u8],
	mut runtime_key_write: File,
	runtime_key: &[u8],
) -> Result<()> {
	std::thread::scope(|scope| {
		let bootstrap_delivery = scope.spawn(move || bootstrap_write.write_all(bootstrap));
		let runtime_key_delivery = scope.spawn(move || runtime_key_write.write_all(runtime_key));
		bootstrap_delivery
			.join()
			.map_err(|_| error("inherited bootstrap delivery worker panicked"))?
			.map_err(|err| error(format!("inherited bootstrap delivery failed: {err}")))?;
		runtime_key_delivery
			.join()
			.map_err(|_| error("inherited runtime-key delivery worker panicked"))?
			.map_err(|err| error(format!("inherited runtime-key delivery failed: {err}")))
	})
}

#[napi(js_name = "launchVerifiedProcess")]
pub fn launch_verified_process(
	spec: Either<ClassInstance<NativeVerifiedRuntimeLaunch>, Object<'_>>,
) -> Result<crate::task::Promise<NativeOwnedProcess>> {
	let (executable, args, environment, bundle) =
		match spec {
			Either::A(runtime) => {
				let material =
					runtime.state.material.lock().take().ok_or_else(|| {
						error("verified runtime launch capability is closed or consumed")
					})?;
				{
					let handles = material.bundle.state.handles.lock();
					let handles = handles
						.as_ref()
						.ok_or_else(|| error("verified runtime bundle capability is closed"))?;
					verify_runtime_handles(&material.bundle.state, handles)?;
				}
				(material.executable, material.args, material.environment, Some(material.bundle))
			},
			Either::B(spec) => {
				let executable: ClassInstance<NativeVerifiedExecutable> =
					spec.get_named_property("executable")?;
				let args: Vec<String> = spec.get_named_property("args")?;
				let environment: ClassInstance<NativeLaunchEnvironment> =
					spec.get_named_property("environment")?;
				(executable.as_ref().clone(), args, environment.as_ref().clone(), None)
			},
		};
	Ok(crate::task::blocking("local_peer.process.launch", (), move |_| {
		let _bundle = bundle;
		launch_verified_process_sync(executable, args, environment)
	}))
}

fn launch_verified_process_sync(
	executable: NativeVerifiedExecutable,
	args: Vec<String>,
	environment: NativeLaunchEnvironment,
) -> Result<NativeOwnedProcess> {
	if args.len() > 64
		|| args
			.iter()
			.any(|argument| argument.len() > 4096 || argument.contains('\0'))
	{
		return Err(error("verified process arguments are invalid"));
	}
	let EnvironmentKind::Tunnel { bootstrap, bootstrap_identity, runtime_key, broker, epoch } =
		environment.kind.as_ref()
	else {
		return Err(error("verified process launch requires tunnel-child environment"));
	};
	if broker.state.name.is_empty() || epoch.is_empty() || !valid_launch_identity(bootstrap_identity)
	{
		return Err(error("tunnel launch capability is closed"));
	}
	let (mut bootstrap_bytes, mut runtime_key_bytes) = {
		let mut bootstrap = bootstrap.lock();
		let mut runtime_key = runtime_key.lock();
		let bootstrap = bootstrap
			.take()
			.ok_or_else(|| error("tunnel launch capability is already consumed"))?;
		let runtime_key = match runtime_key.take() {
			Some(bytes) => bytes,
			None => {
				let mut bootstrap = bootstrap;
				bootstrap.fill(0);
				return Err(error("tunnel launch capability is already consumed"));
			},
		};
		(bootstrap, runtime_key)
	};
	#[cfg(windows)]
	{
		let inherited_broker = connect_local_sync(broker)?;
		let inherited_file = {
			let guard = inherited_broker.state.file.lock();
			guard
				.as_ref()
				.ok_or_else(|| error("inherited broker connection is closed"))?
				.try_clone()
				.map_err(|err| error(err.to_string()))?
		};
		let (inherited_bootstrap, bootstrap_write) = anonymous_inherited_pipe()?;
		let (inherited_runtime_key, runtime_key_write) = anonymous_inherited_pipe()?;
		set_handle_inheritable(&inherited_file, true)?;
		set_handle_inheritable(&bootstrap_write, false)?;
		set_handle_inheritable(&runtime_key_write, false)?;
		let broker_handle = inherited_file.as_raw_handle() as usize;
		let bootstrap_handle = inherited_bootstrap.as_raw_handle() as usize;
		let runtime_key_handle = inherited_runtime_key.as_raw_handle() as usize;
		let launched = spawn_verified(&executable, &args, move |command| {
			command
				.env("OMP_INHERITED_BROKER_HANDLE", broker_handle.to_string())
				.env("OMP_INHERITED_BOOTSTRAP_HANDLE", bootstrap_handle.to_string())
				.env("OMP_INHERITED_BOOTSTRAP_IDENTITY", bootstrap_identity.clone())
				.env("OMP_INHERITED_RUNTIME_KEY_HANDLE", runtime_key_handle.to_string());
			Ok(())
		});

		let clear_result = set_handle_inheritable(&inherited_file, false);
		drop((inherited_file, inherited_bootstrap, inherited_runtime_key));
		let process = match launched {
			Ok(process) => process,
			Err(err) => {
				bootstrap_bytes.fill(0);
				runtime_key_bytes.fill(0);
				return Err(err);
			},
		};
		if let Err(err) = clear_result {
			let _ = process.terminate_sync();
			bootstrap_bytes.fill(0);
			runtime_key_bytes.fill(0);
			return Err(err);
		}
		let delivery = deliver_inherited_material(
			bootstrap_write,
			bootstrap_bytes.as_slice(),
			runtime_key_write,
			runtime_key_bytes.as_slice(),
		);
		bootstrap_bytes.fill(0);
		runtime_key_bytes.fill(0);
		if let Err(err) = delivery {
			let _ = process.terminate_sync();
			return Err(err);
		}
		return Ok(process);
	}
	#[cfg(unix)]
	{
		const BROKER_FD: RawFd = 3;
		const BOOTSTRAP_FD: RawFd = 4;
		const RUNTIME_KEY_FD: RawFd = 5;
		let inherited_broker = connect_local_sync(broker)?;
		let broker_file = {
			let guard = inherited_broker.state.file.lock();
			duplicate_cloexec(
				guard
					.as_ref()
					.ok_or_else(|| error("inherited broker connection is closed"))?,
			)?
		};
		let (bootstrap_source, bootstrap_write) = anonymous_inherited_pipe()?;
		let (runtime_key_source, runtime_key_write) = anonymous_inherited_pipe()?;
		let bootstrap_file = duplicate_cloexec(&bootstrap_source)?;
		let runtime_key_file = duplicate_cloexec(&runtime_key_source)?;
		drop((bootstrap_source, runtime_key_source));
		let launched = spawn_verified(&executable, &args, move |command| {
			command
				.env("OMP_INHERITED_BROKER_FD", BROKER_FD.to_string())
				.env("OMP_INHERITED_BOOTSTRAP_FD", BOOTSTRAP_FD.to_string())
				.env("OMP_INHERITED_BOOTSTRAP_IDENTITY", bootstrap_identity.clone())
				.env("OMP_INHERITED_RUNTIME_KEY_FD", RUNTIME_KEY_FD.to_string());
			configure_dedicated_fds(command, vec![
				(broker_file, BROKER_FD),
				(bootstrap_file, BOOTSTRAP_FD),
				(runtime_key_file, RUNTIME_KEY_FD),
			]);
			Ok(())
		});
		let process = match launched {
			Ok(process) => process,
			Err(err) => {
				bootstrap_bytes.fill(0);
				runtime_key_bytes.fill(0);
				return Err(err);
			},
		};
		let delivery = deliver_inherited_material(
			bootstrap_write,
			bootstrap_bytes.as_slice(),
			runtime_key_write,
			runtime_key_bytes.as_slice(),
		);
		bootstrap_bytes.fill(0);
		runtime_key_bytes.fill(0);
		if let Err(err) = delivery {
			let _ = process.terminate_sync();
			return Err(err);
		}
		return Ok(process);
	}
	#[cfg(all(not(windows), not(unix)))]
	{
		bootstrap_bytes.fill(0);
		runtime_key_bytes.fill(0);
		let _ = (&executable, args, broker);
		Err(error(UNSUPPORTED))
	}
}

#[napi(string_enum)]
pub enum NativeBrowserFeatureToggle {
	#[napi(value = "disable-background-networking")]
	DisableBackgroundNetworking,
	#[napi(value = "disable-component-update")]
	DisableComponentUpdate,
	#[napi(value = "disable-default-apps")]
	DisableDefaultApps,
}

#[napi(object)]
pub struct NativeBrowserLaunchOptions {
	pub headed:          bool,
	#[napi(js_name = "featureToggles")]
	pub feature_toggles: Option<Vec<NativeBrowserFeatureToggle>>,
}

fn validate_browser_launch_record(flags: &[String]) -> Result<()> {
	if flags
		.iter()
		.filter(|arg| arg.as_str() == "--remote-debugging-pipe")
		.count()
		!= 1
	{
		return Err(error("browser launch must contain exactly one remote-debugging pipe flag"));
	}
	if flags
		.iter()
		.filter(|arg| arg.starts_with("--user-data-dir="))
		.count()
		!= 1
	{
		return Err(error("browser launch must contain exactly one owned profile flag"));
	}
	for forbidden in [
		"--remote-debugging-port",
		"--remote-debugging-address",
		"--no-sandbox",
		"--disable-sandbox",
		"--disable-web-security",
		"--allow-running-insecure-content",
		"--ignore-certificate-errors",
		"--profile-directory",
	] {
		if flags
			.iter()
			.any(|arg| arg == forbidden || arg.starts_with(&format!("{forbidden}=")))
		{
			return Err(error("forbidden browser endpoint or security flag"));
		}
	}
	Ok(())
}

fn browser_launch_record(
	options: &NativeBrowserLaunchOptions,
	profile_root: &Path,
	io_handles: Option<(usize, usize)>,
) -> Result<Vec<String>> {
	let mut flags = vec![
		"--remote-debugging-pipe".to_owned(),
		format!("--user-data-dir={}", profile_root.to_string_lossy()),
	];
	if let Some((input, output)) = io_handles {
		flags.push(format!("--remote-debugging-io-pipes={input},{output}"));
	}
	if !options.headed {
		flags.push("--headless=new".to_owned());
	}
	for toggle in options.feature_toggles.as_deref().unwrap_or_default() {
		let flag = match toggle {
			NativeBrowserFeatureToggle::DisableBackgroundNetworking => {
				"--disable-background-networking"
			},
			NativeBrowserFeatureToggle::DisableComponentUpdate => "--disable-component-update",
			NativeBrowserFeatureToggle::DisableDefaultApps => "--disable-default-apps",
		};
		if flags.iter().any(|existing| existing == flag) {
			return Err(error("duplicate native browser feature toggle"));
		}
		flags.push(flag.to_owned());
	}
	validate_browser_launch_record(&flags)?;
	Ok(flags)
}

#[derive(Clone)]
struct DuplexPipe {
	reader: Arc<Mutex<Option<File>>>,
	writer: Arc<Mutex<Option<File>>>,
}

#[napi]
#[derive(Clone)]
pub struct NativeBrowserPipe {
	state: DuplexPipe,
}

#[napi]
impl NativeBrowserPipe {
	#[napi(getter, js_name = "nonBlocking")]
	pub fn non_blocking(&self) -> bool {
		true
	}

	#[napi]
	pub fn read(&self) -> crate::task::Promise<Uint8Array> {
		let reader = Arc::clone(&self.state.reader);
		crate::task::blocking("local_peer.browser_pipe.read", (), move |_| {
			let mut reader = {
				let guard = reader.lock();
				guard
					.as_ref()
					.ok_or_else(|| error("native browser pipe is closed"))?
					.try_clone()
					.map_err(|err| error(err.to_string()))?
			};
			let mut bytes = vec![0_u8; 64 * 1024];
			let count = reader
				.read(&mut bytes)
				.map_err(|err| error(err.to_string()))?;
			bytes.truncate(count);
			Ok(bytes.into())
		})
	}

	#[napi]
	pub fn write(&self, bytes: Uint8Array) -> crate::task::Promise<()> {
		let writer = Arc::clone(&self.state.writer);
		let bytes = bytes.to_vec();
		crate::task::blocking("local_peer.browser_pipe.write", (), move |_| {
			let mut writer = {
				let guard = writer.lock();
				guard
					.as_ref()
					.ok_or_else(|| error("native browser pipe is closed"))?
					.try_clone()
					.map_err(|err| error(err.to_string()))?
			};
			writer
				.write_all(&bytes)
				.map_err(|err| error(err.to_string()))
		})
	}

	#[napi]
	pub fn close(&self) -> crate::task::Promise<()> {
		let reader = Arc::clone(&self.state.reader);
		let writer = Arc::clone(&self.state.writer);
		crate::task::blocking("local_peer.browser_pipe.close", (), move |_| {
			reader.lock().take();
			writer.lock().take();
			Ok(())
		})
	}
}

#[napi]
#[derive(Clone)]
pub struct NativeOwnedBrowserProcess {
	process: NativeOwnedProcess,
	pipe:    NativeBrowserPipe,
}

#[napi]
impl NativeOwnedBrowserProcess {
	#[napi(getter)]
	pub fn process(&self) -> NativeOwnedProcess {
		self.process.clone()
	}

	#[napi(getter)]
	pub fn pipe(&self) -> NativeBrowserPipe {
		self.pipe.clone()
	}
}

#[cfg(windows)]
fn set_handle_inheritable(file: &File, inheritable: bool) -> Result<()> {
	if unsafe {
		SetHandleInformation(
			file.as_raw_handle() as HANDLE,
			HANDLE_FLAG_INHERIT,
			if inheritable { HANDLE_FLAG_INHERIT } else { 0 },
		)
	} == 0
	{
		return Err(last_error("SetHandleInformation failed"));
	}
	Ok(())
}
#[cfg(windows)]
fn anonymous_inherited_pipe() -> Result<(File, File)> {
	let mut read = std::ptr::null_mut();
	let mut write = std::ptr::null_mut();
	let mut attributes = SECURITY_ATTRIBUTES {
		nLength:              size_of::<SECURITY_ATTRIBUTES>() as u32,
		lpSecurityDescriptor: std::ptr::null_mut(),
		bInheritHandle:       1,
	};
	if unsafe { CreatePipe(&mut read, &mut write, &mut attributes, 0) } == 0 {
		return Err(last_error("CreatePipe failed"));
	}
	Ok((unsafe { File::from_raw_handle(read as RawHandle) }, unsafe {
		File::from_raw_handle(write as RawHandle)
	}))
}

#[napi(js_name = "launchVerifiedBrowser")]
pub fn launch_verified_browser(
	spec: Object<'_>,
) -> Result<crate::task::Promise<NativeOwnedBrowserProcess>> {
	reject_named_properties(
		&spec,
		&["args", "argv", "profile", "profilePath", "userDataDir", "endpoint", "remoteDebuggingPort"],
		"verified browser launch",
	)?;
	let options_object: Object<'_> = spec.get_named_property("options")?;
	reject_named_properties(
		&options_object,
		&[
			"args",
			"argv",
			"profile",
			"profilePath",
			"userDataDir",
			"endpoint",
			"remoteDebuggingPort",
			"noSandbox",
			"disableWebSecurity",
		],
		"native browser options",
	)?;
	let executable: ClassInstance<NativeVerifiedExecutable> =
		spec.get_named_property("executable")?;
	let environment: ClassInstance<NativeLaunchEnvironment> =
		spec.get_named_property("environment")?;
	let options: NativeBrowserLaunchOptions = spec.get_named_property("options")?;
	let executable = executable.as_ref().clone();
	let environment = environment.as_ref().clone();
	Ok(crate::task::blocking("local_peer.browser.launch", (), move |_| {
		launch_verified_browser_sync(executable, environment, options)
	}))
}

fn launch_verified_browser_sync(
	executable: NativeVerifiedExecutable,
	environment: NativeLaunchEnvironment,
	options: NativeBrowserLaunchOptions,
) -> Result<NativeOwnedBrowserProcess> {
	let EnvironmentKind::Browser { profile_root, profile_generation, owner_fence } =
		environment.kind.as_ref()
	else {
		return Err(error("browser launch requires browser-child environment"));
	};
	if profile_root.state.file.lock().is_none()
		|| !valid_launch_identity(profile_generation)
		|| !valid_launch_identity(owner_fence)
	{
		return Err(error("browser profile capability is closed or invalid"));
	}
	#[cfg(windows)]
	let current_profile = windows_open_existing_private_directory(&profile_root.state.path)?;
	#[cfg(windows)]
	if opened_identity(&current_profile).map_err(|err| error(err.to_string()))?
		!= profile_root.state.identity
	{
		return Err(error("browser profile path was replaced before launch"));
	}
	#[cfg(unix)]
	let profile_file = {
		let held = profile_root.state.file.lock();
		held
			.as_ref()
			.ok_or_else(|| error("browser profile capability is closed"))?
			.try_clone()
			.map_err(|err| error(err.to_string()))?
	};
	#[cfg(unix)]
	if opened_identity(&profile_file).map_err(|err| error(err.to_string()))?
		!= profile_root.state.identity
	{
		return Err(error("browser profile handle identity changed"));
	}
	#[cfg(windows)]
	{
		let (command_read, parent_write) = anonymous_inherited_pipe()?;
		let (parent_read, response_write) = anonymous_inherited_pipe()?;
		set_handle_inheritable(&parent_write, false)?;
		set_handle_inheritable(&parent_read, false)?;
		if opened_identity(&current_profile).map_err(|err| error(err.to_string()))?
			!= profile_root.state.identity
		{
			return Err(error("browser profile path changed immediately before launch"));
		}
		let record = browser_launch_record(
			&options,
			&profile_root.state.path,
			Some((command_read.as_raw_handle() as usize, response_write.as_raw_handle() as usize)),
		)?;
		let process = spawn_verified(&executable, &record, move |command| {
			command.stdin(Stdio::from(command_read));
			command.stdout(Stdio::from(response_write));
			Ok(())
		})?;
		return Ok(NativeOwnedBrowserProcess {
			process,
			pipe: NativeBrowserPipe {
				state: DuplexPipe {
					reader: Arc::new(Mutex::new(Some(parent_read))),
					writer: Arc::new(Mutex::new(Some(parent_write))),
				},
			},
		});
	}
	#[cfg(unix)]
	{
		const COMMAND_FD: RawFd = 3;
		const RESPONSE_FD: RawFd = 4;
		const PROFILE_FD: RawFd = 5;
		let (command_read, parent_write) = anonymous_inherited_pipe()?;
		let (parent_read, response_write) = anonymous_inherited_pipe()?;
		let child_command = duplicate_cloexec(&command_read)?;
		let child_response = duplicate_cloexec(&response_write)?;
		let child_profile = duplicate_cloexec(&profile_file)?;
		drop((command_read, response_write));
		#[cfg(target_os = "linux")]
		let profile_path = PathBuf::from(format!("/proc/self/fd/{PROFILE_FD}"));
		#[cfg(target_os = "macos")]
		let profile_path = PathBuf::from(format!("/dev/fd/{PROFILE_FD}"));
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		let profile_path: PathBuf = return Err(error(UNSUPPORTED));
		let record = browser_launch_record(&options, &profile_path, None)?;
		let process = spawn_verified(&executable, &record, move |command| {
			configure_dedicated_fds(command, vec![
				(child_command, COMMAND_FD),
				(child_response, RESPONSE_FD),
				(child_profile, PROFILE_FD),
			]);
			Ok(())
		})?;
		return Ok(NativeOwnedBrowserProcess {
			process,
			pipe: NativeBrowserPipe {
				state: DuplexPipe {
					reader: Arc::new(Mutex::new(Some(parent_read))),
					writer: Arc::new(Mutex::new(Some(parent_write))),
				},
			},
		});
	}
	#[cfg(all(not(windows), not(unix)))]
	{
		let _ = (&executable, options);
		Err(error(UNSUPPORTED))
	}
}

#[cfg(windows)]
struct PipeSecurity {
	descriptor: Box<SECURITY_DESCRIPTOR>,
	acl:        Vec<u64>,
	sid:        Vec<u8>,
}

#[cfg(windows)]
impl PipeSecurity {
	fn attributes(&mut self) -> SECURITY_ATTRIBUTES {
		SECURITY_ATTRIBUTES {
			nLength:              size_of::<SECURITY_ATTRIBUTES>() as u32,
			lpSecurityDescriptor: self.descriptor.as_mut() as *mut _ as *mut _,
			bInheritHandle:       0,
		}
	}
}

#[cfg(windows)]
fn owner_only_pipe_security() -> Result<PipeSecurity> {
	let mut token = std::ptr::null_mut();
	if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
		return Err(last_error("OpenProcessToken failed"));
	}
	let token = WinHandle(token);
	let mut needed = 0_u32;
	unsafe {
		GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed);
	}
	if needed == 0 {
		return Err(last_error("GetTokenInformation size failed"));
	}
	let mut token_user = vec![0_u8; needed as usize];
	if unsafe {
		GetTokenInformation(token.0, TokenUser, token_user.as_mut_ptr().cast(), needed, &mut needed)
	} == 0
	{
		return Err(last_error("GetTokenInformation failed"));
	}
	let user = unsafe { &*(token_user.as_ptr() as *const TOKEN_USER) };
	let sid_len = unsafe { GetLengthSid(user.User.Sid) } as usize;
	if sid_len == 0 {
		return Err(last_error("GetLengthSid failed"));
	}
	let mut sid = vec![0_u8; sid_len];
	unsafe {
		std::ptr::copy_nonoverlapping(user.User.Sid.cast::<u8>(), sid.as_mut_ptr(), sid_len);
	}
	let acl_bytes =
		size_of::<ACL>() + size_of::<windows_sys::Win32::Security::ACCESS_ALLOWED_ACE>() + sid_len
			- size_of::<u32>();
	let mut acl = vec![0_u64; acl_bytes.div_ceil(size_of::<u64>())];
	let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
	if unsafe { InitializeAcl(acl_ptr, acl_bytes as u32, ACL_REVISION) } == 0
		|| unsafe { AddAccessAllowedAce(acl_ptr, ACL_REVISION, GENERIC_ALL, sid.as_mut_ptr().cast()) }
			== 0
	{
		return Err(last_error("owner-only ACL construction failed"));
	}
	let mut descriptor = Box::<SECURITY_DESCRIPTOR>::default();
	let descriptor_ptr = descriptor.as_mut() as *mut SECURITY_DESCRIPTOR as *mut std::ffi::c_void;
	if unsafe { InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION) } == 0
		|| unsafe { SetSecurityDescriptorOwner(descriptor_ptr, sid.as_mut_ptr().cast(), 0) } == 0
		|| unsafe { SetSecurityDescriptorDacl(descriptor_ptr, 1, acl_ptr, 0) } == 0
	{
		return Err(last_error("owner-only security descriptor construction failed"));
	}
	Ok(PipeSecurity { descriptor, acl, sid })
}

#[cfg(windows)]
const fn named_pipe_mode() -> u32 {
	PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS
}

#[cfg(windows)]
fn create_named_pipe(name: &str, first: bool) -> Result<File> {
	let mut security = owner_only_pipe_security()?;
	let mut attributes = security.attributes();
	let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
	let handle = unsafe {
		CreateNamedPipeW(
			name.as_ptr(),
			PIPE_ACCESS_DUPLEX
				| if first {
					FILE_FLAG_FIRST_PIPE_INSTANCE
				} else {
					0
				},
			named_pipe_mode(),
			PIPE_UNLIMITED_INSTANCES,
			64 * 1024,
			64 * 1024,
			0,
			&mut attributes,
		)
	};
	if handle == INVALID_HANDLE_VALUE {
		return Err(last_error("CreateNamedPipeW failed"));
	}
	Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
}

#[cfg(target_os = "linux")]
fn unix_peer_pid(file: &File) -> Result<u32> {
	let mut credentials = unsafe { std::mem::zeroed::<libc::ucred>() };
	let mut length = size_of::<libc::ucred>() as libc::socklen_t;
	if unsafe {
		libc::getsockopt(
			file.as_raw_fd(),
			libc::SOL_SOCKET,
			libc::SO_PEERCRED,
			(&mut credentials as *mut libc::ucred).cast(),
			&mut length,
		)
	} != 0
		|| length as usize != size_of::<libc::ucred>()
	{
		return Err(error(format!("SO_PEERCRED failed: {}", std::io::Error::last_os_error())));
	}
	if credentials.pid <= 0 || credentials.uid != unsafe { libc::geteuid() } {
		return Err(error("Unix peer is not owned by the current user"));
	}
	Ok(credentials.pid as u32)
}

#[cfg(target_os = "macos")]
fn unix_peer_pid(file: &File) -> Result<u32> {
	const SOL_LOCAL: libc::c_int = 0;
	const LOCAL_PEERPID: libc::c_int = 2;
	let mut uid = 0;
	let mut gid = 0;
	if unsafe { libc::getpeereid(file.as_raw_fd(), &mut uid, &mut gid) } != 0 {
		return Err(error(format!("getpeereid failed: {}", std::io::Error::last_os_error())));
	}
	if uid != unsafe { libc::geteuid() } {
		return Err(error("Unix peer is not owned by the current user"));
	}
	let mut pid: libc::pid_t = 0;
	let mut length = size_of::<libc::pid_t>() as libc::socklen_t;
	if unsafe {
		libc::getsockopt(
			file.as_raw_fd(),
			SOL_LOCAL,
			LOCAL_PEERPID,
			(&mut pid as *mut libc::pid_t).cast(),
			&mut length,
		)
	} != 0
		|| length as usize != size_of::<libc::pid_t>()
		|| pid <= 0
	{
		return Err(error(format!("LOCAL_PEERPID failed: {}", std::io::Error::last_os_error())));
	}
	Ok(pid as u32)
}
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn unix_peer_pid(_file: &File) -> Result<u32> {
	Err(error(UNSUPPORTED))
}

#[cfg(unix)]
fn unix_stream_file(stream: UnixStream) -> File {
	unsafe { File::from_raw_fd(stream.into_raw_fd()) }
}

#[cfg(unix)]
fn remove_unix_listener_paths(state: &ListenerState) {
	use std::os::unix::fs::MetadataExt;
	if fs::symlink_metadata(&state.endpoint.state.name).is_ok_and(|metadata| {
		metadata.dev() == state.socket_device && metadata.ino() == state.socket_inode
	}) {
		let _ = fs::remove_file(&state.endpoint.state.name);
	}
	if fs::symlink_metadata(&state.socket_dir).is_ok_and(|metadata| {
		metadata.dev() == state.directory_device && metadata.ino() == state.directory_inode
	}) {
		let _ = fs::remove_dir(&state.socket_dir);
	}
}

#[cfg(unix)]
impl Drop for ListenerState {
	fn drop(&mut self) {
		remove_unix_listener_paths(self);
	}
}

#[derive(Clone)]
struct EndpointState {
	name:      String,
	owner_pid: u32,
	owner:     NativeProcessIdentity,
}

#[napi]
#[derive(Clone)]
pub struct NativeLocalEndpoint {
	state: Arc<EndpointState>,
}

#[napi]
impl NativeLocalEndpoint {
	#[napi(getter)]
	pub fn kind(&self) -> &'static str {
		"owner-local"
	}
}

struct ListenerState {
	endpoint:         NativeLocalEndpoint,
	#[cfg(windows)]
	pending:          Mutex<Option<File>>,
	#[cfg(unix)]
	listener:         Mutex<Option<UnixListener>>,
	#[cfg(unix)]
	socket_dir:       PathBuf,
	#[cfg(unix)]
	socket_device:    u64,
	#[cfg(unix)]
	socket_inode:     u64,
	#[cfg(unix)]
	directory_device: u64,
	#[cfg(unix)]
	directory_inode:  u64,
	closed:           AtomicBool,
}

#[napi]
#[derive(Clone)]
pub struct NativeLocalListener {
	state: Arc<ListenerState>,
}

static PIPE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[napi]
impl NativeLocalListener {
	#[napi(factory)]
	pub fn create() -> Result<Self> {
		#[cfg(windows)]
		{
			let owner_pid = unsafe { GetCurrentProcessId() };
			let owner = process_identity(owner_pid)?;
			let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
			let name = format!(r"\\.\pipe\omp-local-peer-{owner_pid}-{sequence}");
			let pending = create_named_pipe(&name, true)?;
			let endpoint =
				NativeLocalEndpoint { state: Arc::new(EndpointState { name, owner_pid, owner }) };
			return Ok(Self {
				state: Arc::new(ListenerState {
					endpoint,
					pending: Mutex::new(Some(pending)),
					closed: AtomicBool::new(false),
				}),
			});
		}
		#[cfg(unix)]
		{
			let owner_pid = std::process::id();
			let owner = process_identity(owner_pid)?;
			let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
			let socket_dir = std::env::temp_dir().join(format!("omp-lp-{owner_pid:x}-{sequence:x}"));
			let mut builder = fs::DirBuilder::new();
			builder.mode(0o700);
			builder
				.create(&socket_dir)
				.map_err(|err| error(format!("create owner-local socket directory: {err}")))?;
			let name_path = socket_dir.join("peer.sock");
			let listener = match UnixListener::bind(&name_path) {
				Ok(listener) => listener,
				Err(err) => {
					let _ = fs::remove_dir(&socket_dir);
					return Err(error(format!("bind owner-local Unix socket: {err}")));
				},
			};
			listener
				.set_nonblocking(true)
				.map_err(|err| error(format!("make owner-local Unix listener interruptible: {err}")))?;
			if let Err(err) = fs::set_permissions(&name_path, fs::Permissions::from_mode(0o600)) {
				let _ = fs::remove_file(&name_path);
				let _ = fs::remove_dir(&socket_dir);
				return Err(error(format!("secure owner-local Unix socket: {err}")));
			}
			use std::os::unix::fs::MetadataExt;
			let directory_metadata =
				fs::metadata(&socket_dir).map_err(|err| error(err.to_string()))?;
			let socket_metadata = fs::metadata(&name_path).map_err(|err| error(err.to_string()))?;
			let euid = unsafe { libc::geteuid() };
			if directory_metadata.uid() != euid
				|| socket_metadata.uid() != euid
				|| directory_metadata.mode() & 0o777 != 0o700
				|| socket_metadata.mode() & 0o777 != 0o600
			{
				let _ = fs::remove_file(&name_path);
				let _ = fs::remove_dir(&socket_dir);
				return Err(error("owner-local Unix socket permissions are not exclusive"));
			}
			let name = match name_path.to_str() {
				Some(name) => name.to_owned(),
				None => {
					let _ = fs::remove_file(&name_path);
					let _ = fs::remove_dir(&socket_dir);
					return Err(error("owner-local Unix socket path is not UTF-8"));
				},
			};
			let endpoint =
				NativeLocalEndpoint { state: Arc::new(EndpointState { name, owner_pid, owner }) };
			return Ok(Self {
				state: Arc::new(ListenerState {
					endpoint,
					listener: Mutex::new(Some(listener)),
					socket_dir,
					socket_device: socket_metadata.dev(),
					socket_inode: socket_metadata.ino(),
					directory_device: directory_metadata.dev(),
					directory_inode: directory_metadata.ino(),
					closed: AtomicBool::new(false),
				}),
			});
		}
		#[cfg(all(not(windows), not(unix)))]
		{
			Err(error(UNSUPPORTED))
		}
	}

	#[napi(getter)]
	pub fn endpoint(&self) -> Result<NativeLocalEndpoint> {
		if self.state.closed.load(Ordering::Acquire) {
			return Err(error("native local listener is closed"));
		}
		Ok(self.state.endpoint.clone())
	}

	#[napi]
	pub fn accept(&self) -> crate::task::Promise<NativePeerConnection> {
		let state = Arc::clone(&self.state);
		crate::task::blocking("local_peer.listener.accept", (), move |_| {
			#[cfg(windows)]
			{
				if state.closed.load(Ordering::Acquire) {
					return Err(error("native local listener is closed"));
				}
				let file = {
					let mut pending = state.pending.lock();
					if pending.is_none() {
						*pending = Some(create_named_pipe(&state.endpoint.state.name, false)?);
					}
					pending.take().expect("pending named pipe exists")
				};
				loop {
					if state.closed.load(Ordering::Acquire) {
						return Err(error("native local listener is closed"));
					}
					let connected =
						unsafe { ConnectNamedPipe(file.as_raw_handle() as HANDLE, std::ptr::null_mut()) };
					if connected != 0 {
						break;
					}
					match std::io::Error::last_os_error().raw_os_error() {
						Some(code) if code == ERROR_PIPE_CONNECTED as i32 => break,
						Some(code) if code == ERROR_PIPE_LISTENING as i32 => {
							std::thread::sleep(Duration::from_millis(10));
						},
						_ => return Err(last_error("ConnectNamedPipe failed")),
					}
				}
				if state.closed.load(Ordering::Acquire) {
					return Err(error("native local listener is closed"));
				}
				let mut pid = 0_u32;
				if unsafe { GetNamedPipeClientProcessId(file.as_raw_handle() as HANDLE, &mut pid) } == 0
				{
					return Err(last_error("GetNamedPipeClientProcessId failed"));
				}
				let peer = process_identity(pid)?;
				return peer_connection(file, peer, true);
			}
			#[cfg(unix)]
			{
				let listener = {
					let listener = state.listener.lock();
					listener
						.as_ref()
						.ok_or_else(|| error("native local listener is closed"))?
						.try_clone()
						.map_err(|err| error(format!("clone owner-local Unix listener: {err}")))?
				};
				let stream = loop {
					if state.closed.load(Ordering::Acquire) {
						return Err(error("native local listener is closed"));
					}
					match listener.accept() {
						Ok((stream, _)) => break stream,
						Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
							std::thread::sleep(Duration::from_millis(10));
						},
						Err(err) => return Err(error(format!("accept owner-local Unix peer: {err}"))),
					}
				};
				if state.closed.load(Ordering::Acquire) {
					return Err(error("native local listener is closed"));
				}
				stream
					.set_nonblocking(true)
					.map_err(|err| error(format!("make owner-local Unix peer interruptible: {err}")))?;
				let file = unix_stream_file(stream);
				let pid = unix_peer_pid(&file)?;
				let peer = process_identity(pid)?;
				return peer_connection(file, peer, true);
			}
			#[cfg(all(not(windows), not(unix)))]
			Err(error(UNSUPPORTED))
		})
	}

	#[napi]
	pub fn close(&self) {
		self.state.closed.store(true, Ordering::Release);
		#[cfg(windows)]
		self.state.pending.lock().take();
		#[cfg(unix)]
		{
			self.state.listener.lock().take();
			remove_unix_listener_paths(&self.state);
		}
	}
}

fn configure_peer_nonblocking(file: &File) -> Result<()> {
	#[cfg(windows)]
	{
		let mut mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
		if unsafe {
			SetNamedPipeHandleState(
				file.as_raw_handle() as HANDLE,
				&mut mode,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
			)
		} == 0
		{
			return Err(last_error("SetNamedPipeHandleState failed"));
		}
	}
	#[cfg(unix)]
	{
		let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
		if flags < 0
			|| unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } != 0
		{
			return Err(error(format!(
				"make owner-local Unix peer interruptible: {}",
				std::io::Error::last_os_error(),
			)));
		}
	}
	#[cfg(all(not(windows), not(unix)))]
	{
		let _ = file;
		return Err(error(UNSUPPORTED));
	}
	Ok(())
}

fn peer_connection(
	file: File,
	peer: NativeProcessIdentity,
	peer_is_client: bool,
) -> Result<NativePeerConnection> {
	configure_peer_nonblocking(&file)?;
	Ok(NativePeerConnection {
		state: Arc::new(PeerState {
			file: Mutex::new(Some(file)),
			peer,
			closed: AtomicBool::new(false),
			peer_is_client,
		}),
	})
}

fn peer_io_would_block(err: &std::io::Error) -> bool {
	if err.kind() == std::io::ErrorKind::WouldBlock {
		return true;
	}
	#[cfg(windows)]
	{
		const ERROR_NO_DATA: i32 = 232;
		return err.raw_os_error() == Some(ERROR_NO_DATA);
	}
	#[cfg(not(windows))]
	false
}

struct PeerState {
	file:           Mutex<Option<File>>,
	peer:           NativeProcessIdentity,
	closed:         AtomicBool,
	peer_is_client: bool,
}

#[napi]
#[derive(Clone)]
pub struct NativePeerConnection {
	state: Arc<PeerState>,
}

#[napi]
impl NativePeerConnection {
	#[napi(getter)]
	pub fn peer(&self) -> Result<NativeProcessIdentity> {
		Ok(self.state.peer.clone())
	}

	#[napi(js_name = "currentPeer")]
	pub fn current_peer(&self) -> Result<NativeProcessIdentity> {
		let guard = self.state.file.lock();
		let file = guard
			.as_ref()
			.ok_or_else(|| error("native peer connection is closed"))?;
		#[cfg(windows)]
		let peer_pid = {
			let mut pid = 0_u32;
			let read = if self.state.peer_is_client {
				unsafe { GetNamedPipeClientProcessId(file.as_raw_handle() as HANDLE, &mut pid) }
			} else {
				unsafe { GetNamedPipeServerProcessId(file.as_raw_handle() as HANDLE, &mut pid) }
			};
			if read == 0 {
				return Err(last_error("re-read named-pipe peer PID failed"));
			}
			pid
		};
		#[cfg(unix)]
		let peer_pid = unix_peer_pid(file)?;
		#[cfg(all(not(windows), not(unix)))]
		let peer_pid: u32 = return Err(error(UNSUPPORTED));
		if peer_pid != self.state.peer.pid {
			return Err(error("native peer PID changed"));
		}
		let current = process_identity(peer_pid)?;
		if !same_identity(&self.state.peer, &current) {
			return Err(error("native peer identity changed"));
		}
		Ok(current)
	}

	#[napi]

	pub fn read(&self) -> crate::task::Promise<Uint8Array> {
		let state = Arc::clone(&self.state);
		crate::task::blocking("local_peer.connection.read", (), move |_| {
			let mut reader = {
				let guard = state.file.lock();
				guard
					.as_ref()
					.ok_or_else(|| error("native peer connection is closed"))?
					.try_clone()
					.map_err(|err| error(err.to_string()))?
			};
			let mut bytes = vec![0_u8; 64 * 1024];
			loop {
				if state.closed.load(Ordering::Acquire) {
					return Err(error("native peer connection is closed"));
				}
				match reader.read(&mut bytes) {
					Ok(count) => {
						bytes.truncate(count);
						return Ok(bytes.into());
					},
					Err(err) if peer_io_would_block(&err) => {
						std::thread::sleep(Duration::from_millis(10))
					},
					Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {},
					Err(err) => return Err(error(err.to_string())),
				}
			}
		})
	}

	#[napi]
	pub fn write(&self, bytes: Uint8Array) -> crate::task::Promise<()> {
		let state = Arc::clone(&self.state);
		let bytes = bytes.to_vec();
		crate::task::blocking("local_peer.connection.write", (), move |_| {
			let mut writer = {
				let guard = state.file.lock();
				guard
					.as_ref()
					.ok_or_else(|| error("native peer connection is closed"))?
					.try_clone()
					.map_err(|err| error(err.to_string()))?
			};
			let mut written = 0;
			while written < bytes.len() {
				if state.closed.load(Ordering::Acquire) {
					return Err(error("native peer connection is closed"));
				}
				match writer.write(&bytes[written..]) {
					Ok(0) => return Err(error("native peer connection write returned zero bytes")),
					Ok(count) => written += count,
					Err(err) if peer_io_would_block(&err) => {
						std::thread::sleep(Duration::from_millis(10))
					},
					Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {},
					Err(err) => return Err(error(err.to_string())),
				}
			}
			Ok(())
		})
	}

	#[napi]
	pub fn close(&self) -> crate::task::Promise<()> {
		self.state.closed.store(true, Ordering::Release);
		let state = Arc::clone(&self.state);
		crate::task::blocking("local_peer.connection.close", (), move |_| {
			state.file.lock().take();
			state.peer.live.store(false, Ordering::Release);
			Ok(())
		})
	}
}

#[napi(js_name = "connectLocal")]
pub fn connect_local(endpoint: &NativeLocalEndpoint) -> crate::task::Promise<NativePeerConnection> {
	let endpoint = endpoint.clone();
	crate::task::blocking("local_peer.connection.connect", (), move |_| {
		connect_local_sync(&endpoint)
	})
}

fn connect_local_sync(endpoint: &NativeLocalEndpoint) -> Result<NativePeerConnection> {
	if !matches_process_identity(&endpoint.state.owner, &endpoint.state.owner) {
		return Err(error("owner-local endpoint process is no longer live"));
	}
	#[cfg(windows)]
	{
		let name: Vec<u16> = endpoint.state.name.encode_utf16().chain(Some(0)).collect();
		let handle = unsafe {
			CreateFileW(
				name.as_ptr(),
				GENERIC_READ | GENERIC_WRITE,
				0,
				std::ptr::null(),
				OPEN_EXISTING,
				FILE_ATTRIBUTE_NORMAL,
				std::ptr::null_mut(),
			)
		};
		if handle == INVALID_HANDLE_VALUE {
			return Err(last_error("CreateFileW named-pipe connect failed"));
		}
		let file = unsafe { File::from_raw_handle(handle as RawHandle) };
		let mut pid = 0_u32;
		if unsafe { GetNamedPipeServerProcessId(handle, &mut pid) } == 0 {
			return Err(last_error("GetNamedPipeServerProcessId failed"));
		}
		if pid != endpoint.state.owner_pid {
			return Err(error("named-pipe server process changed"));
		}
		let peer = process_identity(pid)?;
		if !same_identity(&peer, &endpoint.state.owner) {
			return Err(error("named-pipe server identity changed"));
		}
		return peer_connection(file, peer, false);
	}
	#[cfg(unix)]
	{
		let stream = UnixStream::connect(&endpoint.state.name)
			.map_err(|err| error(format!("connect owner-local Unix socket: {err}")))?;
		let file = unix_stream_file(stream);
		let pid = unix_peer_pid(&file)?;
		if pid != endpoint.state.owner_pid {
			return Err(error("Unix socket server process changed"));
		}
		let peer = process_identity(pid)?;
		if !same_identity(&peer, &endpoint.state.owner) {
			return Err(error("Unix socket server identity changed"));
		}
		return peer_connection(file, peer, false);
	}
	#[cfg(all(not(windows), not(unix)))]
	{
		let _ = endpoint;
		Err(error(UNSUPPORTED))
	}
}
static INHERITED_BROKER_CONSUMED: AtomicBool = AtomicBool::new(false);

fn claim_inherited_broker(consumed: &AtomicBool) -> Result<()> {
	if consumed.swap(true, Ordering::AcqRel) {
		Err(error("inherited broker capability was already consumed"))
	} else {
		Ok(())
	}
}

#[cfg(windows)]
fn inherited_broker_handle() -> Result<(HANDLE, u32)> {
	let value = std::env::var("OMP_INHERITED_BROKER_HANDLE")
		.map_err(|_| error("inherited broker capability is absent"))?;
	// SAFETY: this runs once during child bootstrap, before the process starts
	// worker threads. Removing the locator prevents replay through descendants.
	unsafe {
		std::env::remove_var("OMP_INHERITED_BROKER_HANDLE");
	}
	let raw = value
		.parse::<usize>()
		.map_err(|_| error("inherited broker handle is malformed"))?;
	let excluded = [
		std::io::stdin().as_raw_handle() as usize,
		std::io::stdout().as_raw_handle() as usize,
		std::io::stderr().as_raw_handle() as usize,
	];
	if raw == 0 || raw == INVALID_HANDLE_VALUE as usize || excluded.contains(&raw) {
		return Err(error("inherited broker handle is invalid"));
	}
	let handle = raw as HANDLE;
	let mut server_pid = 0_u32;
	if unsafe { GetNamedPipeServerProcessId(handle, &mut server_pid) } == 0 {
		return Err(last_error("inherited broker handle is not a named-pipe connection"));
	}
	Ok((handle, server_pid))
}

#[cfg(unix)]
fn inherited_fd(variable: &str, consumed: &AtomicBool) -> Result<File> {
	if consumed.swap(true, Ordering::AcqRel) {
		return Err(error(format!("{variable} capability was already consumed")));
	}
	let value =
		std::env::var(variable).map_err(|_| error(format!("{variable} capability is absent")))?;
	// SAFETY: child bootstrap consumes inherited locators before starting worker
	// threads.
	unsafe {
		std::env::remove_var(variable);
	}
	let fd = value
		.parse::<RawFd>()
		.map_err(|_| error(format!("{variable} descriptor is malformed")))?;
	if fd <= libc::STDERR_FILENO {
		return Err(error(format!("{variable} descriptor is invalid")));
	}
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
	if flags < 0 {
		return Err(error(format!("{variable} descriptor is not open")));
	}
	if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } != 0 {
		return Err(error(format!(
			"secure inherited descriptor: {}",
			std::io::Error::last_os_error()
		)));
	}
	Ok(unsafe { File::from_raw_fd(fd) })
}

fn inherited_material_identity(
	identity_variable: Option<&str>,
	fallback: String,
) -> Result<String> {
	let identity = match identity_variable {
		Some(variable) => {
			let value =
				std::env::var(variable).map_err(|_| error(format!("{variable} identity is absent")))?;
			unsafe {
				std::env::remove_var(variable);
			}
			value
		},
		None => fallback,
	};
	if !valid_launch_identity(&identity) {
		return Err(error("inherited material identity is invalid"));
	}
	Ok(identity)
}

#[cfg(unix)]
fn open_inherited_owned_file(
	variable: &str,
	consumed: &AtomicBool,
	identity_variable: Option<&str>,
) -> Result<NativeOwnedFile> {
	let file = inherited_fd(variable, consumed)?;
	use std::os::unix::fs::FileTypeExt;
	if !file
		.metadata()
		.map_err(|err| error(format!("{variable} descriptor metadata failed: {err}")))?
		.file_type()
		.is_fifo()
	{
		return Err(error(format!("{variable} descriptor is not an inherited material pipe")));
	}
	let identity =
		inherited_material_identity(identity_variable, format!("inherited-fd:{}", file.as_raw_fd()))?;
	Ok(NativeOwnedFile {
		state: Arc::new(OwnedFileState {
			path: PathBuf::new(),
			file: Mutex::new(Some(file)),
			identity,
			directory: false,
			consumed: AtomicBool::new(false),
			mutation_lock: Arc::new(Mutex::new(())),
			parent: None,
			name: None,
		}),
	})
}

/// Recover the one-shot broker capability from its dedicated inherited
/// named-pipe handle.
#[napi(js_name = "connectInheritedBroker")]
pub fn connect_inherited_broker() -> Result<NativePeerConnection> {
	#[cfg(windows)]
	{
		claim_inherited_broker(&INHERITED_BROKER_CONSUMED)?;
		let (handle, server_pid) = inherited_broker_handle()?;
		if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
			return Err(last_error("SetHandleInformation inherited broker failed"));
		}
		let file = unsafe { File::from_raw_handle(handle as RawHandle) };
		let peer = process_identity(server_pid)?;
		return peer_connection(file, peer, false);
	}
	#[cfg(unix)]
	{
		let file = inherited_fd("OMP_INHERITED_BROKER_FD", &INHERITED_BROKER_CONSUMED)?;
		let server_pid = unix_peer_pid(&file)?;
		let peer = process_identity(server_pid)?;
		return peer_connection(file, peer, false);
	}
	#[cfg(all(not(windows), not(unix)))]
	{
		Err(error(UNSUPPORTED))
	}
}
static INHERITED_BOOTSTRAP_CONSUMED: AtomicBool = AtomicBool::new(false);
static INHERITED_RUNTIME_KEY_CONSUMED: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
fn open_inherited_owned_file(
	variable: &str,
	consumed: &AtomicBool,
	identity_variable: Option<&str>,
) -> Result<NativeOwnedFile> {
	claim_inherited_broker(consumed)?;
	let value =
		std::env::var(variable).map_err(|_| error(format!("{variable} capability is absent")))?;
	// SAFETY: bootstrap executes before worker threads and consumes this locator
	// once.
	unsafe {
		std::env::remove_var(variable);
	}
	let raw = value
		.parse::<usize>()
		.map_err(|_| error(format!("{variable} handle is malformed")))?;
	let excluded = [
		std::io::stdin().as_raw_handle() as usize,
		std::io::stdout().as_raw_handle() as usize,
		std::io::stderr().as_raw_handle() as usize,
	];
	if raw == 0 || raw == INVALID_HANDLE_VALUE as usize || excluded.contains(&raw) {
		return Err(error(format!("{variable} handle is invalid")));
	}
	let handle = raw as HANDLE;
	if unsafe { GetFileType(handle) } != FILE_TYPE_PIPE {
		return Err(error(format!("{variable} handle is not an inherited material pipe")));
	}
	if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
		return Err(last_error("SetHandleInformation inherited file failed"));
	}
	let file = unsafe { File::from_raw_handle(handle as RawHandle) };
	let identity =
		inherited_material_identity(identity_variable, format!("inherited-handle:{raw}"))?;
	Ok(NativeOwnedFile {
		state: Arc::new(OwnedFileState {
			path: PathBuf::new(),
			file: Mutex::new(Some(file)),
			identity,
			directory: false,
			consumed: AtomicBool::new(false),
			mutation_lock: Arc::new(Mutex::new(())),
		}),
	})
}

#[napi(js_name = "openInheritedBrokerBootstrap")]
pub fn open_inherited_broker_bootstrap() -> Result<NativeOwnedFile> {
	#[cfg(windows)]
	{
		return open_inherited_owned_file(
			"OMP_INHERITED_BOOTSTRAP_HANDLE",
			&INHERITED_BOOTSTRAP_CONSUMED,
			Some("OMP_INHERITED_BOOTSTRAP_IDENTITY"),
		);
	}
	#[cfg(unix)]
	{
		return open_inherited_owned_file(
			"OMP_INHERITED_BOOTSTRAP_FD",
			&INHERITED_BOOTSTRAP_CONSUMED,
			Some("OMP_INHERITED_BOOTSTRAP_IDENTITY"),
		);
	}

	#[cfg(all(not(windows), not(unix)))]
	{
		Err(error(UNSUPPORTED))
	}
}

#[napi(js_name = "openInheritedRuntimeKey")]
pub fn open_inherited_runtime_key() -> Result<NativeOwnedFile> {
	#[cfg(windows)]
	{
		return open_inherited_owned_file(
			"OMP_INHERITED_RUNTIME_KEY_HANDLE",
			&INHERITED_RUNTIME_KEY_CONSUMED,
			None,
		);
	}
	#[cfg(unix)]
	{
		return open_inherited_owned_file(
			"OMP_INHERITED_RUNTIME_KEY_FD",
			&INHERITED_RUNTIME_KEY_CONSUMED,
			None,
		);
	}
	#[cfg(all(not(windows), not(unix)))]
	{
		Err(error(UNSUPPORTED))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn semantic_version_parser_is_strict() {
		for valid in ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3-alpha-1+linux.x86-64"] {
			assert!(is_strict_semver(valid), "{valid}");
		}
		for invalid in [
			"",
			"v1.2.3",
			"01.2.3",
			"1.02.3",
			"1.2.03",
			"1.2",
			"1.2.3-01",
			"1.2.3-",
			"1.2.3+",
			"1.2.3 alpha",
		] {
			assert!(!is_strict_semver(invalid), "{invalid}");
		}
	}

	#[test]
	fn version_output_requires_an_exact_token() {
		assert!(version_output_contains(b"tunnel-client 1.2.3\n", "1.2.3"));
		assert!(version_output_contains(b"version=(1.2.3-alpha.1+linux)\n", "1.2.3-alpha.1+linux"));
		assert!(!version_output_contains(b"tunnel-client v1.2.3\n", "1.2.3"));
		assert!(!version_output_contains(b"tunnel-client 1.2.30\n", "1.2.3"));
		assert!(!version_output_contains(b"tunnel-client 11.2.3\n", "1.2.3"));
	}

	#[test]
	fn version_output_reader_caps_retained_bytes() {
		let overflow = Arc::new(AtomicBool::new(false));
		let input = vec![b'x'; MAX_EXECUTABLE_VERSION_OUTPUT_BYTES + 1];
		let output =
			read_bounded_version_output(std::io::Cursor::new(input), overflow.clone()).unwrap();
		assert_eq!(output.len(), MAX_EXECUTABLE_VERSION_OUTPUT_BYTES);
		assert!(overflow.load(Ordering::Acquire));
	}

	#[test]
	fn browser_record_has_exactly_one_pipe_and_owned_profile() {
		let record = browser_launch_record(
			&NativeBrowserLaunchOptions { headed: true, feature_toggles: None },
			Path::new("owned-profile"),
			None,
		)
		.unwrap();
		assert_eq!(
			record
				.iter()
				.filter(|arg| *arg == "--remote-debugging-pipe")
				.count(),
			1
		);
		assert_eq!(
			record
				.iter()
				.filter(|arg| arg.starts_with("--user-data-dir="))
				.count(),
			1
		);
		assert!(
			!record
				.iter()
				.any(|arg| arg.contains("remote-debugging-port")
					|| arg.starts_with("http:")
					|| arg.starts_with("ws:"))
		);
	}
	#[cfg(any(target_os = "linux", target_os = "macos"))]
	#[test]
	fn browser_record_uses_inherited_profile_directory_fd() {
		#[cfg(target_os = "linux")]
		let profile = "/proc/self/fd/5";
		#[cfg(target_os = "macos")]
		let profile = "/dev/fd/5";
		let record = browser_launch_record(
			&NativeBrowserLaunchOptions { headed: false, feature_toggles: None },
			Path::new(profile),
			None,
		)
		.unwrap();
		assert!(
			record
				.iter()
				.any(|arg| arg == &format!("--user-data-dir={profile}"))
		);
	}

	#[test]
	fn duplicate_feature_toggle_is_rejected() {
		let result = browser_launch_record(
			&NativeBrowserLaunchOptions {
				headed:          false,
				feature_toggles: Some(vec![
					NativeBrowserFeatureToggle::DisableDefaultApps,
					NativeBrowserFeatureToggle::DisableDefaultApps,
				]),
			},
			Path::new("owned-profile"),
			None,
		);
		assert!(result.is_err());
	}

	#[test]
	fn forbidden_browser_flags_are_rejected() {
		for forbidden in [
			"--remote-debugging-port=0",
			"--remote-debugging-address=0.0.0.0",
			"--no-sandbox",
			"--disable-sandbox",
			"--disable-web-security",
			"--allow-running-insecure-content",
			"--ignore-certificate-errors",
			"--profile-directory=Default",
		] {
			let flags = vec![
				"--remote-debugging-pipe".into(),
				"--user-data-dir=owned".into(),
				forbidden.into(),
			];
			assert!(validate_browser_launch_record(&flags).is_err());
		}
	}

	#[cfg(windows)]
	#[test]
	fn pipe_security_is_owner_only_and_rejects_remote_clients() {
		let security = owner_only_pipe_security().unwrap();
		assert!(!security.sid.is_empty());
		assert!(!security.acl.is_empty());
		assert_ne!(named_pipe_mode() & PIPE_REJECT_REMOTE_CLIENTS, 0);
	}

	#[cfg(windows)]
	#[test]
	fn held_file_cleanup_preserves_a_replacement_path() {
		let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let path = std::env::temp_dir()
			.join(format!("pi-native-file-replacement-{}-{sequence}", std::process::id()));
		let displaced = path.with_extension("displaced");
		fs::write(&path, b"original").unwrap();
		let owned = NativeOwnedFile::open(path.to_string_lossy().into_owned(), Some(false)).unwrap();
		fs::rename(&path, &displaced).unwrap();
		fs::write(&path, b"replacement").unwrap();
		owned.cleanup().unwrap();
		owned.close();
		assert_eq!(fs::read(&path).unwrap(), b"replacement");
		assert!(!displaced.exists());
		let _ = fs::remove_file(&path);
		let _ = fs::remove_file(&displaced);
	}
	#[test]
	fn inherited_broker_is_process_bound_and_one_shot() {
		let consumed = AtomicBool::new(false);
		assert!(claim_inherited_broker(&consumed).is_ok());
		assert!(claim_inherited_broker(&consumed).is_err());
	}

	#[test]
	fn complete_identity_is_not_pid_only() {
		let live = Arc::new(AtomicBool::new(true));
		let first = NativeProcessIdentity {
			pid:        7,
			start:      "one".into(),
			executable: "exe-a".into(),
			live:       live.clone(),
		};
		let reused = NativeProcessIdentity {
			pid:        7,
			start:      "two".into(),
			executable: "exe-a".into(),
			live:       live.clone(),
		};
		let replaced =
			NativeProcessIdentity { pid: 7, start: "one".into(), executable: "exe-b".into(), live };
		assert!(!matches_process_identity(&first, &reused));
		assert!(!matches_process_identity(&first, &replaced));
	}

	#[test]
	fn checked_tree_termination_drains_parent_and_grandchild() {
		let expected = NativeProcessIdentity {
			pid:        41,
			start:      "parent-start".into(),
			executable: "parent-executable".into(),
			live:       Arc::new(AtomicBool::new(true)),
		};
		let current = expected.clone();
		let mut parent_alive = true;
		let mut grandchild_alive = true;
		terminate_owned_tree_checked(
			&expected,
			|| Ok(current),
			|| {
				parent_alive = false;
				grandchild_alive = false;
				Ok(())
			},
		)
		.unwrap();
		assert!(!parent_alive);
		assert!(!grandchild_alive);
	}

	#[test]
	fn checked_tree_termination_refuses_reused_parent_identity() {
		let expected = NativeProcessIdentity {
			pid:        41,
			start:      "parent-start".into(),
			executable: "parent-executable".into(),
			live:       Arc::new(AtomicBool::new(true)),
		};
		let reused = NativeProcessIdentity {
			pid:        41,
			start:      "reused-start".into(),
			executable: "parent-executable".into(),
			live:       Arc::new(AtomicBool::new(true)),
		};
		let invoked = std::cell::Cell::new(false);
		assert!(
			terminate_owned_tree_checked(
				&expected,
				|| Ok(reused),
				|| {
					invoked.set(true);
					Ok(())
				},
			)
			.is_err()
		);
		assert!(!invoked.get());
	}

	#[cfg(any(windows, unix))]
	#[test]
	fn owned_tree_process_fixture() {
		match std::env::var("OMP_NATIVE_OWNED_TREE_FIXTURE").as_deref() {
			Ok("parent") => {
				let mut grandchild = Command::new(std::env::current_exe().unwrap());
				grandchild
					.arg("owned_tree_process_fixture")
					.arg("--nocapture")
					.arg("--test-threads=1")
					.env("OMP_NATIVE_OWNED_TREE_FIXTURE", "grandchild");
				let grandchild = grandchild.spawn().unwrap();
				fs::write(
					std::env::var_os("OMP_NATIVE_OWNED_TREE_PID_FILE").unwrap(),
					grandchild.id().to_string(),
				)
				.unwrap();
				loop {
					std::thread::sleep(Duration::from_secs(1));
				}
			},
			Ok("grandchild") => loop {
				std::thread::sleep(Duration::from_secs(1));
			},
			_ => {},
		}
	}

	#[cfg(any(windows, unix))]
	#[test]
	fn owned_tree_termination_removes_real_grandchild() {
		let path = std::env::current_exe().unwrap();
		let executable = open_executable_sync(path.to_string_lossy().into_owned()).unwrap();
		let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let pid_file = std::env::temp_dir()
			.join(format!("pi-native-owned-tree-{}-{sequence}", std::process::id(),));
		let pid_file_value = pid_file.to_string_lossy().into_owned();
		let owned = spawn_verified(
			&executable,
			&["owned_tree_process_fixture".into(), "--nocapture".into(), "--test-threads=1".into()],
			move |command| {
				command
					.env("OMP_NATIVE_OWNED_TREE_FIXTURE", "parent")
					.env("OMP_NATIVE_OWNED_TREE_PID_FILE", pid_file_value);
				Ok(())
			},
		)
		.unwrap();
		let started = Instant::now();
		let grandchild_pid = loop {
			if let Ok(value) = fs::read_to_string(&pid_file) {
				break value.parse::<u32>().unwrap();
			}
			assert!(started.elapsed() < Duration::from_secs(5), "grandchild PID was not published");
			std::thread::sleep(Duration::from_millis(10));
		};
		let grandchild = process_identity(grandchild_pid).unwrap();
		owned.terminate_sync().unwrap();
		owned.wait_sync(Some(5_000)).unwrap();
		assert!(!owned.state.identity.live.load(Ordering::Acquire));
		let started = Instant::now();
		while matches_process_identity(&grandchild, &grandchild) {
			assert!(
				started.elapsed() < Duration::from_secs(5),
				"owned grandchild survived tree termination"
			);
			std::thread::sleep(Duration::from_millis(10));
		}
		owned.terminate_sync().unwrap();
		owned.close();
		owned.close();

		let _ = fs::remove_file(pid_file);
	}
	#[cfg(windows)]
	#[test]
	fn owner_local_windows_endpoint_retains_complete_process_identity() {
		let listener = NativeLocalListener::create().unwrap();
		let endpoint = listener.endpoint().unwrap();
		assert_eq!(endpoint.state.owner.pid, std::process::id());
		assert!(!endpoint.state.owner.start.is_empty());
		assert!(!endpoint.state.owner.executable.is_empty());
		let mut reused = endpoint.state.owner.clone();
		reused.start.push_str("-reused");
		assert!(!same_identity(&endpoint.state.owner, &reused));
		let reused_endpoint = NativeLocalEndpoint {
			state: Arc::new(EndpointState {
				name:      endpoint.state.name.clone(),
				owner_pid: endpoint.state.owner_pid,
				owner:     reused,
			}),
		};
		assert!(connect_local_sync(&reused_endpoint).is_err());
		listener.close();
	}
	#[cfg(unix)]
	#[test]
	fn held_file_rejects_symlinks_and_preserves_replacements() {
		use std::os::unix::fs::symlink;

		let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let root = std::env::temp_dir()
			.join(format!("pi-native-unix-held-{}-{sequence}", std::process::id()));
		let real = root.join("real");
		let linked = root.join("linked");
		fs::create_dir_all(&real).unwrap();
		let path = real.join("capability");
		fs::write(&path, b"original").unwrap();
		symlink(&real, &linked).unwrap();
		assert!(
			NativeOwnedFile::open(
				linked.join("capability").to_string_lossy().into_owned(),
				Some(false)
			)
			.is_err()
		);
		let final_link = real.join("final-link");
		symlink(&path, &final_link).unwrap();
		assert!(
			NativeOwnedFile::open(final_link.to_string_lossy().into_owned(), Some(false)).is_err()
		);

		let owned = NativeOwnedFile::open(path.to_string_lossy().into_owned(), Some(false)).unwrap();
		let displaced = real.join("displaced");
		fs::rename(&path, &displaced).unwrap();
		fs::write(&path, b"replacement").unwrap();
		assert!(owned.cleanup().is_err());
		assert_eq!(fs::read(&path).unwrap(), b"replacement");
		owned.close();
		fs::remove_dir_all(&root).unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn current_process_identity_is_complete_and_live() {
		let identity = process_identity(std::process::id()).unwrap();
		assert_eq!(identity.pid, std::process::id());
		assert!(!identity.start.is_empty());
		assert!(!identity.executable.is_empty());
		assert!(matches_process_identity(&identity, &identity));
	}

	#[cfg(unix)]
	#[test]
	fn owner_local_unix_transport_captures_native_peer_pid() {
		let listener = NativeLocalListener::create().unwrap();
		let endpoint = listener.endpoint().unwrap();
		let client = connect_local_sync(&endpoint).unwrap();
		let server_stream = listener
			.state
			.listener
			.lock()
			.as_ref()
			.unwrap()
			.accept()
			.unwrap()
			.0;
		let server_file = unix_stream_file(server_stream);
		assert_eq!(unix_peer_pid(&server_file).unwrap(), std::process::id());
		assert_eq!(client.peer().unwrap().pid, std::process::id());
		assert!(matches_process_identity(&endpoint.state.owner, &client.peer().unwrap()));
		client.close();
		listener.close();
	}

	#[cfg(any(windows, unix))]
	#[test]
	fn recursive_owned_tree_cleanup_removes_nested_contents() {
		let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let root_path = std::env::temp_dir()
			.join(format!("pi-native-tree-cleanup-{}-{sequence}", std::process::id()));
		let root =
			open_or_create_private_directory(root_path.to_string_lossy().into_owned()).unwrap();
		let tree = open_or_create_owned_directory(&root, "profile".into()).unwrap();
		let tree_identity = tree.state.identity.clone();
		let nested = open_or_create_owned_directory(&tree, "nested".into()).unwrap();
		let file = create_private_owned(&nested, "state".into(), b"value").unwrap();
		assert!(Arc::ptr_eq(&root.state.mutation_lock, &tree.state.mutation_lock));
		assert!(Arc::ptr_eq(&root.state.mutation_lock, &nested.state.mutation_lock));
		assert!(Arc::ptr_eq(&root.state.mutation_lock, &file.state.mutation_lock));
		file.close();
		nested.close();
		tree.close();
		remove_owned_tree_atomic(&root, "profile".into(), tree_identity).unwrap();
		assert!(
			open_owned_child_optional(&root, "profile", true)
				.unwrap()
				.is_none()
		);
		root.close();
		fs::remove_dir(root_path).unwrap();
	}

	#[cfg(any(windows, unix))]
	#[test]
	fn browser_executable_immutability_policy_is_basename_scoped() {
		for name in [
			"google-chrome-stable",
			"google-chrome",
			"chromium",
			"chromium-browser",
			"chrome",
			"Google Chrome",
			"Chromium.exe",
		] {
			assert!(is_known_browser_executable(Path::new(name)), "{name}");
		}
		assert!(!is_known_browser_executable(Path::new("generic-launch-fixture")));
	}
	#[cfg(windows)]
	#[test]
	fn windows_browser_executable_policy_rejects_user_writable_candidates() {
		assert!(windows_browser_executable_path_is_trusted(Path::new(
			r"C:\Program Files\Google\Chrome\Application\chrome.exe",
		)));
		assert!(windows_browser_executable_path_is_trusted(Path::new(
			r"C:\Program Files (x86)\Chromium\Application\chrome.exe",
		)));
		assert!(!windows_browser_executable_path_is_trusted(Path::new(
			r"C:\Users\Owner\AppData\Local\Google\Chrome\Application\chrome.exe",
		)));
		assert!(!windows_browser_executable_path_is_trusted(Path::new(
			r"C:\Program Files\Google\..\..\Users\Owner\chrome.exe",
		)));
	}

	#[cfg(unix)]
	#[test]
	fn browser_executable_immutability_policy_allows_owner_read_only_install() {
		use std::os::unix::fs::PermissionsExt;
		let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let root = std::env::temp_dir()
			.join(format!("pi-native-browser-policy-{}-{sequence}", std::process::id(),));
		fs::create_dir_all(&root).unwrap();
		let target = root.join("Google Chrome");
		fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
		fs::set_permissions(&target, fs::Permissions::from_mode(0o555)).unwrap();
		let executable = open_executable_sync(target.to_string_lossy().into_owned()).unwrap();
		assert!(!executable.state.sha256.is_empty());
		executable.close();
		fs::remove_dir_all(root).unwrap();
	}

	#[cfg(any(windows, unix))]
	#[test]
	fn executable_discovery_derives_digest_version_and_strict_open_still_matches() {
		let path = std::env::current_exe()
			.unwrap()
			.to_string_lossy()
			.into_owned();
		let discovered = open_executable_sync(path.clone()).unwrap();
		assert_eq!(discovered.state.sha256.len(), 64);
		assert_eq!(discovered.state.version, format!("sha256:{}", discovered.state.sha256));
		assert!(
			open_verified_executable_sync(OpenVerifiedExecutableSpec {
				path:    path.clone(),
				sha256:  "0".repeat(64),
				version: discovered.state.version.clone(),
			})
			.is_err()
		);
		let verified = open_verified_executable_sync(OpenVerifiedExecutableSpec {
			path,
			sha256: discovered.state.sha256.clone(),
			version: discovered.state.version.clone(),
		})
		.unwrap();
		assert_eq!(verified.state.identity, discovered.state.identity);
	}

	#[cfg(unix)]
	#[test]
	fn verified_executable_snapshot_is_stable_after_in_place_source_mutation() {
		let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let root = std::env::temp_dir()
			.join(format!("pi-native-executable-digest-{}-{sequence}", std::process::id(),));
		fs::create_dir_all(&root).unwrap();
		let target = root.join("fixture");
		fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
		let executable = open_executable_sync(target.to_string_lossy().into_owned()).unwrap();
		fs::write(&target, b"changed in place").unwrap();
		let snapshot = executable
			.state
			.file
			.lock()
			.as_ref()
			.unwrap()
			.try_clone()
			.unwrap();
		assert_eq!(opened_identity(&snapshot).unwrap(), executable.state.launch_identity);
		assert_eq!(sha256(&snapshot).unwrap(), executable.state.sha256);
		assert_ne!(sha256(&File::open(&target).unwrap()).unwrap(), executable.state.sha256);
		executable.close();
		fs::remove_dir_all(root).unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn replacement_commit_revalidation_rejects_changed_destination() {
		let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let root_path = std::env::temp_dir()
			.join(format!("pi-native-replacement-cas-{}-{sequence}", std::process::id(),));
		fs::create_dir_all(&root_path).unwrap();
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			fs::set_permissions(&root_path, fs::Permissions::from_mode(0o700)).unwrap();
		}
		let target = root_path.join("state");
		fs::write(&target, b"original").unwrap();
		let root =
			NativeOwnedFile::open(root_path.to_string_lossy().into_owned(), Some(true)).unwrap();
		let original = open_owned_child_optional(&root, "state", false)
			.unwrap()
			.unwrap();
		validate_owned_replacement_state(&root, "state", Some(&original.state.identity)).unwrap();
		fs::rename(&target, root_path.join("displaced")).unwrap();
		fs::write(&target, b"replacement").unwrap();
		assert!(
			validate_owned_replacement_state(&root, "state", Some(&original.state.identity)).is_err()
		);
		root.close();
		fs::remove_dir_all(root_path).unwrap();
	}

	#[cfg(windows)]
	#[test]
	fn windows_executable_capability_denies_replacement() {
		let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let root = std::env::temp_dir()
			.join(format!("pi-native-executable-replacement-{}-{sequence}", std::process::id(),));
		fs::create_dir_all(&root).unwrap();
		let target = root.join("fixture.exe");
		fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
		let file = windows_executable_open(&target).unwrap();
		let displaced = root.join("displaced");
		assert!(fs::rename(&target, &displaced).is_err());
		drop(file);
		fs::remove_dir_all(root).unwrap();
	}

	#[cfg(any(windows, unix))]
	#[test]
	fn tunnel_material_snapshot_survives_source_consumption_and_is_one_shot() {
		let sequence = PIPE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let root = std::env::temp_dir()
			.join(format!("pi-native-launch-material-{}-{sequence}", std::process::id(),));
		fs::create_dir_all(&root).unwrap();
		let bootstrap_path = root.join("bootstrap");
		let key_path = root.join("key");
		fs::write(&bootstrap_path, b"bootstrap-proof").unwrap();
		fs::write(&key_path, b"runtime-key").unwrap();
		let bootstrap_file =
			NativeOwnedFile::open(bootstrap_path.to_string_lossy().into_owned(), Some(false)).unwrap();
		let key_file =
			NativeOwnedFile::open(key_path.to_string_lossy().into_owned(), Some(false)).unwrap();
		let listener = NativeLocalListener::create().unwrap();
		let endpoint = listener.endpoint().unwrap();
		let environment = NativeLaunchEnvironment::tunnel_child(
			&bootstrap_file,
			&key_file,
			&endpoint,
			"epoch-1".into(),
		)
		.unwrap();
		bootstrap_file.consume().unwrap();
		key_file.consume().unwrap();
		let EnvironmentKind::Tunnel { bootstrap, runtime_key, .. } = environment.kind.as_ref() else {
			unreachable!()
		};
		let mut bootstrap_bytes = bootstrap.lock().take().unwrap();
		let mut key_bytes = runtime_key.lock().take().unwrap();
		assert_eq!(bootstrap_bytes.as_slice(), b"bootstrap-proof");
		assert_eq!(key_bytes.as_slice(), b"runtime-key");
		assert!(bootstrap.lock().take().is_none());
		assert!(runtime_key.lock().take().is_none());
		let (mut read, mut write) = anonymous_inherited_pipe().unwrap();
		write.write_all(bootstrap_bytes.as_slice()).unwrap();
		drop(write);
		let mut delivered = Vec::new();
		read.read_to_end(&mut delivered).unwrap();
		assert_eq!(delivered, b"bootstrap-proof");
		bootstrap_bytes.fill(0);
		key_bytes.fill(0);
		listener.close();
		bootstrap_file.close();
		key_file.close();
		fs::remove_dir_all(root).unwrap();
	}

	#[cfg(any(windows, unix))]
	#[test]
	fn inherited_material_delivery_does_not_depend_on_child_read_order() {
		let (mut bootstrap_read, bootstrap_write) = anonymous_inherited_pipe().unwrap();
		let (mut key_read, key_write) = anonymous_inherited_pipe().unwrap();
		let bootstrap = vec![0x42; MAX_INHERITED_MATERIAL_BYTES];
		let key = vec![0x4b; MAX_INHERITED_MATERIAL_BYTES];
		std::thread::scope(|scope| {
			let key_reader = scope.spawn(|| {
				let mut bytes = Vec::new();
				key_read.read_to_end(&mut bytes).unwrap();
				bytes
			});
			let bootstrap_reader = scope.spawn(|| {
				let mut bytes = Vec::new();
				bootstrap_read.read_to_end(&mut bytes).unwrap();
				bytes
			});
			deliver_inherited_material(bootstrap_write, &bootstrap, key_write, &key).unwrap();
			assert_eq!(bootstrap_reader.join().unwrap(), bootstrap);
			assert_eq!(key_reader.join().unwrap(), key);
		});
	}
}
