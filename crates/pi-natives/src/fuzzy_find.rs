//! Fuzzy content search over files.
//!
//! Searches file contents line by line using subsequence scoring similar to
//! `fzf --filter`: tolerant of missing characters and non-contiguous matches,
//! but not full edit-distance typo correction. Complements the exact-regex
//! `grep` tool.

use std::{
	cmp::Ordering,
	collections::BinaryHeap,
	path::{Path, PathBuf},
};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{fd, grep, iofs, task};

const DEFAULT_MAX_RESULTS: u32 = 20;
const DEFAULT_LINE_CHAR_LIMIT: usize = 1000;

/// Options for fuzzy content search.
#[napi(object)]
pub struct FuzzyContentOptions<'env> {
	/// Fuzzy query to match against file contents.
	pub query:           String,
	/// Directory to search.
	pub path:            String,
	/// Include hidden files (default: false).
	pub hidden:          Option<bool>,
	/// Respect .gitignore (default: true).
	pub gitignore:       Option<bool>,
	/// Maximum number of matches to return (default: 20).
	pub max_results:     Option<u32>,
	/// Maximum characters per returned match line (default: 1000).
	pub line_char_limit: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:          Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:      Option<u32>,
}

/// A single fuzzy content match.
#[napi(object)]
pub struct FuzzyContentMatch {
	/// Absolute filesystem path to the file containing the match.
	pub path:    String,
	/// 1-based line number of the match.
	pub line:    u32,
	/// Matching line text (truncated to `line_char_limit`).
	pub content: String,
	/// Match quality score (higher is better).
	pub score:   u32,
}

/// Result of fuzzy content search.
#[napi(object)]
pub struct FuzzyContentResult {
	/// Matched entries (up to `max_results`).
	pub matches:        Vec<FuzzyContentMatch>,
	/// Total number of matching lines found (may exceed `matches.len()`).
	pub total_matches:  u32,
	/// Number of files that were searched.
	pub files_searched: u32,
}

struct FuzzyContentConfig {
	query:           String,
	path:            String,
	hidden:          Option<bool>,
	gitignore:       Option<bool>,
	max_results:     Option<u32>,
	line_char_limit: Option<u32>,
}

/// Internal wrapper so `BinaryHeap` can order matches by worst-first.
struct ScoredMatch(FuzzyContentMatch);

impl ScoredMatch {
	fn new(path: &str, line: u32, score: u32, content: String) -> Self {
		Self(FuzzyContentMatch { path: path.to_string(), line, content, score })
	}
}

impl PartialEq for ScoredMatch {
	fn eq(&self, other: &Self) -> bool {
		self.0.score == other.0.score && self.0.path == other.0.path && self.0.line == other.0.line
	}
}

impl Eq for ScoredMatch {}

impl Ord for ScoredMatch {
	/// Order by worst match first: lower score, then higher path, then higher
	/// line. This turns the max-heap into a min-heap for the eviction
	/// candidate.
	fn cmp(&self, other: &Self) -> Ordering {
		self
			.0
			.score
			.cmp(&other.0.score)
			.reverse()
			.then_with(|| self.0.path.cmp(&other.0.path).reverse())
			.then_with(|| self.0.line.cmp(&other.0.line).reverse())
	}
}

impl PartialOrd for ScoredMatch {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

/// Keep only the top `capacity` scored matches while still counting every
/// match.
struct BoundedMatchCollector {
	capacity:      usize,
	heap:          BinaryHeap<ScoredMatch>,
	total_matches: u64,
}

impl BoundedMatchCollector {
	const fn new(capacity: usize) -> Self {
		Self { capacity, heap: BinaryHeap::new(), total_matches: 0 }
	}

	fn consider(
		&mut self,
		line: &str,
		path: &str,
		line_index: usize,
		score: u32,
		line_char_limit: usize,
	) {
		self.total_matches = self.total_matches.saturating_add(1);
		if self.capacity == 0 {
			return;
		}

		if self.heap.len() < self.capacity {
			self
				.heap
				.push(Self::make_match(line, path, line_index, score, line_char_limit));
			return;
		}

		// Compare without allocating the content string; only build it if we evict the
		// worst entry.
		let candidate = ScoredMatch::new(
			path,
			crate::utils::clamp_u32((line_index as u64).saturating_add(1)),
			score,
			String::new(),
		);
		if let Some(mut worst) = self.heap.peek_mut()
			&& worst.cmp(&candidate) == Ordering::Greater
		{
			*worst = Self::make_match(line, path, line_index, score, line_char_limit);
		}
	}

	fn make_match(
		line: &str,
		path: &str,
		line_index: usize,
		score: u32,
		line_char_limit: usize,
	) -> ScoredMatch {
		let content = if line.chars().count() > line_char_limit {
			line.chars().take(line_char_limit).collect()
		} else {
			line.to_string()
		};
		ScoredMatch::new(
			path,
			crate::utils::clamp_u32((line_index as u64).saturating_add(1)),
			score,
			content,
		)
	}

	fn into_sorted(self) -> (Vec<FuzzyContentMatch>, u64) {
		let mut matches: Vec<_> = self.heap.into_iter().map(|entry| entry.0).collect();
		matches.sort_by(|a, b| {
			b.score
				.cmp(&a.score)
				.then_with(|| a.path.cmp(&b.path).then_with(|| a.line.cmp(&b.line)))
		});
		(matches, self.total_matches)
	}
}

/// Score a single line against the lowercased query and its normalized
/// subsequence characters.
fn score_fuzzy_line(line: &str, query_lower: &str, query_chars: &[char]) -> u32 {
	if query_lower.is_empty() {
		return 0;
	}
	let line_lower = line.to_lowercase();
	if line_lower == query_lower {
		return 200;
	}
	if line_lower.starts_with(query_lower) {
		return 160;
	}
	if line_lower.contains(query_lower) {
		return 120;
	}
	let normalized_line = fd::normalize_fuzzy_text(&line_lower);
	let fuzzy = fd::fuzzy_subsequence_score(query_chars, &normalized_line);
	if fuzzy > 0 { 20 + fuzzy } else { 0 }
}

/// Search a single file's contents and feed scored matches into `collector`.
fn search_file(
	abs_path: &Path,
	relative_path: &str,
	query_lower: &str,
	query_chars: &[char],
	line_char_limit: usize,
	collector: &mut BoundedMatchCollector,
	ct: &task::CancelToken,
) -> Result<()> {
	let mut buffer = Vec::new();
	match grep::read_file_bytes(abs_path, &mut buffer) {
		Ok(grep::ReadFile::Read) => {},
		Ok(grep::ReadFile::Oversized | grep::ReadFile::Skipped) => return Ok(()),
		Err(err) => {
			return Err(Error::from_reason(format!("Failed to read {}: {err}", abs_path.display())));
		},
	};

	let text = grep::bytes_to_trimmed_string(&buffer);
	for (line_index, line) in text.lines().enumerate() {
		ct.heartbeat()?;
		let score = score_fuzzy_line(line, query_lower, query_chars);
		if score == 0 {
			continue;
		}
		collector.consider(line, relative_path, line_index, score, line_char_limit);
	}
	Ok(())
}

fn fuzzy_content_search_sync(
	config: FuzzyContentConfig,
	ct: task::CancelToken,
) -> Result<FuzzyContentResult> {
	let candidate = PathBuf::from(&config.path);
	let root = if candidate.is_absolute() {
		candidate
	} else {
		let cwd = std::env::current_dir()
			.map_err(|err| Error::from_reason(format!("Failed to resolve cwd: {err}")))?;
		cwd.join(candidate)
	};
	let max_results = config.max_results.unwrap_or(DEFAULT_MAX_RESULTS) as usize;
	let line_char_limit = config
		.line_char_limit
		.map_or(DEFAULT_LINE_CHAR_LIMIT, |n| n as usize);

	let query_lower = config.query.trim().to_lowercase();
	let normalized_query = fd::normalize_fuzzy_text(&query_lower);
	if query_lower.is_empty() || normalized_query.is_empty() {
		return Ok(FuzzyContentResult {
			matches:        Vec::new(),
			total_matches:  0,
			files_searched: 0,
		});
	}
	let query_chars: Vec<char> = normalized_query.chars().collect();

	let mut collector = BoundedMatchCollector::new(max_results);
	let mut files_searched: u64 = 0;

	match std::fs::metadata(&root) {
		Ok(metadata) if metadata.is_file() => {
			files_searched = 1;
			search_file(
				&root,
				&root.to_string_lossy(),
				&query_lower,
				&query_chars,
				line_char_limit,
				&mut collector,
				&ct,
			)?;
		},
		Ok(metadata) if metadata.is_dir() => {
			let include_hidden = config.hidden.unwrap_or(false);
			let respect_gitignore = config.gitignore.unwrap_or(true);
			let outcome = pi_walker::WalkRequest::new(root.clone())
				.hidden(include_hidden)
				.gitignore(respect_gitignore)
				.skip_git(true)
				.skip_node_modules(true)
				.follow_links(pi_walker::FollowLinks::Never)
				.detail(pi_walker::WalkDetail::Minimal)
				.order(pi_walker::WalkOrder::Path)
				.emit_root(false)
				.depth(1, usize::MAX)
				.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
				.cache(false)
				.empty_recheck(pi_walker::EmptyRecheck::Configured)
				.collect_with_heartbeat(|| ct.heartbeat())
				.map_err(iofs::map_walker_error)?;

			for entry in outcome.entries {
				ct.heartbeat()?;
				let glob_match = iofs::GlobMatch::from(entry);
				if glob_match.file_type != iofs::FileType::File {
					continue;
				}
				files_searched = files_searched.saturating_add(1);
				let abs_path = root.join(&glob_match.path);
				search_file(
					&abs_path,
					&abs_path.to_string_lossy(),
					&query_lower,
					&query_chars,
					line_char_limit,
					&mut collector,
					&ct,
				)?;
			}
		},
		Ok(_) => {
			return Err(Error::from_reason(format!(
				"Path is not a file or directory: {}",
				root.display()
			)));
		},
		Err(err) => {
			return Err(Error::from_reason(format!("Path not found: {} ({err})", root.display())));
		},
	}

	let (matches, total_matches) = collector.into_sorted();
	Ok(FuzzyContentResult {
		matches,
		total_matches: crate::utils::clamp_u32(total_matches),
		files_searched: crate::utils::clamp_u32(files_searched),
	})
}

/// Fuzzy content search for file contents.
#[napi(js_name = "fuzzyContentSearch")]
pub fn fuzzy_content_search(options: FuzzyContentOptions<'_>) -> task::Promise<FuzzyContentResult> {
	let FuzzyContentOptions {
		query,
		path,
		hidden,
		gitignore,
		max_results,
		line_char_limit,
		timeout_ms,
		signal,
	} = options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	let config = FuzzyContentConfig { query, path, hidden, gitignore, max_results, line_char_limit };
	task::blocking("fuzzy_content_search", ct, move |ct| fuzzy_content_search_sync(config, ct))
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::task;

	#[test]
	fn exact_match_scores_highest() {
		assert_eq!(score_fuzzy_line("hello", "hello", &['h', 'e', 'l', 'l', 'o']), 200);
	}

	#[test]
	fn prefix_match_scores_high() {
		assert_eq!(score_fuzzy_line("hello world", "hell", &['h', 'e', 'l', 'l']), 160);
	}

	#[test]
	fn substring_match_scores_medium() {
		assert_eq!(score_fuzzy_line("hello world", "world", &['w', 'o', 'r', 'l', 'd']), 120);
	}

	#[test]
	fn subsequence_with_gaps_matches() {
		let score = score_fuzzy_line("hello world", "hlo", &['h', 'l', 'o']);
		assert!(score > 0 && score < 120);
	}

	#[test]
	fn unrelated_line_scores_zero() {
		assert_eq!(score_fuzzy_line("hello world", "xyz", &['x', 'y', 'z']), 0);
	}

	#[test]
	fn empty_query_scores_zero() {
		assert_eq!(score_fuzzy_line("hello world", "", &[]), 0);
	}

	#[cfg(unix)]
	#[test]
	fn fuzzy_content_search_caps_retained_matches() {
		use std::{
			fs,
			path::{Path, PathBuf},
			sync::atomic::{AtomicU64, Ordering},
			time::{SystemTime, UNIX_EPOCH},
		};

		struct TempDir(PathBuf);
		impl TempDir {
			fn new() -> Self {
				static COUNTER: AtomicU64 = AtomicU64::new(0);
				let nanos = SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.expect("system time")
					.as_nanos();
				let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
				let pid = std::process::id();
				let path =
					std::env::temp_dir().join(format!("pi-fuzzy-content-test-{pid}-{nanos}-{seq}"));
				fs::create_dir_all(&path).expect("create temp dir");
				Self(path)
			}

			fn path(&self) -> &Path {
				&self.0
			}
		}
		impl Drop for TempDir {
			fn drop(&mut self) {
				let _ = fs::remove_dir_all(&self.0);
			}
		}

		let root = TempDir::new();
		let file = root.path().join("lines.txt");
		let contents: String = (0..50).map(|i| format!("line {i}\n")).collect();
		fs::write(&file, contents).expect("write file");

		let result = fuzzy_content_search_sync(
			FuzzyContentConfig {
				query:           "line".to_string(),
				path:            root.path().to_string_lossy().into_owned(),
				hidden:          Some(false),
				gitignore:       Some(false),
				max_results:     Some(5),
				line_char_limit: Some(1000),
			},
			task::CancelToken::default(),
		)
		.expect("search succeeds");

		assert_eq!(result.total_matches, 50);
		assert_eq!(result.matches.len(), 5);
		assert_eq!(result.files_searched, 1);
		assert!(
			result
				.matches
				.iter()
				.zip(result.matches.iter().skip(1))
				.all(|(a, b)| {
					a.score > b.score
						|| (a.score == b.score && a.path.cmp(&b.path).then(a.line.cmp(&b.line)).is_le())
				})
		);
	}

	#[cfg(unix)]
	#[test]
	fn fuzzy_content_search_skips_symlinked_directories() {
		use std::{
			fs,
			os::unix::fs::symlink,
			path::{Path, PathBuf},
			sync::atomic::{AtomicU64, Ordering},
			time::{SystemTime, UNIX_EPOCH},
		};

		struct TempDir(PathBuf);
		impl TempDir {
			fn new() -> Self {
				static COUNTER: AtomicU64 = AtomicU64::new(0);
				let nanos = SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.expect("system time")
					.as_nanos();
				let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
				let pid = std::process::id();
				let path =
					std::env::temp_dir().join(format!("pi-fuzzy-content-test-{pid}-{nanos}-{seq}"));
				fs::create_dir_all(&path).expect("create temp dir");
				Self(path)
			}

			fn path(&self) -> &Path {
				&self.0
			}
		}
		impl Drop for TempDir {
			fn drop(&mut self) {
				let _ = fs::remove_dir_all(&self.0);
			}
		}

		let root = TempDir::new();
		let outside = TempDir::new();
		let real_dir = root.path().join("real");
		fs::create_dir_all(&real_dir).expect("create real dir");
		fs::write(real_dir.join("a.txt"), "hello world\n").expect("write a");
		fs::write(outside.path().join("b.txt"), "hello world\n").expect("write b");
		let symlink_path = root.path().join("link");
		symlink(outside.path(), &symlink_path).expect("create symlink");

		let result = fuzzy_content_search_sync(
			FuzzyContentConfig {
				query:           "hello".to_string(),
				path:            root.path().to_string_lossy().into_owned(),
				hidden:          Some(false),
				gitignore:       Some(false),
				max_results:     Some(10),
				line_char_limit: Some(1000),
			},
			task::CancelToken::default(),
		)
		.expect("search succeeds");

		assert_eq!(result.files_searched, 1);
		assert_eq!(result.total_matches, 1);
		assert_eq!(result.matches.len(), 1);
		assert!(result.matches[0].path.ends_with("a.txt"));
	}

	#[cfg(unix)]
	#[test]
	fn fuzzy_content_search_finds_subsequence() {
		use std::{
			fs,
			path::{Path, PathBuf},
			sync::atomic::{AtomicU64, Ordering},
			time::{SystemTime, UNIX_EPOCH},
		};

		struct TempDir(PathBuf);
		impl TempDir {
			fn new() -> Self {
				static COUNTER: AtomicU64 = AtomicU64::new(0);
				let nanos = SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.expect("system time")
					.as_nanos();
				let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
				let pid = std::process::id();
				let path =
					std::env::temp_dir().join(format!("pi-fuzzy-content-test-{pid}-{nanos}-{seq}"));
				fs::create_dir_all(&path).expect("create temp dir");
				Self(path)
			}

			fn path(&self) -> &Path {
				&self.0
			}
		}
		impl Drop for TempDir {
			fn drop(&mut self) {
				let _ = fs::remove_dir_all(&self.0);
			}
		}

		let root = TempDir::new();
		fs::write(root.path().join("a.txt"), "db migration helper\nother line\n").expect("write a");
		fs::write(root.path().join("b.txt"), "fuzzy content search\n").expect("write b");

		let result = fuzzy_content_search_sync(
			FuzzyContentConfig {
				query:           "dbmig".to_string(),
				path:            root.path().to_string_lossy().into_owned(),
				hidden:          Some(false),
				gitignore:       Some(false),
				max_results:     Some(10),
				line_char_limit: Some(1000),
			},
			task::CancelToken::default(),
		)
		.expect("search succeeds");

		assert_eq!(result.total_matches, 1);
		assert_eq!(result.files_searched, 2);
		assert_eq!(result.matches.len(), 1);
		let m = &result.matches[0];
		assert!(m.path.ends_with("a.txt"));
		assert_eq!(m.line, 1);
		assert_eq!(m.content, "db migration helper");
		assert!(m.score > 0);
	}
}
