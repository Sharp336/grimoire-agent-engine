/** The paired app shell must make Cowork reachable with the Console selection as its task target. */

import "./rnw.ts";

import { expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic because rnw.ts must install the React Native shim before this graph resolves.
const { PairedShell } = await import("../src/screens/PairedShell.tsx");
const { renderToStaticMarkup } = await import("react-dom/server");

const connection: Connection = {
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "test-token",
  scopes: ["read", "prompt"],
};

const selectedAgent: Agent = {
  id: "agt_0000000000000001",
  name: "cartographer",
  state: "idle",
  host: { kind: "local", id: "laptop", spec: { kind: "local" } },
  cwd: "/Users/someone/dev/src/github.com/jwaldrip/oh-my-pi",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  labels: {},
};

test("the paired app shell reaches Cowork with Console's selected agent", () => {
  const html = renderToStaticMarkup(
    <PairedShell connection={connection} onUnpair={() => undefined} initialSurface="cowork" initialAgent={selectedAgent} />,
  );

  expect(html).toContain('data-testid="paired-shell"');
  expect(html).toContain('aria-label="Cowork"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('data-testid="cowork-screen"');
  expect(html).toContain('data-testid="task-sidebar"');
  expect(html).not.toContain('data-testid="cowork-needs-agent"');
});

test("Cowork fails closed until Console supplies a selected agent", () => {
  const html = renderToStaticMarkup(<PairedShell connection={connection} onUnpair={() => undefined} initialSurface="cowork" />);

  expect(html).toContain('data-testid="cowork-needs-agent"');
  expect(html).toContain("Select an agent in Console before starting a task.");
  expect(html).not.toContain('data-testid="cowork-screen"');
});
