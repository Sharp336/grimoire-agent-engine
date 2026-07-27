import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	discoverRelayLinks,
	registerDaemonProjectPresence,
	sendCommand,
} from "../../src/launch/presence";

describe("relay-link registry + command socket", () => {
	it("second process discovers first via relayLink/roomKey in presence registry", async () => {
		using tempDir = TempDir.createSync("@omp-presence-relay-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const relayLink1 = "omp://session/alpha-001";
		const roomKey1 = "room-key-alpha";

		const presence1 = await registerDaemonProjectPresence(projectDir, {
			runtimeDir,
			relayLink: relayLink1,
			roomKey: roomKey1,
		});

		// Second process discovers first via relay-link registry
		const links = await discoverRelayLinks(runtimeDir, undefined);
		expect(links.length).toBeGreaterThanOrEqual(1);

		const found = links.find(l => l.relayLink === relayLink1);
		expect(found).toBeTruthy();
		expect(found?.roomKey).toBe(roomKey1);
		expect(found?.pid).toBe(process.pid);

		await presence1.close();
	}, 10_000);

	it("two live processes both discover each other via relay-link registry", async () => {
		using tempDir = TempDir.createSync("@omp-presence-relay-two-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const relayLink1 = "omp://session/proc-1";
		const relayLink2 = "omp://session/proc-2";

		const presence1 = await registerDaemonProjectPresence(projectDir, {
			runtimeDir,
			relayLink: relayLink1,
			roomKey: "shared-room",
		});

		const presence2 = await registerDaemonProjectPresence(projectDir, {
			runtimeDir,
			relayLink: relayLink2,
			roomKey: "shared-room",
		});

		// Each discovers the other (excluding self by pid)
		const links1 = await discoverRelayLinks(runtimeDir, presence1);
		const links2 = await discoverRelayLinks(runtimeDir, presence2);

		// Both should see at least the other process
		expect(links1.length).toBeGreaterThanOrEqual(1);
		expect(links2.length).toBeGreaterThanOrEqual(1);

		// Verify cross-discovery
		const otherFrom1 = links1.find(l => l.relayLink === relayLink2);
		const otherFrom2 = links2.find(l => l.relayLink === relayLink1);
		expect(otherFrom1).toBeTruthy();
		expect(otherFrom2).toBeTruthy();

		await presence1.close();
		await presence2.close();
	}, 10_000);

	it("command socket accepts gate-response and delivers payload", async () => {
		using tempDir = TempDir.createSync("@omp-cmd-socket-");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(runtimeDir, { recursive: true });

		// Start a command socket listener
		const socketPath = path.join(runtimeDir, "command.sock");
		const server = net.createServer(socket => {
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					const msg = JSON.parse(line);
					if (msg.cmd === "gate-response") {
						socket.write(JSON.stringify({ ok: true, echoed: msg.payload }) + "\n");
					}
				} catch {
					// ignore
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.listen(socketPath, resolve);
			server.once("error", reject);
		});

		try {
			// Send gate-response command
			const result = await sendCommand(socketPath, {
				cmd: "gate-response",
				payload: { gate: "g1", action: "approve" },
			});

			expect(result.ok).toBe(true);
			expect(result.echoed).toEqual({ gate: "g1", action: "approve" });
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close(err => (err ? reject(err) : resolve()));
			});
		}
	}, 10_000);

	it("command socket rejects unknown commands", async () => {
		using tempDir = TempDir.createSync("@omp-cmd-socket-unknown-");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(runtimeDir, { recursive: true });

		const socketPath = path.join(runtimeDir, "command.sock");
		const server = net.createServer(socket => {
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", chunk => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					const msg = JSON.parse(line);
					const validCmds = ["gate-response", "kill", "pause", "resume"];
					if (validCmds.includes(msg.cmd)) {
						socket.write(JSON.stringify({ ok: true, cmd: msg.cmd }) + "\n");
					} else {
						socket.write(JSON.stringify({ ok: false, error: `unknown command: ${msg.cmd}` }) + "\n");
					}
				} catch {
					socket.write(JSON.stringify({ ok: false, error: "invalid json" }) + "\n");
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.listen(socketPath, resolve);
			server.once("error", reject);
		});

		try {
			const result = await sendCommand(socketPath, {
				cmd: "invalid-cmd" as "kill",
				payload: {},
			});
			expect(result.ok).toBe(false);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close(err => (err ? reject(err) : resolve()));
			});
		}
	}, 10_000);
});
