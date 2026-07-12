//! Job management

use std::{collections::VecDeque, fmt::Display, time::Duration};

#[cfg(windows)]
use std::os::windows::io::OwnedHandle;

use futures::FutureExt;

use crate::{ExecutionResult, error, processes, sys, trace_categories, traps};

pub(crate) type JobJoinHandle = tokio::task::JoinHandle<Result<ExecutionResult, error::Error>>;
pub(crate) type JobResult = (Job, Result<ExecutionResult, error::Error>);

const WAIT_NEXT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MAX_RETAINED_COMPLETED_JOBS: usize = 1024;

/// Selects a managed job by shell job ID or child process ID.
#[derive(Clone, Copy)]
pub enum JobSelector {
	/// Shell-internal job ID.
	JobId(usize),
	/// Child process ID.
	ProcessId(i32),
}

/// Result returned when waiting for a single managed job.
pub struct WaitedJob {
	/// Shell-internal job ID.
	pub id: usize,
	/// Process ID when known, otherwise the shell-internal job ID.
	pub identifier: String,
	/// Command line associated with the job.
	pub command_line: String,
	/// Exit status returned by the job.
	pub result: ExecutionResult,
}

impl WaitedJob {
	fn from_job(job: Job, result: ExecutionResult, identifier: String) -> Self {
		Self { id: job.id, identifier, command_line: job.command_line, result }
	}
}

/// Manages the jobs that are currently managed by the shell.
#[derive(Default)]
pub struct JobManager {
	/// The jobs that are currently managed by the shell.
	pub jobs: Vec<Job>,
}

/// Represents a task that is part of a job.
pub enum JobTask {
	/// An external process.
	External(processes::ChildProcess),
	/// An internal asynchronous task.
	Internal(JobJoinHandle),
}

/// Represents the result of waiting on a job task.
pub enum JobTaskWaitResult {
	/// The task has completed.
	Completed(ExecutionResult),
	/// The task was stopped.
	Stopped,
}

impl JobTask {
	/// Returns whether the task is an external process.
	pub const fn is_external(&self) -> bool {
		matches!(self, Self::External(_))
	}

	/// Waits for the task to complete. Returns the result of the wait.
	pub async fn wait(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<JobTaskWaitResult, error::Error> {
		match self {
			Self::External(process) => loop {
				let wait_result = process.wait(None).await?;
				match wait_result {
					processes::ProcessWaitResult::Completed(output) => {
						break Ok(JobTaskWaitResult::Completed(output.into()));
					},
					processes::ProcessWaitResult::Stopped if wait_for_terminate => {},
					processes::ProcessWaitResult::Stopped => break Ok(JobTaskWaitResult::Stopped),
					processes::ProcessWaitResult::Cancelled => {
						break Ok(JobTaskWaitResult::Completed(ExecutionResult::new(130)));
					},
				}
			},
			Self::Internal(handle) => Ok(JobTaskWaitResult::Completed(handle.await??)),
		}
	}

	/// Returns the process ID of an external task, if it has one.
	const fn pid(&self) -> Option<sys::process::ProcessId> {
		match self {
			Self::External(process) => process.pid(),
			Self::Internal(_) => None,
		}
	}

	/// Polls the task for completion. Returns `Some(result)` if the task has
	/// completed, or `None` if it is still running. The result is the execution
	/// result of the task. Behaves in a best-effort manner; if an internal
	/// error occurs during polling, it will return `None`.
	fn poll(&mut self) -> Option<Result<ExecutionResult, error::Error>> {
		match self {
			Self::External(process) => {
				let check_result = process.poll();
				check_result.map(|polled_result| polled_result.map(|output| output.into()))
			},
			Self::Internal(handle) => {
				let checkable_handle = handle;
				checkable_handle.now_or_never().and_then(|r| r.ok())
			},
		}
	}
}

impl JobManager {
	/// Returns a new job manager.
	pub fn new() -> Self {
		Self::default()
	}

	/// Adds a job to the job manager and marks it as the current job;
	/// returns an immutable reference to the job.
	///
	/// # Arguments
	///
	/// * `job` - The job to add.
	#[allow(clippy::missing_panics_doc, reason = "push() guarantees the vector length is >= 1")]
	pub fn add_as_current(&mut self, mut job: Job) -> &Job {
		for j in &mut self.jobs {
			if matches!(j.annotation, JobAnnotation::Current) {
				j.annotation = JobAnnotation::Previous;
				break;
			}
		}

		let id = self.jobs.iter().map(|existing| existing.id).max().map_or(1, |max_id| max_id + 1);
		job.id = id;
		job.annotation = JobAnnotation::Current;
		self.jobs.push(job);

		#[allow(clippy::unwrap_used, reason = "we just pushed an element")]
		self.jobs.last().unwrap()
	}

	/// Returns the current job, if there is one.
	pub fn current_job(&self) -> Option<&Job> {
		self
			.jobs
			.iter()
			.find(|j| matches!(j.annotation, JobAnnotation::Current))
	}

	/// Returns a mutable reference to the current job, if there is one.
	pub fn current_job_mut(&mut self) -> Option<&mut Job> {
		self
			.jobs
			.iter_mut()
			.find(|j| matches!(j.annotation, JobAnnotation::Current))
	}

	/// Returns the previous job, if there is one.
	pub fn prev_job(&self) -> Option<&Job> {
		self
			.jobs
			.iter()
			.find(|j| matches!(j.annotation, JobAnnotation::Previous))
	}

	/// Returns a mutable reference to the previous job, if there is one.
	pub fn prev_job_mut(&mut self) -> Option<&mut Job> {
		self
			.jobs
			.iter_mut()
			.find(|j| matches!(j.annotation, JobAnnotation::Previous))
	}

	/// Tries to resolve the given job specification to a job.
	///
	/// # Arguments
	///
	/// * `job_spec` - The job specification to resolve.
	pub fn resolve_job_spec(&mut self, job_spec: &str) -> Option<&mut Job> {
		let remainder = job_spec.strip_prefix('%')?;

		match remainder {
			"%" | "+" => self.current_job_mut(),
			"-" => self.prev_job_mut(),
			s if s.chars().all(char::is_numeric) => {
				let id = s.parse::<usize>().ok()?;
				self.jobs.iter_mut().find(|j| j.id == id)
			},
			_ => {
				tracing::warn!(target: trace_categories::UNIMPLEMENTED, "unimplemented: job spec naming command: '{job_spec}'");
				None
			},
		}
	}

	/// Tries to resolve the given job specification to a wait selector.
	///
	/// # Arguments
	///
	/// * `job_spec` - The job specification to resolve.
	pub fn resolve_job_spec_selector(&self, job_spec: &str) -> Option<JobSelector> {
		let remainder = job_spec.strip_prefix('%')?;

		match remainder {
			"%" | "+" => self.current_job().map(|job| JobSelector::JobId(job.id)),
			"-" => self.prev_job().map(|job| JobSelector::JobId(job.id)),
			s if s.chars().all(char::is_numeric) => {
				let id = s.parse::<usize>().ok()?;
				self
					.jobs
					.iter()
					.any(|job| job.id == id)
					.then_some(JobSelector::JobId(id))
			},
			_ => {
				tracing::warn!(target: trace_categories::UNIMPLEMENTED, "unimplemented: job spec naming command: '{job_spec}'");
				None
			},
		}
	}

	/// Returns whether a managed job contains the given process ID.
	pub fn contains_process_id(&self, pid: i32) -> bool {
		self.jobs.iter().any(|job| job.contains_process_id(pid))
	}

	/// Tries to resolve the given process ID to a managed job.
	///
	/// # Arguments
	///
	/// * `pid` - The process ID to resolve.
	pub fn resolve_process_id(&mut self, pid: i32) -> Option<&mut Job> {
		self.jobs.iter_mut().find(|job| job.contains_process_id(pid))
	}

	/// Waits for all managed jobs to complete.
	pub async fn wait_all(&mut self) -> Result<Vec<Job>, error::Error> {
		self.wait_all_with_policy(false).await
	}

	/// Waits for all managed jobs to terminate, ignoring stopped-state changes.
	pub async fn wait_all_for_termination(&mut self) -> Result<Vec<Job>, error::Error> {
		self.wait_all_with_policy(true).await
	}

	async fn wait_all_with_policy(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<Vec<Job>, error::Error> {
		for job in &mut self.jobs {
			job.wait_with_policy(wait_for_terminate).await?;
		}

		Ok(self.sweep_completed_jobs())
	}

	/// Waits for the next matching managed job to complete.
	pub async fn wait_next(
		&mut self,
		selectors: &[JobSelector],
	) -> Result<Option<WaitedJob>, error::Error> {
		loop {
			let mut found_candidate = false;
			let mut i = 0;
			while i != self.jobs.len() {
				if !selectors.is_empty()
					&& !selectors
						.iter()
						.any(|selector| self.jobs[i].matches_selector(*selector))
				{
					i += 1;
					continue;
				}

				found_candidate = true;
				let identifier = self.jobs[i].wait_identifier();
				if let Some(result) = self.jobs[i].poll_done()? {
					let job = self.jobs.remove(i);
					return result.map(|result| Some(WaitedJob::from_job(job, result, identifier)));
				}
				if matches!(self.jobs[i].state, JobState::Done) {
					let job = self.jobs.remove(i);
					if job.is_wait_status_consumed() {
						continue;
					}
					return Ok(Some(WaitedJob::from_job(
						job,
						ExecutionResult::success(),
						identifier,
					)));
				}
				i += 1;
			}

			if !found_candidate {
				return Ok(None);
			}

			tokio::time::sleep(WAIT_NEXT_POLL_INTERVAL).await;
		}
	}

	/// Polls all managed jobs for completion.
	pub fn poll(&mut self) -> Result<Vec<JobResult>, error::Error> {
		let mut results = vec![];

		let mut i = 0;
		while i != self.jobs.len() {
			if let Some(result) = self.jobs[i].poll_done()? {
				let job = self.jobs.remove(i);
				results.push((job, result));
			} else if matches!(self.jobs[i].state, JobState::Done) {
				let job = self.jobs.remove(i);
				if !job.is_wait_status_consumed() {
					// TODO(jobs): This is a workaround for a done job whose status is unknown.
					results.push((job, Ok(ExecutionResult::success())));
				}
			} else {
				i += 1;
			}
		}

		Ok(results)
	}
	/// Polls completed jobs while retaining recent exit statuses for a later
	/// `wait` by PID or job ID. The retention limit prevents persistent hosts
	/// that poll without waiting from growing the job table without bound.
	pub fn reap_completed(&mut self) -> Result<(), error::Error> {
		for job in &mut self.jobs {
			if matches!(job.state, JobState::Done) {
				continue;
			}
			if let Some(result) = job.poll_done()? {
				job.completed_result = Some(result);
			}
		}

		self.jobs.retain(|job| !job.is_wait_status_consumed());

		let completed_count = self
			.jobs
			.iter()
			.filter(|job| matches!(job.state, JobState::Done))
			.count();
		let mut completed_to_discard = completed_count.saturating_sub(MAX_RETAINED_COMPLETED_JOBS);
		self.jobs.retain(|job| {
			if completed_to_discard > 0 && matches!(job.state, JobState::Done) {
				completed_to_discard -= 1;
				false
			} else {
				true
			}
		});
		Ok(())
	}

	fn sweep_completed_jobs(&mut self) -> Vec<Job> {
		let mut completed_jobs = vec![];

		let mut i = 0;
		while i != self.jobs.len() {
			if self.jobs[i].tasks.is_empty() {
				completed_jobs.push(self.jobs.remove(i));
			} else {
				i += 1;
			}
		}

		completed_jobs
	}
}

/// Represents the current execution state of a job.
#[derive(Clone)]
pub enum JobState {
	/// Unknown state.
	Unknown,
	/// The job is running.
	Running,
	/// The job is stopped.
	Stopped,
	/// The job has completed.
	Done,
}

impl Display for JobState {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Unknown => write!(f, "Unknown"),
			Self::Running => write!(f, "Running"),
			Self::Stopped => write!(f, "Stopped"),
			Self::Done => write!(f, "Done"),
		}
	}
}

/// Represents an annotation for a job.
#[derive(Clone)]
pub enum JobAnnotation {
	/// No annotation.
	None,
	/// The job is the current job.
	Current,
	/// The job is the previous job.
	Previous,
}

impl Display for JobAnnotation {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::None => write!(f, ""),
			Self::Current => write!(f, "+"),
			Self::Previous => write!(f, "-"),
		}
	}
}

/// Encapsulates a set of processes managed by the shell as a single unit.
pub struct Job {
	/// The tasks that make up the job.
	tasks: VecDeque<JobTask>,

	/// If available, the process group ID of the job's processes.
	pgid: Option<sys::process::ProcessId>,

	/// Process IDs and exit statuses retained after a host-side background
	/// reaper has consumed the child handles. One entry is kept per external
	/// task in this job, so the storage is bounded by the owning job's
	/// pipeline and is dropped with the job.
	reaped_children: Vec<(sys::process::ProcessId, u8)>,

	/// Exit status retained by a host-side background reaper.
	completed_result: Option<Result<ExecutionResult, error::Error>>,

	/// The annotation of the job (e.g., current, previous).
	annotation: JobAnnotation,

	/// The shell-internal ID of the job.
	pub id: usize,

	/// The command line of the job.
	pub command_line: String,

	/// The current operational state of the job.
	pub state: JobState,
}

impl Display for Job {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(
			f,
			"[{}]{:3}{}\t{}",
			self.id,
			self.annotation.to_string(),
			self.state,
			self.command_line
		)
	}
}

impl Job {
	/// Returns a new job object.
	///
	/// # Arguments
	///
	/// * `children` - The job's known child processes.
	/// * `command_line` - The command line of the job.
	/// * `state` - The current operational state of the job.
	pub(crate) fn new<I>(tasks: I, command_line: String, state: JobState) -> Self
	where
		I: IntoIterator<Item = JobTask>,
	{
		Self {
			id: 0,
			tasks: tasks.into_iter().collect(),
			pgid: None,
			reaped_children: Vec::new(),
			completed_result: None,
			annotation: JobAnnotation::None,
			command_line,
			state,
		}
	}

	/// Returns a pid-style string for the job.
	pub fn to_pid_style_string(&self) -> String {
		let display_pid = self
			.representative_pid()
			.map_or_else(|| String::from("<pid unknown>"), |pid| pid.to_string());
		std::format!("[{}]{}\t{}", self.id, self.annotation, display_pid)
	}

	/// Returns the annotation of the job.
	pub fn annotation(&self) -> JobAnnotation {
		self.annotation.clone()
	}

	/// Returns the command name of the job.
	pub fn command_name(&self) -> &str {
		self
			.command_line
			.split_ascii_whitespace()
			.next()
			.unwrap_or_default()
	}

	/// Returns whether the job is the current job.
	pub const fn is_current(&self) -> bool {
		matches!(self.annotation, JobAnnotation::Current)
	}

	/// Returns whether the job is the previous job.
	pub const fn is_prev(&self) -> bool {
		matches!(self.annotation, JobAnnotation::Previous)
	}

	/// Polls whether the job has completed.
	pub fn poll_done(
		&mut self,
	) -> Result<Option<Result<ExecutionResult, error::Error>>, error::Error> {
		if self.tasks.is_empty() {
			return Ok(self.completed_result.take());
		}

		let mut result: Option<Result<ExecutionResult, error::Error>> = None;

		tracing::debug!(target: trace_categories::JOBS, "Polling job {} for completion...", self.id);

		while !self.tasks.is_empty() {
			let task = &mut self.tasks[0];
			let task_pid = task.pid();
			match task.poll() {
				Some(r) => {
					if let (Some(pid), Ok(execution_result)) = (task_pid, &r) {
						self.reaped_children.push((pid, u8::from(&execution_result.exit_code)));
					}
					self.tasks.remove(0);
					result = Some(r);
				},
				None => {
					return Ok(None);
				},
			}
		}

		tracing::debug!(target: trace_categories::JOBS, "Job {} has completed.", self.id);

		self.state = JobState::Done;

		Ok(result)
	}

	/// Waits for the job to complete.
	pub async fn wait(&mut self) -> Result<ExecutionResult, error::Error> {
		self.wait_with_policy(false).await
	}

	/// Waits for the job to terminate, ignoring stopped-state changes.
	pub async fn wait_for_termination(&mut self) -> Result<ExecutionResult, error::Error> {
		self.wait_with_policy(true).await
	}

	/// Waits for the process identified by `pid`, returning that process's exact
	/// status without draining other tasks in the same job.
	pub async fn wait_for_process(
		&mut self,
		pid: i32,
		wait_for_terminate: bool,
	) -> Result<ExecutionResult, error::Error> {
		if let Some(index) = self
			.reaped_children
			.iter()
			.position(|(reaped_pid, _)| *reaped_pid == pid)
		{
			let (_, exit_code) = self.reaped_children.remove(index);
			if self.reaped_children.is_empty() {
				self.completed_result = None;
			}
			return Ok(ExecutionResult::new(exit_code));
		}

		if let Some(index) = self.tasks.iter().position(|task| task.pid() == Some(pid)) {
			match self.tasks[index].wait(wait_for_terminate).await? {
				JobTaskWaitResult::Completed(result) => {
					self.tasks.remove(index);
					if self.tasks.is_empty() {
						self.state = JobState::Done;
					}
					return Ok(result);
				},
				JobTaskWaitResult::Stopped => {
					self.state = JobState::Stopped;
					return Ok(ExecutionResult::stopped());
				},
			}
		}

		Err(error::ErrorKind::ProcessNotFoundInJob(pid).into())
	}

	async fn wait_with_policy(
		&mut self,
		wait_for_terminate: bool,
	) -> Result<ExecutionResult, error::Error> {
		if let Some(result) = self.completed_result.take() {
			self.reaped_children.clear();
			self.state = JobState::Done;
			return result;
		}

		let mut result = ExecutionResult::success();

		while let Some(task) = self.tasks.back_mut() {
			match task.wait(wait_for_terminate).await? {
				JobTaskWaitResult::Completed(execution_result) => {
					result = execution_result;
					self.tasks.pop_back();
				},
				JobTaskWaitResult::Stopped => {
					self.state = JobState::Stopped;
					return Ok(ExecutionResult::stopped());
				},
			}
		}

		self.reaped_children.clear();
		self.state = JobState::Done;

		Ok(result)
	}

	/// Moves the job to execute in the background.
	pub fn move_to_background(&mut self) -> Result<(), error::Error> {
		match &self.state {
			JobState::Stopped => {
				let pgid = self
					.process_group_id()
					.ok_or(error::ErrorKind::FailedToSendSignal)?;
				sys::signal::continue_process(pgid)?;
				self.state = JobState::Running;
				Ok(())
			},
			JobState::Running => Ok(()),
			JobState::Unknown | JobState::Done => Err(error::ErrorKind::FailedToSendSignal.into()),
		}
	}

	/// Moves the job to execute in the foreground.
	pub fn move_to_foreground(&mut self) -> Result<(), error::Error> {
		if matches!(self.state, JobState::Stopped) {
			if let Some(pgid) = self.process_group_id() {
				sys::signal::continue_process(pgid)?;
				self.state = JobState::Running;
			} else {
				return Err(error::ErrorKind::FailedToSendSignal.into());
			}
		}

		if let Some(pgid) = self.process_group_id() {
			sys::terminal::move_to_foreground(pgid)?;
		}

		Ok(())
	}

	/// Kills the job.
	///
	/// # Arguments
	///
	/// * `signal` - The signal to send to the job.
	pub fn kill(&self, signal: traps::TrapSignal) -> Result<(), error::Error> {
		if let Some(pid) = self.process_group_id() {
			sys::signal::kill_process(pid, signal)
		} else {
			Err(error::ErrorKind::FailedToSendSignal.into())
		}
	}

	/// Aborts shell-internal background tasks and drops their join handles.
	///
	/// External process jobs are intentionally left alone; callers that abort
	/// internal tasks are still responsible for signalling any process trees
	/// those tasks may have spawned.
	pub fn abort_internal_tasks(&mut self) {
		let mut aborted = false;
		self.tasks.retain_mut(|task| {
			if let JobTask::Internal(handle) = task {
				handle.abort();
				aborted = true;
				return false;
			}
			true
		});
		if aborted && self.tasks.is_empty() {
			self.state = JobState::Done;
		}
	}

	fn matches_selector(&self, selector: JobSelector) -> bool {
		match selector {
			JobSelector::JobId(id) => self.id == id,
			JobSelector::ProcessId(pid) => self.contains_process_id(pid),
		}
	}

	fn contains_process_id(&self, pid: i32) -> bool {
		self
			.reaped_children
			.iter()
			.any(|(reaped_pid, _)| *reaped_pid == pid)
			|| self.tasks.iter().any(|task| match task {
				JobTask::External(process) => process.pid().is_some_and(|process_pid| process_pid == pid),
				JobTask::Internal(_) => false,
			})
	}

	fn is_wait_status_consumed(&self) -> bool {
		matches!(self.state, JobState::Done)
			&& self.tasks.is_empty()
			&& self.reaped_children.is_empty()
			&& self.completed_result.is_none()
	}

	fn wait_identifier(&self) -> String {
		self
			.representative_pid()
			.map_or_else(|| self.id.to_string(), |pid| pid.to_string())
	}

	/// Tries to retrieve a "representative" pid for the job.
	pub fn representative_pid(&self) -> Option<sys::process::ProcessId> {
		for task in &self.tasks {
			match task {
				JobTask::External(p) => {
					if let Some(pid) = p.pid() {
						return Some(pid);
					}
				},
				JobTask::Internal(_) => (),
			}
		}
		self.reaped_children.first().map(|(pid, _)| *pid)
	}

	/// Tries to retrieve the process group ID (PGID) of the job.
	pub fn process_group_id(&self) -> Option<sys::process::ProcessId> {
		// TODO(jobs): Don't assume that the first PID is the PGID.
		self.pgid.or_else(|| self.representative_pid())
	}

	/// Duplicates process handles for termination on Windows.
	#[cfg(windows)]
	pub fn duplicate_kill_handles(&self) -> Vec<OwnedHandle> {
		self
			.tasks
			.iter()
			.filter_map(|task| match task {
				JobTask::External(process) => process.duplicate_kill_handle(),
				JobTask::Internal(_) => None,
			})
			.collect()
	}
}

#[cfg(test)]
mod tests {
	#![allow(clippy::expect_used, reason = "test failures need explicit context")]

	use super::*;

	#[cfg(unix)]
	fn spawn_exit_task(exit_code: u8) -> (i32, JobTask) {
		spawn_shell_task(&format!("exit {exit_code}"))
	}

	#[cfg(unix)]
	fn spawn_shell_task(script: &str) -> (i32, JobTask) {
		let mut command = std::process::Command::new("/bin/sh");
		command.arg("-c").arg(script);
		let child = sys::process::spawn(command).expect("spawn child");
		let pid = i32::try_from(child.id().expect("child pid")).expect("pid fits i32");
		let process = processes::ChildProcess::new(child, Some(pid), None);
		(pid, JobTask::External(process))
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn reaper_retains_each_pipeline_child_status_for_wait_by_pid() {
		let (first_pid, first_task) = spawn_exit_task(23);
		let (second_pid, second_task) = spawn_exit_task(37);
		let mut manager = JobManager::new();
		manager.add_as_current(Job::new(
			[first_task, second_task],
			"first | second".into(),
			JobState::Running,
		));

		tokio::time::timeout(Duration::from_secs(5), async {
			loop {
				manager.reap_completed().expect("reap completed children");
				if matches!(manager.jobs[0].state, JobState::Done) {
					break;
				}
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("timed out reaping pipeline children");

		assert_eq!(manager.jobs[0].representative_pid(), Some(first_pid));
		let first_result = manager
			.resolve_process_id(first_pid)
			.expect("first child remains waitable")
			.wait_for_process(first_pid, false)
			.await
			.expect("wait first child");
		assert_eq!(u8::from(&first_result.exit_code), 23);
		assert!(!manager.contains_process_id(first_pid));

		let second_result = manager
			.resolve_process_id(second_pid)
			.expect("second child remains waitable")
			.wait_for_process(second_pid, false)
			.await
			.expect("wait second child");
		assert_eq!(u8::from(&second_result.exit_code), 37);
		assert!(!manager.contains_process_id(second_pid));
		let next = manager.wait_next(&[]).await.expect("check for another unwaited job");
		assert!(next.is_none());
		assert!(manager.jobs.is_empty());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn representative_pid_prefers_a_remaining_live_pipeline_child() {
		let (first_pid, first_task) = spawn_exit_task(23);
		let (second_pid, second_task) = spawn_shell_task("sleep 30; exit 37");
		let mut job = Job::new(
			[first_task, second_task],
			"first | second".into(),
			JobState::Running,
		);

		tokio::time::timeout(Duration::from_secs(5), async {
			loop {
				let _ = job.poll_done().expect("poll pipeline");
				if job.reaped_children.iter().any(|(pid, _)| *pid == first_pid) {
					break;
				}
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("timed out reaping first pipeline child");

		assert_eq!(job.representative_pid(), Some(second_pid));
		assert_eq!(job.process_group_id(), Some(second_pid));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn wait_for_process_waits_only_for_the_requested_active_child() {
		let (first_pid, first_task) = spawn_exit_task(23);
		let (second_pid, second_task) = spawn_shell_task("sleep 30; exit 37");
		let mut job = Job::new(
			[first_task, second_task],
			"first | second".into(),
			JobState::Running,
		);

		let first_result = tokio::time::timeout(
			Duration::from_secs(5),
			job.wait_for_process(first_pid, false),
		)
		.await
		.expect("waiting for the first child must not wait for the second")
		.expect("wait first child");
		assert_eq!(u8::from(&first_result.exit_code), 23);
		assert!(!job.contains_process_id(first_pid));
		assert!(job.contains_process_id(second_pid));
		assert!(matches!(job.state, JobState::Running));
	}

	#[test]
	fn reaper_bounds_unconsumed_completed_job_retention_and_preserves_unique_ids() {
		let mut manager = JobManager::new();
		for index in 0..=MAX_RETAINED_COMPLETED_JOBS {
			let mut job = Job::new(
				std::iter::empty::<JobTask>(),
				format!("completed-{index}"),
				JobState::Done,
			);
			let pid = 10_000 + i32::try_from(index).expect("retained job index fits i32");
			job.reaped_children.push((pid, 0));
			manager.add_as_current(job);
		}

		manager.reap_completed().expect("bound completed jobs");
		assert_eq!(manager.jobs.len(), MAX_RETAINED_COMPLETED_JOBS);
		assert_eq!(manager.jobs.first().map(|job| job.id), Some(2));
		assert_eq!(
			manager.jobs.last().map(|job| job.id),
			Some(MAX_RETAINED_COMPLETED_JOBS + 1),
		);
		assert!(!manager.contains_process_id(10_000));
		assert!(manager.contains_process_id(10_001));

		let next_id = manager
			.add_as_current(Job::new(
				std::iter::empty::<JobTask>(),
				"next".into(),
				JobState::Done,
			))
			.id;
		assert_eq!(next_id, MAX_RETAINED_COMPLETED_JOBS + 2);
	}
}
