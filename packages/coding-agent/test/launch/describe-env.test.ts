import { describe, expect, it } from "bun:test";
import type { DaemonRpcResult, DaemonSnapshot, DaemonSpec } from "../../src/launch/protocol";
import type { LaunchParams } from "../../src/tools/hub/launch";
import { toolContent } from "../../src/tools/hub/launch";

const daemon: DaemonSnapshot = {
	name: "web",
	id: "d1",
	state: "running",
	pid: 123,
	createdAt: 0,
	startedAt: 0,
	outputBytes: 0,
	restartCount: 0,
	persist: false,
	detached: false,
};

function specWith(env: Record<string, string>): DaemonSpec {
	return {
		name: "web",
		application: "bun",
		args: ["run", "dev"],
		env,
		cwd: "/repo",
		pty: true,
		restart: "no",
		persist: false,
		detached: false,
	};
}

const params: LaunchParams = { op: "describe", name: "web" };

function describeContent(env: Record<string, string>): string {
	const result: DaemonRpcResult = { op: "describe", daemon, spec: specWith(env) };
	return toolContent(result, params);
}

describe("hub describe env output", () => {
	it("omits the Env line when the spec carries no env entries", () => {
		const content = describeContent({});
		expect(content).not.toContain("Env:");
		expect(content.split("\n").at(-1)).toStartWith("PTY:");
	});

	it("appends one Env line listing every override", () => {
		const content = describeContent({ PORT: "3000", NODE_ENV: "development" });
		expect(content.split("\n").at(-1)).toBe("Env: PORT=3000; NODE_ENV=development");
	});

	it("flattens control characters and ANSI escapes in values", () => {
		const content = describeContent({ SNEAKY: "a\nb\u001b[2Jc\td" });
		const envLine = content.split("\n").at(-1);
		expect(envLine).toBe("Env: SNEAKY=a bc\td");
	});

	it("strips C1 controls in values", () => {
		const content = describeContent({ C1: "x\u009b2Jy" });
		expect(content.split("\n").at(-1)).toBe("Env: C1=x2Jy");
	});

	it("flattens control characters and ANSI escapes in keys", () => {
		const content = describeContent({ "BAD\nKEY\u001b[31m": "v" });
		const lines = content.split("\n");
		expect(lines.at(-1)).toBe("Env: BAD KEY=v");
		expect(lines.filter(line => line.startsWith("Env:")).length).toBe(1);
	});
});
