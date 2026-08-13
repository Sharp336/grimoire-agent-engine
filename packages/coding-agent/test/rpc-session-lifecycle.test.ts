import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * End-to-end RPC session-lifecycle coverage against a real `runRpcMode` process.
 *
 * `runRpcMode` installs `quiesceAndReleaseCouncilForSessionTransition` as the
 * session transition reconciler before it emits `ready`, so every identity
 * change (`new_session`, `switch_session`, `branch`, `handoff`) and the
 * terminal stdin-EOF teardown now run through that barrier. These tests drive
 * the real binary so a broken install shows up as a hung or failing frame rather
 * than passing under a stub.
 */
const CLI_PATH = path.join(import.meta.dir, "..", "src", "cli.ts");
const REPO_CWD = path.join(import.meta.dir, "..");

interface RpcProcess {
	send(frame: object): void;
	/** Resolve the first frame matching `predicate`, reading stdout lazily. */
	next(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
	/** Close stdin and await exit; returns the code plus every stdout line seen. */
	finish(): Promise<{ exitCode: number; lines: string[] }>;
}

function startRpcProcess(): RpcProcess {
	const argv = ["bun", CLI_PATH, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"];
	const child = Bun.spawn(argv, {
		cwd: REPO_CWD,
		env: { ...Bun.env, PI_NO_TITLE: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const decoder = new TextDecoder();
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const lines: string[] = [];
	let pending = "";
	let done = false;

	const readLine = async (): Promise<string | undefined> => {
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				lines.push(line);
				return line;
			}
			if (done) return undefined;
			const chunk = await reader.read();
			if (chunk.done) {
				done = true;
				continue;
			}
			pending += decoder.decode(chunk.value, { stream: true });
		}
	};

	return {
		send(frame: object): void {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			void child.stdin.flush();
		},
		async next(predicate): Promise<Record<string, unknown>> {
			for (;;) {
				const line = await readLine();
				if (line === undefined) throw new Error("RPC stdout closed before the expected frame arrived");
				if (!line.trim()) continue;
				const parsed: unknown = JSON.parse(line);
				if (isRecord(parsed) && predicate(parsed)) return parsed;
			}
		},
		async finish(): Promise<{ exitCode: number; lines: string[] }> {
			child.stdin.end();
			while ((await readLine()) !== undefined) {
				// Drain the rest of the protocol stream so the exit-time frames are captured.
			}
			const exitCode = await child.exited;
			return { exitCode, lines };
		},
	};
}

describe("RPC session lifecycle with the Council transition reconciler installed", () => {
	test("processes new_session, switch_session, branch, and handoff, then exits cleanly on stdin EOF", async () => {
		const rpc = startRpcProcess();
		await rpc.next(frame => frame.type === "ready");

		rpc.send({ type: "get_state", id: "state-0" });
		const initialState = await rpc.next(frame => frame.id === "state-0");
		const initial = initialState.data;
		if (!isRecord(initial) || typeof initial.sessionFile !== "string") {
			throw new Error("Expected the initial session file in get_state");
		}
		const initialSessionFile = initial.sessionFile;
		const initialSessionId = initial.sessionId;

		rpc.send({ type: "new_session", id: "new-1" });
		const created = await rpc.next(frame => frame.id === "new-1");
		expect(created).toMatchObject({ type: "response", command: "new_session", success: true });
		expect(created.data).toMatchObject({ cancelled: false });

		rpc.send({ type: "get_state", id: "state-1" });
		const afterNew = await rpc.next(frame => frame.id === "state-1");
		const afterNewData = afterNew.data;
		if (!isRecord(afterNewData)) throw new Error("Expected get_state data");
		// The transition really happened, which means the reconciler ran and let it through.
		expect(afterNewData.sessionId).not.toBe(initialSessionId);

		rpc.send({ type: "switch_session", id: "switch-1", sessionPath: initialSessionFile });
		const switched = await rpc.next(frame => frame.id === "switch-1");
		expect(switched).toMatchObject({ type: "response", command: "switch_session", success: true });

		// Branching an empty transcript is refused, but the frame must still be
		// processed and correlated rather than parked behind the reconciler.
		rpc.send({ type: "branch", id: "branch-1", entryId: "no-such-entry" });
		const branched = await rpc.next(frame => frame.id === "branch-1");
		expect(branched).toMatchObject({ type: "response", command: "branch" });

		rpc.send({ type: "handoff", id: "handoff-1" });
		const handed = await rpc.next(frame => frame.id === "handoff-1");
		expect(handed).toMatchObject({ type: "response", command: "handoff" });

		const { exitCode, lines } = await rpc.finish();
		expect(exitCode).toBe(0);
		// Nothing but protocol JSON may reach stdout in RPC mode.
		for (const line of lines) {
			if (!line.trim()) continue;
			expect(() => JSON.parse(line) as unknown).not.toThrow();
		}
	}, 60_000);
});
