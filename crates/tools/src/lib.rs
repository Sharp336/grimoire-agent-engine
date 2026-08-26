//! Resource-owning built-in tools for the OMP environment.
//!
//! Executors consume the same streaming invocation contract as extensions:
//! speculative preparation may begin while arguments arrive, while filesystem
//! and process effects remain behind the explicit commitment gate. Durable
//! payloads are revisioned truth and prompt parts are deterministic
//! projections.

/// Shared foreground-wait and managed-job transfer helpers.
pub mod auto_background;

/// Interactive user question picker.
pub mod ask;
/// Structural multi-target rewrites.
pub mod ast_edit;
/// Structural multi-target search.
pub mod ast_grep;
/// Supervised embedded browser automation.
pub mod browser;
/// Durable exploration checkpoint and boundary-rewind tools.
pub mod checkpoint;
/// Native desktop capture, input, and accessibility.
pub mod computer;
/// Workspace-confinement and selector path utilities.
pub mod path;
mod render;
/// Typed policy projection owned by file tools.
pub mod settings;
/// Shared staged-proposal lifecycle for preview-producing tools.
pub mod staging;

pub use render::{
	BuiltinRendererIdentities,
	json_tree::{JsonTreeBounds, JsonTreePreview, preview as preview_json_tree},
	register_builtin_renderers,
};

/// Revisioned project debugger tool.
pub mod debug;
/// Bounded debugger snapshot renderers.
pub mod debug_render;
/// Stable dynamic device transport and catalog rendering.
pub mod device;
/// Schema-derived command-line mappings for dynamic devices.
pub mod device_ctl;
/// Hashline document transactions with speculative previews.
pub mod edit;
/// Persistent Python evaluation.
pub mod eval;
/// Reader-mode URL fetching through the shared read conversion pipeline.
pub mod fetch;
/// Native renderer lifecycle fixtures for visual QA.
pub mod gallery;
/// Direct GitHub API and isolated pull-request operations.
pub mod github;
/// Deterministic workspace path matching.
pub mod glob;
/// Hidden durable goal lifecycle tool.
pub mod goal;
/// Workspace byte and pattern search.
pub mod grep;
/// Peer, detached-job, and named-process coordination.
pub mod hub;
/// Durable lesson capture with optional managed-skill publication.
pub mod learn;
/// Revisioned project language-server tool.
pub mod lsp;
/// Isolated generated-skill create, update, and delete tool.
pub mod manage_skill;
/// Typed Mnemopi recall, reflect, and retain tools.
pub mod memory;
/// Typed Mnemopi mutation tool.
pub mod memory_edit;
/// Pi-compatible reads across local and special sources.
pub mod read;
/// Review finding parsing and priority normalization.
pub mod review;
/// Persistent-session shell execution.
pub mod shell;
/// Pre-authorization guidance for shell intents served by dedicated tools.
pub mod shell_intercept;
/// Internal-resource URI scanner used before environment execution.
pub mod shell_uri;
/// Private no-op reasoning scratch notes.
pub mod think;
/// Phased session task tracking.
pub mod todo;
/// Canonical provider-routed web search.
pub mod web_search;
/// Pi-compatible whole-file writes.
pub mod write;
/// Structured subagent result submission.
pub mod yield_tool;
