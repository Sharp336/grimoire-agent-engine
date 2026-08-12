/**
 * The transport, as the app actually imports it.
 *
 * The web package has a much longer suite against its own copy. This one covers
 * the properties the port could plausibly have broken and the one behaviour
 * that genuinely changed for React Native: every seam the client reaches for is
 * injected, so nothing here needs a daemon, a socket, or the wall clock.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, agentsEndpoint, computeBackoffDelay, DEFAULT_BACKOFF } from "../src/client.ts";
import type { Cancel, SocketLike } from "../src/client.ts";

const OPEN = 1;

/** A socket that records what was sent and lets a test push frames back. */
class FakeSocket implements SocketLike {
  readyState = OPEN;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onclose: ((info: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed = { code, reason };
  }

  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames(): { t: string; [key: string]: unknown }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { t: string });
  }
}

/** A scheduler a test drives by hand, so backoff never costs wall time. */
class Clock {
  private readonly pending: { fn: () => void; ms: number }[] = [];

  readonly schedule = (fn: () => void, ms: number): Cancel => {
    const task = { fn, ms };
    this.pending.push(task);
    return () => {
      const index = this.pending.indexOf(task);
      if (index >= 0) this.pending.splice(index, 1);
    };
  };

  /** Runs every task queued at this instant. Tasks they queue wait for the next. */
  fire(): void {
    const due = this.pending.splice(0, this.pending.length);
    for (const task of due) task.fn();
  }

  get depth(): number {
    return this.pending.length;
  }
}

interface Harness {
  client: OmpdClient;
  clock: Clock;
  sockets: FakeSocket[];
  latest: () => FakeSocket;
}

function harness(): Harness {
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
  return {
    client,
    clock,
    sockets,
    latest: () => {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error("no socket was opened");
      return socket;
    },
  };
}

function agent(id: string): Agent {
  return {
    id,
    name: id,
    state: "idle",
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: "/tmp",
    createdAt: new Date(0).toISOString(),
    lastActiveAt: new Date(0).toISOString(),
    labels: {},
  };
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

describe("lossless resume", () => {
  test("a reconnect reattaches from the last delivered seq, not from zero", () => {
    const { client, clock, latest } = harness();
    const seen: number[] = [];
    client.on("update", (event) => seen.push(event.seq));

    client.start();
    latest().onopen?.();
    latest().deliver({ t: "hello", deviceId: "dev", agents: [agent("a1")] });
    client.attach("a1", { sinceSeq: 0 });
    latest().deliver({ t: "update", agentId: "a1", seq: 1, update: { sessionUpdate: "plan" } });
    latest().deliver({ t: "update", agentId: "a1", seq: 2, update: { sessionUpdate: "plan" } });

    const first = latest();
    first.onclose?.({ code: 1006, reason: "" });
    clock.fire();

    const second = latest();
    expect(second).not.toBe(first);
    second.onopen?.();
    second.deliver({ t: "hello", deviceId: "dev", agents: [agent("a1")] });

    const attach = second.frames().find((frame) => frame.t === "attach");
    expect(attach).toEqual({ t: "attach", agentId: "a1", sinceSeq: 2 });
    expect(seen).toEqual([1, 2]);
  });

  test("replayed updates at or below the watermark are dropped", () => {
    const { client, latest } = harness();
    const seen: number[] = [];
    client.on("update", (event) => seen.push(event.seq));

    client.start();
    latest().onopen?.();
    latest().deliver({ t: "hello", deviceId: "dev", agents: [] });
    latest().deliver({ t: "update", agentId: "a1", seq: 4, update: {} });
    latest().deliver({ t: "update", agentId: "a1", seq: 4, update: {} });
    latest().deliver({ t: "update", agentId: "a1", seq: 3, update: {} });
    latest().deliver({ t: "update", agentId: "a1", seq: 5, update: {} });

    expect(seen).toEqual([4, 5]);
    expect(client.watermark("a1")).toBe(5);
  });

  test("a gap in the sequence is reported rather than swallowed", () => {
    const { client, latest } = harness();
    const codes: (string | undefined)[] = [];
    client.on("error", (event) => codes.push(event.code));

    client.start();
    latest().onopen?.();
    latest().deliver({ t: "hello", deviceId: "dev", agents: [] });
    latest().deliver({ t: "update", agentId: "a1", seq: 1, update: {} });
    latest().deliver({ t: "update", agentId: "a1", seq: 4, update: {} });

    expect(codes).toContain("seq_gap");
  });
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe("backoff", () => {
  test("grows to the ceiling and stops", () => {
    const delays = [0, 1, 2, 3, 10, 40].map((attempt) =>
      computeBackoffDelay(attempt, DEFAULT_BACKOFF, () => 0),
    );
    expect(delays).toEqual([500, 1000, 2000, 4000, 30_000, 30_000]);
  });

  test("jitter only ever shortens a wait", () => {
    for (const random of [0, 0.5, 1]) {
      const delay = computeBackoffDelay(3, DEFAULT_BACKOFF, () => random);
      expect(delay).toBeLessThanOrEqual(4000);
      expect(delay).toBeGreaterThanOrEqual(4000 * (1 - DEFAULT_BACKOFF.jitter));
    }
  });

  test("two consecutive waits are never identical", () => {
    // Pinned at the ceiling with jitter off, the formula repeats itself, which
    // is the exact collision jitter exists to prevent.
    const { client, clock, sockets } = harness();
    client.start();
    for (let round = 0; round < 12; round += 1) {
      sockets.at(-1)?.onclose?.({ code: 1006, reason: "" });
      clock.fire();
    }
    expect(sockets.length).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

describe("frames", () => {
  test("say is delivered, not dropped into the default arm", () => {
    // The whole point of an on-device voice: a client that swallows `say` has
    // nothing to speak.
    const { client, latest } = harness();
    const spoken: { seq: number; text: string }[] = [];
    client.on("say", (event) => spoken.push({ seq: event.seq, text: event.text }));

    client.start();
    latest().onopen?.();
    latest().deliver({ t: "hello", deviceId: "dev", agents: [] });
    latest().deliver({ t: "say", agentId: "a1", seq: 9, text: "the build passed" });

    expect(spoken).toEqual([{ seq: 9, text: "the build passed" }]);
  });

  test("a frame this build has never heard of is ignored, not fatal", () => {
    const { client, latest } = harness();
    const errors: string[] = [];
    client.on("error", (event) => errors.push(event.message));

    client.start();
    latest().onopen?.();
    latest().deliver({ t: "hello", deviceId: "dev", agents: [] });
    latest().onmessage?.({ data: JSON.stringify({ t: "from_the_future", payload: 1 }) });

    expect(errors).toEqual([]);
    expect(client.connectionState).toBe("connected");
  });

  test("an instruction lost to a closed socket is reported; a ping is not", () => {
    const { client } = harness();
    const errors: string[] = [];
    client.on("error", (event) => errors.push(event.message));

    // Never started, so there is no socket at all.
    client.prompt("a1", "do the thing");
    client.attach("a1");

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("prompt");
  });

  test("a decision carries its scope only when one was chosen", () => {
    const { client, latest } = harness();
    client.start();
    latest().onopen?.();
    latest().deliver({ t: "hello", deviceId: "dev", agents: [] });

    client.decide("a1", "req-1", "allow");
    client.decide("a1", "req-2", "allow", "always");

    const decisions = latest()
      .frames()
      .filter((frame) => frame.t === "decide");
    expect(decisions).toEqual([
      { t: "decide", agentId: "a1", requestId: "req-1", choice: "allow" },
      { t: "decide", agentId: "a1", requestId: "req-2", choice: "allow", scope: "always" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The one thing the port changed
// ---------------------------------------------------------------------------

describe("credential probe endpoint", () => {
  test("maps a socket address onto the daemon's http origin", () => {
    // React Native's URL is getter-only and does not parse `ws://` at all, so
    // this mapping is string work. It has to survive a query and a fragment.
    expect(agentsEndpoint("ws://127.0.0.1:7717/v1/socket")).toBe("http://127.0.0.1:7717/v1/agents");
    expect(agentsEndpoint("wss://home.example:443/v1/socket?token=x#frag")).toBe(
      "https://home.example:443/v1/agents",
    );
    expect(agentsEndpoint("https://host/anything")).toBe("https://host/v1/agents");
  });

  test("an address that is not a socket url yields nothing to probe", () => {
    expect(agentsEndpoint("not a url")).toBeNull();
    expect(agentsEndpoint("ws://")).toBeNull();
    expect(agentsEndpoint("file:///etc/passwd")).toBeNull();
  });

  test("a rejected credential stops the retry loop", async () => {
    const clock = new Clock();
    const sockets: FakeSocket[] = [];
    let resolveProbe: (() => void) | null = null;
    const probed = new Promise<void>((resolve) => {
      resolveProbe = resolve;
    });

    const client = new OmpdClient({
      url: "ws://127.0.0.1:7717/v1/socket",
      token: "dead",
      schedule: clock.schedule,
      random: () => 0,
      isOnline: () => true,
      probeCredential: async () => {
        resolveProbe?.();
        return "rejected";
      },
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const reasons: string[] = [];
    client.on("unauthorized", (event) => reasons.push(event.reason));

    client.start();
    // Closed before `hello`, which is how a refused upgrade arrives.
    sockets.at(-1)?.onclose?.({ code: 1006, reason: "" });
    await probed;
    await Promise.resolve();

    expect(reasons.length).toBe(1);
    clock.fire();
    // Retrying a credential the daemon has withdrawn is the loop this breaks.
    expect(sockets.length).toBe(1);
    expect(client.connectionState).toBe("offline");
  });
});
