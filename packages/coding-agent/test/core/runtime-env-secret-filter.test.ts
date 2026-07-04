import { describe, expect, it } from "bun:test";
import { createEnvFilter, SECRET_VALUE_PATTERN } from "@oh-my-pi/pi-coding-agent/eval/runtime-env";

const filterRustEnv = createEnvFilter({
	allowList: ["PATH", "HOME", "CARGO_HOME"],
	windowsAllowList: [],
	denyList: ["OPENAI_API_KEY"],
	allowPrefixes: ["CARGO_", "SCCACHE_", "PI_", "RUST"],
});

describe("runtime env secret value filtering", () => {
	it("drops URL-credential values even when the key name is allowed", () => {
		const filtered = filterRustEnv({
			CARGO_HTTP_PROXY: "https://user:pass@proxy.example.com",
			SCCACHE_REDIS: "redis://:secretpw@redis.example.com",
			PI_REGISTRY: "https://alice:hunter2@registry.example.com",
			CARGO_HOME: "/home/u/.cargo",
			PATH: "/usr/bin:/bin",
			PI_MIRROR: "https://mirror.example.com",
			RUSTUP_TOOLCHAIN: "stable",
		});

		expect(filtered.CARGO_HTTP_PROXY).toBeUndefined();
		expect(filtered.SCCACHE_REDIS).toBeUndefined();
		expect(filtered.PI_REGISTRY).toBeUndefined();
		expect(filtered.CARGO_HOME).toBe("/home/u/.cargo");
		expect(filtered.PATH).toBe("/usr/bin:/bin");
		expect(filtered.PI_MIRROR).toBe("https://mirror.example.com");
		expect(filtered.RUSTUP_TOOLCHAIN).toBe("stable");
	});

	it("matches only URL userinfo credentials with a password segment", () => {
		expect(SECRET_VALUE_PATTERN.test("https://u:p@h")).toBe(true);
		expect(SECRET_VALUE_PATTERN.test("https://example.com")).toBe(false);
		expect(SECRET_VALUE_PATTERN.test("/usr/local/bin")).toBe(false);
		expect(SECRET_VALUE_PATTERN.test("host:8080/path")).toBe(false);
	});
});
