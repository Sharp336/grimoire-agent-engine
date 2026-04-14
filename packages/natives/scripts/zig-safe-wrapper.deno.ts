export function buildZigArgs(args: string[], overrides: { target?: string; cpu?: string }): string[] {
	const nextArgs = [...args];
	if (nextArgs[0] !== "build") {
		return nextArgs;
	}

	const target = overrides.target?.trim();
	const cpu = overrides.cpu?.trim();

	if (target && !nextArgs.some(arg => arg.startsWith("-Dtarget="))) {
		nextArgs.push(`-Dtarget=${target}`);
	}
	if (cpu && !nextArgs.some(arg => arg.startsWith("-Dcpu="))) {
		nextArgs.push(`-Dcpu=${cpu}`);
	}

	return nextArgs;
}

export async function main(
	argv: string[] = Deno.args,
	env: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<number> {
	const realZigPath = env.PI_NATIVE_REAL_ZIG;
	if (!realZigPath) {
		throw new Error("PI_NATIVE_REAL_ZIG is required when using zig-safe-wrapper.ts");
	}

	const cmd = new Deno.Command(realZigPath, {
		args: buildZigArgs(argv, {
			target: env.PI_NATIVE_ZIG_TARGET,
			cpu: env.PI_NATIVE_ZIG_CPU,
		}),
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const child = cmd.spawn();
	const status = await child.status;
	return status.code;
}

const isMain = new URL(import.meta.url).pathname === new URL(Deno.mainModule).pathname;
if (isMain) {
	const exitCode = await main();
	Deno.exit(exitCode);
}
