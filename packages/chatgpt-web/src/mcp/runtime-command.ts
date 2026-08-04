import type { ChatGptWebMode } from "../config";

const PACKAGE_NAME = "@oh-my-pi/pi-chatgpt-web";
const PACKAGE_CLI_NAME = "chatgpt-web";
const PACKAGE_CLI_RELATIVE_PATH = "app/cli.js";
const PACKAGE_VERSION = "17.2.7";
const BROKER_HANDOFF_ARGV = Object.freeze(["mcp", "--broker-handoff"] as const);

/** Opaque native capability retaining the already-open, verified package CLI until spawn. */
export interface NativeVerifiedExecutable {
	readonly identity: string;
	readonly packageName: typeof PACKAGE_NAME;
	readonly packageVersion: typeof PACKAGE_VERSION;
	readonly cliName: typeof PACKAGE_CLI_NAME;
	close(): void;
	readonly __nativeVerifiedExecutable: symbol;
}

export interface RuntimeCommandNativeHost {
	/** Opens the fixed, package-owned CLI and retains its verified native capability until close. */
	openVerifiedPackageCli(request: {
		readonly packageName: typeof PACKAGE_NAME;
		readonly packageVersion: typeof PACKAGE_VERSION;
		readonly cliName: typeof PACKAGE_CLI_NAME;
		readonly cliRelativePath: typeof PACKAGE_CLI_RELATIVE_PATH;
	}): Promise<NativeVerifiedExecutable>;
}
export interface RuntimeCommand {
	readonly executable: NativeVerifiedExecutable;
	readonly argv: readonly ["mcp", "--broker-handoff"];
	readonly command: typeof PACKAGE_CLI_NAME;
	readonly mode: "full";
	close(): void;
}
function hasExactKeys(value: object, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Resolves only the package-owned full-mode MCP handoff command. */
export async function resolveRuntimeCommand(
	options: { readonly mode: ChatGptWebMode },
	host: RuntimeCommandNativeHost,
): Promise<RuntimeCommand> {
	if (!hasExactKeys(options, ["mode"])) throw new Error("Invalid runtime command options");
	if (options.mode !== "full") throw new Error("The MCP broker handoff command requires full mode");
	const executable = await host.openVerifiedPackageCli({
		packageName: PACKAGE_NAME,
		packageVersion: PACKAGE_VERSION,
		cliName: PACKAGE_CLI_NAME,
		cliRelativePath: PACKAGE_CLI_RELATIVE_PATH,
	});
	if (
		executable.packageName !== PACKAGE_NAME ||
		executable.packageVersion !== PACKAGE_VERSION ||
		executable.cliName !== PACKAGE_CLI_NAME ||
		executable.identity === "" ||
		typeof executable.close !== "function"
	) {
		throw new Error("The verified runtime package identity does not match this package");
	}
	return Object.freeze({
		executable,
		argv: BROKER_HANDOFF_ARGV,
		command: PACKAGE_CLI_NAME,
		mode: "full" as const,
		close: () => executable.close(),
	});
}

function quoteWindowsArgument(value: string): string {
	if (value.includes("\0") || /[\r\n]/u.test(value)) throw new Error("Invalid Windows process argument");
	if (value !== "" && !/[\t "]/u.test(value)) return value;
	let output = '"';
	let backslashes = 0;
	for (const character of value) {
		if (character === "\\") {
			backslashes += 1;
			continue;
		}
		if (character === '"') {
			output += "\\".repeat(backslashes * 2 + 1);
			output += '"';
			backslashes = 0;
			continue;
		}
		output += "\\".repeat(backslashes);
		output += character;
		backslashes = 0;
	}
	output += "\\".repeat(backslashes * 2);
	return `${output}"`;
}

/** Serializes argv for CreateProcess using the CommandLineToArgvW-compatible escaping rules. */
export function serializeWindowsArgv(argv: readonly string[]): string {
	if (!Array.isArray(argv)) throw new Error("Windows argv must be an array");
	return argv.map(quoteWindowsArgument).join(" ");
}
