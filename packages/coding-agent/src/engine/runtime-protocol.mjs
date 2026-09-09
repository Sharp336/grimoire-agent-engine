import protocol from './runtime-protocol-v1.json' with { type: 'json' };
import { sha256 } from '@noble/hashes/sha2.js';

export const runtimeProtocol = protocol;
export const runtimeLimits = protocol['x-artel'].limits;

export class RuntimeProtocolError extends Error {
  constructor(code, message, admission = 'not_admitted') {
    super(message);
    this.name = 'RuntimeProtocolError';
    this.code = code;
    this.retryable = false;
    this.admission = admission;
  }
}

function matches(schema, value, depth = 0) {
  if (!schema || depth > runtimeLimits.maxJsonDepth) return false;
  if (schema.$ref) {
    const name = schema.$ref.slice('#/$defs/'.length);
    return matches(protocol.$defs[name], value, depth + 1) && validProjection(name, value);
  }
  if (schema.oneOf) return schema.oneOf.filter(choice => matches(choice, value, depth + 1)).length === 1;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= (schema.minimum ?? 0) && value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER);
  if (schema.type === 'string') return typeof value === 'string'
    && [...value].length >= (schema.minLength ?? 0)
    && [...value].length <= (schema.maxLength ?? Infinity)
    && (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
  if (schema.type === 'array') return Array.isArray(value)
    && value.length >= (schema.minItems ?? 0)
    && value.length <= (schema.maxItems ?? Infinity)
    && (!schema.uniqueItems || new Set(value.map(item => canonicalRuntimeJson(item))).size === value.length)
    && value.every(item => matches(schema.items, item, depth + 1));
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => schema.properties?.[key]
      ? matches(schema.properties[key], item, depth + 1)
      : schema.additionalProperties !== false);
  }
  return !schema.type;
}

const encodedBytes = value => new TextEncoder().encode(value).byteLength;
const projectionLimits = {
  agentSummary: 'summaryBytes', detailState: 'detailStateBytes', change: 'liveChangeBytes',
  bulkPreview: 'bulkPreviewBytes', snapshot: 'httpPageBytes', historyPage: 'httpPageBytes',
  inputDetail: 'httpPageBytes', inputPage: 'httpPageBytes', holdsPage: 'httpPageBytes', messagesPage: 'httpPageBytes', toolsPage: 'httpPageBytes',
  queuePage: 'httpPageBytes', queueItem: 'liveChangeBytes',
};

// JSON Schema covers the shape; these are the cross-field byte/identity invariants.
function validProjection(name, value) {
  const bound = projectionLimits[name];
  if (bound && encodedBytes(JSON.stringify(value)) > runtimeLimits[bound]) return false;
  if (name === 'command' && ['continue', 'history-branch-and-run'].includes(value.action)
    && Object.hasOwn(value.payload, 'text') !== Object.hasOwn(value.payload, 'clientMessageId')) return false;
  if (name === 'nativeTargetRequest' && value.executionId !== undefined && value.attemptId === undefined) return false;
  if (name === 'nativeTarget' && value.kind === 'bound'
    && Object.hasOwn(value, 'startCommandId') !== Object.hasOwn(value, 'startExpectedIntentRevision')) return false;
  if (name === 'nativeEventsRequest' && value.untilCursor !== undefined && value.untilCursor < value.afterCursor) return false;
  if (name === 'textSnapshot' || name === 'textAppend') {
    if (value.offset > value.endOffset || value.endOffset > value.totalBytes
      || encodedBytes(value.text) !== value.endOffset - value.offset) return false;
    // Lone surrogates cannot identify a UTF-8 codepoint boundary.
    if (!value.text.isWellFormed()) return false;
    if (name === 'textAppend') return value.revision > value.baseRevision && value.endOffset === value.totalBytes;
    if (value.partial !== (value.offset !== 0 || value.endOffset !== value.totalBytes)) return false;
    if (value.partial && !value.resource) return false;
    if (value.resource?.kind === 'message' && (value.resource.messageId !== value.messageId
      || value.resource.blockId !== value.blockId || value.resource.stream !== value.stream
      || value.resource.contentId !== value.contentId || value.resource.revision !== value.revision
      || value.resource.bytes !== value.totalBytes)) return false;
  }
  if (name === 'agentSummary' || name === 'detailState') {
    if (value.target.agentInstanceRef !== value.agentInstanceRef) return false;
    if (value.pendingStart && value.pendingStart.agentInstanceRef !== value.agentInstanceRef) return false;
    if ((value.state === 'registered') !== (value.target.attemptId === undefined)) return false;
  }
  if (name === 'detailState') {
    if ((value.target.attemptId ?? null) !== value.attemptId) return false;
    if (value.attemptId === null && (value.messages.length || value.tools.length || value.toolsNextCursor !== null)) return false;
    if (value.messages.some(message => message.resource && (message.resource.agentInstanceRef !== value.agentInstanceRef
      || message.resource.attemptId !== value.attemptId))) return false;
  }
  if (['summaryChange', 'membershipChange', 'stateChange'].includes(name)) {
    if (value.agentInstanceRef !== value.value.agentInstanceRef || value.revision !== value.value.revision) return false;
  }
  if (name === 'assistantChange') {
    if (value.revision !== value.value.revision) return false;
    const resource = value.value.resource;
    if (resource && (resource.agentInstanceRef !== value.agentInstanceRef
      || (resource.attemptId !== undefined && resource.attemptId !== value.attemptId))) return false;
  }
  if (['toolChange', 'detailState', 'toolsPage'].includes(name)) {
    const tools = name === 'toolChange' ? [value.value] : name === 'detailState' ? value.tools : value.items;
    if (name !== 'toolChange' && (new Set(tools.map(tool => tool.toolCallId)).size !== tools.length
      || tools.some(tool => tool.revision > value.revision || !['started', 'unknown'].includes(tool.phase)))) return false;
    if (name === 'toolsPage' && value.work.changes < tools.length) return false;
    for (const tool of tools) for (const resource of [tool.result, tool.preview?.resource]) {
      if (resource && (resource.agentInstanceRef !== value.agentInstanceRef
        || resource.attemptId !== value.attemptId)) return false;
    }
  }
  if (name === 'inputDetail') {
    if (value.partial && (encodedBytes(JSON.stringify(value.input)) > runtimeLimits.inputPreviewBytes
      || value.resource.agentInstanceRef !== value.agentInstanceRef || value.resource.attemptId !== value.attemptId
      || value.resource.inputId !== value.input.inputId || value.resource.revision !== value.input.revision)) return false;
  }
  if (name === 'messagesPage' && value.items.some(message => message.resource
    && (message.resource.agentInstanceRef !== value.agentInstanceRef || message.resource.attemptId !== value.attemptId))) return false;
  if (name === 'queueItem') {
    if (value.partial !== Boolean(value.resource)) return false;
    for (const [field, key] of [['deliveryPayload', 'resource'], ['annotation', 'annotationResource'], ['sender', 'senderResource']]) {
      const resource = value[key];
      if (value[field] !== undefined && !value[field].isWellFormed()) return false;
      if (resource && (typeof value[field] !== 'string' || resource.field !== field || resource.queueId !== value.queueId
        || resource.revision !== value.revision || encodedBytes(value[field]) >= resource.bytes)) return false;
    }
    if ((value.resource || value.annotationResource || value.senderResource)
      && encodedBytes(JSON.stringify({ deliveryPayload: value.deliveryPayload, annotation: value.annotation, sender: value.sender })) > runtimeLimits.bulkPreviewBytes) return false;
  }
  if (name === 'queuePage' && value.items.some(item => [item.resource, item.annotationResource, item.senderResource]
    .some(resource => resource && resource.agentInstanceRef !== value.agentInstanceRef))) return false;
  if (name === 'lifecycleActivity' && (value.beforeEntryId !== undefined && value.afterEntryId !== undefined
    || value.id !== `engine:${value.sessionId}:${value.agentInstanceRef}:${value.attemptId}:${value.eventId}`)) return false;
  if (name === 'historyPage' && (value.entries.length + value.activities.length > runtimeLimits.httpPageRecords
    || value.work.changes < value.entries.length + value.activities.length
    || new Set(value.activities.map(item => item.id)).size !== value.activities.length
    || value.activities.some(item => item.agentInstanceRef !== value.agentInstanceRef || item.sessionId !== value.sessionId))) return false;
  if (name === 'eventBatch' || name === 'update') {
    const frame = name === 'update' ? { jsonrpc: '2.0', method: 'runtime.update', params: value } : value;
    if (encodedBytes(JSON.stringify(frame)) > runtimeLimits.deliveryBatchBytes) return false;
    if (name === 'eventBatch' && value.throughCursor > value.headCursor) return false;
    let cursor = 0;
    for (const change of value.changes) {
      if (change.cursor < cursor || change.cursor > value.throughCursor) return false;
      cursor = change.cursor;
    }
  }
  if (name === 'httpRange') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.contentBase64)) return false;
    const bytes = value.contentBase64.length / 4 * 3 - (value.contentBase64.endsWith('==') ? 2 : value.contentBase64.endsWith('=') ? 1 : 0);
    const end = value.offset + bytes;
    if (bytes > runtimeLimits.httpRangeBytes || end > value.resource.bytes
      || (value.nextOffset === null ? end !== value.resource.bytes : value.nextOffset !== end || bytes === 0)) return false;
    if (value.resource.kind === 'message' || value.resource.kind === 'queue_item') {
      try { new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.contentBase64), char => char.charCodeAt(0))); }
      catch { return false; }
    }
  }
  return true;
}

export function canonicalRuntimeJson(value, depth = 0) {
  if (depth > runtimeLimits.maxJsonDepth) throw new RuntimeProtocolError('invalid_params', 'Runtime JSON is nested too deeply.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalRuntimeJson(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalRuntimeJson(value[key], depth + 1)}`).join(',')}}`;
  throw new RuntimeProtocolError('invalid_params', 'Runtime JSON contains an unsupported value.');
}

export function validateRuntimeValue(name, value) {
  const maxBytes = ['snapshot', 'summarySnapshot', 'detailSnapshot', 'historyPage', 'inputDetail', 'inputPage', 'holdsPage', 'messagesPage', 'toolsPage', 'queuePage'].includes(name) ? runtimeLimits.httpPageBytes : runtimeLimits.wsMessageBytes;
  const canonical = canonicalRuntimeJson(value);
  if (new TextEncoder().encode(canonical).byteLength > maxBytes) throw new RuntimeProtocolError('payload_too_large', 'Runtime payload is too large. Use an HTTP attachment.');
  if (!matches({ $ref: `#/$defs/${name}` }, value)) throw new RuntimeProtocolError('invalid_params', `Invalid runtime ${name}.`);
  return value;
}

export function validateRuntimeChannelScope(channel, scope) {
  validateRuntimeValue('channel', channel);
  validateRuntimeValue('scope', scope);
  if (channel.kind === 'app' ? scope.kind !== 'catalog'
    : scope.kind !== 'branch' || scope.rootAgentInstanceRef !== channel.rootAgentInstanceRef) {
    throw new RuntimeProtocolError('invalid_scope', 'Runtime scope does not belong to this channel.');
  }
  return scope;
}

async function hashRuntimeValue(value) {
  const bytes = new TextEncoder().encode(canonicalRuntimeJson(value));
  const digest = typeof globalThis.crypto?.subtle?.digest === 'function'
    ? await globalThis.crypto.subtle.digest('SHA-256', bytes)
    : sha256(bytes);
  return `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function runtimeProjectionHash(scope) {
  return hashRuntimeValue(validateRuntimeValue('scope', scope));
}

export async function runtimeCommandHash(command) {
  return hashRuntimeValue(validateRuntimeValue('command', command));
}
