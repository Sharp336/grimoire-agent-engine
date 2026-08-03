"use strict";

const { randomBytes, timingSafeEqual } = require("node:crypto");

const PROTOCOL_VERSION = 1;
const MAX_LEASES = 5;
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const ALLOWED_ENVELOPE_KEYS = new Set([
  "version", "ownerId", "runtimeEpoch", "lifecycleGeneration", "launcherNonce", "controlToken", "clientPid",
  "connectionNonce", "requestNonce", "sequence", "operation", "leaseId", "leaseCapability", "arguments",
]);
const PUBLIC_OPERATIONS = new Set([
  "host.login", "host.close", "lease.open", "lease.cancel", "lease.close", "attachment.stage",
  "page.goto", "page.read-composer", "page.read-response", "page.read-health", "page.state", "page.close",
  "locator.click", "locator.fill", "locator.insert-text", "locator.press", "locator.press-sequentially",
  "locator.set-input-files", "locator.is-visible", "locator.is-enabled", "locator.count",
  "locator.all-inner-texts", "locator.text-content",
]);

class ControlProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "ControlProtocolError";
    this.code = code;
  }
}

function tokenMatches(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function plainRecord(value, code = "malformed_request") {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ControlProtocolError(code);
  }
  return value;
}

function boundedString(value, maximum, code) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new ControlProtocolError(code);
  }
  return value;
}

function safeResult(value) {
  if (value === undefined) return null;
  return value;
}

function errorCode(error) {
  if (error instanceof ControlProtocolError) return error.code;
  if (error && typeof error.message === "string") {
    const allowed = new Set([
      "aborted", "browser_host_closed", "browser_lease_closed", "browser_lease_limit",
      "browser_process_identity_changed", "browser_process_unavailable", "invalid_attachment_bytes",
      "invalid_attachment_capability", "invalid_attachment_name", "invalid_filter_target", "invalid_locator",
      "invalid_locator_chain", "invalid_locator_index", "invalid_locator_text", "invalid_navigation_target",
      "invalid_role_target", "locator_text_too_large", "locator_texts_too_large", "unknown_keyboard_key",
      "unknown_selector_key",
    ]);
    if (allowed.has(error.message)) return error.message;
  }
  return "operation_failed";
}

function samePeer(native, expected, actual) {
  return Boolean(native.matchesProcessIdentity(expected, actual));
}

function authorizedPeer(native, peer, ownerIdentity) {
  return samePeer(native, ownerIdentity, peer) || Boolean(native.verifyPeerDescendant(peer, ownerIdentity));
}

class JsonFrameChannel {
  #connection;
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(connection) {
    this.#connection = connection;
  }

  async *messages() {
    for await (const chunk of this.#connection.read()) {
      if (this.#closed) return;
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
      if (this.#buffer.length > MAX_FRAME_BYTES) throw new ControlProtocolError("frame_too_large");
      for (;;) {
        const boundary = this.#buffer.indexOf(10);
        if (boundary < 0) break;
        const frame = this.#buffer.subarray(0, boundary);
        this.#buffer = this.#buffer.subarray(boundary + 1);
        if (frame.length === 0) continue;
        let message;
        try { message = JSON.parse(frame.toString("utf8")); }
        catch { throw new ControlProtocolError("malformed_json"); }
        yield message;
      }
    }
    if (this.#buffer.length !== 0) throw new ControlProtocolError("truncated_frame");
  }

  async send(message) {
    if (this.#closed) throw new ControlProtocolError("connection_closed");
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (bytes.length > MAX_FRAME_BYTES) throw new ControlProtocolError("response_too_large");
    await this.#connection.write(bytes);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#connection.close();
  }
}

class AuthenticatedControlServer {
  #listener;
  #native;
  #host;
  #authority;
  #ownerIdentity;
  #launcherIdentity;
  #launcherNonce;
  #connections = new Set();
  #leases = new Map();
  #openingLeases = 0;
  #closedLeases = new Map();
  #closed = false;
  #acceptTask;
  #closeTask;

  constructor({ listener, native, browserHost, authority, ownerIdentity, launcherIdentity, launcherNonce = randomToken(24) }) {
    if (!listener || listener.endpoint?.kind !== "owner-local" || typeof listener.accept !== "function") {
      throw new TypeError("invalid_owner_local_listener");
    }
    if (!native || typeof native.matchesProcessIdentity !== "function" || typeof native.verifyPeerDescendant !== "function") {
      throw new TypeError("invalid_native_peer_adapter");
    }
    if (!browserHost || typeof browserHost.lease !== "function" || typeof browserHost.close !== "function") {
      throw new TypeError("invalid_browser_host");
    }
    plainRecord(authority, "invalid_lifecycle_authority");
    boundedString(authority.ownerId, 256, "invalid_owner");
    boundedString(authority.runtimeEpoch, 256, "invalid_runtime_epoch");
    if (!Number.isSafeInteger(authority.lifecycleGeneration) || authority.lifecycleGeneration < 1) {
      throw new TypeError("invalid_lifecycle_generation");
    }
    boundedString(authority.controlToken, 1024, "invalid_control_token");
    if (!Number.isSafeInteger(authority.launcherPid) || authority.launcherPid <= 0) throw new TypeError("invalid_launcher_pid");
    this.#listener = listener;
    this.#native = native;
    this.#host = browserHost;
    this.#authority = Object.freeze({ ...authority });
    this.#ownerIdentity = ownerIdentity;
    this.#launcherIdentity = launcherIdentity;
    this.#launcherNonce = launcherNonce;
  }

  start() {
    if (this.#acceptTask) return this;
    this.#acceptTask = this.#acceptLoop();
    return this;
  }

  descriptor() {
    return Object.freeze({
      version: PROTOCOL_VERSION,
      ownerId: this.#authority.ownerId,
      runtimeEpoch: this.#authority.runtimeEpoch,
      lifecycleGeneration: this.#authority.lifecycleGeneration,
      launcherPid: this.#authority.launcherPid,
      launcherNonce: this.#launcherNonce,
      launcherIdentity: this.#launcherIdentity,
      endpoint: this.#listener.endpoint,
    });
  }

  async #acceptLoop() {
    while (!this.#closed) {
      let connection;
      try { connection = await this.#listener.accept(); }
      catch {
        if (this.#closed) return;
        await this.#beginClose(null, true);
        return;
      }
      this.serveConnection(connection);
    }
  }

  serveConnection(connection) {
    const entry = { connection, channel: null, task: null, requestController: null, shutdownInitiator: false };
    const task = this.#serveConnection(entry);
    entry.task = task;
    this.#connections.add(entry);
    void task.then(
      () => this.#connections.delete(entry),
      () => this.#connections.delete(entry),
    );
    return task;
  }

  async #serveConnection(entry) {
    const { connection } = entry;
    if (this.#closed) {
      await connection.close();
      return;
    }
    const acceptedPeer = connection.peer;
    if (!authorizedPeer(this.#native, acceptedPeer, this.#ownerIdentity)) {
      await connection.close();
      return;
    }
    const state = { connectionNonce: null, sequence: 0, requestNonces: new Set() };
    const channel = new JsonFrameChannel(connection);
    entry.channel = channel;
    try {
      for await (const request of channel.messages()) {
        const requestController = new AbortController();
        entry.requestController = requestController;
        let response;
        try {
          const result = await this.handleRequest(connection, acceptedPeer, state, request, entry, requestController.signal);
          response = { version: PROTOCOL_VERSION, sequence: request?.sequence ?? 0, ok: true, result: safeResult(result) };
        } catch (error) {
          response = {
            version: PROTOCOL_VERSION,
            sequence: Number.isSafeInteger(request?.sequence) ? request.sequence : 0,
            ok: false,
            error: { code: errorCode(error) },
          };
        } finally {
          if (entry.requestController === requestController) entry.requestController = null;
        }
        if (this.#closed && !entry.shutdownInitiator) return;
        await channel.send(response);
        if (this.#closed) return;
      }
    } finally {
      entry.requestController?.abort();
      await channel.close().catch(() => {});
    }
  }

  async handleRequest(connection, acceptedPeer, state, rawRequest, connectionEntry = null, signal = undefined) {
    if (this.#closed) throw new ControlProtocolError("connection_closed");
    const request = plainRecord(rawRequest);
    if (Object.keys(request).some((key) => !ALLOWED_ENVELOPE_KEYS.has(key))) throw new ControlProtocolError("malformed_request");
    if (request.version !== PROTOCOL_VERSION) throw new ControlProtocolError("unsupported_protocol");
    if (request.ownerId !== this.#authority.ownerId) throw new ControlProtocolError("wrong_owner");
    if (request.runtimeEpoch !== this.#authority.runtimeEpoch) throw new ControlProtocolError("stale_runtime_epoch");
    if (request.lifecycleGeneration !== this.#authority.lifecycleGeneration) throw new ControlProtocolError("stale_lifecycle_generation");
    if (request.launcherNonce !== this.#launcherNonce) throw new ControlProtocolError("stale_launcher_nonce");
    if (!tokenMatches(this.#authority.controlToken, request.controlToken)) throw new ControlProtocolError("unauthorized");
    boundedString(request.connectionNonce, 256, "invalid_connection_nonce");
    boundedString(request.requestNonce, 256, "invalid_request_nonce");
    if (!Number.isSafeInteger(request.sequence) || request.sequence !== state.sequence + 1) {
      throw new ControlProtocolError(request.sequence <= state.sequence ? "replayed_sequence" : "out_of_order_sequence");
    }
    if (state.connectionNonce === null) state.connectionNonce = request.connectionNonce;
    else if (state.connectionNonce !== request.connectionNonce) throw new ControlProtocolError("wrong_connection_nonce");
    if (state.requestNonces.has(request.requestNonce)) throw new ControlProtocolError("replayed_request_nonce");
    const currentPeer = connection.currentPeer();
    if (!samePeer(this.#native, acceptedPeer, currentPeer)) throw new ControlProtocolError("peer_identity_changed");
    if (!authorizedPeer(this.#native, currentPeer, this.#ownerIdentity)) throw new ControlProtocolError("unauthorized_peer");
    if (!Number.isSafeInteger(request.clientPid) || request.clientPid !== currentPeer.pid) throw new ControlProtocolError("wrong_client_pid");
    boundedString(request.operation, 128, "unknown_operation");
    if (!PUBLIC_OPERATIONS.has(request.operation)) throw new ControlProtocolError("unknown_operation");
    const args = plainRecord(request.arguments, "malformed_arguments");
    state.sequence = request.sequence;
    state.requestNonces.add(request.requestNonce);
    if (state.requestNonces.size > 2048) {
      const oldest = state.requestNonces.values().next().value;
      state.requestNonces.delete(oldest);
    }
    return this.#dispatch(request, args, connectionEntry, signal);
  }

  #getLease(request, { allowClosed = false } = {}) {
    boundedString(request.leaseId, 256, "missing_lease");
    boundedString(request.leaseCapability, 256, "missing_lease_capability");
    const entry = this.#leases.get(request.leaseId);
    if (entry) {
      if (!tokenMatches(entry.capability, request.leaseCapability)) throw new ControlProtocolError("wrong_lease_capability");
      return entry;
    }
    const closedCapability = this.#closedLeases.get(request.leaseId);
    if (allowClosed && closedCapability && tokenMatches(closedCapability, request.leaseCapability)) return null;
    throw new ControlProtocolError(closedCapability ? "closed_lease" : "unknown_lease");
  }

  async #closeLease(request) {
    const entry = this.#getLease(request, { allowClosed: true });
    if (!entry) return Object.freeze({ closed: true });
    this.#leases.delete(entry.lease.id);
    this.#closedLeases.set(entry.lease.id, entry.capability);
    if (this.#closedLeases.size > 1024) this.#closedLeases.delete(this.#closedLeases.keys().next().value);
    entry.attachments.clear();
    await entry.lease.close();
    return Object.freeze({ closed: true });
  }

  #locator(entry, args) {
    const descriptor = plainRecord(args.locator, "invalid_locator");
    let locator;
    if (descriptor.kind === "selector") locator = entry.lease.page.locator(descriptor.key);
    else if (descriptor.kind === "role") locator = entry.lease.page.getByRole(descriptor.target);
    else throw new ControlProtocolError("invalid_locator");
    const chain = descriptor.chain ?? [];
    if (!Array.isArray(chain) || chain.length > 16) throw new ControlProtocolError("invalid_locator_chain");
    for (const rawStep of chain) {
      const step = plainRecord(rawStep, "invalid_locator_chain");
      if (step.kind === "nth") locator = locator.nth(step.index);
      else if (step.kind === "last") locator = locator.last();
      else if (step.kind === "filter") locator = locator.filter({ key: step.key, hasText: step.hasText });
      else throw new ControlProtocolError("invalid_locator_chain");
    }
    return locator;
  }

  async #dispatch(request, args, connectionEntry, signal) {
    switch (request.operation) {
      case "host.login":
        return this.#host.login({
          profileGeneration: boundedString(args.profileGeneration, 256, "invalid_profile_generation"),
          ownerFence: boundedString(args.ownerFence, 256, "invalid_owner_fence"),
          headed: true,
          signal,
        });
      case "host.close":
        await this.#beginClose(connectionEntry);
        return { closed: true };
      case "lease.open": {
        if (this.#leases.size + this.#openingLeases >= MAX_LEASES) throw new ControlProtocolError("browser_lease_limit");
        if ((args.mode !== "browser-only" && args.mode !== "full") || typeof args.headed !== "boolean") {
          throw new ControlProtocolError("invalid_lease_request");
        }
        this.#openingLeases++;
        try {
          const lease = await this.#host.lease({
            sessionId: boundedString(args.sessionId, 512, "invalid_session_id"),
            turnId: boundedString(args.turnId, 512, "invalid_turn_id"),
            modelKey: boundedString(args.modelKey, 512, "invalid_model_key"),
            mode: args.mode,
            headed: args.headed,
            signal,
          });
          if (signal?.aborted || this.#closed) {
            await lease.close().catch(() => {});
            throw new Error(signal?.aborted ? "aborted" : "connection_closed");
          }
          const capability = randomToken();
          this.#leases.set(lease.id, { lease, capability, attachments: new Map() });
          return Object.freeze({ leaseId: lease.id, leaseCapability: capability });
        } finally {
          this.#openingLeases--;
        }
      }
      case "lease.cancel":
      case "lease.close":
      case "page.close":
        return this.#closeLease(request);
      default:
        break;
    }
    const entry = this.#getLease(request);
    switch (request.operation) {
      case "attachment.stage": {
        boundedString(args.name, 255, "invalid_attachment_name");
        boundedString(args.base64, 30_000_000, "invalid_attachment_bytes");
        const bytes = Buffer.from(args.base64, "base64");
        if (bytes.toString("base64") !== args.base64 || bytes.length > 20_000_000) throw new ControlProtocolError("invalid_attachment_bytes");
        const attachment = await entry.lease.stageAttachment({ name: args.name, bytes });
        entry.attachments.set(attachment.id, attachment);
        return { id: attachment.id, name: attachment.name, size: attachment.size, sha256: attachment.sha256 };
      }
      case "page.goto": return entry.lease.page.goto(args.target);
      case "page.read-composer": return entry.lease.page.readComposerSnapshot();
      case "page.read-response": return entry.lease.page.readResponseSnapshot();
      case "page.read-health": return entry.lease.page.readHealthSnapshot();
      case "page.state": return entry.lease.page.state();
      default:
        break;
    }
    const locator = this.#locator(entry, args);
    switch (request.operation) {
      case "locator.click": return locator.click();
      case "locator.fill": return locator.fill(args.text);
      case "locator.insert-text": return locator.insertText(args.text);
      case "locator.press": return locator.press(args.key);
      case "locator.press-sequentially": return locator.pressSequentially(args.text);
      case "locator.set-input-files": {
        if (!Array.isArray(args.attachmentIds)) throw new ControlProtocolError("invalid_attachment_capability");
        const attachments = args.attachmentIds.map((id) => entry.attachments.get(id));
        if (attachments.some((attachment) => !attachment)) throw new ControlProtocolError("invalid_attachment_capability");
        return locator.setInputFiles(attachments);
      }
      case "locator.is-visible": return locator.isVisible();
      case "locator.is-enabled": return locator.isEnabled();
      case "locator.count": return locator.count();
      case "locator.all-inner-texts": return locator.allInnerTexts();
      case "locator.text-content": return locator.textContent();
      default: throw new ControlProtocolError("unknown_operation");
    }
  }

  publicState() {
    return Object.freeze({
      status: this.#closed ? "stopped" : "ready",
      activeLeases: this.#leases.size,
    });
  }

  #beginClose(currentConnection = null, skipAcceptTask = false) {
    if (!this.#closeTask && currentConnection) currentConnection.shutdownInitiator = true;
    if (!this.#closeTask) {
      this.#closed = true;
      this.#closeTask = this.#shutdown(currentConnection, skipAcceptTask);
    }
    return this.#closeTask;
  }

  async #shutdown(currentConnection, skipAcceptTask) {
    await this.#listener.close().catch(() => {});
    if (!skipAcceptTask && this.#acceptTask) await this.#acceptTask;
    const connections = [...this.#connections];
    const peers = connections.filter(entry => entry !== currentConnection);
    for (const entry of peers) entry.requestController?.abort();
    await Promise.allSettled(peers.map(entry => entry.channel?.close() ?? entry.connection.close()));
    const entries = [...this.#leases.values()];
    this.#leases.clear();
    await Promise.allSettled(entries.map(entry => entry.lease.close()));
    let hostCloseError;
    try { await this.#host.close(); }
    catch (error) { hostCloseError = error; }
    await Promise.allSettled(peers.map(entry => entry.task));
    if (hostCloseError) throw hostCloseError;
  }

  async close() {
    let closeError;
    try { await this.#beginClose(); }
    catch (error) { closeError = error; }
    await Promise.allSettled([...this.#connections].map(entry => entry.task));
    if (closeError) throw closeError;
  }
}

module.exports = {
  AuthenticatedControlServer,
  ControlProtocolError,
  JsonFrameChannel,
  MAX_FRAME_BYTES,
  MAX_LEASES,
  PROTOCOL_VERSION,
  PUBLIC_OPERATIONS,
  tokenMatches,
};
