"use strict";

const { normalizeMode } = require("./runtime-supervisor.cjs");

class RuntimeHost {
  constructor({ supervisor }) {
    if (!supervisor
      || typeof supervisor.start !== "function"
      || typeof supervisor.restart !== "function"
      || typeof supervisor.drain !== "function"
      || typeof supervisor.stop !== "function"
      || typeof supervisor.snapshot !== "function"
      || typeof supervisor.subscribe !== "function") {
      throw new TypeError("runtime_supervisor_invalid");
    }
    this.supervisor = supervisor;
  }

  start(modeOrOptions) {
    const mode = typeof modeOrOptions === "string" ? modeOrOptions : modeOrOptions?.mode;
    return this.supervisor.start({ mode: normalizeMode(mode) });
  }

  restart() { return this.supervisor.restart(); }
  drain() { return this.supervisor.drain(); }
  stop() { return this.supervisor.stop(); }
  snapshot() { return this.supervisor.snapshot(); }
  subscribe(listener) { return this.supervisor.subscribe(listener); }
  currentOperation() {
    const status = this.snapshot().status;
    return ["starting", "restarting", "draining"].includes(status) ? status : null;
  }
}

function createRuntimeHost(options) {
  return new RuntimeHost(options);
}

module.exports = { RuntimeHost, createRuntimeHost };
