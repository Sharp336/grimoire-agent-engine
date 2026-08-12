/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { once } from "node:events";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Message, serviceTierFamily } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { EditorTheme, TUI } from "@oh-my-pi/pi-tui";
import { isEnoent, isRecord, readLines, Snowflake } from "@oh-my-pi/pi-utils";
import { JobProjectionService } from "../../async";
import { reset as resetCapabilities } from "../../capability";
import type { KeybindingsManager } from "../../config/keybindings";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import type { EvalToolDetails } from "../../eval/types";
import {
 type AutocompleteProviderFactory,
 type ExtensionAskDialogQuestion,
 type ExtensionAskDialogResult,
 type ExtensionToolApprovalDecision,
 type ExtensionToolApprovalRequest,
 type ExtensionUIContext,
 type ExtensionUIDialogOptions,
 type ExtensionUISelectItem,
 type ExtensionUiComponent,
 type ExtensionUiComponentFactory,
 type ExtensionWidgetContent,
 type ExtensionWidgetOptions,
 getExtensionUISelectOptionLabel,
 type TerminalInputHandler,
} from "../../extensibility/extensions";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { type MCPManager, reloadMcpResources } from "../../mcp";
import type { CustomEditor } from "../../modes/components/custom-editor";
import { buildBrowserItems, resolveRoleAssignments, sortModelItems } from "../../modes/components/model-browser";
import { type Theme, theme } from "../../modes/theme/theme";
import { AgentControlService } from "../../registry/agent-control";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { AgentSessionAuthority } from "../../session/agent-session-authority";
import type { PromptOptions } from "../../session/agent-session-types";
import {
 ArtifactExportPathError,
 ArtifactHashMismatchError,
 ArtifactNotFoundError,
 ArtifactRangeError,
 MAX_ARTIFACT_RANGE_BYTES,
} from "../../session/artifacts";
import { materializeEvalOutput } from "../../session/eval-output";
import { type PythonExecutionMessage, SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { ComposerInputRouter } from "../controllers/composer-input-router";
import manualContinuePrompt from "../../prompts/system/manual-continue.md" with { type: "text" };
import { splitQueuedMessages } from "../queue-input";
import { adaptSemanticRenderResultToHost } from "../../session/semantic-content";
import {
 inspectPersistedSessionWorkspace,
 listSessionCatalog,
 listSessionWorkspaceRoots,
 projectSessionCatalogEntry,
 projectSessionTree,
 resolveSessionCatalogReference,
 SessionCatalogError,
} from "../../session/session-catalog";
import type { ContextAssemblyRelation, ContextAssemblySnapshot } from "../../session/session-context-projection";
import {
 negotiateSessionHost,
 SESSION_SEMANTIC_PROFILE,
 SessionCursorError,
 SessionHost,
 type SessionHostNegotiated,
 type SessionJsonValue,
} from "../../session/session-host";
import { SessionLoopScheduler } from "../../session/session-loop";
import { SessionQueueEntryNotFoundError, SessionQueueInvalidPositionError } from "../../session/session-queue-service";
import { FileSessionStorage } from "../../session/session-storage";
import { BUILTIN_SLASH_COMMANDS } from "../../slash-commands/builtin-registry";
import { ToolInventoryUnavailableError } from "../../session/session-tools";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { getSelectableThinkingLevels } from "../../thinking";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { EvalTool } from "../../tools/eval";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import {
 ProviderAuthController,
 ProviderAuthError,
 ProviderAuthService,
 type ProviderAuthUpdate,
} from "../controllers/provider-auth-controller";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import {
 type RpcCollaborationAuthorityCommit,
 RpcCollaborationAuthorityError,
 type RpcCollaborationAuthorityTransition,
 RpcCollaborationManager,
 type RpcCollaborationSessionAuthority,
 RpcCollaborationStateError,
} from "./rpc-collaboration";
import { RpcCollaborationSessionMediaStore, RpcCollaborationTransportFactoryImpl } from "./rpc-collaboration-transport";
import {
 getRpcCapabilityManifest,
 getRpcCommandRequiredFeatures,
 MAX_RPC_CONTEXT_CONTENT_BYTES,
 MAX_RPC_CONTEXT_RELATIONS,
 MAX_RPC_CONTEXT_SOURCES,
 RPC_APPLICATION_API_VERSION,
 RpcToolActivationValidationError,
 validateRpcCommand,
 validateRpcToolActivationBatch,
} from "./rpc-command-registry";
import { RpcEvalOutputStream } from "./rpc-eval";
import {
 applyRpcTodoOperation,
 controlRpcCheckpoint,
 controlRpcGoal,
 controlRpcLoop,
 RpcTodoOperationError,
 setRpcModelRole,
 setRpcServiceTier,
 setRpcTodoPhases,
} from "./rpc-execution-controls";
import { projectRpcSessionExecution } from "./rpc-execution-snapshot";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import { handleGetSettings } from "./rpc-get-settings";
import { claimRpcInput } from "./rpc-input";
import { RpcInteractiveSurfaceError, RpcInteractiveSurfaceManager } from "./rpc-interactive-surface";
import { pageRpcMessages, pageRpcTranscript, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import { type RpcOperationHandle, RpcOperationManager, RpcOperationMessageOwnership } from "./rpc-operations";
import { RpcProvenanceManager, type RpcProvenanceSource } from "./rpc-provenance";
import { RpcResourceLifecycleManager, RpcResourceNotFoundError } from "./rpc-resource-lifecycle";
import { RpcRuntimeResourceSource } from "./rpc-runtime-resources";
import { RpcSemanticRenderingManager } from "./rpc-semantic-rendering";
import {
 type RpcExecutionAuthorityTransitionToken,
 RpcSessionAuthorityCoordinator,
 RpcSessionAuthorityError,
 type RpcSessionAuthorityToken,
 type RpcSessionTransitionToken,
} from "./rpc-session-authority";
import {
 createRpcSessionCommandInvoker,
 getRpcSessionCommandCapability,
 RpcSessionHostAdapter,
 RpcSessionSubscriptionNotFoundError,
} from "./rpc-session-host";
import { handleSetSettings } from "./rpc-set-settings";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import { projectRpcToolSemantic } from "./rpc-tool-semantic-rendering";
import type {
 RpcCommand,
 RpcContextGetResult,
 RpcDeleteSessionResult,
 RpcEvalHistoryEntry,
 RpcExtensionUIRequest,
 RpcExtensionUIResponse,
 RpcForkSessionResult,
 RpcHostToolCallRequest,
 RpcHostToolCancelRequest,
 RpcHostToolDefinition,
 RpcHostToolResult,
 RpcHostToolUpdate,
 RpcHostUriCancelRequest,
 RpcHostUriRequest,
 RpcHostUriResult,
 RpcInteractionSettledFrame,
 RpcPendingInteractionSnapshot,
 RpcRenameSessionResult,
 RpcResponse,
 RpcResumeSessionResult,
 RpcSessionInfoResult,
 RpcSessionState,
 RpcSubagentSubscriptionLevel,
 RpcToolActivationResult,
} from "./rpc-types";
import { getRpcV3CapabilityManifest } from "./rpc-v3";

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
 resolve: (response: RpcExtensionUIResponse) => void;
 reject: (error: Error) => void;
 snapshot?: RpcPendingInteractionSnapshot;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
 #closedError: Error | undefined;
 #supportedMethods: ReadonlySet<string> | undefined;

 override set(id: string, request: PendingExtensionRequest): this {
  if (this.#closedError) {
   request.reject(this.#closedError);
   return this;
  }
  return super.set(id, request);
 }

 /** Constrain interactive requests to the exact host surface negotiated by RPC v3. */
 configureHostCapabilities(methods: readonly string[]): void {
  this.#supportedMethods = new Set(methods);
 }

 supports(method: string): boolean {
  return this.#supportedMethods?.has(method) ?? true;
 }

 snapshot(): RpcPendingInteractionSnapshot[] {
  return Array.from(this.values(), request => request.snapshot)
   .filter((value): value is RpcPendingInteractionSnapshot => value !== undefined)
   .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
 }

 /** Reject every active and future extension UI request. */
 rejectAll(message: string): void {
  if (!this.#closedError) this.#closedError = new RpcInteractionDisconnectedError(message);
  const requests = Array.from(this.values());
  this.clear();
  for (const request of requests) {
   request.reject(this.#closedError);
  }
 }
}

class RpcInteractionDisconnectedError extends Error { }

type RpcOutput = (
 obj:
  | RpcResponse
  | RpcExtensionUIRequest
  | RpcHostToolCallRequest
  | RpcHostToolCancelRequest
  | RpcHostUriRequest
  | RpcHostUriCancelRequest
  | object,
) => void;

export function projectBoundedRpcContext(
 snapshot: ContextAssemblySnapshot,
 options: {
  maxSources?: number;
  maxRelations?: number;
  maxContentBytes?: number;
 },
): RpcContextGetResult {
 const bounds = {
  maxSources: options.maxSources ?? MAX_RPC_CONTEXT_SOURCES,
  maxRelations: options.maxRelations ?? MAX_RPC_CONTEXT_RELATIONS,
  maxContentBytes: options.maxContentBytes ?? MAX_RPC_CONTEXT_CONTENT_BYTES,
 };
 let contentBytes = 0;
 let contentTruncated = false;
 let sourcesTruncated = false;
 let relationsTruncated = false;
 const retainContent = <T>(content: T): T | undefined => {
  const serialized = JSON.stringify(content);
  const byteLength = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  if (contentBytes + byteLength > bounds.maxContentBytes) {
   contentTruncated = true;
   return undefined;
  }
  contentBytes += byteLength;
  return content;
 };
 const sourceSlice = snapshot.sources.slice(0, bounds.maxSources);
 sourcesTruncated ||= sourceSlice.length < snapshot.sources.length;
 const sources = sourceSlice.map(source => {
  const { content, metadata, outputMeta, ...bounded } = source;
  const retainedSourceContent = content === undefined ? undefined : retainContent(content);
  const retainedMetadata = metadata === undefined ? undefined : retainContent(metadata);
  const retainedOutputMeta = outputMeta === undefined ? undefined : retainContent(outputMeta);
  return {
   ...bounded,
   ...(retainedSourceContent === undefined ? {} : { content: retainedSourceContent }),
   ...(retainedMetadata === undefined ? {} : { metadata: retainedMetadata }),
   ...(retainedOutputMeta === undefined ? {} : { outputMeta: retainedOutputMeta }),
  };
 });
 const retainedSourceIds = new Set(sources.map(source => source.id));
 const logicalSourceSlice = snapshot.systemPrompt.logicalSources.slice(0, bounds.maxSources);
 sourcesTruncated ||= logicalSourceSlice.length < snapshot.systemPrompt.logicalSources.length;
 const unmappedLogicalSources = logicalSourceSlice.map(source => {
  const { content, metadata, ...bounded } = source;
  const retainedSourceContent = content === undefined ? undefined : retainContent(content);
  const retainedMetadata = metadata === undefined ? undefined : retainContent(metadata);
  return {
   ...bounded,
   ...(retainedSourceContent === undefined ? {} : { content: retainedSourceContent }),
   ...(retainedMetadata === undefined ? {} : { metadata: retainedMetadata }),
  };
 });
 const renderedSlice = snapshot.systemPrompt.rendered.slice(0, bounds.maxSources);
 sourcesTruncated ||= renderedSlice.length < snapshot.systemPrompt.rendered.length;
 const rendered: string[] = [];
 const renderedIndexMap = new Map<number, number>();
 for (const [index, value] of renderedSlice.entries()) {
  const retainedValue = retainContent(value);
  if (retainedValue === undefined) continue;
  renderedIndexMap.set(index, rendered.length);
  rendered.push(retainedValue);
 }
 const logicalSources = unmappedLogicalSources.map(source => {
  const remappedFoldedInto = source.foldedInto.flatMap(index => {
   const projectedIndex = renderedIndexMap.get(index);
   return projectedIndex === undefined ? [] : [projectedIndex];
  });
  const foldedInto = remappedFoldedInto.slice(0, bounds.maxRelations);
  relationsTruncated ||=
   remappedFoldedInto.length < source.foldedInto.length || foldedInto.length < remappedFoldedInto.length;
  return { ...source, foldedInto };
 });
 const relationSlice = snapshot.relations.slice(0, bounds.maxRelations);
 relationsTruncated ||= relationSlice.length < snapshot.relations.length;
 const relations = relationSlice.flatMap((relation): ContextAssemblyRelation[] => {
  if (relation.kind === "branch-order") {
   if (retainedSourceIds.has(relation.sourceId)) return [relation];
   relationsTruncated = true;
   return [];
  }
  const sourceIds = relation.sourceIds.filter(sourceId => retainedSourceIds.has(sourceId));
  const targetIds = relation.targetIds.flatMap(targetId => {
   if (retainedSourceIds.has(targetId)) return [targetId];
   const renderedIndex = /^system-rendered:(\d+)$/.exec(targetId)?.[1];
   if (renderedIndex === undefined) return [];
   const projectedIndex = renderedIndexMap.get(Number(renderedIndex));
   return projectedIndex === undefined ? [] : [`system-rendered:${projectedIndex}`];
  });
  relationsTruncated ||=
   sourceIds.length < relation.sourceIds.length || targetIds.length < relation.targetIds.length;
  return [{ ...relation, sourceIds, targetIds }];
 });
 const provider =
  snapshot.provider === undefined
   ? undefined
   : (() => {
    const providerSystemPromptSlice = snapshot.provider.systemPrompt?.slice(0, bounds.maxSources);
    if (
     providerSystemPromptSlice &&
     providerSystemPromptSlice.length < (snapshot.provider.systemPrompt?.length ?? 0)
    ) {
     sourcesTruncated = true;
    }
    const messagesSlice = snapshot.provider.messages.slice(0, bounds.maxSources);
    sourcesTruncated ||= messagesSlice.length < snapshot.provider.messages.length;
    const providerMessages: Message[] = [];
    const providerMessageIndexMap = new Map<number, number>();
    for (const [index, message] of messagesSlice.entries()) {
     const retainedMessage = retainContent(message);
     if (retainedMessage === undefined) continue;
     providerMessageIndexMap.set(index, providerMessages.length);
     providerMessages.push(retainedMessage);
    }
    const providerRelationSlice = snapshot.provider.relations.slice(0, bounds.maxRelations);
    relationsTruncated ||= providerRelationSlice.length < snapshot.provider.relations.length;
    return {
     ...(providerSystemPromptSlice === undefined
      ? {}
      : {
       systemPrompt: providerSystemPromptSlice.flatMap(value =>
        retainContent(value) === undefined ? [] : [value],
       ),
      }),
     messages: providerMessages,
     relations: providerRelationSlice.map(relation => {
      const sourceIds = relation.sourceIds.filter(sourceId => retainedSourceIds.has(sourceId));
      const transformedMessageIndexes = relation.transformedMessageIndexes.filter(
       index => index >= 0 && index < bounds.maxSources,
      );
      const providerMessageIndexes = relation.providerMessageIndexes.flatMap(index => {
       const projectedIndex = providerMessageIndexMap.get(index);
       return projectedIndex === undefined ? [] : [projectedIndex];
      });
      relationsTruncated ||=
       sourceIds.length < relation.sourceIds.length ||
       transformedMessageIndexes.length < relation.transformedMessageIndexes.length ||
       providerMessageIndexes.length < relation.providerMessageIndexes.length;
      return {
       ...relation,
       sourceIds,
       transformedMessageIndexes,
       providerMessageIndexes,
      };
     }),
    };
   })();
 const tokenEvidence = snapshot.tokenEvidence?.slice(0, bounds.maxSources);
 if (tokenEvidence && tokenEvidence.length < (snapshot.tokenEvidence?.length ?? 0)) sourcesTruncated = true;
 const boundedSnapshot: ContextAssemblySnapshot = {
  ...snapshot,
  sources,
  relations,
  systemPrompt: {
   logicalSources,
   rendered,
  },
  ...(provider === undefined ? {} : { provider }),
  ...(tokenEvidence === undefined ? {} : { tokenEvidence }),
 };
 return {
  snapshot: boundedSnapshot,
  bounds,
  returned: {
   sources: sources.length,
   relations: relations.length,
   contentBytes,
  },
  truncated: {
   sources: sourcesTruncated,
   relations: relationsTruncated,
   content: contentTruncated,
  },
 };
}

export type RpcSessionChangeCommand = Extract<
 RpcCommand,
 { type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
 | { type: "new_session"; data: { cancelled: boolean } }
 | { type: "switch_session"; data: { cancelled: boolean } }
 | { type: "branch"; data: { text: string; cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
 session: RpcSkillCommandSession,
 text: string,
 streamingBehavior: "steer" | "followUp" = "steer",
 messageTag?: string,
 signal?: AbortSignal,
): Promise<RpcSkillCommandResult | false> {
 if (!session.skillsSettings?.enableSkillCommands) return false;
 const parsed = parseSkillInvocation(text);
 if (!parsed) return false;
 const skill = session.skills.find(candidate => candidate.name === parsed.name);
 if (!skill) return false;
 const built = await buildSkillPromptMessage(skill, parsed.args, "user");
 signal?.throwIfAborted();
 await session.promptCustomMessage(
  {
   customType: SKILL_PROMPT_MESSAGE_TYPE,
   content: built.message,
   display: true,
   details: built.details,
   attribution: "user",
  },
  { streamingBehavior, messageTag, signal },
 );
 return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
 id: string | undefined;
 prompt: Promise<boolean>;
 output: (obj: object) => void;
 onError: (error: Error) => void;
 hasExtensionAgentMessageTask?: () => boolean;
 waitForExtensionAgentMessageTasks?: () => Promise<void>;
 isAuthorityCurrent?: () => boolean;
 operation?: {
  handle: RpcOperationHandle;
  manager: RpcOperationManager;
  waitForAgentCompletion?: () => Promise<void>;
 };
}): Promise<void> {
 return input.prompt
  .then(async agentInvoked => {
   await input.waitForExtensionAgentMessageTasks?.();
   if (input.isAuthorityCurrent?.() === false) return;
   const resolvedAgentInvoked = agentInvoked || Boolean(input.hasExtensionAgentMessageTask?.());
   if (resolvedAgentInvoked) {
    await input.operation?.waitForAgentCompletion?.();
    if (input.isAuthorityCurrent?.() === false) return;
   }
   const operation = input.operation;
   if (operation) {
    setImmediate(() => {
     if (input.isAuthorityCurrent?.() === false) return;
     if (!resolvedAgentInvoked) {
      input.output({
       type: "prompt_result",
       id: input.id,
       operationId: operation.handle.operationId,
       agentInvoked: false,
      });
     }
     operation.manager.complete(operation.handle, resolvedAgentInvoked);
    });
   } else if (!resolvedAgentInvoked) {
    input.output({
     type: "prompt_result",
     id: input.id,
     agentInvoked: false,
    });
   }
  })
  .catch(error => {
   if (input.isAuthorityCurrent?.() === false) return;
   const promptError = error instanceof Error ? error : new Error(String(error));
   const operation = input.operation;
   if (operation) {
    setImmediate(() => {
     if (input.isAuthorityCurrent?.() === false) return;
     operation.manager.fail(operation.handle, promptError, "prompt_scheduling_failed");
    });
   }
   input.onError(promptError);
  });
}

type RpcExtensionUserMessageScope = {
 agentMessageTasks: Promise<unknown>[];
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
 #activePromptScopes = new Set<RpcExtensionUserMessageScope>();

 markAgentMessageTask(): void {
  for (const scope of this.#activePromptScopes) {
   scope.agentMessageTasks.push(Promise.resolve());
  }
 }

 trackAgentMessageTask(task: Promise<unknown>): void {
  for (const scope of this.#activePromptScopes) {
   scope.agentMessageTasks.push(task);
  }
 }

 async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
  let observedCount = 0;
  while (observedCount < scope.agentMessageTasks.length) {
   const tasks = scope.agentMessageTasks.slice(observedCount);
   observedCount = scope.agentMessageTasks.length;
   await Promise.all(tasks);
  }
 }

 watchPrompt<T>(startPrompt: () => Promise<T>): {
  prompt: Promise<T>;
  hasAgentMessageTask: () => boolean;
  waitForAgentMessageTasks: () => Promise<void>;
 } {
  const scope: RpcExtensionUserMessageScope = {
   agentMessageTasks: [],
  };
  this.#activePromptScopes.add(scope);
  let prompt: Promise<T>;
  try {
   prompt = startPrompt();
  } catch (error) {
   this.#activePromptScopes.delete(scope);
   throw error;
  }
  return {
   prompt: prompt.finally(() => {
    this.#activePromptScopes.delete(scope);
   }),
   hasAgentMessageTask: () => scope.agentMessageTasks.length > 0,
   waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
  };
 }
}

export function watchAndReportLocalOnlyPromptResult(input: {
 id: string | undefined;
 startPrompt: () => Promise<boolean>;
 output: (obj: object) => void;
 onError: (error: Error) => void;
 extensionUserMessageTracker: RpcExtensionUserMessageTracker;
 isAuthorityCurrent?: () => boolean;
 operation?: {
  handle: RpcOperationHandle;
  manager: RpcOperationManager;
  waitForAgentCompletion?: () => Promise<void>;
 };
}): { scheduling: Promise<boolean>; lifecycle: Promise<void> } {
 const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
 return {
  scheduling: trackedPrompt.prompt,
  lifecycle: reportLocalOnlyPromptResult({
   id: input.id,
   prompt: trackedPrompt.prompt,
   output: input.output,
   onError: input.onError,
   isAuthorityCurrent: input.isAuthorityCurrent,
   hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
   waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
   operation: input.operation,
  }),
 };
}

async function waitForQueuedRpcPrompt(
 session: Pick<AgentSession, "isStreaming" | "queuedMessageCount" | "waitForIdle">,
) {
 while (true) {
  await session.waitForIdle();
  const nextTurn = Promise.withResolvers<void>();
  setImmediate(nextTurn.resolve);
  await nextTurn.promise;
  if (!session.isStreaming && session.queuedMessageCount === 0) return;
 }
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
 handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
 output: RpcOutput;
 errorResponse: (id: string | undefined, command: string, message: string, code?: string) => RpcResponse;
 trackBackgroundTask?: (task: Promise<void>) => void;
 pendingExtensionRequests: Map<string, PendingExtensionRequest>;
 onHostToolResult: (frame: RpcHostToolResult) => void;
 onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
 onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
 if (!isRecord(value)) return false;
 return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
 if (isRpcExtensionUIResponse(parsed)) {
  const pending = deps.pendingExtensionRequests.get(parsed.id);
  if (pending) pending.resolve(parsed);
  return true;
 }

 if (isRpcHostToolResult(parsed)) {
  deps.onHostToolResult(parsed);
  return true;
 }

 if (isRpcHostToolUpdate(parsed)) {
  deps.onHostToolUpdate(parsed);
  return true;
 }

 if (isRpcHostUriResult(parsed)) {
  deps.onHostUriResult(parsed);
  return true;
 }

 return false;
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Concurrent and control commands are dispatched in the background so the
 * caller can keep reading while a long-running serial command is in flight.
 * This lets abort, steering, and cancellation commands preempt queued work.
 * Response correlation is preserved via each command's `id`; ordering across
 * concurrent commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`concurrent` or `control`). Otherwise a promise that resolves once the response
 *   for the command has been emitted via `output`. Errors from `handleCommand`
 *   on serial commands propagate; the caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
 if (dispatchRpcControlFrame(parsed, deps)) return undefined;
 const validation = validateRpcCommand(parsed);
 if (!validation.ok) {
  deps.output(deps.errorResponse(validation.id, validation.command, validation.error, validation.code));
  return undefined;
 }
 const command = validation.command;

 if (validation.scheduling !== "serial") {
  const task = (async () => {
   try {
    const response = await deps.handleCommand(command);
    deps.output(response);
    if (response.success && response.command === "set_settings") deps.output({ type: "settings_update" });
   } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    deps.output(deps.errorResponse(command.id, command.type, message));
   }
  })();
  deps.trackBackgroundTask?.(task);
  return undefined;
 }

 return (async () => {
  const response = await deps.handleCommand(command);
  deps.output(response);
  if (response.success && response.command === "set_settings") deps.output({ type: "settings_update" });
 })();
}

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
 #tail: Promise<void> = Promise.resolve();
 #tasks = new Set<Promise<void>>();
 #accepting = true;
 readonly #deps: RpcInputFrameDeps;
 readonly #afterSerialCommand: (() => Promise<void>) | undefined;
 readonly #onShutdownInitiated: (() => void) | undefined;
 readonly #beforeShutdown: (() => Promise<void>) | undefined;

 constructor(options: {
  deps: RpcInputFrameDeps;
  afterSerialCommand?: () => Promise<void>;
  onShutdownInitiated?: () => void;
  beforeShutdown?: () => Promise<void>;
 }) {
  this.#deps = options.deps;
  this.#afterSerialCommand = options.afterSerialCommand;
  this.#onShutdownInitiated = options.onShutdownInitiated;
  this.#beforeShutdown = options.beforeShutdown;
 }

 /** Accept a parsed input frame without blocking the stdin reader. */
 dispatch(parsed: unknown): void {
  try {
   if (dispatchRpcControlFrame(parsed, this.#deps)) return;

   const validation = validateRpcCommand(parsed);
   if (!validation.ok) {
    this.#deps.output(
     this.#deps.errorResponse(validation.id, validation.command, validation.error, validation.code),
    );
    return;
   }
   if (!this.#accepting) {
    this.#deps.output(
     this.#deps.errorResponse(
      validation.command.id,
      validation.command.type,
      "RPC session is shutting down",
      "session_closing",
     ),
    );
    return;
   }
   if (validation.command.type === "session_shutdown") {
    this.#accepting = false;
    this.#onShutdownInitiated?.();
    const serialTail = this.#tail;
    const task = (async () => {
     try {
      await serialTail;
      await this.#beforeShutdown?.();
      const response = await this.#deps.handleCommand(validation.command);
      this.#deps.output(response);
     } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.#deps.output(this.#deps.errorResponse(validation.command.id, validation.command.type, message));
     } finally {
      await this.#afterSerialCommand?.();
     }
    })();
    this.#tasks.add(task);
    void task.finally(() => {
     this.#tasks.delete(task);
    });
    return;
   }
   if (validation.scheduling !== "serial") {
    dispatchRpcInputFrame(validation.command, this.#deps);
    return;
   }

   const task = this.#tail.then(
    () => this.#dispatchSerialCommand(validation.command),
    () => this.#dispatchSerialCommand(validation.command),
   );
   this.#tail = task.catch(() => { });
   this.#tasks.add(task);
   void task.finally(() => {
    this.#tasks.delete(task);
   });
  } catch (err: unknown) {
   const message = err instanceof Error ? err.message : String(err);
   const id = isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : undefined;
   this.#deps.output(this.#deps.errorResponse(id, "parse", `Failed to parse command: ${message}`));
  }
 }

 /** Await every accepted serial command, including commands queued before EOF. */
 async drain(): Promise<void> {
  while (this.#tasks.size > 0) {
   await Promise.allSettled(Array.from(this.#tasks));
  }
 }

 async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
  try {
   const awaited = dispatchRpcInputFrame(command, this.#deps);
   if (awaited) await awaited;
  } catch (err: unknown) {
   const message = err instanceof Error ? err.message : String(err);
   this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
  } finally {
   await this.#afterSerialCommand?.();
  }
 }
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
 #tasks = new Set<Promise<void>>();
 #shutdown: Promise<void> | undefined;
 readonly #isShutdownRequested: () => boolean;
 readonly #performShutdown: () => Promise<void>;

 constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
  this.#isShutdownRequested = options.isShutdownRequested;
  this.#performShutdown = options.performShutdown;
 }

 /**
  * Track a background input task. When it settles it is untracked and the
  * shutdown request is re-checked, so a deferred shutdown fires even when
  * no further client frames arrive.
  */
 track(task: Promise<void>): void {
  this.#tasks.add(task);
  void task.finally(() => {
   this.#tasks.delete(task);
   // Fire-and-forget: performShutdown ends the process. Rejections are
   // not expected — hook errors are caught inside extensionRunner.emit,
   // and background tasks catch their own dispatch errors.
   void this.checkShutdownRequested();
  });
 }

 /** Await every tracked task, including tasks tracked while draining. */
 async drain(): Promise<void> {
  while (this.#tasks.size > 0) {
   await Promise.allSettled(Array.from(this.#tasks));
  }
 }

 /**
  * If shutdown was requested, drain background tasks (so every owed
  * response frame is written) before running the shutdown sequence.
  */
 checkShutdownRequested(): Promise<void> {
  if (!this.#shutdown) {
   if (!this.#isShutdownRequested()) return Promise.resolve();
   this.#shutdown = this.drain().then(() => this.#performShutdown());
  }
  return this.#shutdown;
 }
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
 session: RpcSessionChangeSession,
 command: RpcSessionChangeCommand,
 subagentRegistry?: RpcSubagentResetRegistry,
 beforeCommit?: () => void | Promise<void>,
): Promise<RpcSessionChangeResult> {
 switch (command.type) {
  case "new_session": {
   const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
   const cancelled = !(await session.newSession(options, beforeCommit));
   if (!cancelled) subagentRegistry?.clear();
   return { type: "new_session", data: { cancelled } };
  }

  case "switch_session": {
   const cancelled = !(await session.switchSession(command.sessionPath, beforeCommit));
   if (!cancelled) subagentRegistry?.clear();
   return { type: "switch_session", data: { cancelled } };
  }

  case "branch": {
   const result = await session.branch(command.entryId, beforeCommit);
   if (!result.cancelled) subagentRegistry?.clear();
   return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
  }
 }
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
 return tools.map((tool, index) => {
  const name = typeof tool.name === "string" ? tool.name.trim() : "";
  if (!name) {
   throw new Error(`Host tool at index ${index} must provide a non-empty name`);
  }
  const description = typeof tool.description === "string" ? tool.description.trim() : "";
  if (!description) {
   throw new Error(`Host tool "${name}" must provide a non-empty description`);
  }
  if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
   throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
  }
  const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
  return {
   name,
   label,
   description,
   parameters: tool.parameters,
   hidden: tool.hidden === true,
   loadMode: defaultLoadModeForToolName(name, tool.loadMode),
  };
 });
}

function parseValueDialogResponse(
 response: RpcExtensionUIResponse,
 dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
 if ("cancelled" in response && response.cancelled) {
  if (response.timedOut) dialogOptions?.onTimeout?.();
  return undefined;
 }
 if ("value" in response) return response.value;
 return undefined;
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
 return value === "off" || value === "progress" || value === "events";
}

export function requestRpcEditor(
 pendingRequests: Map<string, PendingExtensionRequest>,
 output: RpcOutput,
 title: string,
 prefill?: string,
 dialogOptions?: ExtensionUIDialogOptions,
 editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
 return requestRpcDialog(
  pendingRequests,
  output,
  dialogOptions,
  undefined,
  {
   method: "editor",
   title,
   prefill,
   promptStyle: editorOptions?.promptStyle,
  },
  response => ("value" in response ? response.value : undefined),
 );
}

/** Sends an RPC extension dialog and cancels the remote presentation when its signal aborts. */
export function requestRpcDialog<T>(
 pendingRequests: Map<string, PendingExtensionRequest>,
 output: RpcOutput,
 opts: ExtensionUIDialogOptions | undefined,
 defaultValue: T,
 request: Record<string, unknown>,
 parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
 if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

 const method = request.method;
 if (
  method !== "select" &&
  method !== "confirm" &&
  method !== "input" &&
  method !== "editor" &&
  method !== "approval" &&
  method !== "ask"
 ) {
  throw new Error("RPC dialog request must declare a supported interactive method");
 }
 const id = Snowflake.next() as string;
 const operationId = typeof request.operationId === "string" ? request.operationId : undefined;
 const emitOutcome = (outcome: RpcInteractionSettledFrame["outcome"]) => {
  output({
   type: "interaction_settled",
   id,
   method,
   ...(operationId ? { operationId } : {}),
   outcome,
  });
 };
 if (pendingRequests instanceof RpcPendingExtensionRequests && !pendingRequests.supports(method)) {
  emitOutcome({
   state: "unsupported",
   message: `RPC host did not negotiate the "${method}" interaction`,
  });
  return Promise.resolve(defaultValue);
 }

 const { promise, resolve, reject } = Promise.withResolvers<T>();
 let timeoutId: NodeJS.Timeout | undefined;
 let settled = false;

 const cleanup = () => {
  clearTimeout(timeoutId);
  opts?.signal?.removeEventListener("abort", onAbort);
  pendingRequests.delete(id);
 };
 const cancelRemote = () => {
  output({
   type: "extension_ui_request",
   id: Snowflake.next() as string,
   method: "cancel",
   targetId: id,
  } as RpcExtensionUIRequest);
 };
 const finish = (value: T, outcome: RpcInteractionSettledFrame["outcome"]) => {
  if (settled) return;
  settled = true;
  cleanup();
  emitOutcome(outcome);
  resolve(value);
 };
 const fail = (cause: Error) => {
  if (settled) return;
  settled = true;
  cleanup();
  emitOutcome({
   state: cause instanceof RpcInteractionDisconnectedError ? "disconnected" : "failed",
   message: cause.message,
  });
  reject(cause);
 };
 const onAbort = () => {
  cancelRemote();
  finish(defaultValue, { state: "cancelled" });
 };
 opts?.signal?.addEventListener("abort", onAbort, { once: true });

 if (opts?.timeout !== undefined) {
  timeoutId = setTimeout(() => {
   opts.onTimeout?.();
   cancelRemote();
   finish(defaultValue, { state: "timed_out" });
  }, opts.timeout);
 }

 const snapshot: RpcPendingInteractionSnapshot = {
  id,
  method,
  startedAt: Date.now(),
  ...(typeof request.title === "string" ? { title: request.title } : {}),
  ...(operationId ? { operationId } : {}),
  sensitive: request.sensitive === true,
  ...(typeof request.toolCallId === "string" ? { toolCallId: request.toolCallId } : {}),
  ...(typeof request.toolName === "string" ? { toolName: request.toolName } : {}),
 };
 pendingRequests.set(id, {
  resolve: response => {
   if (settled) return;
   if ("cancelled" in response && response.cancelled) {
    let value: T;
    try {
     value = parseResponse(response);
    } catch (cause) {
     fail(cause instanceof Error ? cause : new Error(String(cause)));
     return;
    }
    finish(value, { state: response.timedOut ? "timed_out" : "cancelled" });
    return;
   }
   try {
    const value = parseResponse(response);
    finish(value, {
     state: "accepted",
     provenance: "provenance" in response ? (response.provenance ?? "host") : "host",
     ...("decision" in response ? { decision: response.decision } : {}),
    });
   } catch (cause) {
    fail(cause instanceof Error ? cause : new Error(String(cause)));
   }
  },
  reject: fail,
  snapshot,
 });
 if (settled) return promise;
 output({ type: "extension_ui_request", ...request, id } as RpcExtensionUIRequest);
 return promise;
}

type RpcPassiveInteractionCapability = "notification" | "status" | "progress";
type RpcPassiveInteractionRequest = Extract<RpcExtensionUIRequest, { method: "notify" | "setStatus" | "progress" }>;

/** Emits a negotiated one-way host interaction without creating pending response state. */
export function emitRpcPassiveInteraction(
 pendingRequests: Map<string, PendingExtensionRequest>,
 output: RpcOutput,
 capability: RpcPassiveInteractionCapability,
 request: RpcPassiveInteractionRequest,
): boolean {
 if (pendingRequests instanceof RpcPendingExtensionRequests && !pendingRequests.supports(capability)) return false;
 output(request);
 return true;
}

export function requestRpcAgentMutationConfirmation(
 pendingRequests: Map<string, PendingExtensionRequest>,
 output: RpcOutput,
 command: "start_agent" | "cancel_agent" | "release_agent",
 agentId: string,
 tombstone = false,
 timeout = 30_000,
): Promise<boolean> {
 const operationId = Snowflake.next() as string;
 return requestRpcDialog(
  pendingRequests,
  output,
  { timeout },
  false,
  {
   method: "confirm",
   title:
    command === "start_agent"
     ? "Start child agent"
     : command === "cancel_agent"
      ? "Cancel agent"
      : "Release agent",
   message:
    command === "start_agent"
     ? `Start child agent ${agentId}?`
     : command === "cancel_agent"
      ? `Cancel agent ${agentId}?`
      : `Release agent ${agentId} (tombstone: ${tombstone})?`,
   timeout,
   operationId,
   command,
  },
  response => "confirmed" in response && response.confirmed === true && response.operationId === operationId,
 );
}

export function requestRpcPrivilegedConfirmation(
 pendingRequests: Map<string, PendingExtensionRequest>,
 output: RpcOutput,
 command: "eval_execute" | "bash" | "cancel_job" | "delete_session" | "remove_provider_auth",
 title: string,
 message: string,
 options: { operationId?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<boolean> {
 const operationId = options.operationId ?? (Snowflake.next() as string);
 const timeout = options.timeout ?? 30_000;
 return requestRpcDialog(
  pendingRequests,
  output,
  { signal: options.signal, timeout },
  false,
  { method: "confirm", title, message, timeout, operationId, command },
  response => "confirmed" in response && response.confirmed === true && response.operationId === operationId,
 );
}
export type RpcToolActivationSession = Pick<
 AgentSession,
 | "activityPhase"
 | "getActiveToolNames"
 | "getAllToolNames"
 | "getEnabledToolNames"
 | "getMountedXdevToolNames"
 | "getToolInventory"
 | "isCompacting"
 | "isStreaming"
 | "setActiveToolsByName"
>;

export class RpcToolActivationBusyError extends Error {
 constructor() {
  super("Session is busy; tool activation cannot change during active work");
  this.name = "RpcToolActivationBusyError";
 }
}

class RpcSessionTransitionBusyError extends Error {
 constructor() {
  super("Session transition is unavailable while an authentication, mode, or plan operation is committing");
  this.name = "RpcSessionTransitionBusyError";
 }
}

/** Validate and atomically reconcile one session's enabled tool set. */
export async function applyRpcToolActivation(
 session: RpcToolActivationSession,
 command: Extract<RpcCommand, { type: "set_tool_activation" }>,
 hasActiveOperation = false,
): Promise<RpcToolActivationResult> {
 const { activate, deactivate } = validateRpcToolActivationBatch(command, session.getAllToolNames());
 if (hasActiveOperation || session.activityPhase !== "idle" || session.isStreaming || session.isCompacting) {
  throw new RpcToolActivationBusyError();
 }
 const previousEnabled = [...new Set(session.getEnabledToolNames())];
 const deactivateSet = new Set(deactivate);
 const next = previousEnabled.filter(name => !deactivateSet.has(name));
 const nextSet = new Set(next);
 for (const name of activate) {
  if (!nextSet.has(name)) {
   next.push(name);
   nextSet.add(name);
  }
 }

 await session.setActiveToolsByName(next, false);

 const enabledToolNames = [...new Set(session.getEnabledToolNames())];
 const activeToolNames = [...new Set(session.getActiveToolNames())];
 const mountedToolNames = [...new Set(session.getMountedXdevToolNames())];
 const previousSet = new Set(previousEnabled);
 const achievedSet = new Set(enabledToolNames);
 const activated = enabledToolNames.filter(name => !previousSet.has(name));
 const deactivated = previousEnabled.filter(name => !achievedSet.has(name));
 try {
  return {
   enabledToolNames,
   activeToolNames,
   mountedToolNames,
   activated,
   deactivated,
   inventoryAvailable: true,
   inventory: session.getToolInventory(RPC_APPLICATION_API_VERSION),
  };
 } catch (cause) {
  if (!(cause instanceof ToolInventoryUnavailableError)) throw cause;
  return {
   enabledToolNames,
   activeToolNames,
   mountedToolNames,
   activated,
   deactivated,
   inventoryAvailable: false,
  };
 }
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
 session: AgentSession,
 setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
 eventBus?: EventBus,
 input: ReadableStream<Uint8Array> = claimRpcInput(),
 mcpManager?: MCPManager,
): Promise<never> {
 // Signal to RPC clients that the server is ready to accept commands
 // Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
 // process.stdout with no newline, which the reader merges with the next JSON line and
 // breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
 // may write there.
 process.env.PI_NOTIFICATIONS = "off";

 const frameEncoder = new RpcFrameEncoder();
 const getCapabilityFeatures = () => {
  const features = new Set<string>();
  if (eventBus) features.add("subagent-event-bus");
  features.add("agent-control");
  features.add("session-catalog");
  features.add("session-observe");
  features.add("session-execute");
  features.add("context.projection");
  features.add("session-shutdown");
  features.add("interaction");
  features.add("approval");
  features.add("semantic-rendering");
  if (setToolUIContext) {
   features.add("ui");
   features.add("ui.composer-input");
  }
  if (session.sessionManager.getArtifactManager()) features.add("artifact");
  features.add("resource-lifecycle");
  features.add("runtime-provenance");
  features.add("collaboration");
  if (session.asyncJobManager && session.getAgentId()) features.add("job-control");
  if (session.model && serviceTierFamily(session.model)) features.add("model.fast-mode");
  return features;
 };
 const getToolInventoryAvailability = (): boolean => {
  try {
   session.getToolInventory(RPC_APPLICATION_API_VERSION);
   return true;
  } catch (cause) {
   if (cause instanceof ToolInventoryUnavailableError) return false;
   throw cause;
  }
 };
 const getSessionHostManifest = () => getRpcV3CapabilityManifest({ features: getCapabilityFeatures() });
 const getCapabilityManifest = () => {
  const features = getCapabilityFeatures();
  const manifest = getRpcCapabilityManifest({ features, toolInventoryAvailable: getToolInventoryAvailability() });
  manifest.sessionHost = getSessionHostManifest();
  return manifest;
 };
 const capabilityManifest = getCapabilityManifest();
 let selectedFramingVersion = 1;
 let semanticNegotiation:
  | {
   requestKey: string;
   result: SessionHostNegotiated;
  }
  | undefined;
 let negotiatedSemanticContent = new Set<string>();
 // Ordered stdout writer honoring backpressure: chunked v2 frames are produced
 // lazily by the encoder and written one physical line at a time, so a near-limit
 // logical frame never materializes its full base64 transport in memory.
 let stdoutQueue: Promise<void> = Promise.resolve();
 const writeFrames = (frames: Iterable<string>) => {
  stdoutQueue = stdoutQueue
   .then(async () => {
    for (const line of frames) {
     if (!process.stdout.write(line)) await once(process.stdout, "drain");
    }
   })
   // stdout gone (host exited) — nothing left to deliver; keep the queue alive.
   .catch(() => { });
 };
 writeFrames(
  frameEncoder.encodeFrames({
   type: "ready",
   protocolVersion: 1,
   supportedProtocolVersions: [1, 2],
   maxFrameBytes: MAX_RPC_FRAME_BYTES,
   maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
   capabilities: capabilityManifest,
  }),
 );
 let protocolSettled = false;
 const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
  if (protocolSettled) return;
  writeFrames(frameEncoder.encodeFrames(obj));
  if (isRecord(obj) && obj.type === "response" && obj.command === "session_shutdown" && obj.success === true) {
   protocolSettled = true;
  }
  if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true) {
   frameEncoder.setProtocolVersion(2);
   selectedFramingVersion = 2;
  }
 };

 const success = <T extends RpcCommand["type"]>(
  id: string | undefined,
  command: T,
  data?: object | null,
 ): RpcResponse => {
  if (data === undefined) {
   return { id, type: "response", command, success: true } as RpcResponse;
  }
  return { id, type: "response", command, success: true, data } as RpcResponse;
 };

 const error = (
  id: string | undefined,
  command: string,
  message: string,
  code?: string,
  data?: object,
 ): RpcResponse => ({
  id,
  type: "response",
  command,
  success: false,
  error: message,
  ...(code ? { code } : {}),
  ...(data ? { data } : {}),
 });
 const catalogError = (id: string | undefined, command: string, cause: unknown): RpcResponse =>
  cause instanceof SessionCatalogError
   ? error(id, command, cause.message, cause.code)
   : cause instanceof RpcSessionAuthorityError
    ? error(id, command, cause.message, cause.code)
    : cause instanceof RpcSessionTransitionBusyError
     ? error(id, command, cause.message, "session_busy")
     : error(id, command, cause instanceof Error ? cause.message : String(cause));
 const sessionAuthority = new RpcSessionAuthorityCoordinator(() => session.sessionId);
 let callbackAuthorityToken = sessionAuthority.capture();
 const interactiveSurface = new RpcInteractiveSurfaceManager({
  output,
  getAuthority: () => sessionAuthority.captureLifecycleAuthority(),
  getSessionName: () => session.sessionName,
  getCwd: () => session.sessionManager.getCwd(),
 });
 const unsubscribeSessionNameChanged = session.sessionManager.onSessionNameChanged(() =>
  interactiveSurface.sessionNameChanged(),
 );
 const loopScheduler = new SessionLoopScheduler(session, {
  waitForIdle: () => session.waitForIdle(),
  compact: async () => {
   const authority = sessionAuthority.capture();
   await session.compact();
   sessionAuthority.assertCurrent(authority);
  },
  reset: async () => {
   try {
    const started = await session.newSession(undefined, prepareSessionTransition);
    if (!started) throw new Error("Loop could not reset the active session.");
    await completeSessionTransition(undefined, "new_session", { cancelled: false });
   } catch (cause) {
    const cleanupCause = abandonPreparedSessionTransition();
    if (cleanupCause) {
     throw new AggregateError([cause, cleanupCause], "Loop reset and session-transition cleanup failed");
    }
    throw cause;
   }
  },
  prompt: async (prompt, causationId) => {
   const authority = sessionAuthority.capture();
   await session.prompt(prompt, { ...(causationId === undefined ? {} : { messageTag: causationId }) });
   sessionAuthority.assertCurrent(authority);
   await waitForQueuedRpcPrompt(session);
   sessionAuthority.assertCurrent(authority);
  },
  onStateChange: (state, causationId) => {
   if (!sessionAuthority.isCurrent(callbackAuthorityToken)) return;
   output({
    type: "loop_state_update",
    state,
    ...(causationId === undefined ? {} : { causationId }),
   });
  },
  onError: cause => {
   if (!sessionAuthority.isCurrent(callbackAuthorityToken)) return;
   output({
    type: "loop_error",
    error: cause instanceof Error ? cause.message : String(cause),
    state: session.getLoopState(),
   });
  },
 });
 const startRpcPrompt = (prompt: string, options: PromptOptions): Promise<boolean> => {
  options.signal?.throwIfAborted();
  const loopState = session.getLoopState();
  const loopEnabled = loopState.enabled;
  if (loopEnabled) {
   if (loopState.phase === "paused") session.resumeLoop(prompt);
   else session.captureLoopPrompt(prompt);
   output({
    type: "loop_state_update",
    state: session.getLoopState(),
    ...(options.messageTag === undefined ? {} : { causationId: options.messageTag }),
   });
  }
  const task = session.prompt(prompt, options);
  if (loopEnabled) loopScheduler.request(options.messageTag);
  return task;
 };
 const startRpcUserPrompt = (prompt: string, options: PromptOptions): Promise<boolean> => {
  session.maybeStartTitleGeneration(prompt);
  return startRpcPrompt(prompt, options);
 };
 const operationOwnership = new RpcOperationMessageOwnership(session);
 const rpcEvalOperationIds = new Set<string>();
 const rpcEvalConfirmationControllers = new Map<string, AbortController>();
 const rpcEvalTasks = new Set<Promise<void>>();
 const pendingRpcBashConfirmations = new Set<AbortController>();
 const rpcBashExecutions = new Set<Promise<unknown>>();
 const operationManager = new RpcOperationManager(frame => {
  if (frame.type !== "operation_started") operationOwnership.settle(frame.operationId);
  if (frame.type !== "operation_started") {
   rpcEvalOperationIds.delete(frame.operationId);
   rpcEvalConfirmationControllers.get(frame.operationId)?.abort();
   rpcEvalConfirmationControllers.delete(frame.operationId);
  }
  output(frame);
 });
 const planApprovalOperations = new Map<string, string>();

 const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

 const pendingExtensionRequests = new RpcPendingExtensionRequests();
 const hostToolBridge = new RpcHostToolBridge(output);
 const hostUriBridge = new RpcHostUriBridge(output);
 const subagentRegistry = eventBus
  ? new RpcSubagentRegistry(eventBus, frame => {
   if (sessionAuthority.isCurrent(callbackAuthorityToken)) output(frame);
  })
  : undefined;
 const sessionStorage = new FileSessionStorage();
 let providerAuthService = new ProviderAuthService(session.modelRegistry, session.sessionId);
 let rpcTaskTracker: (task: Promise<void>) => void = task => {
  void task;
 };
 const createProviderAuthController = () => {
  const controllerAuthority = sessionAuthority.capture();
  return new ProviderAuthController(
   providerAuthService,
   operationManager,
   frame => {
    if (sessionAuthority.isCurrent(controllerAuthority)) output(frame);
   },
   task => rpcTaskTracker(task),
   async request => {
    sessionAuthority.assertCurrent(controllerAuthority);
    const response = await requestRpcDialog(
     pendingExtensionRequests,
     output,
     { signal: request.signal },
     undefined,
     {
      method: "input",
      title: request.prompt,
      placeholder: request.placeholder,
      sensitive: true,
      operationId: request.operationId,
      purpose: "provider_auth",
      providerId: request.providerId,
     },
     result => ("value" in result ? result.value : undefined),
    );
    sessionAuthority.assertCurrent(controllerAuthority);
    return response;
   },
  );
 };
 let providerAuthController = createProviderAuthController();
 const agentSenderId = session.getAgentId?.() ?? MAIN_AGENT_ID;
 const agentRegistry = AgentRegistry.global();
 const agentLifecycle = AgentLifecycleManager.global();
 const agentControl = new AgentControlService({
  session: { agentRegistry, agentLifecycle: () => agentLifecycle },
  registry: agentRegistry,
  lifecycle: agentLifecycle,
  senderId: agentSenderId,
  settings: session.settings,
  projectResult: agentId => {
   const job = session.asyncJobManager?.getJob(agentId);
   if (!job || (job.ownerId !== undefined && job.ownerId !== agentSenderId)) return undefined;
   return {
    status: job.status,
    resultText: job.resultText,
    errorText: job.errorText,
   };
  },
 });
 const unsubscribeAgentRegistry = agentControl.onRegistryUpdate(update => {
  if (sessionAuthority.isCurrent(callbackAuthorityToken)) output({ type: "agent_registry_update", ...update });
 });
 const rpcJobOwnerId = session.getAgentId();
 const jobProjection =
  session.asyncJobManager && rpcJobOwnerId
   ? new JobProjectionService({
    manager: session.asyncJobManager,
    ownerId: rpcJobOwnerId,
    registry: AgentRegistry.global(),
    lifecycle: AgentLifecycleManager.global(),
   })
   : undefined;

 // Shutdown request flag (wrapped in object to allow mutation with const)
 const shutdownState = { requested: false };

 /**
  * Extension UI context that uses the RPC protocol.
  */
 class RpcExtensionUIContext implements ExtensionUIContext {
  constructor(
   private pendingRequests: Map<string, PendingExtensionRequest>,
   private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
  ) { }

  select(
   title: string,
   options: ExtensionUISelectItem[],
   dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
   return requestRpcDialog(
    this.pendingRequests,
    this.output,
    dialogOptions,
    undefined,
    {
     method: "select",
     title,
     options: options.map(getExtensionUISelectOptionLabel),
     timeout: dialogOptions?.timeout,
    },
    response => parseValueDialogResponse(response, dialogOptions),
   );
  }

  confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
   return requestRpcDialog(
    this.pendingRequests,
    this.output,
    dialogOptions,
    false,
    { method: "confirm", title, message, timeout: dialogOptions?.timeout },
    response => {
     if ("cancelled" in response && response.cancelled) {
      if (response.timedOut) dialogOptions?.onTimeout?.();
      return false;
     }
     if ("confirmed" in response) return response.confirmed;
     return false;
    },
   );
  }

  requestApproval(
   request: ExtensionToolApprovalRequest,
   dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<ExtensionToolApprovalDecision> {
   return requestRpcDialog(
    this.pendingRequests,
    this.output,
    dialogOptions,
    { approved: false, provenance: "host", reason: "Approval was not accepted by the RPC host" },
    { method: "approval", ...request },
    response => {
     if ("decision" in response) {
      return {
       approved: response.decision === "approve",
       provenance: response.provenance ?? "host",
       ...(response.decision === "deny" ? { reason: "denied by user" } : {}),
      };
     }
     return {
      approved: false,
      provenance: "host",
      reason: "cancelled" in response && response.timedOut ? "approval timed out" : "approval cancelled",
     };
    },
   );
  }

  askDialog(
   questions: ExtensionAskDialogQuestion[],
   dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<ExtensionAskDialogResult | undefined> {
   return requestRpcDialog(
    this.pendingRequests,
    this.output,
    dialogOptions,
    undefined,
    { method: "ask", questions, timeout: dialogOptions?.timeout },
    response => {
     if ("result" in response) return response.result;
     if ("cancelled" in response && response.timedOut) dialogOptions?.onTimeout?.();
     return undefined;
    },
   );
  }

  input(
   title: string,
   placeholder?: string,
   dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
   return requestRpcDialog(
    this.pendingRequests,
    this.output,
    dialogOptions,
    undefined,
    { method: "input", title, placeholder, timeout: dialogOptions?.timeout },
    response => parseValueDialogResponse(response, dialogOptions),
   );
  }

  onTerminalInput(handler: TerminalInputHandler): () => void {
   return interactiveSurface.onTerminalInput(handler);
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
   emitRpcPassiveInteraction(this.pendingRequests, this.output, "notification", {
    type: "extension_ui_request",
    id: Snowflake.next() as string,
    method: "notify",
    message,
    notifyType: type,
   });
  }

  setStatus(key: string, text: string | undefined): void {
   emitRpcPassiveInteraction(this.pendingRequests, this.output, "status", {
    type: "extension_ui_request",
    id: Snowflake.next() as string,
    method: "setStatus",
    statusKey: key,
    statusText: text,
   });
  }

  setWorkingMessage(message?: string): void {
   emitRpcPassiveInteraction(this.pendingRequests, this.output, "progress", {
    type: "extension_ui_request",
    id: Snowflake.next() as string,
    method: "progress",
    message,
   });
  }

  setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void {
   interactiveSurface.setWidget(key, content, options);
  }

  setFooter(factory: ExtensionUiComponentFactory | undefined): void {
   interactiveSurface.setFooter(factory);
  }

  setHeader(factory: ExtensionUiComponentFactory | undefined): void {
   interactiveSurface.setHeader(factory);
  }

  setTitle(title: string): void {
   interactiveSurface.setTitle(title);
  }

  custom<T>(
   factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
   ) => ExtensionUiComponent | Promise<ExtensionUiComponent>,
   options?: { overlay?: boolean },
  ): Promise<T> {
   return interactiveSurface.custom(factory, options);
  }

  pasteToEditor(text: string): void {
   interactiveSurface.pasteFromExtension(text);
  }

  setEditorText(text: string): void {
   interactiveSurface.setEditorText(text);
  }

  getEditorText(): string {
   return interactiveSurface.getEditorText();
  }

  async editor(
   title: string,
   prefill?: string,
   dialogOptions?: ExtensionUIDialogOptions,
   editorOptions?: { promptStyle?: boolean },
  ): Promise<string | undefined> {
   return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
  }

  addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
   interactiveSurface.addAutocompleteProvider(factory);
  }

  get theme(): Theme {
   return theme;
  }

  getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
   return interactiveSurface.getAllThemes();
  }

  getTheme(name: string): Promise<Theme | undefined> {
   return interactiveSurface.getTheme(name);
  }

  setTheme(value: string | Theme): Promise<{ success: boolean; error?: string }> {
   return interactiveSurface.setExtensionTheme(value);
  }

  getToolsExpanded(): boolean {
   return interactiveSurface.getToolsExpanded();
  }

  setToolsExpanded(expanded: boolean): void {
   interactiveSurface.setToolsExpanded(expanded);
  }

  setEditorComponent(
   factory: ((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => CustomEditor) | undefined,
  ): void {
   interactiveSurface.setEditorComponent(factory);
  }
 }

 // Wire up UI context for tool execution (ask tool, etc.) and extensions.
 // A single shared instance routes all responses received on stdin to the
 // correct waiting promise regardless of which code path created the request.
 const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
 setToolUIContext?.(rpcUiContext, true);

 // Set up extensions with RPC-based UI context
 await initializeExtensions(session, {
  reportSendError: (action, err) => {
   output(error(undefined, action, err.message));
  },
  reportRuntimeError: err => {
   output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
  },
  onShutdown: () => {
   shutdownState.requested = true;
  },
  trackAgentInvokingMessage: task => {
   extensionUserMessageTracker.trackAgentMessageTask(task);
  },
  uiContext: rpcUiContext,
 });
 const availableCommands = await buildAvailableSlashCommands(session);
 const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map(command => command.name));
 const autocompleteCommands = [
  ...BUILTIN_SLASH_COMMANDS,
  ...availableCommands
   .filter(command => !builtinNames.has(command.name))
   .map(command => ({
    name: command.name,
    aliases: command.aliases,
    description: command.description,
    argumentHint: command.input?.hint,
   })),
 ];
 interactiveSurface.configureAutocomplete(autocompleteCommands, session.sessionManager.getCwd());
 const semanticRendering = new RpcSemanticRenderingManager(output);
 const provenanceSource: RpcProvenanceSource = {
  get model() {
   return session.model;
  },
  get serviceTierByFamily() {
   return session.serviceTierByFamily;
  },
  get messages() {
   return session.messages;
  },
  getActiveRole: () => session.sessionManager.getLastModelChangeRole() ?? "default",
  getRecoverySnapshot: () => session.getRecoverySnapshot(),
  fetchUsageReports: signal => session.fetchUsageReports(signal),
  subscribe: listener => session.subscribe(listener),
 };
 const provenance = new RpcProvenanceManager(provenanceSource, frame => {
  if (sessionAuthority.isCurrent(callbackAuthorityToken)) output(frame);
 });
 let collaborationAuthorityTransition: RpcCollaborationAuthorityTransition | undefined;
 const collaboration = new RpcCollaborationManager({
  factory: new RpcCollaborationTransportFactoryImpl(session, eventBus),
  media: new RpcCollaborationSessionMediaStore(
   () => session.sessionManager.getArtifactManager() ?? undefined,
   () => session.sessionId,
  ),
  getSessionId: () => session.sessionId,
  getSessionAuthority: () => sessionAuthority.captureLifecycleAuthority(),
  transitionAuthority: (captureAuthority, applyAuthority, installAuthority) => {
   const transition = collaborationAuthorityTransition;
   return transition
    ? transition(captureAuthority, applyAuthority, installAuthority)
    : Promise.reject(new RpcCollaborationStateError("Collaboration authority transition is unavailable"));
  },
  output: frame => output(frame),
 });
 const semanticToolRenderIds = new Map<string, string>();
 const semanticRenderingEnabled = (): boolean =>
  negotiatedSemanticContent.size > 0 &&
  semanticNegotiation?.result.capabilities.some(
   capability => capability.id === "semantic-rendering" && capability.supported,
  ) === true;

 // Output all agent events as JSON
 let lastQueueFrame = "";
 const emitQueueUpdate = () => {
  if (!sessionAuthority.isCurrent(callbackAuthorityToken)) return;
  const queue = session.getQueueSnapshot();
  const serialized = JSON.stringify(queue);
  if (serialized === lastQueueFrame) return;
  lastQueueFrame = serialized;
  output({ type: "queue_update", queue });
 };
 session.subscribe(event => {
  if (!sessionAuthority.isCurrent(callbackAuthorityToken)) return;
  if (event.type === "message_start") {
   const operationId = operationOwnership.observeMessageStart(event.message);
   if (operationId !== undefined) operationManager.beginById(operationId);
  }
  output(event);
  if (
   semanticRenderingEnabled() &&
   (event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end")
  ) {
   try {
    const projection = projectRpcToolSemantic(event, session.extensionRunner?.getAllRegisteredTools() ?? []);
    const adapted = adaptSemanticRenderResultToHost(projection, negotiatedSemanticContent);
    const registration = { source: projection.source, ...adapted };
    const existingRenderId = semanticToolRenderIds.get(event.toolCallId);
    if (!existingRenderId || !semanticRendering.update(existingRenderId, registration)) {
     semanticToolRenderIds.set(event.toolCallId, semanticRendering.register(registration));
    }
   } catch (cause) {
    output({
     type: "extension_error",
     extensionPath: "semantic-rendering",
     event: event.type,
     error: cause instanceof Error ? cause.message : String(cause),
    });
   }
  }
  emitQueueUpdate();
 });
 session.planMode.onStateChange(state => {
  if (!sessionAuthority.isCurrent(callbackAuthorityToken)) return;
  output({ type: "plan_state_update", state });
 });
 session.planMode.onApprovalRequest(approval => {
  if (!sessionAuthority.isCurrent(callbackAuthorityToken)) return;
  output({
   type: "plan_approval_request",
   approvalId: approval.approvalId,
   planFilePath: approval.planFilePath,
   title: approval.title,
   planContent: approval.planContent,
  });
 });
 session.planMode.onApprovalSettled(result => {
  if (!sessionAuthority.isCurrent(callbackAuthorityToken)) return;
  output({ type: "plan_approval_settled", approvalId: result.approvalId, result });
 });
 const emitJobUpdate = () => {
  if (!sessionAuthority.isCurrent(callbackAuthorityToken)) return;
  const snapshot = jobProjection?.list();
  if (snapshot) output({ type: "job_update", ...snapshot });
 };
 const unsubscribeJobUpdates = jobProjection?.subscribe(emitJobUpdate);

 const getAvailableCommands = async () => buildAvailableSlashCommands(session);
 const getAdvisorState = () => session.getAdvisorStateOverview();
 const getRpcSessionState = async (): Promise<RpcSessionState> => ({
  mode: session.planMode.mode,
  plan: await session.planMode.project(),
  model: session.model,
  thinkingLevel: session.thinkingLevel,
  configuredThinkingLevel: session.configuredThinkingLevel(),
  isStreaming: session.isStreaming,
  activityPhase: session.activityPhase,
  isCompacting: session.isCompacting,
  steeringMode: session.steeringMode,
  followUpMode: session.followUpMode,
  interruptMode: session.interruptMode,
  sessionFile: session.sessionFile,
  sessionId: session.sessionId,
  sessionName: session.sessionName,
  autoCompactionEnabled: session.autoCompactionEnabled,
  queuedMessageCount: session.queuedMessageCount,
  todoPhases: session.getTodoPhases(),
  fastModeEnabled: session.isFastModeEnabled(),
  tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
  fastModeActive: session.isFastModeActive(),
  messageCount: session.messages.length,
  systemPrompt: session.systemPrompt,
  dumpTools: session.agent.state.tools.map(tool => ({
   name: tool.name,
   description: tool.description,
   parameters: toolWireSchema(tool),
   examples: tool.examples,
  })),
  contextUsage: session.getContextUsage(),
  advisor: getAdvisorState(),
 });
 let executeRpcCommand: (command: RpcCommand) => Promise<RpcResponse>;
 let rpcSessionHost: RpcSessionHostAdapter | undefined;
 const ensureRpcSessionHost = (): RpcSessionHostAdapter => {
  if (rpcSessionHost) return rpcSessionHost;
  const authority = new AgentSessionAuthority(session, {
   snapshotState: async () => {
    const snapshotAuthority = sessionAuthority.capture();
    const operations = operationManager.snapshot();
    const sessionState = await getRpcSessionState();
    sessionAuthority.assertCurrent(snapshotAuthority);
    const execution = await projectRpcSessionExecution(session, {
     applicationApiVersion: RPC_APPLICATION_API_VERSION,
     operations,
     pendingInteractions: pendingExtensionRequests.snapshot(),
    });
    sessionAuthority.assertCurrent(snapshotAuthority);
    return {
     session: sessionState,
     sessionTree: {
      sessionId: session.sessionId,
      leafId: session.sessionManager.getLeafId(),
      roots: projectSessionTree(session.sessionManager.getTree(), session.sessionManager.getLeafId()),
     },
     execution,
     operations,
     agents: agentControl.list({ includeAdvisors: true }),
     subagents: subagentRegistry?.getSubagents() ?? [],
     jobs: jobProjection?.list() ?? null,
     resources: resourceLifecycle?.snapshot() ?? null,
     provenance: provenance.snapshot(),
    } as unknown as SessionJsonValue;
   },
   invoke: createRpcSessionCommandInvoker({
    execute: command => executeRpcCommand(command),
    waitForSettlement: operationId => operationManager.waitForSettlement(operationId),
    cancelOperation: operationId => {
     void executeRpcCommand({
      id: Snowflake.next() as string,
      type: "cancel_operation",
      operationId,
     });
    },
   }),
   settle: async () => {
    session.disableLoop();
    const loopSettled = loopScheduler.dispose();
    const activeOperations = operationManager.snapshot().active;
    const providerOperationIds = new Set(
     activeOperations
      .filter(operation => operation.command === "provider_auth")
      .map(operation => operation.operationId),
    );
    const protectedOperations = new Set(providerAuthController.close());
    for (const operationId of protectedCommitOperationIds()) protectedOperations.add(operationId);
    pendingExtensionRequests.rejectAll("RPC session is shutting down");
    hostToolBridge.close("RPC session is shutting down");
    hostUriBridge.clear("RPC session is shutting down");
    operationManager.cancelAll("shutdown", "session_shutdown", protectedOperations);
    await quiesceCancelledImplementations(providerOperationIds, "RPC session shutdown");
    await Promise.all(
     Array.from(protectedOperations, operationId => operationManager.waitForSettlement(operationId)),
    );
    await loopSettled;
    await session.planMode.abandonPendingApproval();
    semanticRendering.dispose();
    await resourceLifecycle?.dispose();
    provenance.dispose();
    await collaboration.dispose();
    unsubscribeAgentRegistry();
    unsubscribeJobUpdates?.();
    subagentRegistry?.dispose();
    await session.dispose();
    return { state: "settled" };
   },
  });
  const limits = getSessionHostManifest().limits;
  rpcSessionHost = new RpcSessionHostAdapter(
   new SessionHost(authority, { maxBufferedObservations: limits.maxPendingObservations }),
   {
    output: frame => output(frame),
   },
  );
  return rpcSessionHost;
 };
 const emitConfigUpdate = () => {
  output({
   type: "config_update",
   model: session.model,
   thinkingLevel: session.thinkingLevel,
   configuredThinkingLevel: session.configuredThinkingLevel(),
   advisor: getAdvisorState(),
  });
 };
 const reloadPluginState = async (authority: RpcSessionAuthorityToken = callbackAuthorityToken) => {
  const cwd = session.sessionManager.getCwd();
  const projectPath = await resolveActiveProjectRegistryPath(cwd);
  sessionAuthority.assertCurrent(authority);
  clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
  resetCapabilities();
  await session.refreshSkills();
  sessionAuthority.assertCurrent(authority);
  if (mcpManager) {
   await reloadMcpResources({
    session,
    manager: mcpManager,
    enableProjectConfig: session.settings.get("mcp.enableProjectConfig") ?? true,
    browserEnabled: session.settings.get("browser.enabled") ?? false,
   });
   sessionAuthority.assertCurrent(authority);
  }
  const commands = await loadSlashCommands({ cwd });
  sessionAuthority.assertCurrent(authority);
  session.setSlashCommands(commands);
  await emitAvailableCommandsUpdate(authority);
 };
 const runtimeResourceSource = new RpcRuntimeResourceSource(() => session.sessionManager.getCwd(), mcpManager);
 const resourceLifecycle = new RpcResourceLifecycleManager(runtimeResourceSource, frame => {
  if (sessionAuthority.isCurrent(callbackAuthorityToken)) output(frame);
 });
 const emitAvailableCommandsUpdate = async (authority: RpcSessionAuthorityToken = callbackAuthorityToken) => {
  const commands = await getAvailableCommands();
  if (sessionAuthority.isCurrent(authority)) output({ type: "available_commands_update", commands });
 };
 session.subscribeCommandMetadataChanged(() => {
  if (sessionAuthority.isCurrent(callbackAuthorityToken)) void emitAvailableCommandsUpdate();
 });
 session.subscribeToolInventoryChanged(() => {
  if (sessionAuthority.isCurrent(callbackAuthorityToken)) output({ type: "tool_inventory_update" });
 });
 await emitAvailableCommandsUpdate();
 emitQueueUpdate();
 emitJobUpdate();

 const protectedCommitOperationIds = (): Set<string> => {
  const protectedOperations = new Set(providerAuthController.protectedOperationIds());
  for (const operation of operationManager.snapshot().active) {
   if (
    operation.status === "started" &&
    (operation.command === "set_mode" || operation.command === "resolve_plan_approval")
   ) {
    protectedOperations.add(operation.operationId);
   }
  }
  return protectedOperations;
 };
 let activeSessionTransition: RpcSessionTransitionToken | undefined;
 let resourcesDrainedForTransition = false;
 let sessionTransitionAuthorityInvalidationRequired = false;
 const settleQuiescentCancellations = (excludedOperationIds: ReadonlySet<string> = new Set()): void => {
  for (const operation of operationManager.snapshot().active) {
   if (operation.status === "cancelling" && !excludedOperationIds.has(operation.operationId)) {
    operationManager.settleCancellation(operation.operationId);
   }
  }
 };
 const quiesceCancelledImplementations = async (
  providerOperationIds: ReadonlySet<string>,
  abortReason: string,
 ): Promise<void> => {
  const failures: unknown[] = [];
  for (const controller of pendingRpcBashConfirmations) {
   try {
    controller.abort();
   } catch (cause) {
    failures.push(cause);
   }
  }
  try {
   session.abortBash();
  } catch (cause) {
   failures.push(cause);
  }
  for (const operationId of rpcEvalOperationIds) {
   try {
    session.abortEvalExecution(operationId);
   } catch (cause) {
    failures.push(cause);
   }
  }
  if (session.isStreaming) {
   try {
    await session.abort({ reason: abortReason });
   } catch (cause) {
    failures.push(cause);
   }
  }
  const implementationResults = await Promise.allSettled([...rpcEvalTasks, ...rpcBashExecutions]);
  for (const result of implementationResults) {
   if (result.status === "rejected") failures.push(result.reason);
  }
  let idle = false;
  try {
   await session.waitForIdle();
   idle = true;
  } catch (cause) {
   failures.push(cause);
  }
  if (idle) settleQuiescentCancellations(providerOperationIds);
  const providerResults = await Promise.allSettled(
   Array.from(providerOperationIds, operationId => operationManager.waitForSettlement(operationId)),
  );
  for (const result of providerResults) {
   if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length > 0) throw new AggregateError(failures, "Failed to quiesce cancelled RPC operations");
 };
 const abandonPreparedSessionTransition = (): unknown | undefined => {
  const transition = activeSessionTransition;
  if (!transition) return undefined;
  let authority: RpcSessionAuthorityToken;
  if (sessionTransitionAuthorityInvalidationRequired) {
   authority = sessionAuthority.invalidateSessionTransitionAuthority(transition);
  } else {
   sessionAuthority.failSessionTransition(transition);
   authority = sessionAuthority.capture();
  }
  activeSessionTransition = undefined;
  sessionTransitionAuthorityInvalidationRequired = false;
  callbackAuthorityToken = authority;
  interactiveSurface.rebindAuthority(
   authority,
   authority.sessionId !== transition.sessionId || authority.sessionGeneration !== transition.sessionGeneration,
  );
  providerAuthService = new ProviderAuthService(session.modelRegistry, session.sessionId);
  providerAuthController = createProviderAuthController();
  if (!resourcesDrainedForTransition) return undefined;
  try {
   resourceLifecycle.rebind(runtimeResourceSource);
   resourcesDrainedForTransition = false;
   return undefined;
  } catch (cause) {
   return cause;
  }
 };
 const prepareSessionTransition = async (): Promise<void> => {
  const transition = sessionAuthority.beginSessionTransition();
  activeSessionTransition = transition;
  callbackAuthorityToken = transition;
  resourcesDrainedForTransition = false;
  sessionTransitionAuthorityInvalidationRequired = false;
  try {
   if (providerAuthController.hasMutationInFlight()) throw new RpcSessionTransitionBusyError();
   const protectedOperations = protectedCommitOperationIds();
   if (protectedOperations.size > 0) throw new RpcSessionTransitionBusyError();
   sessionTransitionAuthorityInvalidationRequired = true;
   const activeOperations = operationManager.snapshot().active;
   for (const operation of activeOperations) {
    if (operation.status === "accepted") session.removeQueuedMessagesByTag(operation.operationId);
   }
   const providerOperationIds = new Set(
    activeOperations
     .filter(operation => operation.command === "provider_auth")
     .map(operation => operation.operationId),
   );
   const providerProtected = providerAuthController.cancelAll("session_transition", "session_changed");
   if (providerProtected.size > 0) throw new RpcSessionTransitionBusyError();
   operationManager.cancelAll("session_transition", "session_changed");
   await collaboration.leave("session_transition");
   await resourceLifecycle.drain();
   resourcesDrainedForTransition = true;
   await quiesceCancelledImplementations(providerOperationIds, USER_INTERRUPT_LABEL);
   await rpcSessionHost?.disconnect();
   rpcSessionHost = undefined;
  } catch (cause) {
   const cleanupCause = abandonPreparedSessionTransition();
   if (cleanupCause) {
    throw new AggregateError([cause, cleanupCause], "Session preparation and cleanup failed");
   }
   throw cause;
  }
 };
 const completeSessionTransition = async <T extends { cancelled: boolean }>(
  id: string | undefined,
  command: RpcCommand["type"],
  data: T,
 ): Promise<RpcResponse> => {
  const transition = activeSessionTransition;
  let responseAuthority: RpcSessionAuthorityToken;
  if (transition) {
   if (data.cancelled) {
    if (sessionTransitionAuthorityInvalidationRequired) {
     responseAuthority = sessionAuthority.invalidateSessionTransitionAuthority(transition);
    } else {
     sessionAuthority.failSessionTransition(transition);
     responseAuthority = sessionAuthority.capture();
    }
   } else {
    responseAuthority = sessionAuthority.completeSessionTransition(transition);
   }
   activeSessionTransition = undefined;
   sessionTransitionAuthorityInvalidationRequired = false;
   if (resourcesDrainedForTransition) {
    resourceLifecycle.rebind(runtimeResourceSource);
    resourcesDrainedForTransition = false;
   }
   providerAuthService = new ProviderAuthService(session.modelRegistry, session.sessionId);
   callbackAuthorityToken = responseAuthority;
   providerAuthController = createProviderAuthController();
   interactiveSurface.rebindAuthority(
    responseAuthority,
    responseAuthority.sessionId !== transition.sessionId ||
    responseAuthority.sessionGeneration !== transition.sessionGeneration,
   );
  } else {
   responseAuthority = sessionAuthority.capture();
  }
  if (!data.cancelled) {
   session.contextProjection.reset(session.sessionId, session.sessionManager.getLeafId());
   output({
    type: "session_info_update",
    title: session.sessionName,
    sessionId: session.sessionId,
    mode: session.planMode.mode,
   });
   emitQueueUpdate();
   emitConfigUpdate();
   output({ type: "tool_inventory_update" });
   await emitAvailableCommandsUpdate(responseAuthority);
   sessionAuthority.assertCurrent(responseAuthority);
  }
  return success(id, command, data);
 };
 const quiesceExecutionAuthorityOperations = async (): Promise<void> => {
  const protectedOperations = protectedCommitOperationIds();
  if (protectedOperations.size > 0) {
   await Promise.all(
    Array.from(protectedOperations, operationId => operationManager.waitForSettlement(operationId)),
   );
  }
  const activeOperations = operationManager.snapshot().active;
  const providerOperationIds = new Set(
   activeOperations
    .filter(operation => operation.command === "provider_auth")
    .map(operation => operation.operationId),
  );
  for (const operation of activeOperations) {
   if (operation.status === "accepted") session.removeQueuedMessagesByTag(operation.operationId);
  }
  providerAuthController.cancelAll("session_transition", "session_changed");
  operationManager.cancelAll("session_transition", "session_changed", protectedOperations);
  await quiesceCancelledImplementations(providerOperationIds, USER_INTERRUPT_LABEL);
 };
 const commitExecutionAuthorityTransition = (
  transition: RpcExecutionAuthorityTransitionToken,
 ): RpcSessionAuthorityToken => {
  const authority = sessionAuthority.completeExecutionAuthorityTransition(transition);
  callbackAuthorityToken = authority;
  providerAuthController = createProviderAuthController();
  interactiveSurface.rebindAuthority(authority, false);
  return authority;
 };
 const failExecutionAuthorityTransition = (transition: RpcExecutionAuthorityTransitionToken): void => {
  sessionAuthority.failExecutionAuthorityTransition(transition);
  callbackAuthorityToken = sessionAuthority.capture();
 };
 let authorityTransitionRunning = false;
 const pendingAuthorityTransitions: Array<() => void> = [];
 const serializeAuthorityTransition = <T>(transition: () => Promise<T>): Promise<T> => {
  const deferred = Promise.withResolvers<T>();
  const start = (): void => {
   authorityTransitionRunning = true;
   const finish = (settle: () => void): void => {
    const next = pendingAuthorityTransitions.shift();
    if (next) next();
    else authorityTransitionRunning = false;
    settle();
   };
   let work: Promise<T>;
   try {
    work = transition();
   } catch (cause) {
    finish(() => deferred.reject(cause));
    return;
   }
   void work.then(
    value => finish(() => deferred.resolve(value)),
    cause => finish(() => deferred.reject(cause)),
   );
  };
  if (authorityTransitionRunning) pendingAuthorityTransitions.push(start);
  else start();
  return deferred.promise;
 };
 const transitionExecutionAuthority = (): Promise<RpcSessionAuthorityToken> =>
  serializeAuthorityTransition(async () => {
   if (providerAuthController.hasMutationInFlight()) throw new RpcSessionTransitionBusyError();
   const collaborationToken = collaboration.getLifecycleToken();
   if (collaborationToken && !collaboration.isLifecycleTokenCurrent(collaborationToken)) {
    throw new RpcCollaborationStateError("Collaboration authority is stale");
   }
   const transition = sessionAuthority.beginExecutionAuthorityTransition();
   callbackAuthorityToken = transition;
   try {
    await quiesceExecutionAuthorityOperations();
    const authority = commitExecutionAuthorityTransition(transition);
    if (collaborationToken) collaboration.replaceAuthorityToken(collaborationToken, authority);
    return authority;
   } catch (cause) {
    if (sessionAuthority.transitioning) failExecutionAuthorityTransition(transition);
    throw cause;
   }
  });
 const transitionCollaborationLeave = <T>(effect: () => Promise<T>): Promise<T> =>
  serializeAuthorityTransition(async () => {
   if (providerAuthController.hasMutationInFlight()) throw new RpcSessionTransitionBusyError();
   const transition = sessionAuthority.beginExecutionAuthorityTransition();
   callbackAuthorityToken = transition;
   try {
    const result = await effect();
    await quiesceExecutionAuthorityOperations();
    commitExecutionAuthorityTransition(transition);
    return result;
   } catch (cause) {
    failExecutionAuthorityTransition(transition);
    throw cause;
   }
  });
 const transitionCollaborationAuthority = <T>(
  effect: (commitAuthority: RpcCollaborationAuthorityCommit) => Promise<T>,
 ): Promise<T> =>
  serializeAuthorityTransition(async () => {
   if (providerAuthController.hasMutationInFlight()) throw new RpcSessionTransitionBusyError();
   const transition = sessionAuthority.beginExecutionAuthorityTransition();
   callbackAuthorityToken = transition;
   let committed = false;
   const commitAuthority = (expected: RpcCollaborationSessionAuthority): RpcSessionAuthorityToken => {
    if (committed)
     throw new RpcSessionAuthorityError("authority_changed", "Authority transition was already committed");
    if (
     expected.sessionId !== transition.sessionId ||
     expected.sessionGeneration !== transition.sessionGeneration ||
     expected.authorityGeneration !== transition.authorityGeneration
    ) {
     throw new RpcSessionAuthorityError(
      "authority_changed",
      "Collaboration authority changed during the transition",
     );
    }
    const authority = commitExecutionAuthorityTransition(transition);
    committed = true;
    return authority;
   };
   try {
    await quiesceExecutionAuthorityOperations();
    const result = await effect(commitAuthority);
    if (!committed) {
     throw new RpcSessionAuthorityError("authority_changed", "Collaboration authority was not committed");
    }
    return result;
   } catch (cause) {
    if (!committed) failExecutionAuthorityTransition(transition);
    throw cause;
   }
  });
 collaborationAuthorityTransition = (captureAuthority, applyAuthority, installAuthority) =>
  serializeAuthorityTransition(async () => {
   const expected = captureAuthority();
   const transition = sessionAuthority.beginExecutionAuthorityTransition();
   callbackAuthorityToken = transition;
   if (
    expected.sessionId !== transition.sessionId ||
    expected.sessionGeneration !== transition.sessionGeneration ||
    expected.authorityGeneration !== transition.authorityGeneration
   ) {
    failExecutionAuthorityTransition(transition);
    throw new RpcSessionAuthorityError("authority_changed", "Collaboration authority callback is stale");
   }
   try {
    applyAuthority();
   } catch (cause) {
    failExecutionAuthorityTransition(transition);
    throw cause;
   }
   let cleanupFailure: unknown;
   try {
    await quiesceExecutionAuthorityOperations();
   } catch (cause) {
    cleanupFailure = cause;
   }
   const authority = commitExecutionAuthorityTransition(transition);
   installAuthority(authority);
   if (cleanupFailure !== undefined) {
    output(
     error(
      undefined,
      "collaboration_authority",
      cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure),
      "authority_cleanup_failed",
     ),
    );
   }
  });
 let toolActivationInFlight = false;
 const confirmAgentMutation = (
  command: "start_agent" | "cancel_agent" | "release_agent",
  agentId: string,
  tombstone = false,
 ): Promise<boolean> =>
  requestRpcAgentMutationConfirmation(pendingExtensionRequests, output, command, agentId, tombstone);
 const hasNegotiatedCapability = (capabilityId: string): boolean =>
  semanticNegotiation?.result.capabilities.some(
   capability => capability.id === capabilityId && capability.supported,
  ) === true;
 const negotiatedCapabilityByFeature: Readonly<Record<string, string>> = {
  "session-observe": "session.observe",
  "session-catalog": "session.catalog",
  "session-execute": "session.execute",
  "session-shutdown": "session.shutdown",
  "semantic-rendering": "semantic-rendering",
  artifact: "artifact.read",
  "resource-lifecycle": "resource.lifecycle",
  "runtime-provenance": "runtime-provenance",
  collaboration: "collaboration",
  "context.projection": "context.projection",
  ui: "ui",
 };
 const guardCommandFeatures = (command: RpcCommand): RpcResponse | undefined => {
  const availableFeatures = getCapabilityFeatures();
  const requiredFeatures =
   command.type === "session_invoke"
    ? getRpcCommandRequiredFeatures(command.type).map(feature =>
     feature === "session-execute" &&
      getRpcSessionCommandCapability(command.command.kind) === "session.catalog"
      ? "session-catalog"
      : feature,
    )
    : getRpcCommandRequiredFeatures(command.type);
  for (const feature of requiredFeatures) {
   if (feature === "model.fast-mode" && command.type === "set_fast_mode" && !command.enabled) {
    continue;
   }
   if (!availableFeatures.has(feature)) {
    return error(
     command.id,
     command.type,
     `Required RPC feature is unavailable: ${feature}`,
     "feature_unavailable",
    );
   }
   const capabilityId = negotiatedCapabilityByFeature[feature];
   if (capabilityId && !hasNegotiatedCapability(capabilityId)) {
    return error(
     command.id,
     command.type,
     `RPC v3 capability was not negotiated: ${capabilityId}`,
     "capability_not_negotiated",
    );
   }
  }
  return undefined;
 };
 const collaborationGuestCommands = new Set<RpcCommand["type"]>([
  "get_capabilities",
  "initialize",
  "session_shutdown",
  "collaboration_get",
  "collaboration_leave",
  "collaboration_acknowledge",
  "collaboration_read_media",
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "abort_and_prompt",
 ]);

 const collaborationFailure = (id: string | undefined, command: RpcCommand["type"], cause: unknown): RpcResponse => {
  if (cause instanceof RpcSessionAuthorityError) return error(id, command, cause.message, cause.code);
  if (cause instanceof RpcSessionTransitionBusyError) return error(id, command, cause.message, "session_busy");
  if (cause instanceof RpcCollaborationAuthorityError || cause instanceof RpcCollaborationStateError) {
   return error(id, command, cause.message, cause.code);
  }
  if (
   cause instanceof ArtifactNotFoundError ||
   cause instanceof ArtifactRangeError ||
   cause instanceof ArtifactHashMismatchError
  ) {
   return error(id, command, cause.message, cause.code);
  }
  return error(id, command, "Collaboration operation failed", "collaboration_operation_failed");
 };

 // Handle a single command
 const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
  const id = command.id;
  const commandAuthority = sessionAuthority.capture();
  await collaboration.assertSessionIsolation();
  sessionAuthority.assertCurrent(commandAuthority);
  const featureFailure = guardCommandFeatures(command);
  if (featureFailure) return featureFailure;
  const collaborationSnapshot = collaboration.snapshot();
  if (collaborationSnapshot.role === "guest" && !collaborationGuestCommands.has(command.type)) {
   return error(
    id,
    command.type,
    "Local session mutation is unavailable while joined to a collaboration replica",
    "collaboration_authority_denied",
   );
  }

  switch (command.type) {
   case "negotiate_protocol": {
    if (command.protocolVersion !== 2)
     return error(id, "negotiate_protocol", `Unsupported RPC protocol version: ${command.protocolVersion}`);
    return success(id, "negotiate_protocol", { protocolVersion: 2 });
   }

   case "get_capabilities":
    return success(id, "get_capabilities", getCapabilityManifest());

   case "initialize": {
    const requestKey = JSON.stringify({
     profile: command.profile,
     framingVersion: command.framingVersion,
     hostCapabilities: command.hostCapabilities,
     requestedCapabilities: command.requestedCapabilities,
    });
    if (semanticNegotiation) {
     if (semanticNegotiation.requestKey !== requestKey) {
      return error(
       id,
       "initialize",
       "RPC v3 semantic profile is already initialized with different capabilities",
       "invalid_request_state",
      );
     }
     return success(id, "initialize", semanticNegotiation.result);
    }
    if (command.framingVersion !== selectedFramingVersion) {
     return success(id, "initialize", {
      ok: false,
      code: "framing_not_selected",
      message: `RPC framing version ${command.framingVersion} must be selected before semantic initialization`,
      supportedProfiles: [SESSION_SEMANTIC_PROFILE],
     });
    }
    const sessionHostManifest = getSessionHostManifest();
    const result = negotiateSessionHost(sessionHostManifest, {
     profile: command.profile,
     framingVersion: command.framingVersion,
     hostCapabilities: command.hostCapabilities,
     requestedCapabilities: command.requestedCapabilities,
    });
    if (result.ok) {
     semanticNegotiation = { requestKey, result };
     negotiatedSemanticContent = new Set(command.hostCapabilities.semanticContent);
     pendingExtensionRequests.configureHostCapabilities(command.hostCapabilities.interactions);
    }
    return success(id, "initialize", result);
   }

   case "semantic_action": {
    const settled = await semanticRendering.invoke(
     command.renderId,
     command.actionId,
     command.input,
     command.id,
    );
    return success(id, "semantic_action", settled);
   }

   case "semantic_cancel": {
    return success(id, "semantic_cancel", {
     cancelled: semanticRendering.cancel(command.renderId, command.actionId),
    });
   }

   case "artifact_describe": {
    const manager = session.sessionManager.getArtifactManager();
    if (!manager)
     return error(id, "artifact_describe", "Artifact storage is unavailable", "artifact_unavailable");
    try {
     const described = await manager.describe(command.artifactId);
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "artifact_describe", described);
    } catch (cause) {
     if (cause instanceof ArtifactNotFoundError) {
      return error(id, "artifact_describe", cause.message, cause.code);
     }
     throw cause;
    }
   }

   case "artifact_read": {
    const manager = session.sessionManager.getArtifactManager();
    if (!manager) return error(id, "artifact_read", "Artifact storage is unavailable", "artifact_unavailable");
    try {
     const range = await manager.readRange(command.artifactId, {
      offset: command.offset ?? 0,
      length: command.length ?? MAX_ARTIFACT_RANGE_BYTES,
     });
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "artifact_read", range);
    } catch (cause) {
     if (cause instanceof ArtifactNotFoundError || cause instanceof ArtifactRangeError) {
      return error(id, "artifact_read", cause.message, cause.code);
     }
     throw cause;
    }
   }

   case "artifact_export": {
    const manager = session.sessionManager.getArtifactManager();
    if (!manager)
     return error(id, "artifact_export", "Artifact storage is unavailable", "artifact_unavailable");
    try {
     const exported = await manager.exportTo(command.artifactId, {
      exportRoot: session.sessionManager.getCwd(),
      destination: command.destination,
      expectedSha256: command.expectedSha256,
     });
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "artifact_export", exported);
    } catch (cause) {
     if (
      cause instanceof ArtifactNotFoundError ||
      cause instanceof ArtifactHashMismatchError ||
      cause instanceof ArtifactExportPathError
     ) {
      return error(id, "artifact_export", cause.message, cause.code);
     }
     throw cause;
    }
   }
   case "resource_list": {
    if (!resourceLifecycle) {
     return error(id, "resource_list", "Resource management is unavailable", "resource_unavailable");
    }
    return success(id, "resource_list", resourceLifecycle.snapshot());
   }

   case "resource_refresh": {
    if (!resourceLifecycle) {
     return error(id, "resource_refresh", "Resource management is unavailable", "resource_unavailable");
    }
    try {
     return success(id, "resource_refresh", resourceLifecycle.startRefresh(command.serverId, id));
    } catch (cause) {
     if (cause instanceof RpcResourceNotFoundError) {
      return error(id, "resource_refresh", cause.message, cause.code);
     }
     throw cause;
    }
   }

   case "resource_reload": {
    if (!resourceLifecycle) {
     return error(id, "resource_reload", "Resource management is unavailable", "resource_unavailable");
    }
    const reload = async () => {
     sessionAuthority.assertCurrent(commandAuthority);
     await reloadPluginState(commandAuthority);
     sessionAuthority.assertCurrent(commandAuthority);
    };
    return success(id, "resource_reload", resourceLifecycle.startReload(reload, id));
   }

   case "resource_cancel": {
    if (!resourceLifecycle) {
     return error(id, "resource_cancel", "Resource management is unavailable", "resource_unavailable");
    }
    return success(id, "resource_cancel", { cancelled: resourceLifecycle.cancel(command.operationId) });
   }

   case "resource_dispose": {
    if (!resourceLifecycle) {
     return error(id, "resource_dispose", "Resource management is unavailable", "resource_unavailable");
    }
    try {
     const disposed = await resourceLifecycle.disposeServer(command.serverId, id);
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "resource_dispose", disposed);
    } catch (cause) {
     if (cause instanceof RpcResourceNotFoundError) {
      return error(id, "resource_dispose", cause.message, cause.code);
     }
     throw cause;
    }
   }
   case "provenance_get": {
    const provenanceSnapshot =
     command.refreshUsage === true ? await provenance.refresh() : provenance.snapshot();
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "provenance_get", provenanceSnapshot);
   }
   case "collaboration_get":
    return success(id, "collaboration_get", collaboration.snapshot());
   case "collaboration_host": {
    try {
     const collaborationAuthority = await transitionExecutionAuthority();
     const state = await collaboration.host({ relayUrl: command.relayUrl, webUrl: command.webUrl });
     sessionAuthority.assertCurrent(collaborationAuthority);
     return success(id, "collaboration_host", state);
    } catch (cause) {
     return collaborationFailure(id, "collaboration_host", cause);
    }
   }
   case "collaboration_join": {
    try {
     const collaborationAuthority = await transitionExecutionAuthority();
     const state = await collaboration.join({ link: command.link, displayName: command.displayName });
     sessionAuthority.assertCurrent(collaborationAuthority);
     return success(id, "collaboration_join", state);
    } catch (cause) {
     return collaborationFailure(id, "collaboration_join", cause);
    }
   }
   case "collaboration_leave":
    try {
     const state = await transitionCollaborationLeave(() => collaboration.leave(command.reason));
     return success(id, "collaboration_leave", state);
    } catch (cause) {
     return collaborationFailure(id, "collaboration_leave", cause);
    }
   case "collaboration_revoke":
    try {
     const state = await transitionCollaborationAuthority(commitAuthority =>
      collaboration.revoke(command.participantId, commitAuthority),
     );
     return success(id, "collaboration_revoke", state);
    } catch (cause) {
     return collaborationFailure(id, "collaboration_revoke", cause);
    }
   case "collaboration_rotate":
    try {
     const state = await transitionCollaborationAuthority(commitAuthority =>
      collaboration.rotate(commitAuthority),
     );
     return success(id, "collaboration_rotate", state);
    } catch (cause) {
     return collaborationFailure(id, "collaboration_rotate", cause);
    }
   case "collaboration_acknowledge":
    try {
     return success(
      id,
      "collaboration_acknowledge",
      collaboration.acknowledge({ generation: command.generation, sequence: command.sequence }),
     );
    } catch (cause) {
     return collaborationFailure(id, "collaboration_acknowledge", cause);
    }
   case "collaboration_read_media":
    try {
     const media = await collaboration.readMedia(command.mediaId, command.offset, command.length);
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "collaboration_read_media", media);
    } catch (cause) {
     return collaborationFailure(id, "collaboration_read_media", cause);
    }
   case "context_get": {
    const sessionId = session.sessionId;
    const leafId = session.sessionManager.getLeafId();
    let snapshot = session.contextProjection.read();
    if (snapshot.sessionId !== sessionId || snapshot.leafId !== leafId) {
     session.contextProjection.reset(sessionId, leafId);
     snapshot = session.contextProjection.read();
    }
    sessionAuthority.assertCurrent(commandAuthority);
    return success(
     id,
     "context_get",
     projectBoundedRpcContext(snapshot, {
      maxSources: command.maxSources,
      maxRelations: command.maxRelations,
      maxContentBytes: command.maxContentBytes,
     }),
    );
   }

   case "ui_open":
    return success(
     id,
     "ui_open",
     interactiveSurface.open(command.terminalId, {
      width: command.width,
      subscriptions: command.subscriptions,
     }),
    );
   case "ui_close":
    interactiveSurface.close(command.channelId, command.generation);
    return success(id, "ui_close");
   case "ui_input":
    return success(
     id,
     "ui_input",
     interactiveSurface.input(command.channelId, command.generation, command.data),
    );
   case "ui_editor_update":
    return success(
     id,
     "ui_editor_update",
     interactiveSurface.updateEditor(
      command.channelId,
      command.generation,
      command.expectedRevision,
      command.text,
     ),
    );
   case "ui_editor_paste":
    return success(
     id,
     "ui_editor_paste",
     interactiveSurface.pasteEditor(
      command.channelId,
      command.generation,
      command.expectedRevision,
      command.text,
     ),
    );
   case "ui_editor_submit": {
    let editor;
    try {
     editor = interactiveSurface.prepareEditorSubmit(
      command.channelId,
      command.generation,
      command.expectedRevision,
     );
    } catch (cause) {
     if (!(cause instanceof RpcInteractiveSurfaceError)) throw cause;
     return success(id, "ui_editor_submit", {
      accepted: false,
      disposition: "no_op",
      editor: interactiveSurface.getAuthoritativeEditor(),
     });
    }
    let operationId: string | undefined;
    const invokePrompt = async (
     message: string,
     streamingBehavior: "steer" | "followUp",
    ): Promise<boolean> => {
     const response = await handleCommand({
      id: Snowflake.next() as string,
      type: "prompt",
      message,
      images: command.images,
      streamingBehavior,
     });
     if (!response.success || response.command !== "prompt" || !response.data.accepted) return false;
     operationId = response.data.operationId;
     return true;
    };
    try {
     const router = new ComposerInputRouter({
      isFocusedAgent: false,
      isStreaming: session.isStreaming,
      queuedMessageCount: session.queuedMessageCount,
      isCompacting: session.isCompacting,
      isCollabGuest: collaborationSnapshot.role === "guest",
      isCollabReadOnly: collaborationSnapshot.authority !== "full",
      expandEmoticons: true,
     }, {
      abortQueued: async () => {
       const response = await handleCommand({ id: Snowflake.next() as string, type: "abort" });
       if (!response.success) throw new Error(response.error);
      },
      continue: async () => invokePrompt(manualContinuePrompt, "steer"),
      queue: async (body, draft) => {
       const messages = splitQueuedMessages(body);
       const queue = messages.length > 0 ? messages : draft.images?.length ? [""] : [];
       if (queue.length === 0) return false;
       if (!(await invokePrompt(queue[0] ?? "", "followUp"))) return false;
       for (const message of queue.slice(1)) {
        const response = await handleCommand({
         id: Snowflake.next() as string,
         type: "follow_up",
         message,
        });
        if (!response.success) return false;
       }
       return true;
      },
      dispatch: async (draft, mode) => {
       const accepted = await invokePrompt(draft.text, mode === "followUp" ? "followUp" : "steer");
       if (!accepted) throw new Error("Prompt dispatch was rejected");
       if (mode === "followUp") return "follow_up";
       return session.isStreaming ? "steer" : "prompt";
      },
     });
     const routed = await router.submit({ text: editor.text, images: command.images }, command.mode);
     if (!routed.accepted) {
      return success(id, "ui_editor_submit", {
       accepted: false,
       disposition: routed.disposition,
       editor: interactiveSurface.getAuthoritativeEditor(),
      });
     }
     const submittedEditor =
      routed.disposition === "no_op" ? interactiveSurface.getAuthoritativeEditor() : interactiveSurface.clearSubmittedEditor();
     return success(id, "ui_editor_submit", {
      accepted: true,
      disposition: routed.disposition,
      editor: submittedEditor,
      ...(operationId === undefined ? {} : { operationId }),
     });
    } catch (cause) {
     return success(id, "ui_editor_submit", {
      accepted: false,
      disposition: "no_op",
      editor: interactiveSurface.getAuthoritativeEditor(),
     });
    }
   }
   case "ui_autocomplete_suggest":
    return success(
     id,
     "ui_autocomplete_suggest",
     await interactiveSurface.suggest(
      command.id,
      command.channelId,
      command.generation,
      command.lines,
      command.cursorLine,
      command.cursorCol,
      command.forceFile,
     ),
    );
   case "ui_autocomplete_apply":
    return success(
     id,
     "ui_autocomplete_apply",
     interactiveSurface.applySuggestion(command.channelId, command.generation, command.suggestionId),
    );
   case "ui_cancel":
    return success(id, "ui_cancel", {
     cancelled: interactiveSurface.cancelAutocomplete(
      command.channelId,
      command.generation,
      command.operationId,
     ),
    });
   case "ui_presentation_input":
    return success(
     id,
     "ui_presentation_input",
     interactiveSurface.presentationInput(
      command.channelId,
      command.generation,
      command.presentationId,
      command.data,
     ),
    );
   case "ui_presentation_action":
    interactiveSurface.cancelPresentation(command.channelId, command.generation, command.presentationId);
    return success(id, "ui_presentation_action");
   case "ui_theme_list":
    return success(id, "ui_theme_list", {
     themes: await interactiveSurface.listThemes(command.channelId, command.generation),
    });
   case "ui_theme_get":
    return success(id, "ui_theme_get", {
     theme: await interactiveSurface.getThemeInfo(command.channelId, command.generation, command.name),
    });
   case "ui_theme_set":
    return success(id, "ui_theme_set", {
     theme: await interactiveSurface.setThemeName(command.channelId, command.generation, command.name),
    });
   case "ui_tools_expanded_set":
    return success(
     id,
     "ui_tools_expanded_set",
     interactiveSurface.setToolsExpandedFromClient(command.channelId, command.generation, command.expanded),
    );
   case "ui_title_subscribe":
    return success(
     id,
     "ui_title_subscribe",
     interactiveSurface.setTitleSubscription(command.channelId, command.generation, command.subscribed),
    );

   case "session_open": {
    try {
     const opened = await ensureRpcSessionHost().open({
      ...(command.after === undefined ? {} : { after: command.after }),
      ...(command.afterCursor === undefined ? {} : { afterCursor: command.afterCursor }),
      ...(command.snapshot === undefined ? {} : { snapshot: command.snapshot }),
     });
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "session_open", opened);
    } catch (cause) {
     if (cause instanceof SessionCursorError) {
      return error(id, "session_open", cause.message, cause.code);
     }
     throw cause;
    }
   }

   case "session_ack": {
    try {
     await ensureRpcSessionHost().acknowledge(command.subscriptionId, command.sequence);
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "session_ack");
    } catch (cause) {
     if (cause instanceof RpcSessionSubscriptionNotFoundError) {
      return error(id, "session_ack", cause.message, cause.code);
     }
     return error(
      id,
      "session_ack",
      cause instanceof Error ? cause.message : String(cause),
      "invalid_acknowledgement",
     );
    }
   }

   case "session_unsubscribe": {
    try {
     await ensureRpcSessionHost().unsubscribe(command.subscriptionId);
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "session_unsubscribe");
    } catch (cause) {
     if (cause instanceof RpcSessionSubscriptionNotFoundError) {
      return error(id, "session_unsubscribe", cause.message, cause.code);
     }
     throw cause;
    }
   }

   case "session_invoke": {
    const outcome = await ensureRpcSessionHost().invoke(command.command, { requestId: command.id });
    // The nested command owns its authority fence and may intentionally transition the active session.
    return success(id, "session_invoke", outcome);
   }

   case "session_shutdown": {
    shutdownState.requested = true;
    const settled = await ensureRpcSessionHost().shutdown();
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "session_shutdown", settled);
   }

   // =================================================================
   // Prompting
   // =================================================================

   case "prompt": {
    if (collaborationSnapshot.role === "guest") {
     if (collaborationSnapshot.authority !== "full") {
      return error(
       id,
       "prompt",
       "Collaboration guest access is read-only",
       "collaboration_authority_denied",
      );
     }
     const operation = operationManager.start(id, "prompt");
     setImmediate(() => {
      if (!sessionAuthority.isCurrent(commandAuthority) || !operationManager.begin(operation)) return;
      try {
       collaboration.sendPrompt(command.message, command.images);
       if (!sessionAuthority.isCurrent(commandAuthority)) return;
       output({ type: "prompt_result", id, operationId: operation.operationId, agentInvoked: true });
       operationManager.complete(operation, true);
      } catch (cause) {
       if (!sessionAuthority.isCurrent(commandAuthority)) return;
       operationManager.fail(
        operation,
        cause instanceof Error ? cause : new Error(String(cause)),
        "collaboration_prompt_failed",
       );
      }
     });
     return success(id, "prompt", { operationId: operation.operationId, accepted: true });
    }
    const operation = operationManager.start(id, "prompt");
    setImmediate(() => {
     if (!operationManager.canContinue(operation)) return;
     const preparationController = new AbortController();
     const preparationTask = (async () => {
      const skillResult = await tryRunRpcSkillCommand(
       session,
       command.message,
       command.streamingBehavior,
       operation.operationId,
       preparationController.signal,
      );
      if (!sessionAuthority.isCurrent(commandAuthority)) return;
      if (!operationManager.canContinue(operation)) return;
      if (skillResult) {
       void reportLocalOnlyPromptResult({
        id,
        prompt: Promise.resolve(true),
        output,
        onError: () => { },
        isAuthorityCurrent: () => sessionAuthority.isCurrent(commandAuthority),
        operation: {
         handle: operation,
         manager: operationManager,
         waitForAgentCompletion: () => waitForQueuedRpcPrompt(session),
        },
       });
       return;
      }
      const builtinResult = await executeAcpBuiltinSlashCommand(command.message, {
       session,
       sessionManager: session.sessionManager,
       settings: session.settings,
       cwd: session.sessionManager.getCwd(),
       output: text => {
        if (sessionAuthority.isCurrent(commandAuthority)) output({ type: "command_output", text });
       },
       refreshCommands: () => {
        if (sessionAuthority.isCurrent(commandAuthority)) emitAvailableCommandsUpdate();
       },
       reloadPlugins: async () => {
        sessionAuthority.assertCurrent(commandAuthority);
        await reloadPluginState(commandAuthority);
        sessionAuthority.assertCurrent(commandAuthority);
       },
       notifyTitleChanged: async () => {
        if (!sessionAuthority.isCurrent(commandAuthority)) return;
        output({
         type: "session_info_update",
         title: session.sessionName,
         sessionId: session.sessionId,
         mode: session.planMode.mode,
        });
       },
       notifyConfigChanged: async () => {
        if (sessionAuthority.isCurrent(commandAuthority)) emitConfigUpdate();
       },
      });
      sessionAuthority.assertCurrent(commandAuthority);
      if (!operationManager.canContinue(operation)) return;
      if (builtinResult !== false) {
       if ("prompt" in builtinResult) {
        const trackedPrompt = watchAndReportLocalOnlyPromptResult({
         id,
         startPrompt: () =>
          startRpcUserPrompt(builtinResult.prompt, {
           images: command.images,
           messageTag: operation.operationId,
           signal: preparationController.signal,
          }),
         output,
         onError: () => { },
         extensionUserMessageTracker,
         isAuthorityCurrent: () => sessionAuthority.isCurrent(commandAuthority),
         operation: {
          handle: operation,
          manager: operationManager,
          waitForAgentCompletion: () => waitForQueuedRpcPrompt(session),
         },
        });
        void trackedPrompt.lifecycle;
        await trackedPrompt.scheduling.catch(() => undefined);
        return;
       }
       output({ type: "prompt_result", id, operationId: operation.operationId, agentInvoked: false });
       operationManager.complete(operation, false);
       return;
      }

      const trackedPrompt = watchAndReportLocalOnlyPromptResult({
       id,
       startPrompt: () =>
        startRpcUserPrompt(command.message, {
         images: command.images,
         streamingBehavior: command.streamingBehavior,
         messageTag: operation.operationId,
         signal: preparationController.signal,
        }),
       output,
       onError: () => { },
       extensionUserMessageTracker,
       isAuthorityCurrent: () => sessionAuthority.isCurrent(commandAuthority),
       operation: {
        handle: operation,
        manager: operationManager,
        waitForAgentCompletion: () => waitForQueuedRpcPrompt(session),
       },
      });
      void trackedPrompt.lifecycle;
      await trackedPrompt.scheduling.catch(() => undefined);
     })().catch(promptError => {
      if (!sessionAuthority.isCurrent(commandAuthority)) return;
      operationManager.fail(
       operation,
       promptError instanceof Error ? promptError : new Error(String(promptError)),
       promptError instanceof RpcSessionAuthorityError ? promptError.code : "prompt_scheduling_failed",
      );
     });
     operationOwnership.trackPreparation(operation.operationId, preparationController, preparationTask);
    });
    return success(id, "prompt", { operationId: operation.operationId, accepted: true });
   }

   case "steer": {
    if (collaborationSnapshot.role === "guest") {
     try {
      collaboration.sendPrompt(command.message, command.images);
      return success(id, "steer");
     } catch (cause) {
      return collaborationFailure(id, "steer", cause);
     }
    }
    if (toolActivationInFlight) {
     return error(id, "steer", "Session tool activation is in progress", "session_busy");
    }
    await session.steer(command.message, command.images);
    sessionAuthority.assertCurrent(commandAuthority);
    emitQueueUpdate();
    return success(id, "steer");
   }

   case "follow_up": {
    if (collaborationSnapshot.role === "guest") {
     try {
      collaboration.sendPrompt(command.message, command.images);
      return success(id, "follow_up");
     } catch (cause) {
      return collaborationFailure(id, "follow_up", cause);
     }
    }
    if (toolActivationInFlight) {
     return error(id, "follow_up", "Session tool activation is in progress", "session_busy");
    }
    await session.followUp(command.message, command.images);
    sessionAuthority.assertCurrent(commandAuthority);
    emitQueueUpdate();
    return success(id, "follow_up");
   }

   case "abort": {
    if (collaborationSnapshot.role === "guest") {
     try {
      collaboration.sendAbort();
      return success(id, "abort");
     } catch (cause) {
      return collaborationFailure(id, "abort", cause);
     }
    }
    const activeOperations = operationManager.snapshot().active;
    const providerOperationIds = new Set(
     activeOperations
      .filter(operation => operation.command === "provider_auth")
      .map(operation => operation.operationId),
    );
    const protectedOperations = protectedCommitOperationIds();
    for (const operationId of providerAuthController.cancelAll("user", "cancelled_by_client")) {
     protectedOperations.add(operationId);
    }
    operationManager.cancelAll("user", "cancelled_by_client", protectedOperations);
    await quiesceCancelledImplementations(providerOperationIds, USER_INTERRUPT_LABEL);
    sessionAuthority.assertCurrent(commandAuthority);
    emitQueueUpdate();
    return success(id, "abort");
   }

   case "abort_and_prompt": {
    if (collaborationSnapshot.role === "guest") {
     if (collaborationSnapshot.authority !== "full") {
      return error(
       id,
       "abort_and_prompt",
       "Collaboration guest access is read-only",
       "collaboration_authority_denied",
      );
     }
     const operation = operationManager.start(id, "abort_and_prompt");
     setImmediate(() => {
      if (!sessionAuthority.isCurrent(commandAuthority) || !operationManager.begin(operation)) return;
      try {
       collaboration.sendAbort();
       collaboration.sendPrompt(command.message, command.images);
       if (!sessionAuthority.isCurrent(commandAuthority)) return;
       output({ type: "prompt_result", id, operationId: operation.operationId, agentInvoked: true });
       operationManager.complete(operation, true);
      } catch (cause) {
       if (!sessionAuthority.isCurrent(commandAuthority)) return;
       operationManager.fail(
        operation,
        cause instanceof Error ? cause : new Error(String(cause)),
        "collaboration_prompt_failed",
       );
      }
     });
     return success(id, "abort_and_prompt", { operationId: operation.operationId, accepted: true });
    }
    if (toolActivationInFlight) {
     return error(id, "abort_and_prompt", "Session tool activation is in progress", "session_busy");
    }
    const protectedOperations = protectedCommitOperationIds();
    if (protectedOperations.size > 0) {
     return error(id, "abort_and_prompt", "Session state commit is in progress", "session_busy");
    }
    const providerOperationIds = new Set(
     operationManager
      .snapshot()
      .active.filter(operation => operation.command === "provider_auth")
      .map(operation => operation.operationId),
    );
    const providerProtected = providerAuthController.cancelAll("replaced", "replaced_by_prompt");
    if (providerProtected.size > 0) {
     return error(id, "abort_and_prompt", "Session state commit is in progress", "session_busy");
    }
    operationManager.cancelAll("replaced", "replaced_by_prompt");
    const operation = operationManager.start(id, "abort_and_prompt");
    setImmediate(() => {
     if (!sessionAuthority.isCurrent(commandAuthority) || !operationManager.begin(operation)) return;
     void (async () => {
      await quiesceCancelledImplementations(providerOperationIds, USER_INTERRUPT_LABEL);
      if (!sessionAuthority.isCurrent(commandAuthority)) return;
      if (!operationManager.isActive(operation)) return;
      watchAndReportLocalOnlyPromptResult({
       id,
       startPrompt: () =>
        startRpcUserPrompt(command.message, {
         images: command.images,
         messageTag: operation.operationId,
        }),
       output,
       onError: () => { },
       extensionUserMessageTracker,
       isAuthorityCurrent: () => sessionAuthority.isCurrent(commandAuthority),
       operation: {
        handle: operation,
        manager: operationManager,
        waitForAgentCompletion: () => waitForQueuedRpcPrompt(session),
       },
      });
     })().catch(promptError => {
      if (!sessionAuthority.isCurrent(commandAuthority)) return;
      operationManager.fail(
       operation,
       promptError instanceof Error ? promptError : new Error(String(promptError)),
       promptError instanceof RpcSessionAuthorityError ? promptError.code : "prompt_scheduling_failed",
      );
     });
    });
    return success(id, "abort_and_prompt", { operationId: operation.operationId, accepted: true });
   }

   case "cancel_operation": {
    const activeOperation = operationManager
     .snapshot()
     .active.find(operation => operation.operationId === command.operationId);
    if (
     activeOperation?.status === "started" &&
     (activeOperation.command === "set_mode" || activeOperation.command === "resolve_plan_approval")
    ) {
     return error(
      id,
      "cancel_operation",
      "Mode and plan operations cannot be cancelled after their commit phase starts",
      "operation_commit_in_progress",
     );
    }
    const approvalId = planApprovalOperations.get(command.operationId);
    if (approvalId) {
     planApprovalOperations.delete(command.operationId);
     const pending = session.planMode.pendingApproval;
     if (pending?.approvalId === approvalId) {
      await session.planMode.abandonPendingApproval();
      sessionAuthority.assertCurrent(commandAuthority);
     }
    }
    const providerCancellation = providerAuthController.cancel(command.operationId);
    if (providerCancellation === "cancelled") {
     return success(id, "cancel_operation", operationManager.cancel(command.operationId).result);
    }
    if (providerCancellation === "protected") {
     return error(
      id,
      "cancel_operation",
      "Provider authentication credentials are already being committed",
      "provider_auth_commit_in_progress",
     );
    }
    const isRpcEval = rpcEvalOperationIds.has(command.operationId);
    if (isRpcEval) {
     const cancellation = operationManager.cancel(command.operationId);
     rpcEvalConfirmationControllers.get(command.operationId)?.abort();
     if (cancellation.wasStarted) session.abortEvalExecution(command.operationId);
     return success(id, "cancel_operation", cancellation.result);
    }
    const cancellation = await operationOwnership.cancel(operationManager, command.operationId);
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "cancel_operation", cancellation);
   }

   case "resume_session": {
    if (session.isStreaming || session.isCompacting) {
     return error(
      id,
      "resume_session",
      "Session mutation is unavailable while the session is busy",
      "session_busy",
     );
    }
    try {
     const previousCwd = session.sessionManager.getCwd();
     const resolved = await resolveSessionCatalogReference(
      command.session,
      { scope: command.scope ?? (command.cwd ? "cwd" : "all"), cwd: command.cwd },
      sessionStorage,
     );
     sessionAuthority.assertCurrent(commandAuthority);
     const switched = await handleRpcSessionChange(
      session,
      { type: "switch_session", sessionPath: resolved.entry.path },
      subagentRegistry,
      prepareSessionTransition,
     );
     const cwd = session.sessionManager.getCwd();
     const sessionFile = session.sessionManager.getSessionFile();
     const data: RpcResumeSessionResult = {
      cancelled: switched.data.cancelled,
      ...(sessionFile ? { sessionFile } : {}),
      cwd,
      cwdChanged: !switched.data.cancelled && path.resolve(cwd) !== path.resolve(previousCwd),
     };
     return completeSessionTransition(id, "resume_session", data);
    } catch (cause) {
     return catalogError(id, "resume_session", cause);
    }
   }

   case "eval_execute": {
    if (toolActivationInFlight) {
     return error(
      id,
      "eval_execute",
      "Eval execution is unavailable while tool activation is in progress",
      "session_busy",
     );
    }
    const operation = operationManager.start(id, "eval_execute");
    rpcEvalOperationIds.add(operation.operationId);
    const confirmationController = new AbortController();
    rpcEvalConfirmationControllers.set(operation.operationId, confirmationController);
    const { promise: task, resolve: resolveTask } = Promise.withResolvers<void>();
    rpcEvalTasks.add(task);
    void task.finally(() => {
     rpcEvalTasks.delete(task);
    });
    setImmediate(() => {
     if (!operationManager.begin(operation)) {
      resolveTask();
      return;
     }
     void (async () => {
      const confirmed = await requestRpcPrivilegedConfirmation(
       pendingExtensionRequests,
       output,
       "eval_execute",
       "Run eval code?",
       `Language: ${command.language}\n\n${command.code}`,
       { operationId: operation.operationId, signal: confirmationController.signal },
      );
      if (!operationManager.isActive(operation)) return;
      if (!confirmed) {
       operationManager.fail(
        operation,
        new Error("Eval execution was not confirmed"),
        "confirmation_denied",
       );
       return;
      }
      sessionAuthority.assertCurrent(commandAuthority);

      const evalOutput = new RpcEvalOutputStream(
       operation.operationId,
       () => sessionAuthority.isCurrent(commandAuthority) && operationManager.isActive(operation),
       output,
      );
      const registeredEvalTool = session.getEvalToolForHost();
      if (!(registeredEvalTool instanceof EvalTool)) throw new Error("Eval tool is unavailable");
      const evalTool = registeredEvalTool;
      const result = await evalTool.withExecutionId(operation.operationId).execute(
       operation.operationId,
       {
        language: command.language,
        code: command.code,
        title: command.title,
        timeout: command.timeout,
        reset: command.reset,
       },
       undefined,
       update => {
        const text =
         update.details?.cells
          .map((cell: NonNullable<EvalToolDetails["cells"]>[number]) => cell.output.trim())
          .filter(Boolean)
          .join("\n\n") ?? "";
        evalOutput.push(text);
       },
      );
      sessionAuthority.assertCurrent(commandAuthority);
      const outputText = result.content
       .filter(part => part.type === "text")
       .map(part => part.text)
       .join("");
      evalOutput.complete(outputText);
      const completeOutput = result.details?.cells?.map(cell => cell.output).join("\n\n") ?? outputText;
      const artifactManager = session.sessionManager.getArtifactManager();
      if (!artifactManager) throw new Error("Eval artifact storage is unavailable");
      const materialized = await materializeEvalOutput(artifactManager, completeOutput, {
       related: { toolCallId: operation.operationId },
       toolType: "rpc-eval",
       artifactId: result.details?.outputArtifactId ?? result.details?.meta?.truncation?.artifactId,
      });
      sessionAuthority.assertCurrent(commandAuthority);
      if (!operationManager.isActive(operation)) return;
      const firstCell = result.details?.cells?.[0];
      const truncated =
       evalOutput.truncated ||
       materialized.preview.truncated ||
       result.details?.meta?.truncation !== undefined;
      const entry: RpcEvalHistoryEntry = {
       language: command.language,
       code: command.code,
       output: materialized.preview.text,
       outputBytes: materialized.preview.totalBytes,
       outputPreviewBytes: materialized.preview.byteLength,
       outputTruncation: {
        truncated: materialized.preview.truncated,
        direction: materialized.preview.direction,
       },
       artifact: materialized.artifact,
       artifactRef: materialized.artifactRef,
       exitCode: firstCell?.exitCode,
       cancelled: firstCell?.cancelled === true,
       truncated,
       timestamp: Date.now(),
       excludeFromContext: command.excludeFromContext,
      };
      session.recordEvalResult(entry);
      output({ type: "eval_complete", operationId: operation.operationId, result: entry });
      operationManager.complete(operation, false);
     })()
      .catch(cause => {
       const evalError = cause instanceof Error ? cause : new Error(String(cause));
       operationManager.fail(
        operation,
        evalError,
        cause instanceof RpcSessionAuthorityError ? cause.code : "eval_execution_failed",
       );
      })
      .finally(() => {
       operationManager.settleCancellation(operation.operationId);
       resolveTask();
      });
    });
    rpcTaskTracker(task);
    return success(id, "eval_execute", { operationId: operation.operationId, accepted: true });
   }

   case "get_eval_history": {
    const limit = command.limit ?? 50;
    const messages = [...session.messages, ...session.getPendingEvalMessages()]
     .filter((message): message is PythonExecutionMessage => message.role === "pythonExecution")
     .slice(-limit);
    const artifactManager = session.sessionManager.getArtifactManager();
    if (!artifactManager) {
     return error(id, "get_eval_history", "Eval artifact storage is unavailable", "artifact_unavailable");
    }
    const entries = await Promise.all(
     messages.map(async (message): Promise<RpcEvalHistoryEntry> => {
      if (
       message.artifact !== undefined &&
       message.artifactRef !== undefined &&
       message.outputBytes !== undefined &&
       message.outputPreviewBytes !== undefined &&
       message.outputTruncation !== undefined
      ) {
       return {
        language: message.language ?? "py",
        code: message.code.slice(0, 262_144),
        output: message.output,
        outputBytes: message.outputBytes,
        outputPreviewBytes: message.outputPreviewBytes,
        outputTruncation: message.outputTruncation,
        artifact: message.artifact,
        artifactRef: message.artifactRef,
        exitCode: message.exitCode,
        cancelled: message.cancelled,
        truncated: message.truncated || message.outputTruncation.truncated,
        timestamp: message.timestamp,
        excludeFromContext: message.excludeFromContext,
       };
      }
      const materialized = await materializeEvalOutput(artifactManager, message.output, {
       related: { sessionId: session.sessionId },
       toolType: "rpc-eval-history",
       artifactId: message.meta?.truncation?.artifactId,
      });
      sessionAuthority.assertCurrent(commandAuthority);
      const legacyTruncated = message.truncated || materialized.preview.truncated;
      return {
       language: message.language ?? "py",
       code: message.code.slice(0, 262_144),
       output: materialized.preview.text,
       outputBytes: message.meta?.truncation?.totalBytes ?? materialized.preview.totalBytes,
       outputPreviewBytes: materialized.preview.byteLength,
       outputTruncation: {
        truncated: legacyTruncated,
        direction: legacyTruncated ? "tail" : materialized.preview.direction,
       },
       artifact: materialized.artifact,
       artifactRef: materialized.artifactRef,
       exitCode: message.exitCode,
       cancelled: message.cancelled,
       truncated: legacyTruncated,
       timestamp: message.timestamp,
       excludeFromContext: message.excludeFromContext,
      };
     }),
    );
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "get_eval_history", { entries });
   }

   case "new_session":
   case "switch_session":
   case "branch": {
    try {
     const result = await handleRpcSessionChange(
      session,
      command,
      subagentRegistry,
      prepareSessionTransition,
     );
     return completeSessionTransition(id, result.type, result.data);
    } catch (cause) {
     if (cause instanceof RpcSessionTransitionBusyError) {
      return error(id, command.type, cause.message, "session_busy");
     }
     throw cause;
    }
   }

   case "set_mode": {
    if (command.mode !== "plan" && (command.planFilePath !== undefined || command.workflow !== undefined)) {
     return error(
      id,
      "set_mode",
      "planFilePath and workflow are valid only for plan mode.",
      "invalid_request",
     );
    }
    if (command.mode !== "none" && !session.settings.get("plan.enabled")) {
     return error(id, "set_mode", "Plan mode is disabled.", "plan_disabled");
    }
    if (session.isStreaming && command.when !== "next_idle") {
     return error(id, "set_mode", "Session is busy.", "busy");
    }
    if (command.mode === "plan" && (session.getGoalModeState() || session.getVibeModeState())) {
     return error(id, "set_mode", "Another exclusive mode is active.", "mode_conflict");
    }
    if (command.mode === "plan" && session.planMode.active) {
     const current = session.getPlanModeState();
     if (
      (command.planFilePath !== undefined && current?.planFilePath !== command.planFilePath) ||
      (command.workflow !== undefined && current?.workflow !== command.workflow)
     ) {
      return error(
       id,
       "set_mode",
       "Plan mode is already active with a different plan file or workflow.",
       "mode_conflict",
      );
     }
    }
    if (operationManager.hasActiveCommand("set_mode")) {
     return error(id, "set_mode", "Another mode change is already pending.", "busy");
    }
    const operation = operationManager.start(id, "set_mode");
    const apply = async () => {
     sessionAuthority.assertCurrent(commandAuthority);
     if (command.mode === "none") {
      await session.planMode.disable();
      sessionAuthority.assertCurrent(commandAuthority);
     } else if (command.mode === "plan_paused") {
      if (!session.planMode.active && !session.planMode.paused) {
       await session.planMode.enter({
        planFilePath: "local://PLAN.md",
        workflow: "parallel",
       });
       sessionAuthority.assertCurrent(commandAuthority);
      }
      if (session.planMode.active) {
       await session.planMode.pause();
       sessionAuthority.assertCurrent(commandAuthority);
      }
     } else {
      await session.planMode.enter({
       planFilePath: command.planFilePath ?? "local://PLAN.md",
       workflow: command.workflow ?? "parallel",
      });
      sessionAuthority.assertCurrent(commandAuthority);
     }
    };
    const deferred = session.isStreaming && command.when === "next_idle";
    const taskCompletion = Promise.withResolvers<void>();
    setImmediate(() => {
     void (async () => {
      try {
       if (deferred) {
        await session.waitForIdle();
        sessionAuthority.assertCurrent(commandAuthority);
       }
       if (!operationManager.begin(operation)) return;
       await apply();
       sessionAuthority.assertCurrent(commandAuthority);
       operationManager.complete(operation, false);
      } catch (cause) {
       operationManager.fail(operation, cause instanceof Error ? cause : new Error(String(cause)));
      }
     })().finally(taskCompletion.resolve);
    });
    const task = taskCompletion.promise;
    rpcTaskTracker(task);
    return success(id, "set_mode", {
     operationId: operation.operationId,
     accepted: true,
     deferred,
    });
   }

   case "get_plan": {
    const plan = await session.planMode.project({ includeContent: true, includeAvailableFiles: true });
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "get_plan", plan);
   }

   case "resolve_plan_approval": {
    const pending = session.planMode.pendingApproval;
    if (!pending || pending.approvalId !== command.approvalId) {
     return error(id, "resolve_plan_approval", "Unknown plan approval.", "unknown_approval");
    }
    if (operationManager.hasActiveCommand("resolve_plan_approval")) {
     return error(id, "resolve_plan_approval", "The plan approval is already being resolved.", "busy");
    }
    const operation = operationManager.start(id, "resolve_plan_approval");
    planApprovalOperations.set(operation.operationId, command.approvalId);
    const taskCompletion = Promise.withResolvers<void>();
    setImmediate(() => {
     if (!operationManager.begin(operation)) {
      planApprovalOperations.delete(operation.operationId);
      taskCompletion.resolve();
      return;
     }
     void session.planMode
      .resolveApproval(
       command.approvalId,
       command.decision === "approve"
        ? {
         kind: "approve",
         preserveContext: command.preserveContext === true,
         compactBeforeExecute: command.compactBeforeExecute === true,
         executionModelRole: command.executionModelRole,
         editedContent: command.editedContent,
        }
        : { kind: command.decision, feedback: command.feedback },
      )
      .then(result => {
       sessionAuthority.assertCurrent(commandAuthority);
       operationManager.complete(operation, result.executionDispatched);
      })
      .catch(cause =>
       operationManager.fail(operation, cause instanceof Error ? cause : new Error(String(cause))),
      )
      .finally(() => {
       planApprovalOperations.delete(operation.operationId);
       taskCompletion.resolve();
      });
    });
    const task = taskCompletion.promise;
    rpcTaskTracker(task);
    return success(id, "resolve_plan_approval", { operationId: operation.operationId, accepted: true });
   }

   // =================================================================
   // State
   // =================================================================
   case "get_operations": {
    return success(id, "get_operations", operationManager.snapshot());
   }
   case "get_tool_inventory": {
    try {
     const response = success(
      id,
      "get_tool_inventory",
      session.getToolInventory(RPC_APPLICATION_API_VERSION),
     );
     if (Buffer.byteLength(`${JSON.stringify(response)}\n`, "utf8") > MAX_RPC_FRAME_BYTES) {
      return error(
       id,
       "get_tool_inventory",
       "Authoritative tool inventory does not fit the protocol frame",
       "tool_inventory_unavailable",
      );
     }
     return response;
    } catch (cause) {
     if (cause instanceof ToolInventoryUnavailableError) {
      return error(id, "get_tool_inventory", cause.message, "tool_inventory_unavailable");
     }
     throw cause;
    }
   }
   case "set_tool_activation": {
    toolActivationInFlight = true;
    try {
     const activation = await applyRpcToolActivation(
      session,
      command,
      operationManager.snapshot().active.length > 0,
     );
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "set_tool_activation", activation);
    } catch (cause) {
     if (cause instanceof RpcToolActivationValidationError) {
      return error(id, "set_tool_activation", cause.message, "invalid_request");
     }
     if (cause instanceof RpcToolActivationBusyError) {
      return error(id, "set_tool_activation", cause.message, "session_busy");
     }
     throw cause;
    } finally {
     toolActivationInFlight = false;
    }
   }

   case "get_state": {
    const state = await getRpcSessionState();
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "get_state", state);
   }

   case "get_advisor_state":
    return success(id, "get_advisor_state", getAdvisorState());

   case "set_advisor_enabled": {
    session.setAdvisorEnabled(command.enabled);
    const advisor = getAdvisorState();
    emitConfigUpdate();
    return success(id, "set_advisor_enabled", advisor);
   }

   case "set_fast_mode": {
    const supported = session.setFastMode(command.enabled);
    if (command.enabled && !supported) {
     return error(id, "set_fast_mode", "Fast mode is unavailable for the current model.");
    }
    return success(id, "set_fast_mode", {
     enabled: session.isFastModeEnabled(),
     active: session.isFastModeActive(),
    });
   }

   case "get_available_commands": {
    const commands = await getAvailableCommands();
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "get_available_commands", { commands });
   }

   case "set_todos":
    return success(id, "set_todos", { todoPhases: setRpcTodoPhases(session, command.phases) });

   case "todo_apply":
    try {
     return success(id, "todo_apply", {
      todoPhases: applyRpcTodoOperation(session, command.operation),
     });
    } catch (cause) {
     if (cause instanceof RpcTodoOperationError) {
      return error(id, "todo_apply", cause.message, "invalid_request");
     }
     throw cause;
    }

   case "goal_control": {
    const goal = await controlRpcGoal(session, command);
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "goal_control", goal);
   }
   case "checkpoint_control": {
    const checkpoint = await controlRpcCheckpoint(session, command);
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "checkpoint_control", checkpoint);
   }
   case "loop_control": {
    const result = controlRpcLoop(session, command);
    if (command.op !== "get") {
     output({
      type: "loop_state_update",
      state: result.state,
      ...(id === undefined ? {} : { causationId: id }),
     });
    }
    if ((command.op === "enable" || command.op === "resume") && result.state.phase === "running") {
     loopScheduler.request(id);
    }
    return success(id, "loop_control", result);
   }

   case "set_host_tools": {
    const tools = normalizeHostToolDefinitions(command.tools);
    const rpcTools = hostToolBridge.setTools(tools);
    await session.refreshRpcHostTools(rpcTools);
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
   }

   case "set_host_uri_schemes": {
    try {
     const schemes = hostUriBridge.setSchemes(command.schemes);
     return success(id, "set_host_uri_schemes", { schemes });
    } catch (err) {
     return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
    }
   }

   case "set_subagent_subscription": {
    if (!subagentRegistry) {
     return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
    }
    if (!isSubagentSubscriptionLevel(command.level)) {
     return error(
      id,
      "set_subagent_subscription",
      `Invalid subagent subscription level: ${String(command.level)}`,
     );
    }
    subagentRegistry.setSubscriptionLevel(command.level);
    return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
   }

   case "get_subagents": {
    if (!subagentRegistry) {
     return error(id, "get_subagents", "Subagent event bus is unavailable");
    }
    return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
   }

   case "get_subagent_messages": {
    if (!subagentRegistry) {
     return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
    }
    try {
     if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
      return error(id, "get_subagent_messages", "fromByte must be a finite number");
     }
     const sessionFile = subagentRegistry.resolveSessionFile(command);
     const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "get_subagent_messages", transcript);
    } catch (err) {
     return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
    }
   }
   case "get_queue":
    return success(id, "get_queue", session.getQueueSnapshot());

   case "queue_insert": {
    try {
     const result = session.insertQueuedMessage(command.lane, command.text, command.toIndex);
     emitQueueUpdate();
     return success(id, "queue_insert", { entry: result.entry, queue: result.snapshot });
    } catch (cause) {
     if (cause instanceof SessionQueueInvalidPositionError) {
      return error(id, "queue_insert", cause.message, "invalid_queue_position");
     }
     throw cause;
    }
   }

   case "queue_update": {
    try {
     const result = session.queueService.update(command.entryId, command.text);
     emitQueueUpdate();
     return success(id, "queue_update", { entry: result.entry, queue: result.snapshot });
    } catch (cause) {
     if (cause instanceof SessionQueueEntryNotFoundError) {
      return error(id, "queue_update", cause.message, "stale_queue_entry");
     }
     throw cause;
    }
   }

   case "queue_move": {
    try {
     const queue = session.queueService.move(command.entryId, command.lane, command.toIndex);
     emitQueueUpdate();
     return success(id, "queue_move", queue);
    } catch (cause) {
     if (cause instanceof SessionQueueEntryNotFoundError) {
      return error(id, "queue_move", cause.message, "stale_queue_entry");
     }
     if (cause instanceof SessionQueueInvalidPositionError) {
      return error(id, "queue_move", cause.message, "invalid_queue_position");
     }
     throw cause;
    }
   }

   case "remove_queued_message": {
    try {
     const result = session.queueService.remove(command.entryId);
     emitQueueUpdate();
     return success(id, "remove_queued_message", { removed: result.removed, queue: result.snapshot });
    } catch (cause) {
     if (cause instanceof SessionQueueEntryNotFoundError) {
      return error(id, "remove_queued_message", cause.message, "stale_queue_entry");
     }
     throw cause;
    }
   }

   case "reorder_queued_message": {
    try {
     const queue = session.queueService.reorder(command.entryId, command.toIndex);
     emitQueueUpdate();
     return success(id, "reorder_queued_message", queue);
    } catch (cause) {
     if (cause instanceof SessionQueueEntryNotFoundError) {
      return error(id, "reorder_queued_message", cause.message, "stale_queue_entry");
     }
     if (cause instanceof SessionQueueInvalidPositionError) {
      return error(id, "reorder_queued_message", cause.message, "invalid_queue_position");
     }
     throw cause;
    }
   }

   case "clear_queue": {
    const result = session.clearQueue({ lane: command.lane });
    emitQueueUpdate();
    return success(id, "clear_queue", result);
   }

   case "list_jobs": {
    if (!jobProjection) return error(id, "list_jobs", "Background job manager is unavailable", "unavailable");
    return success(id, "list_jobs", jobProjection.list());
   }

   case "get_job": {
    if (!jobProjection) return error(id, "get_job", "Background job manager is unavailable", "unavailable");
    return success(id, "get_job", { job: jobProjection.get(command.jobId) ?? null });
   }

   case "cancel_job": {
    if (!jobProjection) return error(id, "cancel_job", "Background job manager is unavailable", "unavailable");
    const resolvedTargets = jobProjection.resolveCancellationTargets(command.jobIds);
    let confirmed = false;
    try {
     confirmed = await requestRpcPrivilegedConfirmation(
      pendingExtensionRequests,
      output,
      "cancel_job",
      "Cancel background jobs?",
      `Cancel ${command.jobIds.length} background job${command.jobIds.length === 1 ? "" : "s"}: ${command.jobIds.join(", ")}`,
      { timeout: 15_000 },
     );
    } catch {
     sessionAuthority.assertCurrent(commandAuthority);
     return error(id, "cancel_job", "Cancellation confirmation was not completed", "confirmation_required");
    }
    sessionAuthority.assertCurrent(commandAuthority);
    if (!confirmed) {
     return error(id, "cancel_job", "Cancellation was not confirmed", "confirmation_required");
    }
    const outcomes = await jobProjection.cancelResolved(resolvedTargets);
    sessionAuthority.assertCurrent(commandAuthority);
    emitJobUpdate();
    return success(id, "cancel_job", { outcomes });
   }

   case "list_agents":
    return success(id, "list_agents", {
     agents: agentControl.list({ includeAdvisors: command.includeAdvisors }),
    });

   case "get_agent":
    try {
     return success(id, "get_agent", { agent: agentControl.get(command.agentId) });
    } catch (cause) {
     return error(id, "get_agent", cause instanceof Error ? cause.message : String(cause), "not_found");
    }

   case "start_agent":
    try {
     const label = command.name ?? command.agent ?? "task";
     if (!(await confirmAgentMutation("start_agent", label))) {
      return error(id, "start_agent", "Agent start was not confirmed.", "confirmation_required");
     }
     sessionAuthority.assertCurrent(commandAuthority);
     const taskTool = session.getToolByName("task");
     if (!taskTool) {
      return error(id, "start_agent", "Task tool is unavailable.", "agent_start_failed");
     }
     const result: AgentToolResult<unknown> = await taskTool.execute(id ?? (Snowflake.next() as string), {
      task: command.task,
      ...(command.agent === undefined ? {} : { agent: command.agent }),
      ...(command.name === undefined ? {} : { name: command.name }),
      ...(command.context === undefined ? {} : { context: command.context }),
     });
     sessionAuthority.assertCurrent(commandAuthority);
     if (result.isError) {
      const message = result.content.find(part => part.type === "text")?.text ?? "Child agent start failed";
      return error(id, "start_agent", message, "agent_start_failed");
     }
     const details = isRecord(result.details) ? result.details : {};
     const agentIds = new Set<string>();
     for (const key of ["progress", "results"] as const) {
      const entries = details[key];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
       if (isRecord(entry) && typeof entry.id === "string") agentIds.add(entry.id);
      }
     }
     if (agentIds.size === 0) {
      return error(id, "start_agent", "Task execution did not create a child agent.", "agent_start_failed");
     }
     const asyncDetails = isRecord(details.async) ? details.async : undefined;
     return success(id, "start_agent", {
      agentIds: [...agentIds],
      ...(typeof asyncDetails?.jobId === "string" ? { jobId: asyncDetails.jobId } : {}),
     });
    } catch (cause) {
     if (cause instanceof RpcSessionAuthorityError) throw cause;
     return error(
      id,
      "start_agent",
      cause instanceof Error ? cause.message : String(cause),
      "agent_start_failed",
     );
    }

   case "get_agent_result":
    try {
     return success(id, "get_agent_result", agentControl.getResult(command.agentId));
    } catch (cause) {
     return error(
      id,
      "get_agent_result",
      cause instanceof Error ? cause.message : String(cause),
      "not_found",
     );
    }

   case "send_agent_message":
   case "park_agent":
   case "resume_agent":
    try {
     if (command.type === "send_agent_message") {
      const sent = await agentControl.send(command.agentId, command.message, command.replyTo);
      sessionAuthority.assertCurrent(commandAuthority);
      return success(id, command.type, sent);
     }
     const agent =
      command.type === "park_agent"
       ? await agentControl.park(command.agentId)
       : await agentControl.resume(command.agentId);
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, command.type, { agent });
    } catch (cause) {
     if (cause instanceof RpcSessionAuthorityError) throw cause;
     return error(
      id,
      command.type,
      cause instanceof Error ? cause.message : String(cause),
      "agent_control_failed",
     );
    }

   case "cancel_agent":
   case "release_agent":
    try {
     const expected = agentControl.captureMutationTarget(command.agentId);
     const tombstone = command.type === "release_agent" && command.tombstone === true;
     if (!(await confirmAgentMutation(command.type, command.agentId, tombstone))) {
      return error(id, command.type, "Agent mutation was not confirmed.", "confirmation_required");
     }
     sessionAuthority.assertCurrent(commandAuthority);
     const result =
      command.type === "cancel_agent"
       ? await agentControl.cancel(command.agentId, expected)
       : await agentControl.release(command.agentId, { tombstone }, expected);
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, command.type, result);
    } catch (cause) {
     if (cause instanceof RpcSessionAuthorityError) throw cause;
     return error(
      id,
      command.type,
      cause instanceof Error ? cause.message : String(cause),
      "agent_control_failed",
     );
    }

   // =================================================================
   // Model
   // =================================================================

   case "set_model": {
    let models = session.getAvailableModels();
    let model = models.find(m => m.provider === command.provider && m.id === command.modelId);
    if (!model) {
     // Model not in the current catalog. Wait for in-flight
     // background discovery before declaring it missing: on cold
     // start, discovery-backed providers (proxy / ollama / etc.)
     // populate seconds after session ready. Models already in
     // the bundled catalog skip this await entirely so the RPC
     // queue is not stalled behind unrelated discovery.
     await session.modelRegistry.awaitBackgroundRefresh();
     sessionAuthority.assertCurrent(commandAuthority);
     models = session.getAvailableModels();
     model = models.find(m => m.provider === command.provider && m.id === command.modelId);
    }
    if (!model) {
     return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
    }
    await session.setModel(model);
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "set_model", model);
   }
   case "set_model_role": {
    const role = await setRpcModelRole(session, command.role);
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "set_model_role", role);
   }

   case "set_service_tier":
    return success(id, "set_service_tier", setRpcServiceTier(session, command.family, command.tier));

   case "cycle_model": {
    const result = await session.cycleModel();
    sessionAuthority.assertCurrent(commandAuthority);
    if (!result) {
     return success(id, "cycle_model", null);
    }
    return success(id, "cycle_model", result);
   }

   case "get_available_models": {
    await session.modelRegistry.awaitBackgroundRefresh();
    sessionAuthority.assertCurrent(commandAuthority);
    const availableModels = session.getAvailableModels();
    const roles = resolveRoleAssignments(session.settings, session.modelRegistry.getAll(), availableModels);
    const usageOrder = session.settings.getStorage()?.getModelUsageOrder() ?? [];
    const items = buildBrowserItems(availableModels);
    sortModelItems(items, { roles, mruOrder: usageOrder });
    const modelRoles = Object.entries(roles).flatMap(([role, assignment]) =>
     assignment
      ? [
       {
        role,
        provider: assignment.model.provider,
        id: assignment.model.id,
        autoSelected: assignment.autoSelected,
       },
      ]
      : [],
    );
    return success(id, "get_available_models", {
     models: items.map(item => item.model),
     usageOrder,
     thinkingOptions: items.map(({ model }) => ({
      provider: model.provider,
      id: model.id,
      levels: getSelectableThinkingLevels(model),
     })),
     roles: modelRoles,
    });
   }

   case "get_settings":
    return handleGetSettings(session.settings, id, command.tab);

   case "set_settings":
    return handleSetSettings(session.settings, id, command.changes);

   // =================================================================
   // Thinking
   // =================================================================

   case "set_thinking_level": {
    session.setThinkingLevel(command.level);
    return success(id, "set_thinking_level");
   }

   case "cycle_thinking_level": {
    const level = session.cycleThinkingLevel();
    if (!level) {
     return success(id, "cycle_thinking_level", null);
    }
    return success(id, "cycle_thinking_level", { level });
   }

   // =================================================================
   // Queue Modes
   // =================================================================

   case "set_steering_mode": {
    session.setSteeringMode(command.mode);
    return success(id, "set_steering_mode");
   }

   case "set_follow_up_mode": {
    session.setFollowUpMode(command.mode);
    return success(id, "set_follow_up_mode");
   }

   case "set_interrupt_mode": {
    session.setInterruptMode(command.mode);
    return success(id, "set_interrupt_mode");
   }

   // =================================================================
   // Compaction
   // =================================================================

   case "compact": {
    const result = await session.compact(command.customInstructions);
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "compact", result);
   }

   case "set_auto_compaction": {
    session.setAutoCompactionEnabled(command.enabled);
    return success(id, "set_auto_compaction");
   }

   // =================================================================
   // Retry
   // =================================================================

   case "retry": {
    const retried = await session.retry();
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "retry", { retried });
   }

   case "set_auto_retry": {
    session.setAutoRetryEnabled(command.enabled);
    return success(id, "set_auto_retry");
   }

   case "abort_retry": {
    session.abortRetry();
    return success(id, "abort_retry");
   }

   // =================================================================
   // Bash
   // =================================================================
   case "bash": {
    const confirmationController = new AbortController();
    pendingRpcBashConfirmations.add(confirmationController);
    let confirmed = false;
    try {
     confirmed = await requestRpcPrivilegedConfirmation(
      pendingExtensionRequests,
      output,
      "bash",
      "Run shell command?",
      command.command,
      { signal: confirmationController.signal },
     );
    } catch {
     sessionAuthority.assertCurrent(commandAuthority);
     return error(id, "bash", "Shell command confirmation was not completed", "confirmation_required");
    } finally {
     pendingRpcBashConfirmations.delete(confirmationController);
    }
    if (!confirmed) {
     return error(id, "bash", "Shell command execution was not confirmed", "confirmation_required");
    }
    sessionAuthority.assertCurrent(commandAuthority);
    const execution = session.executeBash(command.command);
    rpcBashExecutions.add(execution);
    try {
     const result = await execution;
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "bash", result);
    } finally {
     rpcBashExecutions.delete(execution);
    }
   }

   case "abort_bash": {
    session.abortBash();
    return success(id, "abort_bash");
   }

   // =================================================================
   // Session
   // =================================================================

   case "get_session_stats": {
    const stats = session.getSessionStats();
    const contextBreakdown = session.getContextBreakdown();
    return success(
     id,
     "get_session_stats",
     contextBreakdown ? { ...stats, contextBreakdown } : stats,
    );
   }

   case "export_html": {
    const exportedPath = await session.exportToHtml(command.outputPath);
    sessionAuthority.assertCurrent(commandAuthority);
    return success(id, "export_html", { path: exportedPath });
   }

   case "list_sessions": {
    try {
     await session.sessionManager.flush();
     const catalog = await listSessionCatalog(
      {
       scope: command.scope ?? "cwd",
       cwd: command.cwd ?? session.sessionManager.getCwd(),
       cursor: command.cursor,
       limit: command.limit,
       search: command.search,
      },
      sessionStorage,
      { activeSessionId: session.sessionId },
     );
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "list_sessions", catalog);
    } catch (cause) {
     return catalogError(id, "list_sessions", cause);
    }
   }

   case "get_session_info": {
    try {
     await session.sessionManager.flush();
     const resolved = await resolveSessionCatalogReference(
      command.session,
      { scope: command.scope ?? (command.cwd ? "cwd" : "all"), cwd: command.cwd },
      sessionStorage,
     );
     sessionAuthority.assertCurrent(commandAuthority);
     const activePath = session.sessionManager.getSessionFile();
     const active = activePath !== undefined && path.resolve(activePath) === resolved.entry.path;
     const workspace = active
      ? {
       cwd: session.sessionManager.getCwd(),
       directories: [
        session.sessionManager.getCwd(),
        ...session.sessionManager.getAdditionalDirectories(),
       ],
      }
      : await inspectPersistedSessionWorkspace(resolved.entry.path, resolved.entry.cwd, sessionStorage);
     sessionAuthority.assertCurrent(commandAuthority);
     const data: RpcSessionInfoResult = {
      session: projectSessionCatalogEntry(resolved.session, { activeSessionId: session.sessionId }),
      workspace,
      active,
     };
     return success(id, "get_session_info", data);
    } catch (cause) {
     return catalogError(id, "get_session_info", cause);
    }
   }
   case "get_session_tree": {
    const leafId = session.sessionManager.getLeafId();
    return success(id, "get_session_tree", {
     sessionId: session.sessionId,
     leafId,
     roots: projectSessionTree(session.sessionManager.getTree(), leafId),
    });
   }

   case "select_session_leaf": {
    if (session.isStreaming || session.isCompacting) {
     return error(
      id,
      "select_session_leaf",
      "Session mutation is unavailable while the session is busy",
      "session_busy",
     );
    }
    sessionAuthority.assertCurrent(commandAuthority);
    await prepareSessionTransition();
    const selected = await session.navigateTree(command.entryId, {
     summarize: command.summarize,
     customInstructions: command.customInstructions,
    });
    if (!selected.cancelled) subagentRegistry?.clear();
    return completeSessionTransition(id, "select_session_leaf", {
     cancelled: selected.cancelled,
     leafId: session.sessionManager.getLeafId(),
    });
   }

   case "reset_session": {
    const resetAuthority = await transitionExecutionAuthority();
    const result = await session.resetSessionContext();
    sessionAuthority.assertCurrent(resetAuthority);
    if (!result) {
     return error(
      id,
      "reset_session",
      "Session mutation is unavailable while the session is busy",
      "session_busy",
     );
    }
    return success(id, "reset_session", result);
   }

   case "list_workspace_roots": {
    try {
     await session.sessionManager.flush();
     const roots = await listSessionWorkspaceRoots(sessionStorage);
     sessionAuthority.assertCurrent(commandAuthority);
     return success(id, "list_workspace_roots", { roots });
    } catch (cause) {
     return catalogError(id, "list_workspace_roots", cause);
    }
   }

   case "fork_session": {
    if (session.isStreaming || session.isCompacting)
     return error(
      id,
      "fork_session",
      "Session mutation is unavailable while the session is busy",
      "session_busy",
     );
    if (!session.sessionManager.getSessionFile())
     return error(id, "fork_session", "The active session has not been persisted", "session_not_persisted");
    try {
     const forked = await session.fork(prepareSessionTransition);
     const data: RpcForkSessionResult = {
      cancelled: !forked,
      ...(forked && session.sessionManager.getSessionFile()
       ? { sessionFile: session.sessionManager.getSessionFile() }
       : {}),
     };
     if (forked) subagentRegistry?.clear();
     return completeSessionTransition(id, "fork_session", data);
    } catch (cause) {
     return catalogError(id, "fork_session", cause);
    }
   }

   case "rename_session": {
    if (session.isStreaming || session.isCompacting)
     return error(
      id,
      "rename_session",
      "Session mutation is unavailable while the session is busy",
      "session_busy",
     );
    const name = command.name
     .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
     .replace(/ +/g, " ")
     .trim();
    if (!name) return error(id, "rename_session", "Session name cannot be empty");
    try {
     const resolved = await resolveSessionCatalogReference(
      command.session,
      { scope: command.scope ?? (command.cwd ? "cwd" : "all"), cwd: command.cwd },
      sessionStorage,
     );
     sessionAuthority.assertCurrent(commandAuthority);
     const activePath = session.sessionManager.getSessionFile();
     const active = activePath !== undefined && path.resolve(activePath) === resolved.entry.path;
     if (active) {
      const renamed = await session.setSessionName(name, "user");
      sessionAuthority.assertCurrent(commandAuthority);
      const data: RpcRenameSessionResult = { renamed, active: true };
      return success(id, "rename_session", data);
     }
     await sessionStorage.updateSessionTitle(resolved.entry.path, {
      title: name,
      source: "user",
      updatedAt: new Date().toISOString(),
     });
     sessionAuthority.assertCurrent(commandAuthority);
     const data: RpcRenameSessionResult = { renamed: true, active: false };
     return success(id, "rename_session", data);
    } catch (cause) {
     return catalogError(id, "rename_session", cause);
    }
   }

   case "delete_session": {
    if (session.isStreaming || session.isCompacting)
     return error(
      id,
      "delete_session",
      "Session mutation is unavailable while the session is busy",
      "session_busy",
     );
    try {
     const resolved = await resolveSessionCatalogReference(
      command.session,
      { scope: command.scope ?? (command.cwd ? "cwd" : "all"), cwd: command.cwd },
      sessionStorage,
     );
     const confirmed = await requestRpcPrivilegedConfirmation(
      pendingExtensionRequests,
      output,
      "delete_session",
      "Delete session?",
      `Permanently delete session "${resolved.entry.title ?? resolved.entry.id}" and its artifacts?`,
     );
     sessionAuthority.assertCurrent(commandAuthority);
     if (!confirmed) {
      return error(id, "delete_session", "Session deletion was not confirmed", "confirmation_required");
     }
     const activePath = session.sessionManager.getSessionFile();
     const wasActive = activePath !== undefined && path.resolve(activePath) === resolved.entry.path;
     if (wasActive) {
      const started = await session.newSession(undefined, prepareSessionTransition);
      if (!started) {
       const cancelled: RpcDeleteSessionResult = {
        deleted: false,
        cancelled: true,
        wasActive: true,
        newSessionStarted: false,
       };
       return completeSessionTransition(id, "delete_session", cancelled);
      }
      subagentRegistry?.clear();
      try {
       await session.sessionManager.dropSession(resolved.entry.path);
      } catch (cause) {
       const failed: RpcDeleteSessionResult = {
        deleted: false,
        cancelled: false,
        wasActive: true,
        newSessionStarted: true,
        deleteError: {
         code: "delete_failed",
         message: cause instanceof Error ? cause.message : String(cause),
        },
       };
       return completeSessionTransition(id, "delete_session", failed);
      }
      const deleted: RpcDeleteSessionResult = {
       deleted: true,
       cancelled: false,
       wasActive: true,
       newSessionStarted: true,
      };
      return completeSessionTransition(id, "delete_session", deleted);
     }
     sessionAuthority.assertCurrent(commandAuthority);
     try {
      await sessionStorage.deleteSessionWithArtifacts(resolved.entry.path);
     } catch (cause) {
      if (!isEnoent(cause))
       return error(
        id,
        "delete_session",
        cause instanceof Error ? cause.message : String(cause),
        "delete_failed",
       );
     }
     sessionAuthority.assertCurrent(commandAuthority);
     const deleted: RpcDeleteSessionResult = {
      deleted: true,
      cancelled: false,
      wasActive: false,
      newSessionStarted: false,
     };
     return success(id, "delete_session", deleted);
    } catch (cause) {
     return catalogError(id, "delete_session", cause);
    }
   }

   case "get_branch_messages": {
    const messages = session.getUserMessagesForBranching();
    return success(id, "get_branch_messages", { messages });
   }

   case "get_last_assistant_text": {
    const text = session.getLastAssistantText();
    return success(id, "get_last_assistant_text", { text });
   }

   case "set_session_name": {
    const name = command.name.trim();
    if (!name) {
     return error(id, "set_session_name", "Session name cannot be empty");
    }
    sessionAuthority.assertCurrent(commandAuthority);
    const applied = await session.setSessionName(name, "user");
    sessionAuthority.assertCurrent(commandAuthority);
    if (!applied) {
     return error(id, "set_session_name", "Session name cannot be empty");
    }
    return success(id, "set_session_name");
   }

   case "handoff": {
    // Resetting the agent mid-stream lets the live turn keep emitting into a
    // session that handoff has already torn down. Refuse while a prompt is in
    // flight (mirrors the TUI /handoff guard).
    if (session.isStreaming) {
     return error(id, "handoff", "Cannot hand off while a response is in progress");
    }
    const handoffAuthority = await transitionExecutionAuthority();
    const result = await session.handoff(command.customInstructions);
    sessionAuthority.assertCurrent(handoffAuthority);
    return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
   }

   // =================================================================
   // Messages
   // =================================================================

   case "get_messages": {
    return success(id, "get_messages", { messages: session.messages });
   }

   case "get_messages_page": {
    if (session.isStreaming || session.isCompacting)
     return error(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
    const messages = session.messages;
    try {
     return success(
      id,
      "get_messages_page",
      pageRpcMessages(
       messages,
       {
        sessionId: session.sessionId,
        leafId: session.sessionManager.getLeafId(),
        messageCount: messages.length,
       },
       { cursor: command.cursor, limit: command.limit },
      ),
     );
    } catch (pageError) {
     return error(
      id,
      "get_messages_page",
      pageError instanceof Error ? pageError.message : String(pageError),
      pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
     );
    }
   }

   case "get_transcript_page": {
    if (session.isStreaming || session.isCompacting)
     return error(id, "get_transcript_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
    try {
     const collapseCompactedHistory =
      command.cursor === undefined && command.collapseCompactedHistory === undefined
       ? session.settings.get("display.collapseCompacted")
       : command.collapseCompactedHistory;
     const transcript = session.buildTranscriptSessionContext({
      collapseCompactedHistory,
      keepDanglingToolCalls: session.isStreaming,
     });
     return success(
      id,
      "get_transcript_page",
      pageRpcTranscript(
       transcript.messages,
       transcript.cacheMissExplainedAt ?? transcript.messages.map(() => false),
       {
        sessionId: session.sessionId,
        leafId: session.sessionManager.getLeafId(),
        messageCount: transcript.messages.length,
       },
       { cursor: command.cursor, limit: command.limit, collapseCompactedHistory },
      ),
     );
    } catch (pageError) {
     return error(
      id,
      "get_transcript_page",
      pageError instanceof Error ? pageError.message : String(pageError),
      pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
     );
    }
   }

   // =================================================================
   // Provider authentication
   // =================================================================

   case "list_provider_auth": {
    return success(id, "list_provider_auth", { providers: providerAuthService.list() });
   }

   case "begin_provider_auth": {
    try {
     const handle = providerAuthController.begin(id, command.providerId, command.method);
     return success(id, "begin_provider_auth", { operationId: handle.operationId, accepted: true });
    } catch (authError) {
     const known = authError instanceof ProviderAuthError ? authError : undefined;
     return error(
      id,
      "begin_provider_auth",
      known?.message ?? "Provider authentication could not be started",
      known?.code ?? "provider_auth_failed",
     );
    }
   }

   case "cancel_provider_auth": {
    const providerCancellation = providerAuthController.cancel(command.operationId);
    if (providerCancellation === "not_found") {
     return error(
      id,
      "cancel_provider_auth",
      "Provider authentication operation was not found",
      "provider_auth_operation_not_found",
     );
    }
    if (providerCancellation === "protected") {
     return error(
      id,
      "cancel_provider_auth",
      "Provider authentication credentials are already being committed",
      "provider_auth_commit_in_progress",
     );
    }
    return success(id, "cancel_provider_auth", operationManager.cancel(command.operationId).result);
   }

   case "remove_provider_auth": {
    let releaseReservation: () => void;
    try {
     releaseReservation = providerAuthController.reserveMutation();
    } catch (authError) {
     const known = authError instanceof ProviderAuthError ? authError : undefined;
     return error(
      id,
      "remove_provider_auth",
      known?.message ?? "Provider authentication could not be removed",
      known?.code ?? "provider_auth_remove_failed",
     );
    }
    try {
     const target = providerAuthService.credentialTarget(command.providerId);
     let confirmed = false;
     try {
      confirmed = await requestRpcPrivilegedConfirmation(
       pendingExtensionRequests,
       output,
       "remove_provider_auth",
       "Remove provider authentication?",
       `Remove credentials stored as "${target.storageProvider}" for providers: ${target.affectedProviderIds.join(", ")}?`,
      );
      sessionAuthority.assertCurrent(commandAuthority);
     } catch {
      return error(
       id,
       "remove_provider_auth",
       "Credential removal confirmation was not completed",
       "confirmation_required",
      );
     }
     sessionAuthority.assertCurrent(commandAuthority);
     if (!confirmed) {
      return error(
       id,
       "remove_provider_auth",
       "Credential removal was not confirmed",
       "confirmation_required",
      );
     }
     const result = await providerAuthService.remove(command.providerId);
     sessionAuthority.assertCurrent(commandAuthority);
     for (const state of result.states) {
      output({ type: "provider_auth_update", state } satisfies ProviderAuthUpdate);
     }
     return success(id, "remove_provider_auth", { state: result.state });
    } catch (authError) {
     if (authError instanceof RpcSessionAuthorityError) throw authError;
     const known = authError instanceof ProviderAuthError ? authError : undefined;
     return error(
      id,
      "remove_provider_auth",
      known?.message ?? "Provider authentication could not be removed",
      known?.code ?? "provider_auth_remove_failed",
     );
    } finally {
     releaseReservation();
    }
   }

   default: {
    const exhaustiveCommand: never = command;
    return exhaustiveCommand;
   }
  }
 };
 const authorizedHandleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
  try {
   return await handleCommand(command);
  } catch (cause) {
   const cleanupCause = abandonPreparedSessionTransition();
   if (cleanupCause) {
    throw new AggregateError([cause, cleanupCause], "RPC command and session-transition cleanup failed");
   }
   if (cause instanceof RpcSessionAuthorityError) {
    return error(command.id, command.type, cause.message, cause.code);
   }
   if (cause instanceof RpcSessionTransitionBusyError) {
    return error(command.id, command.type, cause.message, "session_busy");
   }
   if (cause instanceof RpcInteractiveSurfaceError) {
    return error(command.id, command.type, cause.message, cause.code, cause.data);
   }
   throw cause;
  }
 };
 executeRpcCommand = authorizedHandleCommand;

 // Deferred shutdown (pi.shutdown() from an extension) must not kill the
 // process while a background-dispatched command still owes the client its
 // response frame. The coordinator drains tracked tasks before exiting and
 // re-checks the request as each task settles.
 const shutdownCoordinator = new RpcShutdownCoordinator({
  isShutdownRequested: () => shutdownState.requested,
  performShutdown: async () => {
   interactiveSurface.disconnect("shutdown");
   await rpcSessionHost?.shutdown();
   session.disableLoop();
   semanticRendering.dispose();
   await resourceLifecycle?.dispose();
   provenance.dispose();
   await collaboration.dispose();
   const loopSettled = loopScheduler.dispose();
   // Route through the idempotent session.dispose() so the browser
   // reaper (releaseTabsForOwner) and other bounded teardown run before
   // the process exits. dispose() also emits `session_shutdown`, so we
   // must NOT emit it separately here or the event fires twice. Skipping
   // dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
   await session.dispose();
   await loopSettled;
   await stdoutQueue;
   process.exit(0);
  },
 });
 rpcTaskTracker = task => shutdownCoordinator.track(task);

 const dispatchFrameDeps: RpcInputFrameDeps = {
  handleCommand: authorizedHandleCommand,
  output,
  errorResponse: error,
  trackBackgroundTask: task => shutdownCoordinator.track(task),
  pendingExtensionRequests,
  onHostToolResult: frame => hostToolBridge.handleResult(frame),
  onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
  onHostUriResult: frame => hostUriBridge.handleResult(frame),
 };

 const inputDispatcher = new RpcInputDispatcher({
  deps: dispatchFrameDeps,
  onShutdownInitiated: () => {
   interactiveSurface.disconnect("shutdown");
   pendingExtensionRequests.rejectAll("RPC session is shutting down");
   hostToolBridge.close("RPC session is shutting down");
   hostUriBridge.clear("RPC session is shutting down");
  },
  beforeShutdown: async () => {
   await shutdownCoordinator.drain();
  },
  afterSerialCommand: async () => {
   shutdownCoordinator.checkShutdownRequested();
  },
 });

 // Keep the stdin reader moving: side-channel frames dispatch immediately,
 // ordinary commands serialize through inputDispatcher, while concurrent
 // and control commands can overtake them. Frames are read
 // line-by-line and parsed here (not via readJsonl) so a single malformed
 // line is reported as an error frame and the loop keeps running instead of
 // throwing out of the generator and killing the whole process (issue #5194).
 const decoder = new TextDecoder();
 for await (const line of readLines(input ?? Bun.stdin.stream())) {
  const text = decoder.decode(line).trim();
  if (!text) continue;
  let parsed: unknown;
  try {
   parsed = JSON.parse(text);
  } catch (e: unknown) {
   const message = e instanceof Error ? e.message : String(e);
   output(error(undefined, "parse", `Failed to parse command: ${message}`));
   continue;
  }
  inputDispatcher.dispatch(parsed);
 }

 // stdin closed — stop accepting side-channel work, drain every command that
 // already owes a response, then settle any operation still running.
 session.disableLoop();
 const loopSettled = loopScheduler.dispose();
 const activeOperations = operationManager.snapshot().active;
 const providerOperationIds = new Set(
  activeOperations
   .filter(operation => operation.command === "provider_auth")
   .map(operation => operation.operationId),
 );
 const protectedOperations = new Set(providerAuthController.close());
 interactiveSurface.disconnect("client_disconnected");
 pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
 semanticRendering.dispose();
 const resourceDisposal = resourceLifecycle?.dispose();
 provenance.dispose();
 await collaboration.dispose();
 hostToolBridge.close("RPC client disconnected before host tool execution completed");
 hostUriBridge.clear("RPC client disconnected before host URI request completed");
 await inputDispatcher.drain();
 for (const operationId of protectedCommitOperationIds()) protectedOperations.add(operationId);
 operationManager.cancelAll("client_disconnected", "client_disconnected", protectedOperations);
 await quiesceCancelledImplementations(providerOperationIds, "RPC client disconnected");
 await loopSettled;
 await rpcSessionHost?.disconnect();
 await shutdownCoordinator.drain();
 await session.planMode.abandonPendingApproval();
 await resourceDisposal;
 unsubscribeSessionNameChanged();
 unsubscribeAgentRegistry();
 unsubscribeJobUpdates?.();
 subagentRegistry?.dispose();
 // Jobs are process-scoped rather than transport-scoped: keep the host alive
 // until this owner's accepted jobs settle, then tear down without cancelling
 // or evicting their retained outcomes.
 if (session.asyncJobManager && rpcJobOwnerId) {
  await session.asyncJobManager.waitForOwnerJobs(rpcJobOwnerId);
 }
 await session.dispose({ preserveAsyncJobs: true });
 await stdoutQueue;
 process.exit(0);
}
