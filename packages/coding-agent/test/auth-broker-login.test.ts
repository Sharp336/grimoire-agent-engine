import { afterEach, describe, expect, test } from "bun:test";
import { runAuthBrokerCommand } from "../src/cli/auth-broker-cli";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const COMMAND_CODE_CALLBACK_PORTS = Array.from({ length: 10 }, (_, index) => 5959 + index);

function captureStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

function occupyPort(port: number): Bun.Server<undefined> | undefined {
	try {
		return Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch: () => new Response(null, { status: 204 }),
		});
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "EADDRINUSE") return undefined;
		throw error;
	}
}

function readForwardedPort(output: string): number {
	const forward = output.match(/-L (59\d\d):127\.0\.0\.1:\1/);
	expect(forward).not.toBeNull();
	return Number(forward?.[1]);
}

describe("auth-broker login", () => {
	afterEach(() => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	});

	test("remote Command Code login forwards one selected callback port", async () => {
		const restore = captureStdout();
		await runAuthBrokerCommand({
			action: "login",
			flags: { provider: "commandcode", via: "user@example.com", dryRun: true },
		});
		const output = restore();

		const port = readForwardedPort(output);
		expect(output.match(/ -L /g)).toHaveLength(1);
		expect(output).toContain(`OMP_COMMANDCODE_CALLBACK_PORT=${port}`);
		expect(output).toContain("omp auth-broker login commandcode");
	});

	test("remote Command Code login skips an occupied first callback port", async () => {
		const blocker = occupyPort(5959);
		try {
			const restore = captureStdout();
			await runAuthBrokerCommand({
				action: "login",
				flags: { provider: "commandcode", via: "user@example.com", dryRun: true },
			});
			const output = restore();

			const port = readForwardedPort(output);
			expect(port).toBeGreaterThan(5959);
			expect(output.match(/ -L /g)).toHaveLength(1);
			expect(output).toContain(`OMP_COMMANDCODE_CALLBACK_PORT=${port}`);
		} finally {
			blocker?.stop(true);
		}
	});

	test("remote Command Code login fails clearly when no callback ports are available", async () => {
		const blockers = COMMAND_CODE_CALLBACK_PORTS.map(occupyPort).filter(
			(server): server is Bun.Server<undefined> => server !== undefined,
		);
		try {
			await expect(
				runAuthBrokerCommand({
					action: "login",
					flags: { provider: "commandcode", via: "user@example.com", dryRun: true },
				}),
			).rejects.toThrow("No available local callback port for 'commandcode' in 5959-5968");
		} finally {
			for (const blocker of blockers) blocker.stop(true);
		}
	});
});
