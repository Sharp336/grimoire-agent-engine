import { afterEach, describe, expect, test } from "bun:test";
import { runAuthBrokerCommand } from "../src/cli/auth-broker-cli";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

function captureStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
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

		const forward = output.match(/-L (59\d\d):127\.0\.0\.1:\1/);
		expect(forward).not.toBeNull();
		expect(output.match(/ -L /g)).toHaveLength(1);
		expect(output).toContain(`OMP_COMMANDCODE_CALLBACK_PORT=${forward?.[1]}`);
		expect(output).toContain("omp auth-broker login commandcode");
	});
});
