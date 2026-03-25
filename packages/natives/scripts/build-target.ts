export interface BuildTargetOptions {
	targetPlatform: string;
	targetArch: string;
	crossTarget?: string;
	rustHostTarget?: string | null;
}

const RUST_TARGET_BY_PLATFORM_ARCH: Record<string, string> = {
	"darwin-arm64": "aarch64-apple-darwin",
	"darwin-x64": "x86_64-apple-darwin",
	"linux-arm64": "aarch64-unknown-linux-gnu",
	"linux-x64": "x86_64-unknown-linux-gnu",
	"win32-x64": "x86_64-pc-windows-msvc",
};

function parseRustTargetPlatformArch(target: string): { platform: string; arch: string } | null {
	if (target.startsWith("aarch64-apple-darwin")) return { platform: "darwin", arch: "arm64" };
	if (target.startsWith("x86_64-apple-darwin")) return { platform: "darwin", arch: "x64" };
	if (target.startsWith("aarch64-unknown-linux-")) return { platform: "linux", arch: "arm64" };
	if (target.startsWith("x86_64-unknown-linux-")) return { platform: "linux", arch: "x64" };
	if (target.startsWith("x86_64-pc-windows-")) return { platform: "win32", arch: "x64" };
	return null;
}

export function getCargoTarget(options: BuildTargetOptions): string {
	if (options.crossTarget) return options.crossTarget;

	const hostTarget = options.rustHostTarget ? parseRustTargetPlatformArch(options.rustHostTarget) : null;
	if (hostTarget?.platform === options.targetPlatform && hostTarget.arch === options.targetArch) {
		return options.rustHostTarget!;
	}

	const targetKey = `${options.targetPlatform}-${options.targetArch}`;
	const cargoTarget = RUST_TARGET_BY_PLATFORM_ARCH[targetKey];
	if (cargoTarget) return cargoTarget;

	throw new Error(`Unsupported native build target: ${targetKey}.`);
}

export function parseRustHostTarget(versionOutput: string): string | null {
	for (const line of versionOutput.split("\n")) {
		if (line.startsWith("host:")) {
			const hostTarget = line.slice("host:".length).trim();
			return hostTarget.length > 0 ? hostTarget : null;
		}
	}
	return null;
}

export function isCargoCrossCompile(cargoTarget: string, rustHostTarget: string | null): boolean {
	return rustHostTarget !== null && cargoTarget !== rustHostTarget;
}
