import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "../../types";
import { withExtraCaFetch } from "../tls-fetch";

type BunTlsRequestInit = RequestInit & {
	tls?: {
		ca?: string | string[];
	};
};

const EXTRA_CA = "-----BEGIN CERTIFICATE-----\nextra-ca\n-----END CERTIFICATE-----\n";

let originalExtraCa: string | undefined;
let tmpDir: string;

beforeEach(async () => {
	originalExtraCa = Bun.env.NODE_EXTRA_CA_CERTS;
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extra-ca-"));
});

afterEach(async () => {
	if (originalExtraCa === undefined) delete Bun.env.NODE_EXTRA_CA_CERTS;
	else Bun.env.NODE_EXTRA_CA_CERTS = originalExtraCa;
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("withExtraCaFetch", () => {
	it("injects NODE_EXTRA_CA_CERTS into provider fetch TLS options", async () => {
		const caPath = path.join(tmpDir, "proxy-ca.pem");
		await fs.writeFile(caPath, EXTRA_CA);
		Bun.env.NODE_EXTRA_CA_CERTS = caPath;

		let captured: BunTlsRequestInit | undefined;
		const fetchImpl: FetchImpl = async (_input, init) => {
			captured = init as BunTlsRequestInit | undefined;
			return new Response("ok");
		};

		const wrapped = withExtraCaFetch({ fetch: fetchImpl })?.fetch;
		await wrapped?.("https://relay.example/v1/models");

		expect(Array.isArray(captured?.tls?.ca)).toBe(true);
		expect(captured?.tls?.ca).toContain(EXTRA_CA);
	});

	it("preserves existing per-request CA entries", async () => {
		Bun.env.NODE_EXTRA_CA_CERTS = EXTRA_CA.replace(/\n/g, "\\n");

		let captured: BunTlsRequestInit | undefined;
		const fetchImpl: FetchImpl = async (_input, init) => {
			captured = init as BunTlsRequestInit | undefined;
			return new Response("ok");
		};

		const wrapped = withExtraCaFetch({ fetch: fetchImpl })?.fetch;
		await wrapped?.("https://relay.example/v1/models", { tls: { ca: "existing-ca" } } as RequestInit);

		expect(captured?.tls?.ca).toContain("existing-ca");
		expect(captured?.tls?.ca).toContain(EXTRA_CA);
	});

	it("leaves fetch options untouched when NODE_EXTRA_CA_CERTS is unset", async () => {
		delete Bun.env.NODE_EXTRA_CA_CERTS;
		const fetchImpl: FetchImpl = async () => new Response("ok");
		const options = { fetch: fetchImpl };

		expect(withExtraCaFetch(options)).toBe(options);
	});
});
