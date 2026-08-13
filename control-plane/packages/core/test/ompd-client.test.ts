/**
 * The one property this client exists to guarantee: lossless resume.
 *
 * A caller (the TUI, the app, the web console) that reattaches after any kind
 * of disconnect — a network drop, or its own process dying and a fresh one
 * starting — must receive exactly the updates it missed. Every seam this
 * client touches is injected, so none of this needs a daemon, a socket, or
 * the wall clock.
 */

import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "../src/contracts.ts";
import { agentsEndpoint, type Cancel, OmpdClient, type SocketLike } from "../src/ompd-client.ts";

const OPEN = 1;

class FakeSocket implements SocketLike {
  readyState = OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((info: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames(): { t: string; [key: string]: unknown }[] {
    return this.sent.map(raw => JSON.parse(raw) as { t: string });
  }
}

class Clock {
  private readonly pending: { fn: () => void }[] = [];

  readonly schedule = (fn: () => void): Cancel => {
    const task = { fn };
    this.pending.push(task);
    return () => {
      const index = this.pending.indexOf(task);
      if (index >= 0) this.pending.splice(index, 1);
    };
  };

  fire(): void {
    const due = this.pending.splice(0, this.pending.length);
    for (const task of due) task.fn();
  }
}

function harness() {
  const clock = new Clock();
  const sockets: FakeSocket[] = [];
  const client = new OmpdClient({
    url: "ws://127.0.0.1:7717/v1/socket",
    token: "tok",
    schedule: clock.schedule,
    random: () => 0,
    isOnline: () => true,
    probeCredential: async () => "unknown",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const latest = (): FakeSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("no socket was opened");
    return socket;
  };
  return { client, clock, sockets, latest };
}

describe("OmpdClient resume", () => {
  test("attach with an explicit sinceSeq asks for exactly that watermark", () => {
    const h = harness();
    h.client.start();
    h.latest().onopen?.();
    h.latest().deliver({ t: "hello", deviceId: "dev", agents: [] });

    h.client.attach("a1", { sinceSeq: 3 });
    const attach = h.latest().frames().find(f => f.t === "attach");
    expect(attach).toEqual({ t: "attach", agentId: "a1", sinceSeq: 3 });
  });

  test("attach with no sinceSeq resumes from the client's own watermark on reconnect", () => {
    const h = harness();
    h.client.start();
    h.latest().onopen?.();
    h.latest().deliver({ t: "hello", deviceId: "dev", agents: [] });
    h.client.attach("a1", { sinceSeq: 0 });

    h.latest().deliver({ t: "update", agentId: "a1", seq: 1, update: { n: 1 } });
    h.latest().deliver({ t: "update", agentId: "a1", seq: 2, update: { n: 2 } });
    expect(h.client.watermark("a1")).toBe(2);

    // Connection drops; the client reconnects and re-`hello`s.
    h.latest().onclose?.({ code: 1006, reason: "" });
    h.clock.fire();
    h.latest().onopen?.();
    h.latest().deliver({ t: "hello", deviceId: "dev", agents: [] });

    const secondAttach = h.latest().frames().find(f => f.t === "attach");
    expect(secondAttach).toEqual({ t: "attach", agentId: "a1", sinceSeq: 2 });
  });

  test("a duplicate update at or below the watermark is dropped, not re-delivered", () => {
    const h = harness();
    const seen: number[] = [];
    h.client.on("update", event => seen.push(event.seq));
    h.client.start();
    h.latest().onopen?.();
    h.latest().deliver({ t: "hello", deviceId: "dev", agents: [] });
    h.client.attach("a1", { sinceSeq: 0 });

    h.latest().deliver({ t: "update", agentId: "a1", seq: 1, update: {} });
    h.latest().deliver({ t: "update", agentId: "a1", seq: 2, update: {} });
    // Replay overlap: the daemon resent seq 2 after a reattach race.
    h.latest().deliver({ t: "update", agentId: "a1", seq: 2, update: {} });

    expect(seen).toEqual([1, 2]);
  });

  test("agentsEndpoint maps a socket URL to the daemon's REST origin", () => {
    expect(agentsEndpoint("ws://127.0.0.1:7717/v1/socket?token=x")).toBe("http://127.0.0.1:7717/v1/agents");
    expect(agentsEndpoint("wss://ompd.example.com/v1/socket")).toBe("https://ompd.example.com/v1/agents");
    expect(agentsEndpoint("not a url")).toBeNull();
  });
});
