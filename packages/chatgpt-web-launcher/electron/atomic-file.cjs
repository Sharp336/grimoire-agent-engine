"use strict";

const fs = require("node:fs");
const path = require("node:path");

const WINDOWS_RENAME_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 150, 250, 350, 500]);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
let sequence = 0;

function waitSync(milliseconds) {
  Atomics.wait(waitCell, 0, 0, milliseconds);
}

function renameAtomicFile(source, destination, options = {}) {
  const platform = options.platform ?? process.platform;
  const rename = options.rename ?? fs.renameSync;
  const wait = options.wait ?? waitSync;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const retryable = platform === "win32" && ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) throw error;
      wait(delay);
    }
  }
}

function writePrivateFileAtomic(filePath, content, options = {}) {
  const fileSystem = options.fs ?? fs;
  const rename = options.rename ?? ((source, destination) => renameAtomicFile(source, destination));
  const directory = path.dirname(filePath);
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fileSystem.chmodSync(directory, 0o700); } catch {}
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${++sequence}`;
  try {
    fileSystem.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    rename(temporary, filePath);
    try { fileSystem.chmodSync(filePath, 0o600); } catch {}
  } finally {
    fileSystem.rmSync(temporary, { force: true });
  }
}

module.exports = {
  WINDOWS_RENAME_RETRY_DELAYS_MS,
  renameAtomicFile,
  writePrivateFileAtomic,
};
