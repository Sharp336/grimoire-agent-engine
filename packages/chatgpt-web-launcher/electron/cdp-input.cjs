"use strict";

const MAX_TEXT_BYTES = 1_000_000;
const KEY_DEFINITIONS = Object.freeze({
  Enter: Object.freeze({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }),
  Escape: Object.freeze({ key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }),
  "ControlOrMeta+Enter": Object.freeze({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }),
});

function assertText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new TypeError("invalid_input_text");
  }
}

function keyEvents(key, platform = process.platform) {
  const definition = KEY_DEFINITIONS[key];
  if (!definition) throw new TypeError("unknown_keyboard_key");
  const modifiers = key === "ControlOrMeta+Enter" ? (platform === "darwin" ? 4 : 2) : 0;
  return [
    { type: "keyDown", ...definition, modifiers },
    { type: "keyUp", ...definition, modifiers },
  ];
}

class CdpInputBridge {
  #page;
  #session;
  #closed = false;

  constructor(page) {
    if (!page || typeof page.context !== "function") throw new TypeError("invalid_page");
    this.#page = page;
  }

  async #cdp() {
    if (this.#closed) throw new Error("input_bridge_closed");
    if (!this.#session) {
      const context = this.#page.context();
      if (!context || typeof context.newCDPSession !== "function") throw new Error("cdp_session_unavailable");
      this.#session = await context.newCDPSession(this.#page);
    }
    return this.#session;
  }

  async insertText(text) {
    assertText(text);
    const session = await this.#cdp();
    await session.send("Input.insertText", { text });
  }

  async press(key) {
    const session = await this.#cdp();
    for (const event of keyEvents(key)) await session.send("Input.dispatchKeyEvent", event);
  }

  async pressSequentially(text) {
    assertText(text);
    for (const character of text) await this.insertText(character);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const session = this.#session;
    this.#session = undefined;
    if (session && typeof session.detach === "function") await session.detach();
  }
}

module.exports = {
  CdpInputBridge,
  MAX_TEXT_BYTES,
  keyEvents,
};
