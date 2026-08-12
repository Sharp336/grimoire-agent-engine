/**
 * Canonical contracts for ompd.
 *
 * This file is the authority. `docs/architecture.md` describes it in prose; if
 * the two ever disagree, this wins. Every slice builds against these types so
 * they can be developed concurrently without negotiating shapes.
 */

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentId = string; // "agt_" + 16 hex

export type AgentState =
  | "provisioning" // host being acquired
  | "starting" // host up, session not yet created
  | "idle" // ready, no turn in flight
  | "busy" // turn streaming
  | "waiting" // blocked on an approval decision
  | "stopped" // clean exit, transcript retained
  | "failed"; // crashed or provisioning failed

/** States from which no further work can proceed without operator action. */
export const TERMINAL_AGENT_STATES: readonly AgentState[] = ["stopped", "failed"];

export interface Agent {
  id: AgentId;
  name: string;
  state: AgentState;
  /** OMP-side ACP session id. Absent until the session is created. */
  acpSessionId?: string;
  host: HostRef;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  /** Set when this agent was spawned by a routine rather than a human. */
  routineId?: string;
  labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export type HostKind = "local" | "container" | "cloud";

export interface HostSpec {
  kind: HostKind;
  image?: string;
  repo?: string;
  ref?: string;
  /** JIT hosts self-destruct after this long idle. Omit for no expiry. */
  ttlSeconds?: number;
}

export interface HostRef {
  kind: HostKind;
  /** pid for local, container id for container, machine id for cloud. */
  id: string;
  spec: HostSpec;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type ApprovalChoice = "allow" | "deny";
export type ApprovalScope = "once" | "always";

/**
 * ACP option ids, as advertised by `session/request_permission`. The supervisor
 * maps a PolicyDecision onto one of these; nothing else may.
 */
export type AcpOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface ApprovalRequest {
  requestId: string;
  agentId: AgentId;
  tool: string;
  input: unknown;
  /** Human-readable one-liner supplied by ACP, e.g. the shell command. */
  title: string;
  createdAt: string;
}

export interface ApprovalRecord extends ApprovalRequest {
  decision: ApprovalChoice;
  scope: ApprovalScope;
  /** Which rule decided. "operator" when a human broke a `prompt` tie. */
  rule: string;
  actorDeviceId: string | null;
  decidedAt: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface Actor {
  deviceId: string;
  scopes: string[];
}

export interface PolicyContext {
  agent: Agent;
  tool: string;
  input: unknown;
  actor: Actor;
}

export interface PolicyDecision {
  action: "allow" | "deny" | "prompt";
  reason: string;
  rule?: string;
}

export interface Policy {
  /** Pure and total: must never throw and never perform I/O. */
  evaluate(ctx: PolicyContext): PolicyDecision;
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export type TriggerSpec =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "interval"; seconds: number }
  | { kind: "manual" }
  | { kind: "webhook"; secretRef: string };

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerSpec;
  /** Prompt delivered to a fresh agent on each run. */
  prompt: string;
  cwd: string;
  host: HostSpec;
  /** Skip a run if the previous one is still going. */
  singleton: boolean;
  /** Kill a run that exceeds this. */
  timeoutSeconds?: number;
  labels: Record<string, string>;
  createdAt: string;
}

export type RunState = "queued" | "running" | "succeeded" | "failed" | "skipped" | "timed_out";

export interface Run {
  id: string;
  routineId: string;
  agentId?: AgentId;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  /** Final assistant text, truncated for listing. */
  summary?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface Device {
  id: string;
  name: string;
  publicKey: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** Scope required to break a `prompt` tie on a tool approval. */
export const SCOPE_APPROVE = "approve";
/** Scope required to create or destroy agents. */
export const SCOPE_MANAGE = "manage";
/** Scope required to read transcripts. */
export const SCOPE_READ = "read";
/** Scope required to send prompts. */
export const SCOPE_PROMPT = "prompt";

// ---------------------------------------------------------------------------
// Client wire protocol
// ---------------------------------------------------------------------------

export type ClientFrame =
  | { t: "attach"; agentId: AgentId; sinceSeq?: number }
  | { t: "detach"; agentId: AgentId }
  | { t: "prompt"; agentId: AgentId; text: string; images?: string[] }
  | { t: "cancel"; agentId: AgentId }
  | { t: "decide"; agentId: AgentId; requestId: string; choice: ApprovalChoice; scope?: ApprovalScope }
  | { t: "audio"; agentId: AgentId; pcm: string } // base64 16k mono PCM16
  | { t: "audio_end"; agentId: AgentId }
  | { t: "ping" };

export type ServerFrame =
  | { t: "hello"; deviceId: string; agents: Agent[] }
  | { t: "agents"; agents: Agent[] }
  | { t: "update"; agentId: AgentId; seq: number; update: unknown }
  | { t: "approval"; agentId: AgentId; requestId: string; title: string; tool: string; input: unknown }
  /**
   * The speakable form of a turn's answer, as prose.
   *
   * Separate from `speech` because a client that owns its own voice should
   * never receive audio it has to know to ignore, and separate from
   * `transcript` because that one carries the operator's speech in the other
   * direction.
   *
   * A rendering hint and nothing more. Receiving one must never cause a client
   * to act, approve, or change state, and a client that branches on the
   * content of one has a bug. `seq` is the highest update this summary derives
   * from, so a client can tell which turn is speaking and refuse to say the
   * same one twice after a reconnect. The text is already sanitised and capped
   * by the daemon; there is no client-sent counterpart, because a client that
   * could ask for a `say` could make another device speak arbitrary words.
   */
  | { t: "say"; agentId: AgentId; seq: number; text: string }
  /** Synthesized audio, for a client with no voice of its own. */
  | { t: "speech"; agentId: AgentId; pcm: string }
  | { t: "transcript"; agentId: AgentId; text: string; final: boolean }
  | { t: "error"; agentId?: AgentId; message: string; code?: string }
  | { t: "pong" };

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditAction =
  | "agent.create"
  | "agent.stop"
  | "agent.prompt"
  | "approval.decide"
  | "device.pair"
  | "device.revoke"
  /** A daemon registered an outbound tunnel leg with a hub, or was refused. */
  | "tunnel.register"
  /** A client opened a tunnel session to this daemon, or was refused. */
  | "tunnel.attach"
  | "routine.create"
  | "routine.run"
  | "proposal.submit"
  | "proposal.promote"
  | "proposal.reject"
  | "host.provision"
  | "host.destroy";

export interface AuditEntry {
  id: number;
  ts: string;
  action: AuditAction;
  actorDeviceId: string | null;
  agentId?: AgentId;
  /** Structured detail. Must never contain credentials. */
  detail: Record<string, unknown>;
  outcome: "ok" | "denied" | "error";
}

// ---------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------

/**
 * Paths the evolution engine may never modify. A proposal touching any of these
 * is archived at submission time rather than queued for review, because a loop
 * that can edit its own gate has no gate.
 *
 * Matched as path prefixes against repo-relative POSIX paths.
 */
export const PROTECTED_PATHS: readonly string[] = [
  "packages/core/src/policy.ts",
  "packages/core/src/audit.ts",
  "packages/core/src/contracts.ts",
  "packages/daemon/src/auth/",
  "packages/daemon/src/provisioner/",
  "packages/daemon/src/evolution/gate.ts",
  ".github/workflows/",
  "mise.toml",
];

export type ProposalState =
  | "submitted"
  | "archived" // touched a protected path
  | "evaluating"
  | "rejected" // failed evaluation
  | "awaiting_review" // passed evaluation, needs an operator
  | "canary"
  | "promoted"
  | "rolled_back";

export interface Proposal {
  id: string;
  title: string;
  rationale: string;
  /** Unified diff. Never applied to the running tree. */
  diff: string;
  touchedPaths: string[];
  state: ProposalState;
  verdict?: { passed: boolean; log: string };
  createdAt: string;
  promotedCommit?: string;
}

export function isProtectedPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  return PROTECTED_PATHS.some((prefix) =>
    prefix.endsWith("/") ? norm.startsWith(prefix) : norm === prefix,
  );
}
