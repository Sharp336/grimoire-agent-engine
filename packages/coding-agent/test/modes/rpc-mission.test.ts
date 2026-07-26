import { describe, expect, test } from "bun:test";
import type { MissionState } from "@oh-my-pi/pi-coding-agent/missions/types";
import { handleRpcMissionCommand, type RpcMissionSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

const mission = { id: "mission-1", status: "paused" } as MissionState;

function createSession(busy = false): { session: RpcMissionSession; calls: string[] } {
	const calls: string[] = [];
	const session: RpcMissionSession = {
		startMission: async () => {
			calls.push("start");
			return mission;
		},
		missionRuntime: {
			snapshot: () => mission,
			isBusy: () => busy,
			accept: async () => {
				calls.push("accept");
				return mission;
			},
			pause: async () => {
				calls.push("pause");
				return mission;
			},
			resume: async input => {
				const worker = input?.restartWorker ? "fresh" : "same";
				calls.push(`resume:${worker}:${input?.messageToWorker ?? ""}`);
				return mission;
			},
			cancel: async () => {
				calls.push("cancel");
				return mission;
			},
			resolveHandoff: async () => {
				calls.push("resolveHandoff");
				return mission;
			},
		},
	};
	return { session, calls };
}

describe("mission RPC commands", () => {
	test("returns durable snapshots and preserves resume versus restart semantics", async () => {
		const { session, calls } = createSession();
		const commands = [
			{ type: "mission_start", goal: "Ship it" },
			{ type: "get_mission" },
			{ type: "mission_accept" },
			{ type: "mission_pause" },
			{ type: "mission_resume", messageToWorker: "continue" },
			{ type: "mission_restart", messageToWorker: "fresh" },
			{ type: "mission_cancel" },
		] as const;

		for (const command of commands) {
			expect((await handleRpcMissionCommand(session, command)).mission).toBe(mission);
		}

		expect(calls).toEqual(["start", "accept", "pause", "resume:same:continue", "resume:fresh:fresh", "cancel"]);
	});

	test("rejects restart while mission work is active with the machine-readable busy sentinel", async () => {
		const { session } = createSession(true);
		await expect(handleRpcMissionCommand(session, { type: "mission_restart" })).rejects.toThrow("MISSION_BUSY");
	});
});
