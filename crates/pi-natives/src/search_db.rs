//! Shared native search DB state for grep/glob/fuzzyFind.
//!
//! This owns search-side shared state that should outlive individual native
//! calls: frecency tracking plus a bounded per-root cache of `fff` file
//! pickers.

use std::{
	collections::HashMap,
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use fff::{FFFMode, FileItem, FilePicker, FrecencyTracker, SharedFrecency, SharedPicker};
use napi::{Error, bindgen_prelude::Result};
use napi_derive::napi;
use parking_lot::Mutex;

use crate::task;

const MAX_RETAINED_PICKERS: usize = 8;
const PICKER_IDLE_TTL: Duration = Duration::from_mins(2);
const PICKER_STALE_AFTER: Duration = Duration::from_secs(30);
const PICKER_WAIT_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Copy)]
struct SearchDbConfig {
	max_retained_pickers: usize,
	idle_ttl:             Duration,
	stale_after:          Duration,
}

impl Default for SearchDbConfig {
	fn default() -> Self {
		Self {
			max_retained_pickers: MAX_RETAINED_PICKERS,
			idle_ttl:             PICKER_IDLE_TTL,
			stale_after:          PICKER_STALE_AFTER,
		}
	}
}

struct PickerMetadata {
	initial_scan_complete: bool,
	refresh_in_progress:   bool,
	last_used:             Instant,
	last_refresh:          Instant,
}

struct PickerEntry {
	key:           String,
	shared_picker: SharedPicker,
	active_leases: AtomicUsize,
	metadata:      Mutex<PickerMetadata>,
}

impl PickerEntry {
	const fn new(key: String, shared_picker: SharedPicker, now: Instant) -> Self {
		Self {
			key,
			shared_picker,
			active_leases: AtomicUsize::new(0),
			metadata: Mutex::new(PickerMetadata {
				initial_scan_complete: false,
				refresh_in_progress:   false,
				last_used:             now,
				last_refresh:          now,
			}),
		}
	}

	fn start_lease(self: &Arc<Self>) -> PickerLease {
		self.active_leases.fetch_add(1, Ordering::AcqRel);
		PickerLease { entry: Arc::clone(self) }
	}

	fn finish_lease(&self) {
		self.active_leases.fetch_sub(1, Ordering::AcqRel);
	}

	fn active_lease_count(&self) -> usize {
		self.active_leases.load(Ordering::Acquire)
	}
}

struct SearchDbInner {
	path:            String,
	shared_frecency: SharedFrecency,
	pickers:         Mutex<HashMap<String, Arc<PickerEntry>>>,
	config:          SearchDbConfig,
}

impl Drop for SearchDbInner {
	fn drop(&mut self) {
		for entry in self.pickers.lock().values() {
			shutdown_picker(&entry.shared_picker);
		}
	}
}

/// Active access to a cached picker. Dropping the lease makes the picker
/// eligible for eviction again.
pub struct PickerLease {
	entry: Arc<PickerEntry>,
}

impl PickerLease {
	pub fn read<T, F>(&self, f: F) -> Result<T>
	where
		F: FnOnce(&FilePicker) -> Result<T>,
	{
		let guard = self
			.entry
			.shared_picker
			.read()
			.map_err(|_| Error::from_reason("shared picker lock poisoned"))?;
		let Some(picker) = guard.as_ref() else {
			return Err(Error::from_reason("shared picker missing"));
		};
		f(picker)
	}
}

impl Drop for PickerLease {
	fn drop(&mut self) {
		self.entry.finish_lease();
	}
}

/// Long-lived native search state: frecency persistence and per-workspace file
/// picker caches.
#[derive(Clone)]
#[napi]
pub struct SearchDb {
	inner: Arc<SearchDbInner>,
}

#[napi]
impl SearchDb {
	/// Create search DB state rooted at `path` (trimmed). An empty path skips
	/// frecency storage.
	#[napi(constructor)]
	pub fn new(path: String) -> Self {
		Self::build(path, SearchDbConfig::default())
	}

	/// Root path string associated with this instance (same as passed to the
	/// constructor).
	#[napi(getter)]
	pub fn path(&self) -> String {
		self.inner.path.clone()
	}
}

impl SearchDb {
	fn build(path: String, config: SearchDbConfig) -> Self {
		let normalized = path.trim().to_string();
		let shared_frecency: SharedFrecency = Default::default();

		if !normalized.is_empty()
			&& let Ok(tracker) = FrecencyTracker::new(&normalized, false)
		{
			if let Ok(mut guard) = shared_frecency.write() {
				*guard = Some(tracker);
			}
			let _ = FrecencyTracker::spawn_gc(Arc::clone(&shared_frecency), normalized.clone(), false);
		}

		Self {
			inner: Arc::new(SearchDbInner {
				path: normalized,
				shared_frecency,
				pickers: Mutex::new(HashMap::new()),
				config,
			}),
		}
	}

	fn picker_key(root: &Path) -> String {
		root
			.canonicalize()
			.unwrap_or_else(|_| root.to_path_buf())
			.to_string_lossy()
			.into_owned()
	}

	pub fn access_picker(&self, root: &Path, ct: &task::CancelToken) -> Result<PickerLease> {
		let key = Self::picker_key(root);
		let entry = self.get_or_init_entry(&key)?;
		let lease = entry.start_lease();

		if let Err(error) = self.prepare_picker_for_access(&entry, ct) {
			let removed_entry = self.take_uninitialized_picker(&key, &entry);
			drop(lease);
			if let Some(entry) = removed_entry {
				shutdown_picker(&entry.shared_picker);
			}
			return Err(error);
		}

		self.evict_idle_and_overflow();
		Ok(lease)
	}

	fn get_or_init_entry(&self, key: &str) -> Result<Arc<PickerEntry>> {
		let mut pickers = self.inner.pickers.lock();
		if let Some(entry) = pickers.get(key) {
			return Ok(Arc::clone(entry));
		}

		let shared_picker: SharedPicker = Default::default();
		FilePicker::new_with_shared_state(
			key.to_string(),
			false,
			FFFMode::Ai,
			Arc::clone(&shared_picker),
			Arc::clone(&self.inner.shared_frecency),
		)
		.map_err(|err| Error::from_reason(format!("Failed to init file picker: {err}")))?;

		let entry = Arc::new(PickerEntry::new(key.to_string(), shared_picker, Instant::now()));
		pickers.insert(key.to_string(), Arc::clone(&entry));
		Ok(entry)
	}

	fn take_uninitialized_picker(
		&self,
		key: &str,
		entry: &Arc<PickerEntry>,
	) -> Option<Arc<PickerEntry>> {
		let mut pickers = self.inner.pickers.lock();
		let current = pickers.get(key)?;
		if !Arc::ptr_eq(current, entry) {
			return None;
		}
		if current.metadata.lock().initial_scan_complete || current.active_lease_count() != 1 {
			return None;
		}
		pickers.remove(key)
	}

	fn prepare_picker_for_access(
		&self,
		entry: &Arc<PickerEntry>,
		ct: &task::CancelToken,
	) -> Result<()> {
		loop {
			ct.heartbeat()?;

			enum AccessAction {
				WaitForInitialScan,
				WaitForRefresh,
				RefreshStale,
				Ready,
			}

			let now = Instant::now();
			let action = {
				let mut metadata = entry.metadata.lock();
				metadata.last_used = now;
				if !metadata.initial_scan_complete {
					AccessAction::WaitForInitialScan
				} else if metadata.refresh_in_progress {
					AccessAction::WaitForRefresh
				} else if now.duration_since(metadata.last_refresh) >= self.inner.config.stale_after {
					metadata.refresh_in_progress = true;
					AccessAction::RefreshStale
				} else {
					AccessAction::Ready
				}
			};

			match action {
				AccessAction::WaitForInitialScan => {
					wait_for_picker_scan(&entry.shared_picker, ct)?;
					stop_background_monitor(&entry.shared_picker)?;
					let completed_at = Instant::now();
					let mut metadata = entry.metadata.lock();
					metadata.initial_scan_complete = true;
					metadata.last_used = completed_at;
					metadata.last_refresh = completed_at;
				},
				AccessAction::WaitForRefresh => {
					std::thread::sleep(PICKER_WAIT_INTERVAL);
				},
				AccessAction::RefreshStale => {
					let refresh_result = self.refresh_picker(entry);
					let refreshed_at = Instant::now();
					let mut metadata = entry.metadata.lock();
					metadata.refresh_in_progress = false;
					metadata.last_used = refreshed_at;
					if refresh_result.is_ok() {
						metadata.last_refresh = refreshed_at;
					}
					refresh_result?;
				},
				AccessAction::Ready => return Ok(()),
			}
		}
	}

	fn refresh_picker(&self, entry: &Arc<PickerEntry>) -> Result<()> {
		{
			let mut guard = entry
				.shared_picker
				.write()
				.map_err(|_| Error::from_reason("shared picker lock poisoned"))?;
			let Some(picker) = guard.as_mut() else {
				return Ok(());
			};
			picker
				.trigger_rescan(&self.inner.shared_frecency)
				.map_err(|err| Error::from_reason(format!("Failed to refresh file picker: {err}")))?;
			picker.stop_background_monitor();
		}

		FilePicker::refresh_git_status(&entry.shared_picker, &self.inner.shared_frecency)
			.map_err(|err| Error::from_reason(format!("Failed to refresh git status: {err}")))?;
		stop_background_monitor(&entry.shared_picker)?;
		Ok(())
	}

	fn evict_idle_and_overflow(&self) {
		let now = Instant::now();
		let mut pickers = self.inner.pickers.lock();
		let mut removable = Vec::new();
		let mut retained = Vec::new();

		for entry in pickers.values() {
			let active_leases = entry.active_lease_count();
			let last_used = entry.metadata.lock().last_used;
			if active_leases == 0 && now.duration_since(last_used) >= self.inner.config.idle_ttl {
				removable.push(entry.key.clone());
			} else {
				retained.push((entry.key.clone(), last_used, active_leases));
			}
		}

		if retained.len() > self.inner.config.max_retained_pickers {
			retained.sort_by_key(|(_, last_used, _)| *last_used);
			let overflow = retained.len() - self.inner.config.max_retained_pickers;
			let mut overflow_removed = 0;
			for (key, _, active_leases) in retained {
				if overflow_removed >= overflow {
					break;
				}
				if active_leases == 0 {
					removable.push(key);
					overflow_removed += 1;
				}
			}
		}

		let removed_entries: Vec<_> = removable
			.into_iter()
			.filter_map(|key| pickers.remove(&key))
			.collect();
		drop(pickers);

		for entry in removed_entries {
			shutdown_picker(&entry.shared_picker);
		}
	}

	pub fn update_frecency_scores(&self, item: &mut FileItem) {
		let Ok(guard) = self.inner.shared_frecency.read() else {
			return;
		};
		let Some(tracker) = guard.as_ref() else {
			return;
		};
		let _ = item.update_frecency_scores(tracker, FFFMode::Ai);
	}
}

fn wait_for_picker_scan(shared_picker: &SharedPicker, ct: &task::CancelToken) -> Result<()> {
	let signal = {
		let guard = shared_picker
			.read()
			.map_err(|_| Error::from_reason("shared picker lock poisoned"))?;
		let Some(picker) = guard.as_ref() else {
			return Ok(());
		};
		picker.scan_signal()
	};

	while signal.load(Ordering::Acquire) {
		ct.heartbeat()?;
		std::thread::sleep(PICKER_WAIT_INTERVAL);
	}

	ct.heartbeat()?;
	Ok(())
}

fn stop_background_monitor(shared_picker: &SharedPicker) -> Result<()> {
	let mut guard = shared_picker
		.write()
		.map_err(|_| Error::from_reason("shared picker lock poisoned"))?;
	if let Some(picker) = guard.as_mut() {
		picker.cancel();
		picker.stop_background_monitor();
	}
	Ok(())
}

fn shutdown_picker(shared_picker: &SharedPicker) {
	let Ok(mut guard) = shared_picker.write() else {
		return;
	};
	if let Some(picker) = guard.as_mut() {
		picker.cancel();
		picker.stop_background_monitor();
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;

	impl SearchDb {
		fn new_for_tests(config: SearchDbConfig) -> Self {
			Self::build(String::new(), config)
		}

		fn insert_test_entry(
			&self,
			key: &str,
			last_used: Instant,
			active_leases: usize,
			initial_scan_complete: bool,
		) -> Arc<PickerEntry> {
			let entry = Arc::new(PickerEntry::new(key.to_string(), Default::default(), last_used));
			entry.active_leases.store(active_leases, Ordering::Release);
			{
				let mut metadata = entry.metadata.lock();
				metadata.initial_scan_complete = initial_scan_complete;
				metadata.last_used = last_used;
				metadata.last_refresh = last_used;
			}
			self
				.inner
				.pickers
				.lock()
				.insert(key.to_string(), Arc::clone(&entry));
			entry
		}

		fn contains_picker(&self, key: &str) -> bool {
			self.inner.pickers.lock().contains_key(key)
		}
	}

	#[test]
	fn keeps_uninitialized_picker_when_another_lease_is_active() {
		let db = SearchDb::new_for_tests(SearchDbConfig::default());
		let now = Instant::now();
		let entry = db.insert_test_entry("/shared", now, 2, false);

		let removed = db.take_uninitialized_picker("/shared", &entry);

		assert!(removed.is_none());
		assert!(db.contains_picker("/shared"));
	}

	#[test]
	fn removes_orphaned_uninitialized_picker_for_last_lease() {
		let db = SearchDb::new_for_tests(SearchDbConfig::default());
		let now = Instant::now();
		let entry = db.insert_test_entry("/orphaned", now, 1, false);

		let removed = db.take_uninitialized_picker("/orphaned", &entry);

		assert!(removed.is_some());
		assert!(!db.contains_picker("/orphaned"));
	}

	#[test]
	fn evicts_idle_entries() {
		let db = SearchDb::new_for_tests(SearchDbConfig {
			max_retained_pickers: 4,
			idle_ttl:             Duration::from_secs(30),
			stale_after:          Duration::from_secs(300),
		});
		let now = Instant::now();

		db.insert_test_entry("/idle", now - Duration::from_secs(90), 0, true);
		db.insert_test_entry("/fresh", now - Duration::from_secs(5), 0, true);

		db.evict_idle_and_overflow();

		assert!(!db.contains_picker("/idle"));
		assert!(db.contains_picker("/fresh"));
	}

	#[test]
	fn enforces_picker_cap_by_last_use() {
		let db = SearchDb::new_for_tests(SearchDbConfig {
			max_retained_pickers: 2,
			idle_ttl:             Duration::from_secs(300),
			stale_after:          Duration::from_secs(300),
		});
		let now = Instant::now();

		db.insert_test_entry("/oldest", now - Duration::from_secs(30), 0, true);
		db.insert_test_entry("/middle", now - Duration::from_secs(20), 0, true);
		db.insert_test_entry("/newest", now - Duration::from_secs(10), 0, true);

		db.evict_idle_and_overflow();

		assert!(!db.contains_picker("/oldest"));
		assert!(db.contains_picker("/middle"));
		assert!(db.contains_picker("/newest"));
	}

	#[test]
	fn keeps_active_leases_safe_from_overflow_eviction() {
		let db = SearchDb::new_for_tests(SearchDbConfig {
			max_retained_pickers: 1,
			idle_ttl:             Duration::from_secs(1),
			stale_after:          Duration::from_secs(300),
		});
		let now = Instant::now();

		let active_entry = db.insert_test_entry("/active", now - Duration::from_secs(60), 0, true);
		db.insert_test_entry("/other", now - Duration::from_secs(5), 0, true);
		let lease = active_entry.start_lease();

		db.evict_idle_and_overflow();

		assert!(db.contains_picker("/active"));
		assert!(!db.contains_picker("/other"));

		drop(lease);
		db.evict_idle_and_overflow();

		assert!(!db.contains_picker("/active"));
	}
}
