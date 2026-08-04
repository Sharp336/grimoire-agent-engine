"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  CSP,
  RENDERER_URL,
  createLauncherMain,
  resolveRendererAssetPath,
  createSecureLauncherWindow,
  fixedHelperPaths,
  installRendererGuards,
  isPackagedRendererResourceUrl,
  isPackagedRendererUrl,
  revalidateLauncherHelper,
  sanitizedChildEnvironment,
  secureWebPreferences,
  verifyLauncherHelper,
} = require("../electron/main.cjs");

const packageRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

test("isolated package pins the complete OMP dependency and build contract", () => {
  assert.equal(manifest.name, "@oh-my-pi/pi-chatgpt-web-launcher");
  assert.equal(manifest.version, "17.2.7");
  assert.equal(manifest.engines.bun, ">=1.3.14");
  for (const script of ["build", "build:runtime", "check", "check:types", "package", "prepare:runtime", "smoke:package", "test"]) {
    assert.equal(typeof manifest.scripts[script], "string", `missing script ${script}`);
  }
  assert.equal(manifest.scripts["check:types"], "tsgo -p tsconfig.json --noEmit");
  assert.equal(manifest.scripts.test, "node --test test/*.test.cjs");
  assert.equal(manifest.dependencies["playwright-core"], "1.62.1");
  assert.equal(manifest.dependencies["@oh-my-pi/pi-chatgpt-web"], "workspace:*");
  assert.equal(manifest.dependencies["@oh-my-pi/pi-natives"], "catalog:");
  assert.equal(manifest.dependencies.react, "catalog:");
  assert.equal(manifest.dependencies["react-dom"], "catalog:");
  assert.equal(manifest.dependencies.motion, "12.42.2");
  assert.equal(manifest.devDependencies.electron, "41.7.1");
  assert.equal(manifest.devDependencies["electron-builder"], "26.8.1");
  assert.equal(manifest.devDependencies["@vitejs/plugin-react"], "5.2.0");
  assert.equal(manifest.devDependencies["@types/node"], "22.10.2");
  assert.equal(manifest.build.appId, "sh.omp.chatgpt-web");
  assert.equal(manifest.build.productName, "OMP ChatGPT Web");
  assert.deepEqual(manifest.build.win.target, ["nsis"]);
  assert.deepEqual(manifest.build.linux.target, ["AppImage"]);
  assert.deepEqual(manifest.build.mac.target, ["dmg", "zip"]);
  assert.equal(JSON.parse(fs.readFileSync(require.resolve("playwright-core/package.json"), "utf8")).version, "1.62.1");
});

test("renderer uses a packaged origin, restrictive CSP, and locked BrowserWindow preferences", () => {
  assert.equal(isPackagedRendererUrl(RENDERER_URL), true);
  for (const candidate of ["https://omp.sh/", "file:///tmp/index.html", "omp-chatgpt-web://evil/index.html", `${RENDERER_URL}?token=x`, `${RENDERER_URL}#secret`]) {
    assert.equal(isPackagedRendererUrl(candidate), false);
  }
  assert.equal(isPackagedRendererResourceUrl("omp-chatgpt-web://launcher/assets/index-A1b2.js"), true);
  for (const candidate of [
    "omp-chatgpt-web://launcher/assets/../secret.js",
    "omp-chatgpt-web://launcher/assets/app.js?token=x",
    "omp-chatgpt-web://launcher/other/app.js",
  ]) assert.equal(isPackagedRendererResourceUrl(candidate), false);
  const distRoot = path.join(packageRoot, "dist");
  assert.equal(resolveRendererAssetPath(distRoot, RENDERER_URL), path.join(distRoot, "index.html"));
  assert.equal(
    resolveRendererAssetPath(distRoot, "omp-chatgpt-web://launcher/assets/index-A1b2.js"),
    path.join(distRoot, "assets", "index-A1b2.js"),
  );
  assert.throws(() => resolveRendererAssetPath(distRoot, "omp-chatgpt-web://launcher/assets/../secret.js"), /invalid_renderer_resource/);
  assert.deepEqual(secureWebPreferences(), {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webviewTag: false,
    enableRemoteModule: false,
    spellcheck: false,
  });
  assert.match(CSP, /default-src 'none'/);
  assert.match(CSP, /connect-src 'none'/);
  assert.match(CSP, /frame-src 'none'/);
  assert.match(CSP, /object-src 'none'/);
  let constructed;
  class BrowserWindow {
    constructor(options) { constructed = options; this.webContents = webContentsFixture().contents; }
  }
  const preloadPath = path.join(packageRoot, "electron", "preload.cjs");
  createSecureLauncherWindow(BrowserWindow, { preloadPath, webPreferences: { nodeIntegration: true }, show: true });
  assert.equal(constructed.webPreferences.preload, preloadPath);
  assert.equal(constructed.webPreferences.nodeIntegration, false);
  assert.equal(constructed.webPreferences.contextIsolation, true);
  assert.equal(constructed.webPreferences.sandbox, true);
  assert.throws(() => createSecureLauncherWindow(BrowserWindow, { preloadPath: "relative/preload.cjs" }), /invalid_preload_path/);
});

function webContentsFixture() {
  const events = new Map();
  let windowHandler;
  let headerHandler;
  const contents = {
    setWindowOpenHandler(handler) { windowHandler = handler; },
    on(name, handler) { events.set(name, handler); },
    session: { webRequest: { onHeadersReceived(handler) { headerHandler = handler; } } },
  };
  return { contents, events, windowHandler: () => windowHandler, headerHandler: () => headerHandler };
}

test("navigation, redirect, window-open, and CSP policies reject outside destinations", () => {
  const fixture = webContentsFixture();
  installRendererGuards({ webContents: fixture.contents });
  assert.deepEqual(fixture.windowHandler()({ url: "https://attacker.invalid" }), { action: "deny" });
  for (const eventName of ["will-navigate", "will-redirect", "did-redirect-navigation"]) {
    let prevented = false;
    fixture.events.get(eventName)({ preventDefault() { prevented = true; } }, "https://attacker.invalid", false, true);
    assert.equal(prevented, true);
  }
  let outside;
  fixture.headerHandler()({ url: "https://attacker.invalid", responseHeaders: {} }, value => { outside = value; });
  assert.deepEqual(outside, { cancel: true });
  let packaged;
  fixture.headerHandler()({ url: RENDERER_URL, responseHeaders: {} }, value => { packaged = value; });
  assert.equal(packaged.responseHeaders["Content-Security-Policy"][0], CSP);
  assert.deepEqual(packaged.responseHeaders["Cross-Origin-Opener-Policy"], ["same-origin"]);
  let asset;
  fixture.headerHandler()({ url: "omp-chatgpt-web://launcher/assets/index-A1b2.js", responseHeaders: {} }, value => { asset = value; });
  assert.equal(asset.cancel, undefined);
});

test("helper paths are derived under the versioned private root and verified from held native identities", async () => {
  const root = path.resolve("C:/private-omp-runtime");
  const version = "17.2.7";
  const scriptBytes = Buffer.from("console.log('launcher')", "utf8");
  const scriptHash = createHash("sha256").update(scriptBytes).digest("hex");
  const expected = { executableSha256: "a".repeat(64), scriptSha256: scriptHash, executableIdentity: "exe-id", scriptIdentity: "script-id" };
  const opened = [];
  const nativeModule = {
    async openVerifiedExecutable(spec) { opened.push(["executable", spec]); return { identity: "exe-id", sha256: spec.sha256, version: spec.version }; },
    NativeOwnedFile: { open(file, directory) { opened.push(["script", file, directory]); return { identity: "script-id", read: () => scriptBytes, close() {} }; } },
  };
  const verified = await verifyLauncherHelper({ nativeModule, privateInstallRoot: root, version, expected: { ...expected, executablePath: "C:/attacker.exe", scriptPath: "C:/attacker.js" } });
  const fixed = fixedHelperPaths(root, version);
  assert.equal(opened[0][1].path, fixed.executable);
  assert.equal(opened[1][1], fixed.script);
  assert.equal(opened.some(entry => JSON.stringify(entry).includes("attacker")), false);
  assert.equal(verified.script.identity, "script-id");
  verified.script.close();
  await assert.rejects(verifyLauncherHelper({ nativeModule: { ...nativeModule, NativeOwnedFile: { open() { throw new Error("reparse_or_broad_acl"); } } }, privateInstallRoot: root, version, expected }), /reparse_or_broad_acl/);
  await assert.rejects(verifyLauncherHelper({ nativeModule: { ...nativeModule, NativeOwnedFile: { open() { return { identity: "script-id", read: () => Buffer.from("replaced"), close() {} }; } } }, privateInstallRoot: root, version, expected }), /helper_script_hash_mismatch/);
});

test("helper replacement is rejected on immediate pre-use revalidation", async () => {
  const root = path.resolve("C:/private-omp-runtime");
  const bytes = Buffer.from("owned-script");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const expected = { executableSha256: "a".repeat(64), scriptSha256: hash, executableIdentity: "exe-id", scriptIdentity: "script-id" };
  let executableIdentity = "exe-id";
  const nativeModule = {
    async openVerifiedExecutable() { return { identity: executableIdentity }; },
    NativeOwnedFile: { open() { return { identity: "script-id", read: () => bytes, close() {} }; } },
  };
  const verified = await verifyLauncherHelper({ nativeModule, privateInstallRoot: root, version: "17.2.7", expected });
  executableIdentity = "replaced-exe";
  await assert.rejects(revalidateLauncherHelper(nativeModule, verified, expected), /helper_executable_identity_mismatch/);
  verified.script.close();
});

test("child environment is a minimal allowlist and assets are valid package resources", () => {
  const source = { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", PATH: "C:\\attacker", NODE_OPTIONS: "--require evil", SECRET: "canary" };
  assert.deepEqual({ ...sanitizedChildEnvironment(source, "win32") }, { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
  const png = fs.readFileSync(path.join(packageRoot, "assets", "icon.png"));
  const ico = fs.readFileSync(path.join(packageRoot, "assets", "icon.ico"));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
});

test("production factory dynamically adapts native ESM streams and binds package LoginHost to opaque profile authority", async () => {
  const clientIdentity = { pid: 800, processStartIdentity: "client-start", executableIdentity: "client-exe", ancestor: true };
  const ownerIdentity = { pid: 10, processStartIdentity: "owner-start", executableIdentity: "owner-exe" };
  const launcherIdentity = { pid: 700, processStartIdentity: "launcher-start", executableIdentity: "launcher-exe" };
  const pendingReads = [];
  const chunks = [];
  const writes = [];
  let responseReady;
  const response = new Promise(resolve => { responseReady = resolve; });
  const connection = {
    peer: clientIdentity,
    currentPeer: () => clientIdentity,
    read() {
      if (chunks.length) return Promise.resolve(chunks.shift());
      return new Promise(resolve => pendingReads.push(resolve));
    },
    async write(bytes) {
      writes.push(JSON.parse(Buffer.from(bytes).toString("utf8")));
      responseReady();
    },
    async close() {
      const resolve = pendingReads.shift();
      if (resolve) resolve(new Uint8Array());
      else chunks.push(new Uint8Array());
    },
  };
  let accepted = false;
  let rejectAccept;
  const rawListener = {
    endpoint: { kind: "owner-local" },
    accept() {
      if (!accepted) { accepted = true; return Promise.resolve(connection); }
      return new Promise((_resolve, reject) => { rejectAccept = reject; });
    },
    close() { rejectAccept?.(new Error("listener_closed")); },
  };
  const environments = [];
  const nativeModule = {
    NativeLocalListener: { create: () => rawListener },
    connectLocal() { throw new Error("server_does_not_connect"); },
    launchVerifiedBrowser() { throw new Error("login_must_not_start_persistent_browser"); },
    createLaunchEnvironment(profile) { environments.push(profile); return { opaque: "environment" }; },
    matchesProcessIdentity(left, right) {
      return left.pid === right.pid && left.processStartIdentity === right.processStartIdentity && left.executableIdentity === right.executableIdentity;
    },
    verifyPeerDescendant(peer) { return peer.ancestor === true; },
  };
  const loginCalls = [];
  let loginClosed = 0;
  const packageLoginHost = {
    async login(request) {
      loginCalls.push(request);
      return { authenticated: true, verifiedAt: "2026-08-02T00:00:00.000Z", proAvailable: true, profileIdentity: "profile-id", executable: { identity: "exe", sha256: "a".repeat(64), version: "1" } };
    },
    async close() { loginClosed += 1; },
  };
  const profile = {
    root: { opaque: "native-profile-root" },
    reference: { opaque: "secure-entry-reference" },
    config: { opaque: "runtime-config" },
    generation: "profile-generation",
    ownerFence: "owner-fence",
  };
  const authority = { ownerId: "owner", runtimeEpoch: "epoch", lifecycleGeneration: 1, launcherPid: 700, controlToken: "control-token" };
  const main = await createLauncherMain({
    nativeModule,
    authority,
    ownerIdentity,
    launcherIdentity,
    executable: { opaque: "verified-executable" },
    profile,
    browserOptions: { headed: true },
    packageLoginHost,
    playwrightChromium: { connectOverCDP() { throw new Error("not_needed_for_login"); } },
  });
  assert.deepEqual(environments, [{ kind: "browser-child", profileRoot: profile.root, profileGeneration: "profile-generation", ownerFence: "owner-fence" }]);
  const request = {
    version: 1,
    ownerId: "owner",
    runtimeEpoch: "epoch",
    lifecycleGeneration: 1,
    launcherNonce: main.descriptor.launcherNonce,
    controlToken: "control-token",
    clientPid: 800,
    connectionNonce: "connection-nonce",
    requestNonce: "request-nonce",
    sequence: 1,
    operation: "host.login",
    arguments: { profileGeneration: "profile-generation", ownerFence: "owner-fence" },
  };
  const resolveRead = pendingReads.shift();
  if (resolveRead) resolveRead(Buffer.from(`${JSON.stringify(request)}\n`));
  else chunks.push(Buffer.from(`${JSON.stringify(request)}\n`));
  await response;
  assert.equal(writes[0].ok, true);
  assert.equal(JSON.stringify(writes[0]).includes("control-token"), false);
  assert.equal(loginCalls.length, 1);
  const [{ signal, ...loginRequest }] = loginCalls;
  assert.deepEqual(loginRequest, {
    profile: profile.reference,
    config: profile.config,
    profileGeneration: "profile-generation",
    ownerFence: "owner-fence",
    headed: true,
  });
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(signal.aborted, false);
  await main.close();
  assert.equal(loginClosed, 1);
});
