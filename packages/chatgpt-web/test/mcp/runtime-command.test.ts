import { describe, expect, test } from "bun:test";
import {
	type NativeVerifiedExecutable,
	type RuntimeCommandNativeHost,
	resolveRuntimeCommand,
	serializeWindowsArgv,
} from "../../src/mcp/runtime-command";

function verifiedExecutable(overrides: Partial<NativeVerifiedExecutable> = {}): NativeVerifiedExecutable {
	return {
		identity: "opened-package-cli-identity",
		packageName: "@oh-my-pi/pi-chatgpt-web",
		packageVersion: "17.2.6",
		cliName: "chatgpt-web",
		close() {},
		__nativeVerifiedExecutable: Symbol("verified"),
		...overrides,
	};
}

describe("runtime command boundary", () => {
	test("opens the fixed package CLI immediately and returns only the broker handoff argv", async () => {
		const calls: unknown[] = [];
		const host: RuntimeCommandNativeHost = {
			async openVerifiedPackageCli(request) {
				calls.push(request);
				return verifiedExecutable();
			},
		};
		const command = await resolveRuntimeCommand({ mode: "full" }, host);

		expect(calls).toEqual([
			{
				packageName: "@oh-my-pi/pi-chatgpt-web",
				packageVersion: "17.2.6",
				cliName: "chatgpt-web",
				cliRelativePath: "app/cli.js",
			},
		]);
		expect(command.command).toBe("chatgpt-web");
		expect(command.argv).toEqual(["mcp", "--broker-handoff"]);
		expect(Object.isFrozen(command)).toBe(true);
		expect(Object.isFrozen(command.argv)).toBe(true);
	});

	test("rejects browser-only, arbitrary options, and mismatched native identities", async () => {
		const host: RuntimeCommandNativeHost = {
			async openVerifiedPackageCli() {
				return verifiedExecutable();
			},
		};
		await expect(resolveRuntimeCommand({ mode: "browser-only" }, host)).rejects.toThrow("requires full mode");
		await expect(resolveRuntimeCommand({ mode: "full", command: "powershell" } as never, host)).rejects.toThrow(
			"Invalid runtime command options",
		);
		await expect(
			resolveRuntimeCommand(
				{ mode: "full" },
				{
					async openVerifiedPackageCli() {
						return verifiedExecutable({ packageVersion: "0.0.0" as never });
					},
				},
			),
		).rejects.toThrow("does not match");
	});

	test("does not serialize endpoints, commands, or secrets into the descriptor", async () => {
		const command = await resolveRuntimeCommand(
			{ mode: "full" },
			{
				async openVerifiedPackageCli() {
					return verifiedExecutable();
				},
			},
		);
		const serialized = JSON.stringify(command);
		expect(serialized).not.toContain("socket");
		expect(serialized).not.toContain("endpoint");
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("runtime-key");
		expect(serialized).not.toContain("powershell");
	});
});

describe("Windows argv serialization", () => {
	test("uses CommandLineToArgvW-compatible spaces, quotes, backslashes, empties, and Unicode", () => {
		expect(serializeWindowsArgv(["plain", "雪"])).toBe("plain 雪");
		expect(serializeWindowsArgv([""])).toBe('""');
		expect(serializeWindowsArgv(["with space"])).toBe('"with space"');
		expect(serializeWindowsArgv(['quote"inside'])).toBe('"quote\\"inside"');
		expect(serializeWindowsArgv(["C:\\Program Files\\"])).toBe('"C:\\Program Files\\\\"');
		expect(serializeWindowsArgv(['slashes\\\\"quote'])).toBe('"slashes\\\\\\\\\\"quote"');
	});

	test("rejects malformed values instead of producing ambiguous command lines", () => {
		expect(() => serializeWindowsArgv(["line\nbreak"])).toThrow("Invalid Windows process argument");
		expect(() => serializeWindowsArgv(["nul\0byte"])).toThrow("Invalid Windows process argument");
		expect(() => serializeWindowsArgv("not-an-array" as never)).toThrow("must be an array");
	});
});
