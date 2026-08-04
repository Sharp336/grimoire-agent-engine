"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LauncherBrowserHost, createPrivatePipeTransport } = require("../electron/browser-host.cjs");

const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(candidate => { resolve = candidate; });
  return { promise, resolve };
}

function pageFixture(index, options = {}) {
  let closed = 0;
  const locator = {
    first() { return this; }, last() { return this; }, nth() { return this; }, filter() { return this; },
    async waitFor() {}, async click() {}, async fill() {}, async setInputFiles() {},
    async isVisible() { return true; }, async isEnabled() { return true; }, async count() { return 0; },
    async allInnerTexts() { return []; }, async textContent() { return ""; },
  };
  const cdp = { async send() {}, async detach() {} };
  const page = {
    index,
    locator() { return locator; }, getByRole() { return locator; },
    context() { return { newCDPSession: async () => cdp }; },
    async goto() {}, url() { return "https://chatgpt.com/?temporary-chat=true"; },
    async close() {
      closed += 1;
      if (options.closeError) throw options.closeError;
    },
    closed: () => closed,
  };
  return page;
}

function hostFixture(options = {}) {
  const exit = deferred();
  const identity = { pid: 900, processStartIdentity: "start-1", executableIdentity: "chrome-1" };
  const cleanupCalls = { pipe: 0, browser: 0, terminate: 0, process: 0, login: 0 };
  const processHandle = {
    identity,
    wait: () => exit.promise,
    async terminate() {
      cleanupCalls.terminate += 1;
      if (options.terminateError) throw options.terminateError;
    },
    close() {
      cleanupCalls.process += 1;
      if (options.processCloseError) throw options.processCloseError;
    },
  };
  const pipe = {
    async *read() {},
    async write() {},
    async close() {
      cleanupCalls.pipe += 1;
      if (options.pipeCloseError) throw options.pipeCloseError;
    },
  };
  const launched = { process: processHandle, pipe };
  const launches = [];
  const native = {
    async launchVerifiedBrowser(spec) {
      launches.push(spec);
      options.launchEntered?.resolve();
      if (options.launchGate) return options.launchGate.promise;
      return options.launchFactory ? options.launchFactory(launches.length, launched) : launched;
    },
    matchesProcessIdentity(expected, actual) {
      return expected.pid === actual.pid && expected.processStartIdentity === actual.processStartIdentity && expected.executableIdentity === actual.executableIdentity;
    },
  };
  const pages = [];
  const context = {
    async newPage() {
      options.pageEntered?.resolve();
      const page = options.pageGate
        ? await options.pageGate.promise
        : pageFixture(pages.length, { closeError: options.pageCloseError });
      pages.push(page);
      return page;
    },
  };
  const connects = [];
  const browser = {
    contexts: () => [context],
    async close() {
      cleanupCalls.browser += 1;
      if (options.browserCloseError) throw options.browserCloseError;
    },
  };
  const chromium = {
    async connectOverCDP(transport, connectOptions) {
      connects.push({ transport, options: connectOptions });
      options.connectEntered?.resolve();
      if (options.connectGate) return options.connectGate.promise;
      return browser;
    },
  };
  const launchSpec = {
    executable: { identity: "verified-exe", sha256: "a".repeat(64) },
    environment: { kind: "opaque-browser-environment" },
    options: { headed: true, featureToggles: ["disable-background-networking"] },
  };
  const loginCalls = [];
  const loginHost = {
    async login(loginRequest) {
      loginCalls.push(loginRequest);
      options.loginEntered?.resolve();
      if (options.loginGate) return options.loginGate.promise;
      return { authenticated: true, verifiedAt: "2026-08-02T00:00:00.000Z", proAvailable: true, profileIdentity: "profile-1", executable: { identity: "verified-exe", sha256: "a".repeat(64), version: "1" } };
    },
    async close() {
      cleanupCalls.login += 1;
      if (options.loginCloseError) throw options.loginCloseError;
    },
  };
  const host = new LauncherBrowserHost({
    native,
    chromium,
    launchSpec,
    loginHost,
  });
  return {
    host,
    identity,
    exit,
    processHandle,
    pipe,
    launched,
    native,
    chromium,
    context,
    browser,
    loginHost,
    launches,
    connects,
    pages,
    launchSpec,
    loginCalls,
    cleanupCalls,
  };
}

const request = index => ({ sessionId: `session-${index}`, turnId: `turn-${index}`, modelKey: "gpt-5", mode: "browser-only", headed: true });

test("browser host launches only a verified executable/environment/private pipe and pinned transport overload", async () => {
  const state = hostFixture();
  const lease = await state.host.lease(request(1));
  assert.equal(state.launches.length, 1);
  assert.deepEqual(state.launches[0], state.launchSpec);
  assert.equal(state.connects.length, 1);
  assert.equal(typeof state.connects[0].transport.send, "function");
  assert.deepEqual(state.connects[0].options, { isLocal: true, noDefaults: true });
  assert.equal(Object.values(state.launches[0]).some(value => typeof value === "string" && value.includes("ws")), false);
  await lease.close();
  await lease.close();
  assert.equal(state.pages[0].closed(), 1);
  await state.host.close();
});

test("browser host delegates login through the package LoginHost without accepting executable paths", async () => {
  const state = hostFixture();
  const result = await state.host.login({ profileGeneration: "generation-1", ownerFence: "fence-1", headed: true });
  assert.equal(result.authenticated, true);
  assert.deepEqual(state.loginCalls, [{ profileGeneration: "generation-1", ownerFence: "fence-1", headed: true }]);
  await assert.rejects(state.host.login({ profileGeneration: "generation-1", ownerFence: "fence-1", headed: true, executableOverride: "C:\\\\attacker.exe" }), /invalid_login_request/);
  await state.host.close();
});

test("close waits for a pending login and rejects login after shutdown", async () => {
  const loginGate = deferred();
  const loginEntered = deferred();
  const state = hostFixture({ loginGate, loginEntered });
  const loginRequest = { profileGeneration: "generation-1", ownerFence: "fence-1", headed: true };
  const loggingIn = state.host.login(loginRequest);
  await loginEntered.promise;

  const closing = state.host.close();
  let settled = false;
  void closing.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  assert.equal(settled, false);

  loginGate.resolve({ authenticated: true });
  await assert.rejects(loggingIn, /browser_host_closed/);
  await closing;
  await assert.rejects(state.host.login(loginRequest), /browser_host_closed/);
  assert.deepEqual(state.loginCalls, [loginRequest]);
  assert.deepEqual(state.cleanupCalls, { pipe: 0, browser: 0, terminate: 0, process: 0, login: 1 });
});

test("five leases share one persistent context, sixth is rejected, and cancellation is isolated", async () => {
  const state = hostFixture();
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  const leases = [];
  for (let index = 0; index < 5; index += 1) leases.push(await state.host.lease({ ...request(index), signal: controllers[index].signal }));
  await assert.rejects(state.host.lease(request(6)), /browser_lease_limit/);
  controllers[1].abort();
  await tick();
  assert.equal(state.pages[1].closed(), 1);
  assert.equal(state.pages.filter(page => page.closed() > 0).length, 1);
  assert.equal(await leases[2].page.state(), "temporary-chat");
  const replacement = await state.host.lease(request(7));
  assert.equal(state.launches.length, 1);
  await replacement.close();
  await Promise.all(leases.map(lease => lease.close()));
  await state.host.close();
});

test("lease admission revalidates complete native child identity and rejects replacement", async () => {
  const state = hostFixture();
  const first = await state.host.lease(request(1));
  state.processHandle.identity = { ...state.identity, processStartIdentity: "reused-pid" };
  await assert.rejects(state.host.lease(request(2)), /browser_process_identity_changed/);
  await first.close();
  await state.host.close();
});

test("child-process exit clears owned state, closes stale resources, and forces a fresh launch", async () => {
  const nextExit = deferred();
  const state = hostFixture({
    launchFactory(launchNumber, launched) {
      if (launchNumber === 1) return launched;
      return { process: { ...launched.process, wait: () => nextExit.promise }, pipe: launched.pipe };
    },
  });
  await state.host.lease(request(1));

  state.exit.resolve();
  await tick();

  assert.equal(state.host.activeLeaseCount, 0);
  assert.equal(state.pages[0].closed(), 1);
  assert.deepEqual(state.cleanupCalls, { pipe: 1, browser: 1, terminate: 0, process: 1, login: 0 });

  const replacement = await state.host.lease(request(2));
  assert.equal(state.launches.length, 2);
  await replacement.close();
  await state.host.close();
});

test("child-process exit rejects and closes a page created by the stale context", async () => {
  const pageGate = deferred();
  const pageEntered = deferred();
  const state = hostFixture({ pageGate, pageEntered });
  const leasing = state.host.lease(request(1));
  await pageEntered.promise;

  state.exit.resolve();
  await tick();
  const latePage = pageFixture(0);
  pageGate.resolve(latePage);

  await assert.rejects(leasing, /browser_process_unavailable/);
  assert.equal(latePage.closed(), 1);
  assert.equal(state.host.activeLeaseCount, 0);
  await state.host.close();
});

test("close waits for a pending native launch and purges the late owned browser", async () => {
  const launchGate = deferred();
  const launchEntered = deferred();
  const state = hostFixture({ launchGate, launchEntered });
  const leasing = state.host.lease(request(1));
  await launchEntered.promise;

  const closing = state.host.close();
  let settled = false;
  void closing.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  assert.equal(settled, false);

  launchGate.resolve(state.launched);
  await assert.rejects(leasing, /browser_host_closed/);
  await closing;
  assert.equal(state.connects.length, 0);
  assert.deepEqual(state.cleanupCalls, { pipe: 1, browser: 0, terminate: 1, process: 1, login: 1 });
});

test("close waits for a pending CDP connection and closes every late launch resource", async () => {
  const connectGate = deferred();
  const connectEntered = deferred();
  const state = hostFixture({ connectGate, connectEntered });
  const leasing = state.host.lease(request(1));
  await connectEntered.promise;

  const closing = state.host.close();
  await tick();
  connectGate.resolve(state.browser);

  await assert.rejects(leasing, /browser_host_closed/);
  await closing;
  assert.equal(state.pages.length, 0);
  assert.deepEqual(state.cleanupCalls, { pipe: 1, browser: 1, terminate: 1, process: 1, login: 1 });
});

test("close waits for newPage and closes a page created after shutdown", async () => {
  const pageGate = deferred();
  const pageEntered = deferred();
  const state = hostFixture({ pageGate, pageEntered });
  const leasing = state.host.lease(request(1));
  await pageEntered.promise;

  const closing = state.host.close();
  const latePage = pageFixture(0);
  pageGate.resolve(latePage);

  await assert.rejects(leasing, /browser_host_closed/);
  await closing;
  assert.equal(latePage.closed(), 1);
  assert.equal(state.host.activeLeaseCount, 0);
  assert.deepEqual(state.cleanupCalls, { pipe: 1, browser: 1, terminate: 1, process: 1, login: 1 });
});

test("concurrent close callers share cleanup and aggregate failures after every attempt", async () => {
  const state = hostFixture({
    pageCloseError: new Error("page_close_failed"),
    loginCloseError: new Error("login_close_failed"),
    browserCloseError: new Error("browser_close_failed"),
    pipeCloseError: new Error("pipe_close_failed"),
    terminateError: new Error("terminate_failed"),
    processCloseError: new Error("process_close_failed"),
  });
  await state.host.lease(request(1));

  const first = state.host.close();
  const second = state.host.close();
  assert.equal(first, second);
  await assert.rejects(first, error => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.message, "browser_host_cleanup_failed");
    assert.equal(error.errors.length, 6);
    return true;
  });
  assert.equal(state.host.close(), first);
  assert.equal(state.pages[0].closed(), 1);
  assert.deepEqual(state.cleanupCalls, { pipe: 1, browser: 1, terminate: 1, process: 1, login: 1 });
});

test("browser boundary rejects endpoint/path/custom transport fields", () => {
  const state = hostFixture();
  assert.throws(() => new LauncherBrowserHost({
    native: { launchVerifiedBrowser() {}, matchesProcessIdentity() { return true; } },
    chromium: { connectOverCDP() {} },
    launchSpec: { ...state.launchSpec, endpointURL: "http://127.0.0.1:9222" },
    loginHost: { async login() {}, async close() {} },
  }), /invalid_verified_browser_launch_spec/);
});

test("private byte-pipe transport frames objects and rejects malformed/truncated input", async () => {
  const writes = [];
  let closes = 0;
  const pipe = {
    async *read() { yield Buffer.from('{"id":1}\0'); },
    async write(bytes) { writes.push(Buffer.from(bytes)); },
    async close() { closes += 1; },
  };
  const transport = createPrivatePipeTransport(pipe);
  const messages = [];
  const closed = deferred();
  transport.onmessage = message => messages.push(message);
  transport.onclose = reason => closed.resolve(reason);
  transport.open();
  transport.send({ id: 2, method: "Browser.getVersion" });
  assert.equal(await closed.promise, "private_browser_pipe_closed");
  await tick();
  assert.deepEqual(messages, [{ id: 1 }]);
  assert.equal(writes[0].toString("utf8"), '{"id":2,"method":"Browser.getVersion"}\0');
  assert.equal(closes, 1);
});
