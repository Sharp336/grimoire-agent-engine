/**
 * These tests defend the behaviours a phone depends on, not the shape of the
 * code. Each one fails on a plausible bug: a backoff that grows without a
 * ceiling, a reattach that forgets where the stream stopped, a replay that
 * double-renders a turn, an error frame mistaken for a dead link, an
 * unrecognised frame taken as a fatal parse failure.
 *
 * No live daemon and no wall-clock time: the socket, the scheduler, and the
 * randomness are all injected, so a twelve-second backoff costs nothing to test
 * and the assertions are exact rather than approximate.
 */

import { describe, expect, test } from "bun:test";
import { OmpdClient, computeBackoffDelay } from "../src/client.ts";
import type {
  BackoffOptions,
  ClientErrorEvent,
  CredentialVerdict,
  Scheduler,
  SocketCloseInfo,
  SocketLike,
  StatusEvent,
  UnauthorizedEvent,
  UpdateEvent,
} from "../src/client.ts";
import type { Agent, AgentId, ClientFrame, ServerFrame } from "@ompd/core/contracts";

const AGENT: AgentId = "agt_0123456789abcdef";

const AGENT_RECORD: Agent = {
  id: AGENT,
  name: "foundation",
  state: "busy",
  host: { kind: "local", id: "4242", spec: { kind: "local" } },
  cwd: "/work/ompd",
  createdAt: "2026-08-10T10:00:00.000Z",
  lastActiveAt: "2026-08-10T10:05:00.000Z",
  labels: {},
};

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientFrame[] = [];
  closedWith: SocketCloseInfo | null = null;

  onopen: (() => void) | null = null;
  onclose: ((info: SocketCloseInfo) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    const frame: ClientFrame = JSON.parse(data);
    this.sent.push(frame);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith !== null) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** The server accepted the connection. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The server sent a frame. `unknown` on purpose: junk must be testable. */
  deliver(frame: ServerFrame | Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The link died without a clean handshake, as a lost signal does. */
  drop(reason = "connection reset"): void {
    if (this.closedWith !== null) return;
    this.closedWith = { code: 1006, reason };
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason });
  }

  framesOfType<T extends ClientFrame["t"]>(t: T): Extract<ClientFrame, { t: T }>[] {
    const matches: Extract<ClientFrame, { t: T }>[] = [];
    for (const frame of this.sent) {
      if (frame.t === t) matches.push(frame as Extract<ClientFrame, { t: T }>);
    }
    return matches;
  }
}

interface ScheduledTask {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  done: boolean;
}

class ManualClock {
  readonly tasks: ScheduledTask[] = [];

  readonly schedule: Scheduler = (fn, ms) => {
    const task: ScheduledTask = { fn, ms, cancelled: false, done: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  /** Runs the oldest task still pending. Returns its delay. */
  runNext(): number {
    for (const task of this.tasks) {
      if (task.cancelled || task.done) continue;
      task.done = true;
      task.fn();
      return task.ms;
    }
    throw new Error("no pending scheduled task");
  }

  pendingDelays(): number[] {
    return this.tasks.filter((task) => !task.cancelled && !task.done).map((task) => task.ms);
  }
}

interface Harness {
  client: OmpdClient;
  clock: ManualClock;
  sockets: FakeSocket[];
  updates: UpdateEvent[];
  errors: ClientErrorEvent[];
  statuses: StatusEvent[];
  unauthorized: UnauthorizedEvent[];
  /** How many times the client asked whether the credential is still good. */
  probes: () => number;
  /** Settles every probe issued so far. Nothing is asked without an answer. */
  answerProbes: () => Promise<void>;
  /** The socket the client is currently using. */
  latest(): FakeSocket;
}

interface HarnessOptions {
  backoff?: Partial<BackoffOptions>;
  random?: () => number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /**
   * What the daemon says when asked whether the token still authenticates.
   * Defaults to `unknown`, which is what an unreachable daemon says and what
   * every test that is not about credentials wants.
   */
  verdict?: CredentialVerdict;
}

function harness(options: HarnessOptions = {}): Harness {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  const updates: UpdateEvent[] = [];
  const errors: ClientErrorEvent[] = [];
  const statuses: StatusEvent[] = [];
  const unauthorized: UnauthorizedEvent[] = [];
  const verdict = options.verdict ?? "unknown";
  const answers: Array<Promise<CredentialVerdict>> = [];

  const client = new OmpdClient({
    url: "ws://127.0.0.1:7717/v1/socket",
    token: "tok_test",
    backoff: options.backoff,
    random: options.random ?? (() => 0),
    schedule: clock.schedule,
    pingIntervalMs: options.pingIntervalMs ?? 15_000,
    pongTimeoutMs: options.pongTimeoutMs ?? 10_000,
    isOnline: () => true,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    // Injected like every other seam in this file, so no test reaches the
    // network to find out what an unreachable daemon would have said.
    probeCredential: () => {
      const answer = Promise.resolve(verdict);
      answers.push(answer);
      return answer;
    },
  });

  client.on("update", (event) => updates.push(event));
  client.on("error", (event) => errors.push(event));
  client.on("status", (event) => statuses.push(event));
  client.on("unauthorized", (event) => unauthorized.push(event));

  return {
    client,
    clock,
    sockets,
    updates,
    errors,
    statuses,
    unauthorized,
    probes: () => answers.length,
    // Chained onto the same promises the client is waiting on. Promise
    // reactions run in registration order and the client registered first,
    // so this resolves only after it has acted on every verdict. No clock.
    answerProbes: async () => {
      for (const answer of answers) await answer.then(() => undefined);
    },
    latest: () => {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("no socket has been created");
      return socket;
    },
  };
}

/** Brings a fresh socket all the way up: accepted, authenticated, `hello`. */
function bringUp(h: Harness, agents: Agent[] = [AGENT_RECORD]): FakeSocket {
  const socket = h.latest();
  socket.accept();
  socket.deliver({ t: "hello", deviceId: "dev_test", agents });
  return socket;
}

/**
 * Stands in for the daemon's replay: every update with `seq` greater than the
 * client's watermark, in order.
 *
 * `overlap` re-sends that many already-delivered updates on top, which is what
 * an inclusive-bound daemon would do. The client is required to absorb it, so
 * the tests exercise it deliberately rather than assuming the server is exact.
 */
function replay(socket: FakeSocket, log: string[], sinceSeq: number | undefined, overlap = 0): void {
  const from = Math.max(0, (sinceSeq ?? 0) - overlap);
  for (let index = from; index < log.length; index += 1) {
    socket.deliver({ t: "update", agentId: AGENT, seq: index + 1, update: log[index] });
  }
}

function lastAttachSeq(socket: FakeSocket): number | undefined {
  const attaches = socket.framesOfType("attach");
  const last = attaches.at(-1);
  if (!last) throw new Error("no attach frame was sent");
  return last.sinceSeq;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe("backoff", () => {
  const options: BackoffOptions = { baseMs: 500, maxMs: 30_000, factor: 2, jitter: 0.3 };

  test("grows exponentially and stops at the ceiling", () => {
    const noJitter = () => 0;
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 20].map((attempt) =>
      computeBackoffDelay(attempt, options, noJitter),
    );

    expect(delays.slice(0, 7)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    // The bug this catches: an uncapped `base * factor ** attempt`, which by
    // attempt 20 would be six days.
    expect(delays.at(-1)).toBe(30_000);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(options.maxMs);
  });

  test("jitter only ever shortens a wait, so the ceiling still holds", () => {
    const floor = Math.round(options.maxMs * (1 - options.jitter));
    expect(computeBackoffDelay(20, options, () => 1)).toBe(floor);
    expect(computeBackoffDelay(20, options, () => 0)).toBe(options.maxMs);
    for (const sample of [0, 0.17, 0.5, 0.83, 1]) {
      const delay = computeBackoffDelay(20, options, () => sample);
      expect(delay).toBeLessThanOrEqual(options.maxMs);
      expect(delay).toBeGreaterThanOrEqual(floor);
    }
  });

  test("two consecutive reconnect delays are never identical", () => {
    // Pinned at the ceiling with a fixed random, the formula alone would return
    // the same number every time. That is exactly the collision jitter exists
    // to prevent, so the client has to break the tie itself.
    const h = harness({
      backoff: { baseMs: 1_000, maxMs: 1_000, factor: 2, jitter: 0.4 },
      random: () => 0.5,
    });
    h.client.start();

    const scheduled: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      bringUp(h);
      h.latest().drop();
      const pending = h.clock.pendingDelays();
      const delay = pending.at(-1);
      expect(delay).toBeDefined();
      scheduled.push(delay ?? -1);
      h.clock.runNext();
    }

    for (let index = 1; index < scheduled.length; index += 1) {
      expect(scheduled[index]).not.toBe(scheduled[index - 1]);
    }
    for (const delay of scheduled) {
      expect(delay).toBeLessThanOrEqual(1_000);
      expect(delay).toBeGreaterThanOrEqual(600);
    }
  });

  test("a successful hello resets the growth", () => {
    const h = harness({ backoff: { baseMs: 500, maxMs: 30_000, factor: 2, jitter: 0 } });
    h.client.start();

    bringUp(h);
    h.latest().drop();
    expect(h.clock.pendingDelays().at(-1)).toBe(500);
    h.clock.runNext();

    // Second attempt fails before `hello`, so growth continues.
    h.latest().accept();
    h.latest().drop();
    expect(h.clock.pendingDelays().at(-1)).toBe(1_000);
    h.clock.runNext();

    // This one gets all the way up, which must put the client back to base.
    bringUp(h);
    h.latest().drop();
    expect(h.clock.pendingDelays().at(-1)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

describe("reconnect and resume", () => {
  test("reattaches from the watermark, with no gap and no duplicate", () => {
    const h = harness({ backoff: { baseMs: 250, maxMs: 5_000, factor: 2, jitter: 0.25 } });
    h.client.start();

    const log = ["one", "two", "three"];
    const first = bringUp(h);
    h.client.attach(AGENT);

    // A first attach has no watermark to resume from: the client asks for
    // everything and the daemon replays the transcript.
    expect(lastAttachSeq(first)).toBeUndefined();
    replay(first, log, undefined);
    expect(h.updates.map((event) => event.seq)).toEqual([1, 2, 3]);

    // Signal dies mid-turn. Work carries on daemon-side, which is the whole
    // point of the daemon owning agent lifetime.
    first.drop("signal lost");
    log.push("four", "five", "six");

    h.clock.runNext();
    const second = h.latest();
    expect(second).not.toBe(first);
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });

    // The assertion this whole file exists for.
    expect(lastAttachSeq(second)).toBe(3);

    // Replay with a one-frame overlap: a daemon using an inclusive bound would
    // resend seq 3, and the client must swallow it.
    replay(second, log, 3, 1);

    const seqs = h.updates.map((event) => event.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(h.updates.map((event) => event.update)).toEqual(["one", "two", "three", "four", "five", "six"]);
    expect(h.errors.filter((error) => error.code === "seq_gap")).toEqual([]);
    expect(h.client.watermark(AGENT)).toBe(6);
  });

  test("survives repeated drops without losing its place", () => {
    const h = harness({ backoff: { baseMs: 100, maxMs: 1_000, factor: 2, jitter: 0.5 } });
    h.client.start();

    const log: string[] = [];
    bringUp(h);
    h.client.attach(AGENT);

    for (let round = 0; round < 5; round += 1) {
      log.push(`chunk-${round}-a`, `chunk-${round}-b`);
      const socket = h.latest();
      replay(socket, log, h.client.watermark(AGENT), 1);
      socket.drop();
      h.clock.runNext();
      const next = h.latest();
      next.accept();
      next.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });
      expect(lastAttachSeq(next)).toBe(log.length);
    }

    const seqs = h.updates.map((event) => event.seq);
    expect(seqs).toEqual(Array.from({ length: 10 }, (_value, index) => index + 1));
    expect(h.errors.filter((error) => error.code === "seq_gap")).toEqual([]);
  });

  test("keeps a separate watermark per agent", () => {
    const other: AgentId = "agt_fedcba9876543210";
    const h = harness();
    h.client.start();
    bringUp(h);

    h.client.attach(AGENT);
    h.client.attach(other);

    const first = h.latest();
    first.deliver({ t: "update", agentId: AGENT, seq: 1, update: "a1" });
    first.deliver({ t: "update", agentId: AGENT, seq: 2, update: "a2" });
    first.deliver({ t: "update", agentId: other, seq: 1, update: "b1" });

    first.drop();
    h.clock.runNext();
    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });

    const attaches = second.framesOfType("attach");
    // A single shared counter would send the same `sinceSeq` for both, which
    // silently truncates one agent's transcript.
    expect(attaches).toEqual([
      { t: "attach", agentId: AGENT, sinceSeq: 2 },
      { t: "attach", agentId: other, sinceSeq: 1 },
    ]);
  });

  test("reports a gap rather than hiding it, and still delivers", () => {
    const h = harness();
    h.client.start();
    bringUp(h);
    h.client.attach(AGENT);

    const socket = h.latest();
    socket.deliver({ t: "update", agentId: AGENT, seq: 1, update: "a" });
    socket.deliver({ t: "update", agentId: AGENT, seq: 5, update: "e" });

    const gaps = h.errors.filter((error) => error.code === "seq_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.message).toContain("2..4");
    // Dropping the update would turn a visible fault into a silent one.
    expect(h.updates.map((event) => event.seq)).toEqual([1, 5]);
  });

  test("an explicit sinceSeq of zero asks for the whole transcript", () => {
    const h = harness();
    h.client.start();
    bringUp(h);

    h.client.attach(AGENT, { sinceSeq: 0 });
    expect(lastAttachSeq(h.latest())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A credential the daemon no longer accepts
// ---------------------------------------------------------------------------

describe("a rejected credential", () => {
  test("an ordinary drop keeps reconnecting and never gives up", async () => {
    // The behaviour everything below must not regress. A daemon that is down
    // says nothing about the token, and a client that forgot its pairing over
    // a restart would be the original defect wearing a new coat.
    const h = harness({ verdict: "unknown" });
    h.client.start();
    bringUp(h);

    h.latest().drop("signal lost");
    await h.answerProbes();

    expect(h.unauthorized).toEqual([]);
    expect(h.clock.pendingDelays()).toHaveLength(1);
    h.clock.runNext();
    expect(h.sockets).toHaveLength(2);
  });

  test("a handshake the daemon refused stops the loop and says why", async () => {
    // A browser sees a rejected upgrade as an anonymous 1006, identical to a
    // pulled cable. Only asking the daemon separates them.
    const h = harness({ verdict: "rejected" });
    h.client.start();

    h.latest().drop("closed before hello");
    expect(h.probes()).toBe(1);
    await h.answerProbes();

    expect(h.unauthorized).toHaveLength(1);
    expect(h.unauthorized[0]?.reason).toContain("rejected");
    // The pending retry is cancelled, so nothing hammers a daemon that will
    // refuse this token every single time.
    expect(h.clock.pendingDelays()).toEqual([]);
    expect(h.client.connectionState).toBe("offline");
  });

  test("a drop after hello is a dropped link, not a dead credential", async () => {
    // Even with the daemon ready to say 401, a connection that authenticated
    // and then died is an outage. Asking would be answering a question the
    // handshake already answered.
    const h = harness({ verdict: "rejected" });
    h.client.start();
    bringUp(h);

    h.latest().drop("signal lost");
    await h.answerProbes();

    expect(h.probes()).toBe(0);
    expect(h.unauthorized).toEqual([]);
    expect(h.clock.pendingDelays()).toHaveLength(1);
  });

  test("a scope refusal is not a dead credential", async () => {
    // The gateway answers `unauthorized` for a missing scope too. Forgetting
    // the pairing because a phone lacked `approve` would throw away a working
    // credential over a button it was never allowed to press.
    const h = harness({ verdict: "valid" });
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({
      t: "error",
      agentId: AGENT,
      code: "unauthorized",
      message: "decision refused: unknown request or missing approve scope",
    });
    await h.answerProbes();

    expect(h.probes()).toBe(1);
    expect(h.unauthorized).toEqual([]);
    // And the error still reaches the UI, which is what downgrades the
    // approval controls.
    expect(h.errors.at(-1)?.code).toBe("unauthorized");
    expect(socket.closedWith).toBeNull();
  });

  test("an unauthorized frame the daemon confirms ends the session", async () => {
    const h = harness({ verdict: "rejected" });
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({ t: "error", code: "unauthorized", message: "device dev_phone is revoked" });
    await h.answerProbes();

    expect(h.unauthorized).toHaveLength(1);
    expect(h.unauthorized[0]?.reason).toContain("revoked");
    expect(socket.closedWith?.code).toBe(4001);
    expect(h.clock.pendingDelays()).toEqual([]);
  });

  test("a flurry of refusals asks the daemon once", async () => {
    const h = harness({ verdict: "rejected" });
    h.client.start();
    const socket = bringUp(h);

    for (let i = 0; i < 5; i += 1) {
      socket.deliver({ t: "error", code: "unauthorized", message: "no" });
    }
    expect(h.probes()).toBe(1);

    await h.answerProbes();
    expect(h.unauthorized).toHaveLength(1);
  });

  test("reconnectNow does not restart a client the daemon has cut off", async () => {
    // The app calls this on every tab focus and every `online` event. Once the
    // credential is dead, those must not resurrect the loop.
    const h = harness({ verdict: "rejected" });
    h.client.start();

    h.latest().drop("closed before hello");
    await h.answerProbes();
    const before = h.sockets.length;

    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(before);
    expect(h.probes()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Frame handling
// ---------------------------------------------------------------------------

describe("frame handling", () => {
  test("an error frame surfaces on the emitter and leaves the socket up", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);
    h.client.attach(AGENT);

    socket.deliver({ t: "error", agentId: AGENT, message: "policy denied that tool", code: "policy" });

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toEqual({ message: "policy denied that tool", code: "policy", agentId: AGENT });

    // The link is a separate concern from the request that failed.
    expect(socket.closedWith).toBeNull();
    expect(h.sockets).toHaveLength(1);
    expect(h.client.connectionState).toBe("connected");

    socket.deliver({ t: "update", agentId: AGENT, seq: 1, update: "still flowing" });
    expect(h.updates.map((event) => event.update)).toEqual(["still flowing"]);
  });

  test("an unknown frame type is ignored rather than thrown", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);
    h.client.attach(AGENT);

    // A newer daemon speaking a frame this build has never heard of.
    expect(() => {
      socket.deliver({ t: "telemetry", agentId: AGENT, samples: [1, 2, 3] });
    }).not.toThrow();

    expect(h.errors).toEqual([]);
    expect(socket.closedWith).toBeNull();

    socket.deliver({ t: "update", agentId: AGENT, seq: 1, update: "after the unknown" });
    expect(h.updates.map((event) => event.update)).toEqual(["after the unknown"]);
  });

  test("malformed payloads are reported without killing the connection", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);

    expect(() => socket.onmessage?.({ data: "{not json" })).not.toThrow();
    expect(() => socket.onmessage?.({ data: JSON.stringify({ nope: true }) })).not.toThrow();
    expect(() => socket.onmessage?.({ data: new Uint8Array([1, 2]) })).not.toThrow();

    expect(h.errors.map((error) => error.code)).toEqual(["bad_frame", "bad_frame", "bad_frame"]);
    expect(socket.closedWith).toBeNull();
    expect(h.client.connectionState).toBe("connected");
  });

  test("speech and transcript frames are delivered to listeners, not swallowed", () => {
    const h = harness();
    const speech: Array<{ agentId: string; pcm: string }> = [];
    const transcripts: Array<{ text: string; final: boolean }> = [];
    h.client.on("speech", (event) => speech.push({ agentId: event.agentId, pcm: event.pcm }));
    h.client.on("transcript", (event) => transcripts.push({ text: event.text, final: event.final }));
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({ t: "speech", agentId: AGENT, pcm: "AAAA" });
    socket.deliver({ t: "transcript", agentId: AGENT, text: "hello", final: true });

    // Dropping these here is what made bi-directional voice one-directional:
    // the daemon synthesised an answer and the client threw it away.
    expect(speech).toEqual([{ agentId: AGENT, pcm: "AAAA" }]);
    expect(transcripts).toEqual([{ text: "hello", final: true }]);
    expect(h.errors).toEqual([]);
  });

  test("a say frame reaches listeners as text, with the seq it derives from", () => {
    // The load-bearing frame for a client that owns its own voice: it speaks
    // this text locally, so no audio has to cross the network at all. The
    // daemon emitted `say` while every client dropped it into `default`, which
    // made an on-device voice unreachable no matter what the phone could do.
    const h = harness();
    const said: Array<{ agentId: string; seq: number; text: string }> = [];
    h.client.on("say", (event) => {
      said.push({ agentId: event.agentId, seq: event.seq, text: event.text });
    });
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({ t: "say", agentId: AGENT, seq: 12, text: "Twelve tests passing." });

    expect(said).toEqual([{ agentId: AGENT, seq: 12, text: "Twelve tests passing." }]);
    expect(h.errors).toEqual([]);
  });

  test("say carries its own seq so a replayed summary is not spoken twice", () => {
    // A phone that drops mid-turn reattaches with `sinceSeq` and replays.
    // Without the seq on the frame a client cannot tell a fresh summary from
    // one it already read aloud, and the operator hears the turn twice.
    const h = harness();
    const seqs: number[] = [];
    h.client.on("say", (event) => seqs.push(event.seq));
    h.client.start();
    const socket = bringUp(h);

    socket.deliver({ t: "say", agentId: AGENT, seq: 12, text: "Done." });
    socket.deliver({ t: "say", agentId: AGENT, seq: 12, text: "Done." });
    socket.deliver({ t: "say", agentId: AGENT, seq: 19, text: "Also done." });

    // The client does not dedupe; it reports faithfully and hands the caller
    // what it needs to. Swallowing the repeat here would hide the replay from
    // a client that has a legitimate reason to see it.
    expect(seqs).toEqual([12, 12, 19]);
  });

  test("a client with no say listener is unharmed by a say frame", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);

    expect(() => socket.deliver({ t: "say", agentId: AGENT, seq: 3, text: "hi" })).not.toThrow();
    expect(h.errors).toEqual([]);
    expect(socket.closedWith).toBeNull();
  });

  test("a client with no voice listener is unharmed by a speech frame", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);

    // A build with no audio surface still has to survive the frame.
    expect(() => socket.deliver({ t: "speech", agentId: AGENT, pcm: "AAAA" })).not.toThrow();
    expect(h.errors).toEqual([]);
    expect(socket.closedWith).toBeNull();
  });

  test("a listener that throws cannot take the connection down", () => {
    const h = harness();
    h.client.on("update", () => {
      throw new Error("view is broken");
    });
    h.client.start();
    const socket = bringUp(h);
    h.client.attach(AGENT);

    expect(() => socket.deliver({ t: "update", agentId: AGENT, seq: 1, update: "x" })).not.toThrow();
    expect(socket.closedWith).toBeNull();
    expect(h.updates.map((event) => event.seq)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Outbound frames and liveness
// ---------------------------------------------------------------------------

describe("outbound frames", () => {
  test("prompt, cancel, and decide are shaped as the contract says", () => {
    const h = harness();
    h.client.start();
    const socket = bringUp(h);

    h.client.prompt(AGENT, "ship it");
    h.client.prompt(AGENT, "look at this", ["data:image/png;base64,AAAA"]);
    h.client.cancel(AGENT);
    h.client.decide(AGENT, "req_1", "allow", "always");
    h.client.decide(AGENT, "req_2", "deny");

    expect(socket.sent).toEqual([
      { t: "prompt", agentId: AGENT, text: "ship it" },
      { t: "prompt", agentId: AGENT, text: "look at this", images: ["data:image/png;base64,AAAA"] },
      { t: "cancel", agentId: AGENT },
      { t: "decide", agentId: AGENT, requestId: "req_1", choice: "allow", scope: "always" },
      { t: "decide", agentId: AGENT, requestId: "req_2", choice: "deny" },
    ]);
  });

  test("the token travels in the query string, not the body", () => {
    const h = harness();
    h.client.start();
    expect(h.latest().url).toBe("ws://127.0.0.1:7717/v1/socket?token=tok_test");
  });

  test("a prompt sent while disconnected is refused out loud, not queued", () => {
    const h = harness();
    h.client.start();
    bringUp(h);
    h.latest().drop();

    h.client.prompt(AGENT, "this must not be replayed later");

    expect(h.errors.some((error) => error.code === "offline")).toBe(true);
    h.clock.runNext();
    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });
    // Re-delivering an operator's instruction minutes late, to an agent that
    // has moved on, is worse than telling them it did not land.
    expect(second.framesOfType("prompt")).toEqual([]);
  });

  test("an attach issued while offline is resent on the next hello", () => {
    const h = harness();
    h.client.start();
    // No `hello` yet, so the socket is not usable.
    h.client.attach(AGENT);
    // Lifecycle frames are re-sent automatically, so their loss is not an error.
    expect(h.errors).toEqual([]);

    const socket = bringUp(h);
    expect(socket.framesOfType("attach")).toEqual([{ t: "attach", agentId: AGENT }]);
  });
});

describe("liveness", () => {
  test("a missing pong is treated as a dead link and triggers a reconnect", () => {
    const h = harness({ pingIntervalMs: 15_000, pongTimeoutMs: 10_000 });
    h.client.start();
    const socket = bringUp(h);

    // The ping timer, then the pong deadline with nothing answering it.
    expect(h.clock.runNext()).toBe(15_000);
    expect(socket.framesOfType("ping")).toEqual([{ t: "ping" }]);
    expect(h.clock.runNext()).toBe(10_000);

    expect(h.errors.some((error) => error.code === "timeout")).toBe(true);
    expect(socket.closedWith?.code).toBe(4000);
    // A half-open socket that is never noticed is how a turn goes missing.
    expect(h.statuses.at(-1)?.state).toBe("reconnecting");
  });

  test("a pong clears the deadline and the link stays up", () => {
    const h = harness({ pingIntervalMs: 15_000, pongTimeoutMs: 10_000 });
    h.client.start();
    const socket = bringUp(h);

    h.clock.runNext();
    socket.deliver({ t: "pong" });

    // The deadline is cancelled, so the only task left is the next ping.
    expect(h.clock.pendingDelays()).toEqual([15_000]);
    expect(socket.closedWith).toBeNull();
    expect(h.client.connectionState).toBe("connected");
  });

  test("close stops reconnecting", () => {
    const h = harness();
    h.client.start();
    bringUp(h);

    h.client.close();
    expect(h.statuses.at(-1)?.state).toBe("offline");
    expect(h.clock.pendingDelays()).toEqual([]);
    expect(h.sockets).toHaveLength(1);
  });

  test("reconnectNow skips a pending wait but never a connect in flight", () => {
    const h = harness({ backoff: { baseMs: 30_000, maxMs: 30_000, factor: 1, jitter: 0 } });
    h.client.start();
    bringUp(h);
    h.client.attach(AGENT);

    // Connected: nothing is waiting, so this is a no-op.
    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(1);

    h.latest().drop();
    expect(h.clock.pendingDelays()).toEqual([30_000]);

    // Back on wifi. Waiting out a thirty second backoff would be absurd.
    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(2);
    expect(h.clock.pendingDelays()).toEqual([]);

    // The retry has not landed yet. Another foreground event must not abandon
    // it and start a third, which is how a flaky link becomes a connect loop.
    h.client.reconnectNow();
    h.client.reconnectNow();
    expect(h.sockets).toHaveLength(2);

    const second = h.latest();
    second.accept();
    second.deliver({ t: "hello", deviceId: "dev_test", agents: [AGENT_RECORD] });
    expect(lastAttachSeq(second)).toBeUndefined();
    expect(h.client.connectionState).toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// Status reporting
// ---------------------------------------------------------------------------

describe("status", () => {
  test("reports connecting, connected, then reconnecting with a delay", () => {
    const h = harness({ backoff: { baseMs: 800, maxMs: 5_000, factor: 2, jitter: 0 } });
    h.client.start();
    expect(h.statuses.map((event) => event.state)).toEqual(["connecting"]);

    bringUp(h);
    expect(h.statuses.at(-1)?.state).toBe("connected");

    h.latest().drop("signal lost");
    const last = h.statuses.at(-1);
    expect(last?.state).toBe("reconnecting");
    expect(last?.delayMs).toBe(800);
    expect(last?.reason).toBe("signal lost");
  });

  test("says offline rather than reconnecting when the device has no network", () => {
    const clock = new ManualClock();
    const sockets: FakeSocket[] = [];
    const statuses: StatusEvent[] = [];
    let online = true;

    const client = new OmpdClient({
      url: "ws://127.0.0.1:7717/v1/socket",
      token: "tok_test",
      backoff: { baseMs: 300, maxMs: 1_000, factor: 2, jitter: 0 },
      random: () => 0,
      schedule: clock.schedule,
      isOnline: () => online,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    client.on("status", (event) => statuses.push(event));

    client.start();
    const socket = sockets.at(-1);
    socket?.accept();
    socket?.deliver({ t: "hello", deviceId: "dev_test", agents: [] });

    online = false;
    socket?.drop();

    // Both states retry. Only one of them is worth telling the operator to go
    // find some signal.
    expect(statuses.at(-1)?.state).toBe("offline");
    expect(statuses.at(-1)?.delayMs).toBe(300);
  });
});
