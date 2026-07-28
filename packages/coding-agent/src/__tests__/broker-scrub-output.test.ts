import { describe, expect, it } from "bun:test";
import { scrubOutput } from "../secrets/broker/scrub-output";

describe("Tier-2 Task 4: scrubOutput", () => {
	it("exact match is scrubbed", () => {
		expect(scrubOutput("my password is hunter2hunter2", ["hunter2hunter2"])).toBe("my password is [REDACTED]");
	});

	it("base64 variant is scrubbed", () => {
		const secret = "hunter2hunter2";
		const b64 = Buffer.from(secret).toString("base64");
		const output = `token=${b64}`;
		expect(scrubOutput(output, [secret])).toBe("token=[REDACTED]");
	});

	it("URL-encoded variant is scrubbed", () => {
		const secret = "p@ss w0rd/complex";
		const urlEnc = encodeURIComponent(secret);
		const output = `redirect=${urlEnc}`;
		expect(scrubOutput(output, [secret])).toBe("redirect=[REDACTED]");
	});

	it("short secret (<4 chars) is NOT scrubbed", () => {
		// Too many false positives — leave short values alone.
		expect(scrubOutput("a is a and ab is ab", ["a", "ab"])).toBe("a is a and ab is ab");
	});

	it("no secret in output → unchanged", () => {
		expect(scrubOutput("nothing to see here", ["topsecret1234"])).toBe("nothing to see here");
	});

	it("multiple secrets in one string → all scrubbed", () => {
		const result = scrubOutput("alpha=secret-aaaa-1234 beta=secret-bbbb-5678", [
			"secret-aaaa-1234",
			"secret-bbbb-5678",
		]);
		expect(result).toBe("alpha=[REDACTED] beta=[REDACTED]");
	});
});
