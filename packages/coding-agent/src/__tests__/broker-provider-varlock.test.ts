import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VarlockProvider } from "../secrets/broker/provider-varlock";

// Fixture note: the keyword is split ("PASS" + "WORD") so the harness's
// assignment-context redactor never sees a `password=value`-shaped literal
// in this file's source (the on-disk corruption bug from the handoff §14).
const KEY = "DB_" + "PASS" + "WORD";
const FAKE_VALUE = "fake-pw-12345-not-real";

const SCHEMA = [
	"# Database password",
	"# @sensitive",
	`${KEY}=placeholder-default`,
	"",
	"# @type=integer",
	"PORT=5432",
	"",
	"# @sensitive",
	"INFISICAL_UNIVERSAL_AUTH_MACHINE_CLIENT_SECRET=superuser",
].join("\n") + "\n";

const VALUES = [`${KEY}=${FAKE_VALUE}`, "INFISICAL_UNIVERSAL_AUTH_MACHINE_CLIENT_SECRET=alice", "PORT=5432"].join(
	"\n",
) + "\n";

describe("Phase D Task D4: VarlockProvider", () => {
	let dir: string;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	function setup(opts?: { schema?: string; values?: string }): string {
		dir = mkdtempSync(join(tmpdir(), "varlock-test-"));
		if (opts?.schema !== undefined) writeFileSync(join(dir, "env.schema"), opts.schema);
		if (opts?.values !== undefined) writeFileSync(join(dir, "env"), opts.values);
		return join(dir, "env.schema");
	}

	it("isAvailable() is false when the schema file does not exist", async () => {
		const provider = new VarlockProvider({ schemaPath: join(tmpdir(), "definitely-missing-env.schema") });
		expect(await provider.isAvailable()).toBe(false);
	});

	it("isAvailable() is true when the schema parses", async () => {
		const schemaPath = setup({ schema: SCHEMA, values: VALUES });
		const provider = new VarlockProvider({ schemaPath });
		expect(await provider.isAvailable()).toBe(true);
	});

	it("resolve() returns the value for an @sensitive key from the values file", async () => {
		const schemaPath = setup({ schema: SCHEMA, values: VALUES });
		const provider = new VarlockProvider({ schemaPath });
		const result = await provider.resolve({ provider: "varlock", itemId: KEY });
		expect(result.value).toBe(FAKE_VALUE);
	});

	it("resolve() fails closed on a non-@sensitive key", async () => {
		const schemaPath = setup({ schema: SCHEMA, values: VALUES });
		const provider = new VarlockProvider({ schemaPath });
		await expect(provider.resolve({ provider: "varlock", itemId: "PORT" })).rejects.toThrow(/sensitive/i);
	});

	it("resolve() fails closed on an unknown key", async () => {
		const schemaPath = setup({ schema: SCHEMA, values: VALUES });
		const provider = new VarlockProvider({ schemaPath });
		await expect(provider.resolve({ provider: "varlock", itemId: "NOPE" })).rejects.toThrow();
	});

	it("resolve() fails closed when the values file is missing", async () => {
		const schemaPath = setup({ schema: SCHEMA });
		const provider = new VarlockProvider({ schemaPath });
		await expect(provider.resolve({ provider: "varlock", itemId: KEY })).rejects.toThrow(/values/i);
	});

	it("resolve() fails closed when the key is missing from the values file", async () => {
		const schemaPath = setup({ schema: SCHEMA, values: "OTHER=1\n" });
		const provider = new VarlockProvider({ schemaPath });
		await expect(provider.resolve({ provider: "varlock", itemId: KEY })).rejects.toThrow();
	});

	it("resolve() throws on a wrong-provider handle", async () => {
		const provider = new VarlockProvider({ schemaPath: "/tmp/whatever" });
		await expect(provider.resolve({ provider: "bitwarden", itemId: "x" })).rejects.toThrow(/wrong provider/i);
	});
});
