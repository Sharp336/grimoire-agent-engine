import { describe, expect, it } from "bun:test";
import { type OpenCommandEnvironment, resolveOpenCommand } from "../../src/utils/open";

const existingLinuxPath = "/mnt/c/Users/example/Downloads/session.html";
const windowsPath = "C:\\Users\\example\\Downloads\\session.html";

function makeEnv(overrides: Partial<OpenCommandEnvironment> = {}): OpenCommandEnvironment {
	return {
		platform: "linux",
		env: {},
		procVersion: undefined,
		exists: filePath => filePath === existingLinuxPath,
		toWindowsPath: filePath => (filePath === existingLinuxPath ? windowsPath : undefined),
		hasCommand: command => command === "wslview",
		...overrides,
	};
}

describe("resolveOpenCommand", () => {
	it("opens existing local files through wslview with a Windows path on WSL", () => {
		const command = resolveOpenCommand(existingLinuxPath, makeEnv({ env: { WSL_DISTRO_NAME: "Ubuntu" } }));

		expect(command).toEqual(["wslview", windowsPath]);
	});

	it("detects WSL from proc version when WSL environment variables are absent", () => {
		const command = resolveOpenCommand(
			existingLinuxPath,
			makeEnv({ procVersion: "Linux version 5.15.167.4-microsoft-standard-WSL2" }),
		);

		expect(command).toEqual(["wslview", windowsPath]);
	});

	it("keeps URL opening on the platform default opener", () => {
		const command = resolveOpenCommand("https://example.com", makeEnv({ env: { WSL_DISTRO_NAME: "Ubuntu" } }));

		expect(command).toEqual(["xdg-open", "https://example.com"]);
	});

	it("uses cmd.exe when wslview is unavailable on WSL", () => {
		const command = resolveOpenCommand(
			existingLinuxPath,
			makeEnv({
				env: { WSL_DISTRO_NAME: "Ubuntu" },
				hasCommand: command => command === "cmd.exe",
			}),
		);

		expect(command).toEqual(["cmd.exe", "/c", "start", "", windowsPath]);
	});

	it("falls back to xdg-open when no WSL Windows opener is available", () => {
		const command = resolveOpenCommand(
			existingLinuxPath,
			makeEnv({ env: { WSL_DISTRO_NAME: "Ubuntu" }, hasCommand: () => false }),
		);

		expect(command).toEqual(["xdg-open", existingLinuxPath]);
	});

	it("falls back to xdg-open when a WSL local file cannot be converted", () => {
		const command = resolveOpenCommand(
			existingLinuxPath,
			makeEnv({ env: { WSL_DISTRO_NAME: "Ubuntu" }, toWindowsPath: () => undefined }),
		);

		expect(command).toEqual(["xdg-open", existingLinuxPath]);
	});
});
