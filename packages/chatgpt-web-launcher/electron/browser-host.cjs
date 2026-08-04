"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { CdpInputBridge } = require("./cdp-input.cjs");

const MAX_LEASES = 5;
const MAX_PIPE_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 20_000_000;
const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const LOGIN_URL = "https://chatgpt.com/";
const SELECTORS = Object.freeze({
  composer: '[data-testid="prompt-textarea"], #prompt-textarea',
  send: 'button[data-testid="send-button"]',
  response: '[data-message-author-role="assistant"]',
  reasoning: '[data-message-author-role="assistant"] [data-testid="reasoning"]',
  commentary: '[data-message-author-role="assistant"] [data-testid="commentary"]',
  generation: '[data-message-author-role="assistant"]',
  "attachment-input": 'input[type="file"]',
  health: "main",
});
const ROLE_NAMES = Object.freeze({
  button: new Set(["Send", "Stop generating", "Attach files", "Regenerate"]),
  textbox: new Set(["Message", "Prompt"]),
  heading: new Set(["ChatGPT"]),
  main: new Set(),
});

function randomCapability(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function appendBytes(left, right) {
  if (left.length === 0) return Buffer.from(right);
  return Buffer.concat([left, Buffer.from(right)], left.length + right.length);
}

class PrivatePipeTransport {
  #pipe;
  #buffer = Buffer.alloc(0);
  #opened = false;
  #closed = false;
  #closing;
  #writeTail = Promise.resolve();
  onmessage;
  onclose;

  constructor(pipe) {
    if (!pipe || typeof pipe.read !== "function" || typeof pipe.write !== "function" || typeof pipe.close !== "function") {
      throw new TypeError("invalid_private_browser_pipe");
    }
    this.#pipe = pipe;
  }

  open() {
    if (this.#opened || this.#closed) return;
    this.#opened = true;
    void this.#readLoop();
  }

  send(message) {
    if (this.#closed || !message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("private_browser_pipe_closed");
    }
    const encoded = Buffer.from(`${JSON.stringify(message)}\0`, "utf8");
    if (encoded.length > MAX_PIPE_MESSAGE_BYTES) throw new Error("private_browser_message_too_large");
    this.#writeTail = this.#writeTail.then(() => this.#pipe.write(encoded)).catch(() => this.#fail("private_browser_pipe_write_failed"));
  }

  async #readLoop() {
    try {
      for await (const chunk of this.#pipe.read()) {
        if (this.#closed) break;
        this.#buffer = appendBytes(this.#buffer, chunk);
        if (this.#buffer.length > MAX_PIPE_MESSAGE_BYTES) throw new Error("private_browser_message_too_large");
        for (;;) {
          const boundary = this.#buffer.indexOf(0);
          if (boundary < 0) break;
          const frame = this.#buffer.subarray(0, boundary);
          this.#buffer = this.#buffer.subarray(boundary + 1);
          if (frame.length === 0) continue;
          let message;
          try {
            message = JSON.parse(frame.toString("utf8"));
          } catch {
            throw new Error("private_browser_message_malformed");
          }
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            throw new Error("private_browser_message_malformed");
          }
          this.onmessage?.(message);
        }
      }
      if (this.#buffer.length !== 0) throw new Error("private_browser_message_truncated");
      await this.#fail("private_browser_pipe_closed");
    } catch (error) {
      await this.#fail(error instanceof Error ? error.message : "private_browser_pipe_failed");
    }
  }

  #fail(reason) {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      try { await this.#pipe.close(); } finally { this.onclose?.(reason); }
    })();
    return this.#closing;
  }

  close() {
    return this.#fail("private_browser_transport_closed");
  }
}

function createPrivatePipeTransport(pipe) {
  return new PrivatePipeTransport(pipe);
}

function assertCurrentBrowserProcess(native, process, expectedIdentity) {
  if (!process || !process.identity || typeof native.matchesProcessIdentity !== "function") {
    throw new Error("browser_process_identity_unavailable");
  }
  if (!native.matchesProcessIdentity(expectedIdentity, process.identity)) {
    throw new Error("browser_process_identity_changed");
  }
}

function validateRole(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new TypeError("invalid_role_target");
  if (target.role === "main") {
    if (Object.keys(target).length !== 1) throw new TypeError("invalid_role_target");
    return;
  }
  const names = ROLE_NAMES[target.role];
  if (!names || !names.has(target.name) || Object.keys(target).length !== 2) throw new TypeError("invalid_role_target");
}

function resolveLocator(page, descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new TypeError("invalid_locator");
  let locator;
  if (descriptor.kind === "selector" && typeof descriptor.key === "string" && SELECTORS[descriptor.key]) {
    locator = page.locator(SELECTORS[descriptor.key]);
  } else if (descriptor.kind === "role") {
    validateRole(descriptor.target);
    locator = descriptor.target.role === "main"
      ? page.getByRole("main")
      : page.getByRole(descriptor.target.role, { name: descriptor.target.name, exact: true });
  } else {
    throw new TypeError("invalid_locator");
  }
  const chain = descriptor.chain ?? [];
  if (!Array.isArray(chain) || chain.length > 16) throw new TypeError("invalid_locator_chain");
  for (const step of chain) {
    if (step && step.kind === "nth" && Number.isSafeInteger(step.index) && step.index >= 0 && step.index < 256) {
      locator = locator.nth(step.index);
    } else if (step && step.kind === "last" && Object.keys(step).length === 1) {
      locator = locator.last();
    } else if (step && step.kind === "filter" && typeof step.key === "string" && SELECTORS[step.key]
      && (step.hasText === undefined || (typeof step.hasText === "string" && Buffer.byteLength(step.hasText) <= 512))) {
      const options = { has: page.locator(SELECTORS[step.key]) };
      if (step.hasText !== undefined) options.hasText = step.hasText;
      locator = locator.filter(options);
    } else {
      throw new TypeError("invalid_locator_chain");
    }
  }
  return locator;
}


class LauncherBrowserHost {
  #native;
  #chromium;
  #launchSpec;
  #loginHost;
  #browser;
  #context;
  #ownedBrowser;
  #processIdentity;
  #transport;
  #leases = new Map();
  #openingLeases = 0;
  #closed = false;
  #starting;
  #operations = new Set();
  #closing;

  constructor({ native, chromium, launchSpec, loginHost }) {
    if (!native || typeof native.launchVerifiedBrowser !== "function" || typeof native.matchesProcessIdentity !== "function") {
      throw new TypeError("invalid_native_browser_adapter");
    }
    if (!chromium || typeof chromium.connectOverCDP !== "function") throw new TypeError("invalid_playwright_chromium");
    if (!loginHost || typeof loginHost.login !== "function" || typeof loginHost.close !== "function") {
      throw new TypeError("invalid_login_host");
    }
    const launchKeys = launchSpec && typeof launchSpec === "object" ? Object.keys(launchSpec) : [];
    const optionKeys = launchSpec?.options && typeof launchSpec.options === "object" ? Object.keys(launchSpec.options) : [];
    const allowedToggles = new Set(["disable-background-networking", "disable-component-update", "disable-default-apps"]);
    if (!launchSpec || launchKeys.length !== 3 || launchKeys.some((key) => !["executable", "environment", "options"].includes(key))
      || !launchSpec.executable || !launchSpec.environment || !launchSpec.options
      || optionKeys.some((key) => key !== "headed" && key !== "featureToggles")
      || typeof launchSpec.options.headed !== "boolean"
      || (launchSpec.options.featureToggles !== undefined
        && (!Array.isArray(launchSpec.options.featureToggles)
          || launchSpec.options.featureToggles.some((toggle) => !allowedToggles.has(toggle))))) {
      throw new TypeError("invalid_verified_browser_launch_spec");
    }
    this.#native = native;
    this.#chromium = chromium;
    this.#launchSpec = Object.freeze({
      executable: launchSpec.executable,
      environment: launchSpec.environment,
      options: Object.freeze({ ...launchSpec.options }),
    });
    this.#loginHost = loginHost;
  }

  get activeLeaseCount() { return this.#leases.size; }

  async #start() {
    if (this.#closed) throw new Error("browser_host_closed");
    if (this.#browser) return;
    if (!this.#starting) this.#starting = this.#launch();
    await this.#starting;
  }

  async #launch() {
    const owned = await this.#native.launchVerifiedBrowser(this.#launchSpec);
    let transport;
    let browser;
    try {
      if (this.#closed) throw new Error("browser_host_closed");
      const processIdentity = owned.process.identity;
      assertCurrentBrowserProcess(this.#native, owned.process, processIdentity);
      transport = createPrivatePipeTransport(owned.pipe);
      browser = await this.#chromium.connectOverCDP(transport, { isLocal: true, noDefaults: true });
      if (this.#closed) throw new Error("browser_host_closed");
      const contexts = browser.contexts();
      if (!Array.isArray(contexts) || contexts.length !== 1) throw new Error("persistent_browser_context_unavailable");
      assertCurrentBrowserProcess(this.#native, owned.process, processIdentity);
      if (this.#closed) throw new Error("browser_host_closed");
      this.#processIdentity = processIdentity;
      this.#ownedBrowser = owned;
      this.#transport = transport;
      this.#browser = browser;
      this.#context = contexts[0];
      void owned.process.wait().then(
        () => this.#queueBrowserExit(owned),
        () => this.#queueBrowserExit(owned),
      );
    } catch (error) {
      const errors = [error];
      if (browser) {
        try { await browser.close(); } catch (cleanupError) { errors.push(cleanupError); }
      }
      try {
        if (transport) await transport.close();
        else await owned.pipe.close();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      try { await owned.process.terminate(); } catch (cleanupError) { errors.push(cleanupError); }
      try { owned.process.close(); } catch (cleanupError) { errors.push(cleanupError); }
      if (errors.length > 1) {
        throw new AggregateError(errors, error instanceof Error ? error.message : "browser_launch_failed");
      }
      throw error;
    }
  }

  #queueBrowserExit(owned) {
    const operation = Promise.resolve().then(() => this.#browserExited(owned));
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
  }

  async #browserExited(owned) {
    if (this.#closed || this.#ownedBrowser !== owned) return;
    const leases = [...this.#leases.values()];
    const browser = this.#browser;
    const transport = this.#transport;
    this.#leases.clear();
    this.#browser = undefined;
    this.#context = undefined;
    this.#ownedBrowser = undefined;
    this.#processIdentity = undefined;
    this.#transport = undefined;
    this.#starting = undefined;

    const cleanups = leases.map((lease) => lease.close());
    if (browser) cleanups.push(Promise.resolve().then(() => browser.close()));
    if (transport) cleanups.push(Promise.resolve().then(() => transport.close()));
    cleanups.push(Promise.resolve().then(() => owned.process.close()));
    await Promise.allSettled(cleanups);
  }

  #assertProcess() {
    if (!this.#ownedBrowser || !this.#processIdentity) throw new Error("browser_process_unavailable");
    assertCurrentBrowserProcess(this.#native, this.#ownedBrowser.process, this.#processIdentity);
  }

  async login(request) {
    if (!request || request.headed !== true || typeof request.profileGeneration !== "string"
      || typeof request.ownerFence !== "string"
      || Object.keys(request).some((key) => !["profileGeneration", "ownerFence", "headed", "signal"].includes(key))) {
      throw new TypeError("invalid_login_request");
    }
    const operation = this.#login(request);
    this.#operations.add(operation);
    try {
      return await operation;
    } finally {
      this.#operations.delete(operation);
    }
  }

  async #login(request) {
    if (this.#closed) throw new Error("browser_host_closed");
    const result = await this.#loginHost.login(request);
    if (this.#closed) throw new Error("browser_host_closed");
    return result;
  }

  async lease(request) {
    if (!request || typeof request.sessionId !== "string" || !request.sessionId
      || typeof request.turnId !== "string" || !request.turnId || typeof request.modelKey !== "string"
      || (request.mode !== "browser-only" && request.mode !== "full") || typeof request.headed !== "boolean") {
      throw new TypeError("invalid_lease_request");
    }
    if (this.#closed) throw new Error("browser_host_closed");
    if (this.#leases.size + this.#openingLeases >= MAX_LEASES) throw new Error("browser_lease_limit");
    this.#openingLeases++;
    const operation = this.#lease(request);
    this.#operations.add(operation);
    try {
      return await operation;
    } finally {
      this.#openingLeases--;
      this.#operations.delete(operation);
    }
  }

  async #lease(request) {
    await this.#start();
    if (this.#closed) throw new Error("browser_host_closed");
    this.#assertProcess();
    const owned = this.#ownedBrowser;
    const context = this.#context;
    const id = randomCapability(18);
    const capability = Object.freeze({ value: randomCapability(), __opaque: Symbol("browser-lease") });
    const page = await context.newPage();
    const unavailable = this.#ownedBrowser !== owned || this.#context !== context;
    if (this.#closed || unavailable) {
      const lifecycleError = new Error(this.#closed ? "browser_host_closed" : "browser_process_unavailable");
      try {
        await page.close();
      } catch (error) {
        throw new AggregateError([lifecycleError, error], lifecycleError.message);
      }
      throw lifecycleError;
    }
    const input = new CdpInputBridge(page);
    const attachments = new Map();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      this.#leases.delete(id);
      attachments.clear();
      const results = await Promise.allSettled([input.close(), page.close()]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, "browser_lease_cleanup_failed");
    };
    const assertOpen = () => {
      if (closed) throw new Error("browser_lease_closed");
      this.#assertProcess();
    };
    const makeLocator = (descriptor) => {
      const facade = {
        async click() { assertOpen(); await resolveLocator(page, descriptor).click(); },
        async fill(text) {
          assertOpen();
          if (typeof text !== "string" || Buffer.byteLength(text) > 1_000_000) throw new TypeError("invalid_locator_text");
          await resolveLocator(page, descriptor).fill(text);
        },
        async insertText(text) { assertOpen(); await input.insertText(text); },
        async press(key) { assertOpen(); await input.press(key); },
        async pressSequentially(text) { assertOpen(); await input.pressSequentially(text); },
        async setInputFiles(files) {
          assertOpen();
          if (!Array.isArray(files) || files.some((file) => !attachments.has(file))) throw new TypeError("invalid_attachment_capability");
          const payloads = files.map((file) => {
            const attachment = attachments.get(file);
            return { name: attachment.name, mimeType: "application/octet-stream", buffer: attachment.bytes };
          });
          await resolveLocator(page, descriptor).setInputFiles(payloads);
        },
        async isVisible() { assertOpen(); return resolveLocator(page, descriptor).isVisible(); },
        async isEnabled() { assertOpen(); return resolveLocator(page, descriptor).isEnabled(); },
        async count() { assertOpen(); return resolveLocator(page, descriptor).count(); },
        nth(index) {
          if (!Number.isSafeInteger(index) || index < 0 || index >= 256) throw new TypeError("invalid_locator_index");
          return makeLocator({ ...descriptor, chain: [...(descriptor.chain ?? []), { kind: "nth", index }] });
        },
        last() { return makeLocator({ ...descriptor, chain: [...(descriptor.chain ?? []), { kind: "last" }] }); },
        async allInnerTexts() {
          assertOpen();
          const texts = await resolveLocator(page, descriptor).allInnerTexts();
          if (!Array.isArray(texts) || texts.length > 256 || texts.some((text) => typeof text !== "string" || Buffer.byteLength(text) > 1_000_000)) {
            throw new Error("locator_texts_too_large");
          }
          return Object.freeze(texts.slice());
        },
        async textContent() {
          assertOpen();
          const text = await resolveLocator(page, descriptor).textContent();
          if (text !== null && (typeof text !== "string" || Buffer.byteLength(text) > 1_000_000)) throw new Error("locator_text_too_large");
          return text;
        },
        filter(target) {
          if (!target || typeof target !== "object" || !SELECTORS[target.key]
            || (target.hasText !== undefined && (typeof target.hasText !== "string" || Buffer.byteLength(target.hasText) > 512))) {
            throw new TypeError("invalid_filter_target");
          }
          return makeLocator({ ...descriptor, chain: [...(descriptor.chain ?? []), { kind: "filter", ...target }] });
        },
      };
      return facade;
    };
    const pageFacade = {
      async goto(target) {
        assertOpen();
        if (!target || target.kind !== "temporary-chat" || Object.keys(target).length !== 1) throw new TypeError("invalid_navigation_target");
        await page.goto(TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded" });
      },
      locator(key) {
        if (typeof key !== "string" || !SELECTORS[key]) throw new TypeError("unknown_selector_key");
        return makeLocator({ kind: "selector", key, chain: [] });
      },
      getByRole(target) { validateRole(target); return makeLocator({ kind: "role", target: { ...target }, chain: [] }); },
      async readComposerSnapshot() {
        assertOpen();
        const composer = page.locator(SELECTORS.composer).first();
        const text = await composer.textContent() ?? "";
        if (Buffer.byteLength(text) > 1_000_000) throw new Error("composer_text_too_large");
        return Object.freeze({ ready: await composer.isVisible(), text, canSubmit: await page.locator(SELECTORS.send).first().isEnabled().catch(() => false) });
      },
      async readResponseSnapshot() {
        assertOpen();
        const user = page.locator('[data-message-author-role="user"]').last();
        const assistant = page.locator(SELECTORS.response).last();
        const userText = await user.textContent() ?? "";
        const assistantText = await assistant.textContent() ?? "";
        const reasoningText = await page.locator(SELECTORS.reasoning).last().textContent().catch(() => null) ?? "";
        if ([userText, assistantText, reasoningText].some((text) => Buffer.byteLength(text) > 8_000_000)) throw new Error("response_text_too_large");
        return Object.freeze({ userText, assistantText, reasoningText, generationId: null, settled: await page.locator('button[data-testid="stop-button"]').count() === 0 });
      },
      async readHealthSnapshot() {
        assertOpen();
        const temporaryChat = new URL(page.url()).searchParams.get("temporary-chat") === "true";
        return Object.freeze({ temporaryChat, ready: await page.locator(SELECTORS.composer).first().isVisible(), errorClass: null });
      },
      async state() {
        if (closed) return "closed";
        const parsed = new URL(page.url());
        return parsed.origin === "https://chatgpt.com" && parsed.searchParams.get("temporary-chat") === "true" ? "temporary-chat" : "other";
      },
      close,
    };
    const lease = {
      id,
      capability,
      page: pageFacade,
      async stageAttachment({ name, bytes }) {
        assertOpen();
        if (typeof name !== "string" || !name || Buffer.byteLength(name) > 255 || /[\u0000-\u001f\u007f\\/]/u.test(name)) {
          throw new TypeError("invalid_attachment_name");
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new TypeError("invalid_attachment_bytes");
        const ownedBytes = Buffer.from(bytes);
        const attachment = Object.freeze({
          id: randomCapability(18),
          name,
          size: ownedBytes.length,
          sha256: createHash("sha256").update(ownedBytes).digest("hex"),
          __opaque: Symbol("browser-attachment"),
        });
        attachments.set(attachment, { name, bytes: ownedBytes });
        return attachment;
      },
      close,
    };
    this.#leases.set(id, lease);
    if (request.signal) {
      if (request.signal.aborted) await close();
      else request.signal.addEventListener("abort", () => { void close().catch(() => {}); }, { once: true });
    }
    return lease;
  }

  close() {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = this.#close();
    }
    return this.#closing;
  }

  async #close() {
    const errors = [];
    await Promise.allSettled([...this.#operations]);

    const leases = [...this.#leases.values()];
    this.#leases.clear();
    for (const result of await Promise.allSettled(leases.map((lease) => lease.close()))) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    try { await this.#loginHost.close(); } catch (error) { errors.push(error); }
    try { await this.#browser?.close(); } catch (error) { errors.push(error); }
    try { await this.#transport?.close(); } catch (error) { errors.push(error); }
    try { await this.#ownedBrowser?.process.terminate(); } catch (error) { errors.push(error); }
    try { this.#ownedBrowser?.process.close(); } catch (error) { errors.push(error); }

    this.#browser = undefined;
    this.#context = undefined;
    this.#ownedBrowser = undefined;
    this.#processIdentity = undefined;
    this.#transport = undefined;
    this.#starting = undefined;
    if (errors.length > 0) throw new AggregateError(errors, "browser_host_cleanup_failed");
  }
}

module.exports = {
  LauncherBrowserHost,
  MAX_LEASES,
  MAX_PIPE_MESSAGE_BYTES,
  createPrivatePipeTransport,
  resolveLocator,
};
