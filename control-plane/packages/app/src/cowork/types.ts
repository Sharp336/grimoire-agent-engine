/**
 * The Cowork wire contract, mirrored client-side.
 *
 * `SkillSummary`, `ConnectorSummary`, `Task` and `TaskState` are being added to
 * `@ompd/core/contracts` by the daemon side (control-plane/packages/daemon,
 * routes `GET /v1/skills`, `GET /v1/connectors`, `GET|POST /v1/tasks`). This
 * file is a snapshot of that contract as specified by CoworkSurface while
 * `contracts.ts` was mid-flight. Once it lands, replace every declaration
 * below with `export type { SkillSummary, ConnectorSummary, Task, TaskState }
 * from "@ompd/core/contracts"` and delete the local copies — every field name
 * and literal here is typed to match exactly, so the swap is mechanical.
 *
 * Two fields carry a documented provenance gap rather than a guess:
 *
 * `pluginName` is server-derived from the marketplace cache path
 * (`…/plugins/cache/<marketplace>/<pluginName>/…`) and is `undefined` for
 * anything not installed as a plugin package — a bare project-local skill
 * file, a project `.mcp.json` entry. That absence is the honest answer.
 *
 * There is no `origin` field distinguishing "the org's own marketplace" from
 * a public one: no marketplace-allowlist concept exists anywhere in this
 * codebase (confirmed with CoworkSurface), so that finer split is not
 * available. `deriveOrigin` in `catalog.ts` computes the coarser, honestly
 * grounded three-way split this contract *can* support: OMP itself, an
 * installed plugin package (any marketplace), or unpackaged local config.
 */

/** Where a discovered item's config lives: a repo, the user's home, or OMP itself. */
export type SourceLevel = "user" | "project" | "native";

export interface SkillSummary {
  name: string;
  description: string;
  /** A skill is model-invoked prose; a command is a file-based `/name` shortcut. Cowork treats both as "/name" invocable work. */
  kind: "skill" | "command";
  /** `"<providerId>:<level>"`, e.g. `"claude-plugins:project"`. The loading mechanism, not a plugin's own name. */
  source: string;
  /** The loader's own display name, e.g. "Claude Code Marketplace". A category, not a specific plugin. */
  providerName?: string;
  level?: SourceLevel;
  /** The installed plugin's own name, when this came from a plugin package. */
  pluginName?: string;
}

export type ConnectorConnectionState = "connected" | "connecting" | "disconnected";

export interface ConnectorSummary {
  name: string;
  connected: boolean;
  status: ConnectorConnectionState;
  providerName?: string;
  level?: SourceLevel;
  pluginName?: string;
  /**
   * Why it's down. Present only when not connected, and redacted server-side
   * before it ever reaches a client. Never a credential — see
   * `looksLikeCredential` in `catalog.ts` for the client-side backstop.
   */
  error?: string;
}

/**
 * A task's lifecycle. Matches the daemon's own spelling exactly (one "l" in
 * "canceled") because this is a wire literal, not a UI word choice.
 */
export type TaskState = "queued" | "running" | "waiting" | "done" | "failed" | "canceled";

/**
 * A named, tracked prompt against a session that already exists. `agentId` is
 * required at creation — `POST /v1/tasks` never provisions a host itself,
 * that is a separate manage-scope act (`POST /v1/agents`). Per
 * control-plane/docs/portability.md: `agentId` identifies a session, not a
 * machine, and nothing here may assume the session is local to this daemon.
 */
export interface Task {
  id: string;
  title: string;
  prompt: string;
  skillName?: string;
  agentId: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  /** Final assistant text, once the task has settled. */
  result?: string;
  labels: Record<string, string>;
}
