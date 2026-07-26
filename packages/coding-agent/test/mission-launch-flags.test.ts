import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";

describe("mission launch flags", () => {
	it("parses mission worker and validator model overrides", () => {
		expect(
			parseArgs(["--mission", "--mission-worker-model", "worker", "--mission-validator-model", "validator", "goal"]),
		).toMatchObject({
			mission: true,
			missionWorkerModel: "worker",
			missionValidatorModel: "validator",
			messages: ["goal"],
		});
	});

	it("rejects model overrides without a mission", () => {
		expect(() => parseArgs(["--mission-worker-model", "worker"])).toThrow(CliUsageError);
	});

	it("rejects launch modes that cannot drive a mission", () => {
		expect(() => parseArgs(["--mission"])).toThrow("--mission requires a goal");
		expect(() => parseArgs(["--mission", "--print", "goal"])).toThrow("cannot be used with --print");
		expect(() => parseArgs(["--mission", "--continue", "goal"])).toThrow("cannot be used with --continue");
		expect(() => parseArgs(["--mission", "--resume", "session", "goal"])).toThrow("cannot be used with --resume");
		expect(() => parseArgs(["--mission", "--fork", "session", "goal"])).toThrow("cannot be used with --fork");
	});
});
