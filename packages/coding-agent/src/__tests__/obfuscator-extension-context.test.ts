import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "../extensibility/extensions/types";
import { SecretObfuscator } from "../secrets/obfuscator";

// Compile-time assertion: ExtensionContext must declare an `obfuscator`
// property of type `SecretObfuscator | undefined`. If the interface is
// missing the field this assignment fails to type-check.
// biome-ignore lint/suspicious/noExplicitAny: intentional type-level probe
const _typeCheck: ExtensionContext["obfuscator"] extends SecretObfuscator | undefined ? true : false = true;
void _typeCheck;

describe("Tier-1 Task 4: obfuscator exposed via ExtensionContext", () => {
	it("ExtensionContext declares an optional `obfuscator` field (SecretObfuscator | undefined)", () => {
		// Build a minimal mock context object shaped per the interface. The
		// object literal must be assignable to ExtensionContext; if `obfuscator`
		// is absent from the interface, or typed differently, this fails to
		// compile. We use `Pick` to narrow to just the new field so the test
		// stays focused and does not have to satisfy every other ExtensionContext
		// member.
		const ctx: Pick<ExtensionContext, "obfuscator"> = {
			obfuscator: new SecretObfuscator([{ type: "plain", content: "initial-secret-value-1234" }]),
		};
		expect(ctx.obfuscator).toBeInstanceOf(SecretObfuscator);
	});

	it("ctx.obfuscator?.addSecret(...) registers a runtime secret that is obfuscated in subsequent calls", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "initial-secret-value-1234" }]);
		const ctx: Pick<ExtensionContext, "obfuscator"> = { obfuscator };

		// Before addSecret: the new value is NOT obfuscated.
		const before = obfuscator.obfuscate("leaked new-runtime-secret-1234 here");
		expect(before).toContain("new-runtime-secret-1234");

		// Extension registers a new secret at runtime via the context.
		ctx.obfuscator?.addSecret({ type: "plain", content: "new-runtime-secret-1234" });

		// After addSecret: the new value IS obfuscated to a #HASH# placeholder.
		const after = obfuscator.obfuscate("leaked new-runtime-secret-1234 here");
		expect(after).not.toContain("new-runtime-secret-1234");
		expect(after).toMatch(/\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/);

		// Deobfuscation restores the original runtime-registered value.
		const restored = obfuscator.deobfuscate(after);
		expect(restored).toBe("leaked new-runtime-secret-1234 here");
	});

	it("ctx.obfuscator is undefined when no obfuscator is configured (fail-open for the optional field)", () => {
		const ctx: Pick<ExtensionContext, "obfuscator"> = { obfuscator: undefined };
		// Optional chaining must not throw when obfuscator is absent.
		expect(ctx.obfuscator?.addSecret({ type: "plain", content: "no-op-12345678" })).toBeUndefined();
		expect(ctx.obfuscator).toBeUndefined();
	});
});
