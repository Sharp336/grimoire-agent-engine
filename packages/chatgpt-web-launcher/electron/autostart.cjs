"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const LINUX_DESKTOP_NAME = "sh.omp.chatgpt-web.desktop";
const LOGIN_ARGUMENTS = Object.freeze(["--hidden"]);

function linuxDesktopPath(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const configHome = typeof env.OMP_CONFIG_HOME === "string" && env.OMP_CONFIG_HOME.trim()
    ? env.OMP_CONFIG_HOME.trim()
    : path.join(home, ".config");
  return path.join(configHome, "autostart", LINUX_DESKTOP_NAME);
}

function desktopExecArgument(value) {
  return `"${String(value).replaceAll("%", "%%").replace(/["`$\\]/g, "\\$&")}"`;
}

function linuxExecutable(app, options = {}) {
  const env = options.env ?? process.env;
  for (const name of ["OMP_CHATGPT_WEB_LAUNCHER_EXECUTABLE", "OMP_CHATGPT_WEB_APPIMAGE"]) {
    const value = env[name]?.trim();
    if (value && path.isAbsolute(value)) return value;
  }
  return app.getPath("exe");
}

function linuxDesktopEntry(app, executable = linuxExecutable(app)) {
  const quoted = desktopExecArgument(executable);
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=OMP ChatGPT Web\nComment=Start OMP ChatGPT Web in the background\nExec=/usr/bin/env APPIMAGE_EXTRACT_AND_RUN=1 OMP_CHATGPT_WEB_APPIMAGE=${quoted} ${quoted} --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
}

function linuxAutostartMatches(app, options = {}) {
  const fileSystem = options.fs ?? fs;
  try {
    return fileSystem.readFileSync(linuxDesktopPath(options), "utf8") === linuxDesktopEntry(
      app,
      linuxExecutable(app, options),
    );
  } catch {
    return false;
  }
}

function requireAutostartState(result, desired) {
  if (result.supported && result.enabled !== Boolean(desired)) throw new Error("autostart_state_mismatch");
  return result;
}

function setAutostart(app, enabled, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!app.isPackaged) return Object.freeze({ supported: false, enabled: false });
  if (platform === "linux") {
    const fileSystem = options.fs ?? fs;
    const target = linuxDesktopPath(options);
    if (enabled) {
      const writer = options.writePrivateFileAtomic ?? writePrivateFileAtomic;
      writer(target, linuxDesktopEntry(app, linuxExecutable(app, options)));
    } else {
      fileSystem.rmSync(target, { force: true });
    }
    return requireAutostartState(Object.freeze({
      supported: true,
      enabled: enabled ? linuxAutostartMatches(app, options) : false,
    }), enabled);
  }
  if (platform === "darwin" || platform === "win32") {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: Boolean(enabled), args: [...LOGIN_ARGUMENTS] });
    return requireAutostartState(Object.freeze({
      supported: true,
      enabled: app.getLoginItemSettings({ args: [...LOGIN_ARGUMENTS] }).openAtLogin === true,
    }), enabled);
  }
  return Object.freeze({ supported: false, enabled: false });
}

function getAutostart(app, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!app.isPackaged) return Object.freeze({ supported: false, enabled: false });
  if (platform === "linux") return Object.freeze({ supported: true, enabled: linuxAutostartMatches(app, options) });
  if (platform === "darwin" || platform === "win32") {
    return Object.freeze({
      supported: true,
      enabled: app.getLoginItemSettings({ args: [...LOGIN_ARGUMENTS] }).openAtLogin === true,
    });
  }
  return Object.freeze({ supported: false, enabled: false });
}

module.exports = {
  LINUX_DESKTOP_NAME,
  getAutostart,
  linuxAutostartMatches,
  linuxDesktopEntry,
  linuxDesktopPath,
  requireAutostartState,
  setAutostart,
};
