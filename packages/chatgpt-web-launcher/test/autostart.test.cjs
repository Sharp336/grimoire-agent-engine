"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { LINUX_DESKTOP_NAME, getAutostart, linuxDesktopEntry, linuxDesktopPath, setAutostart } = require("../electron/autostart.cjs");

test("Linux autostart uses only the OMP namespace and an atomically owned entry", () => {
  const files = new Map();
  const env = { OMP_CONFIG_HOME: path.resolve("private-config"), OMP_CHATGPT_WEB_APPIMAGE: path.resolve("OMP App.Image") };
  const app = { isPackaged: true, getPath: () => assert.fail("explicit executable should win") };
  const options = {
    platform: "linux", env, home: path.resolve("home"),
    fs: { readFileSync(name) { if (!files.has(name)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(name); }, rmSync(name) { files.delete(name); } },
    writePrivateFileAtomic(name, value) { files.set(name, value); },
  };
  assert.equal(path.basename(linuxDesktopPath(options)), LINUX_DESKTOP_NAME);
  assert.deepEqual(setAutostart(app, true, options), { supported: true, enabled: true });
  assert.equal(getAutostart(app, options).enabled, true);
  const entry = linuxDesktopEntry(app, env.OMP_CHATGPT_WEB_APPIMAGE);
  assert.match(entry, /Name=OMP ChatGPT Web/);
  assert.match(entry, /OMP_CHATGPT_WEB_APPIMAGE=/);
  assert.doesNotMatch(entry, /CODEX|OPENAI/i);
  assert.deepEqual(setAutostart(app, false, options), { supported: true, enabled: false });
});

test("native login-item integration fails closed when the OS result disagrees", () => {
  const app = {
    isPackaged: true,
    setLoginItemSettings() {},
    getLoginItemSettings() { return { openAtLogin: false }; },
  };
  assert.throws(() => setAutostart(app, true, { platform: "win32" }), /autostart_state_mismatch/);
});
