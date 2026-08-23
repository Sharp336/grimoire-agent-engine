import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	applyProviderCallAssignedOrigin,
	assertProviderCallOrigin,
	canonicalProviderCallDescriptorBytes,
	PROVIDER_CALL_ORIGIN_ASSIGNMENT_FIELDS,
	PROVIDER_CALL_ORIGIN_MANIFEST,
	PROVIDER_CALL_ORIGIN_SOURCE_PINS,
	type ProviderCallOriginAssignment,
	type ProviderCallOriginBinding,
	parseProviderCallOriginAssignment,
	resolveProviderCallOrigin,
	resolveProviderCallOriginBinding,
	validateProviderCallOriginAssignment,
	validateProviderCallOriginManifest,
} from "@oh-my-pi/pi-ai/provider-call-origin-manifest";

const CONTROLLER_DYNAMIC_FIELDS = {
	capability_generation: "capability-generation-20260823",
	credential_generation: "credential-generation-20260823",
	source_release_digest: `sha256:${"a".repeat(64)}`,
	restricted_proxy_policy_sha256: `sha256:${"b".repeat(64)}`,
} as const;

function assignment(binding: ProviderCallOriginBinding): ProviderCallOriginAssignment {
	return {
		...binding.frozenStaticAssignment,
		...CONTROLLER_DYNAMIC_FIELDS,
		origin_descriptor: structuredClone(binding.originDescriptor.preimage),
		route_binding_descriptor: structuredClone(binding.bindingDescriptor.preimage),
	};
}

function clone(value: ProviderCallOriginAssignment): Record<string, unknown> {
	return structuredClone(value) as unknown as Record<string, unknown>;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashDescriptor(value: object): string {
	return createHash("sha256").update(canonicalProviderCallDescriptorBytes(value)).digest("hex");
}

describe("provider-call exact origin and binding contract", () => {
	it("matches all eight origin and 31 binding canonical UTF-8 goldens", () => {
		expect(validateProviderCallOriginManifest(PROVIDER_CALL_ORIGIN_MANIFEST)).toEqual({
			configCount: 30,
			originCount: 8,
			providerCount: 7,
			routeCount: 31,
		});
		expect(PROVIDER_CALL_ORIGIN_SOURCE_PINS).toEqual({
			rawSha256: "94f1400f75e63c588f308c6ce716e2ab6b1c8461a17c63bcc095bad6abf69142",
			canonicalSha256: "cf0c7836da1ae4d496dc72841a44c276adb60a94a64318725776bed2dab67072",
		});

		const originCanonical: string[] = [];
		let originBytes = 0;
		for (const descriptor of PROVIDER_CALL_ORIGIN_MANIFEST.origins) {
			const bytes = canonicalProviderCallDescriptorBytes(descriptor.preimage);
			const canonical = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			expect(bytes.byteLength).toBe(descriptor.canonicalBytes);
			expect(hashDescriptor(descriptor.preimage)).toBe(descriptor.sha256);
			originCanonical.push(canonical);
			originBytes += bytes.byteLength;
		}
		expect(originBytes).toBe(3333);
		expect(sha256(originCanonical.join("\n"))).toBe(
			"209fc7ad3ecbb3af75c523ff322d262ef613e18f8b7fc6f12a2995e9f86c4e1a",
		);

		const bindingCanonical: string[] = [];
		let bindingBytes = 0;
		for (const binding of PROVIDER_CALL_ORIGIN_MANIFEST.routes) {
			const bytes = canonicalProviderCallDescriptorBytes(binding.bindingDescriptor.preimage);
			const canonical = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			expect(bytes.byteLength).toBe(binding.bindingDescriptor.canonicalBytes);
			expect(hashDescriptor(binding.bindingDescriptor.preimage)).toBe(binding.bindingDescriptor.sha256);
			bindingCanonical.push(canonical);
			bindingBytes += bytes.byteLength;
		}
		expect(bindingBytes).toBe(20452);
		expect(sha256(bindingCanonical.join("\n"))).toBe(
			"be8af55a3b20a5b8b814710126a504b3ba988c416527f9316fb6a7dbcd6401ba",
		);
	});

	it("freezes one immutable route per assignment, including exact Google primary and director secondary origins", () => {
		expect(
			PROVIDER_CALL_ORIGIN_MANIFEST.routes.filter(route => route.provider === "google-antigravity"),
		).toHaveLength(6);
		const routesByFamily = Object.groupBy(PROVIDER_CALL_ORIGIN_MANIFEST.routes, route =>
			route.provider === "gpt-proxy" ? "gpt" : route.provider === "google-antigravity" ? "antigravity" : "other",
		);
		expect(routesByFamily.gpt).toHaveLength(20);
		expect(routesByFamily.antigravity).toHaveLength(6);
		expect(routesByFamily.other).toHaveLength(5);
		expect(
			new Set(
				PROVIDER_CALL_ORIGIN_MANIFEST.routes.map(
					route =>
						`${route.configId}\u0000${route.routeOrdinal}\u0000${route.modelSelector}\u0000${route.canonicalTupleSha256}\u0000${route.bindingDescriptor.sha256}`,
				),
			).size,
		).toBe(31);
		expect(
			routesByFamily.gpt?.every(
				route =>
					route.authorityOwner === "dedicated-codex-backend" &&
					route.credential === null &&
					route.physicalApiFamily === "openai-responses",
			),
		).toBe(true);
		expect(routesByFamily.antigravity?.every(route => route.authorityOwner === "generic-omp-auth-gateway")).toBe(
			true,
		);
		expect(routesByFamily.other?.every(route => route.authorityOwner === "generic-omp-auth-gateway")).toBe(true);
		expect(
			PROVIDER_CALL_ORIGIN_MANIFEST.routes
				.filter(route => route.provider === "google-antigravity" && route.routeRole === "primary")
				.map(route => route.origin.host),
		).toEqual(Array(5).fill("daily-cloudcode-pa.googleapis.com"));
		const directorSecondary = resolveProviderCallOriginBinding("sol-max-director-gemini37-flash-high-fast-vibe", 1);
		expect(directorSecondary).toMatchObject({
			authorityOwner: "generic-omp-auth-gateway",
			provider: "google-antigravity",
			routeRole: "additional_director_model",
			origin: {
				host: "daily-cloudcode-pa.sandbox.googleapis.com",
				path: { kind: "exact", value: "/v1internal:streamGenerateContent" },
				query: [["alt", "sse"]],
			},
		});
		expect(resolveProviderCallOrigin("sol-low")).toMatchObject({
			authorityOwner: "dedicated-codex-backend",
			provider: "gpt-proxy",
			origin: {
				host: "chatgpt.com",
				path: { kind: "exact", value: "/backend-api/codex/responses" },
			},
			credential: null,
		});
	});

	it("accepts all 31 exact controller-materialized assignments without inventing dynamic values", () => {
		expect(PROVIDER_CALL_ORIGIN_ASSIGNMENT_FIELDS).toHaveLength(28);
		for (const binding of PROVIDER_CALL_ORIGIN_MANIFEST.routes) {
			const value = assignment(binding);
			const validated = validateProviderCallOriginAssignment(value);
			expect(validated).toEqual(value);
			expect(Object.isFrozen(validated)).toBe(true);
			expect(Object.isFrozen(validated.origin_descriptor)).toBe(true);
			expect(Object.isFrozen(validated.route_binding_descriptor)).toBe(true);
		}
	});

	it("rejects missing, null, wrong-type, malformed dynamic and well-formed-wrong frozen values", () => {
		for (const binding of PROVIDER_CALL_ORIGIN_MANIFEST.routes) {
			const valid = assignment(binding);
			for (const field of PROVIDER_CALL_ORIGIN_ASSIGNMENT_FIELDS) {
				const missing = clone(valid);
				delete missing[field];
				expect(() => validateProviderCallOriginAssignment(missing)).toThrow();

				const nil = clone(valid);
				nil[field] = null;
				expect(() => validateProviderCallOriginAssignment(nil)).toThrow();

				const wrongType = clone(valid);
				wrongType[field] = typeof valid[field] === "number" ? String(valid[field]) : 1;
				expect(() => validateProviderCallOriginAssignment(wrongType)).toThrow();

				if (PROVIDER_CALL_ORIGIN_ASSIGNMENT_FIELDS.indexOf(field) < 24) {
					const wrongValue = clone(valid);
					wrongValue[field] =
						typeof valid[field] === "number" ? (valid[field] as number) + 1 : `${valid[field]}-wrong`;
					expect(() => validateProviderCallOriginAssignment(wrongValue)).toThrow();
				}
			}
		}
	});

	it("rejects unknown, duplicate, flat-vs-nested, hash, and self-consistent rehash substitutions", () => {
		const binding = resolveProviderCallOriginBinding("deepseek-v4-pro-0813-max-r3", 0);
		const valid = assignment(binding);

		const unknown = clone(valid);
		unknown.unreviewed_origin = "https://evil.invalid:443";
		expect(() => validateProviderCallOriginAssignment(unknown)).toThrow(/unknown/i);

		const flatMismatch = clone(valid);
		flatMismatch.dns_host = "evil.invalid";
		expect(() => validateProviderCallOriginAssignment(flatMismatch)).toThrow(/frozen|mismatch/i);

		const nestedMismatch = clone(valid);
		(nestedMismatch.origin_descriptor as Record<string, unknown>).dns_host = "evil.invalid";
		expect(() => validateProviderCallOriginAssignment(nestedMismatch)).toThrow(/descriptor|mismatch/i);

		const hashMismatch = clone(valid);
		hashMismatch.origin_descriptor_sha256 = "0".repeat(64);
		expect(() => validateProviderCallOriginAssignment(hashMismatch)).toThrow(/hash|frozen|mismatch/i);

		const selfConsistentRehash = clone(valid);
		const substitutedOrigin = selfConsistentRehash.origin_descriptor as Record<string, unknown>;
		substitutedOrigin.dns_host = "evil.invalid";
		selfConsistentRehash.dns_host = "evil.invalid";
		selfConsistentRehash.origin_descriptor_sha256 = hashDescriptor(substitutedOrigin);
		const substitutedBinding = selfConsistentRehash.route_binding_descriptor as Record<string, unknown>;
		substitutedBinding.origin_descriptor_sha256 = selfConsistentRehash.origin_descriptor_sha256;
		selfConsistentRehash.binding_descriptor_sha256 = hashDescriptor(substitutedBinding);
		expect(() => validateProviderCallOriginAssignment(selfConsistentRehash)).toThrow(/frozen|mismatch/i);

		const raw = JSON.stringify(valid);
		expect(() => parseProviderCallOriginAssignment(raw.replace(/^\{/, '{"config_id":"duplicate",'))).toThrow(
			/duplicate/i,
		);
		expect(() =>
			parseProviderCallOriginAssignment(
				raw.replace('"origin_descriptor":{', '"origin_descriptor":{"dns_host":"duplicate",'),
			),
		).toThrow(/duplicate/i);
	});

	it("requires canonical controller dynamic values and exact assignment-bound transport", () => {
		const binding = resolveProviderCallOriginBinding("deepseek-v4-pro-0813-max-r3", 0);
		const valid = assignment(binding);
		for (const [field, malformed] of [
			["capability_generation", "CAPABILITY-GENERATION"],
			["credential_generation", " credential-generation"],
			["source_release_digest", "a".repeat(64)],
			["restricted_proxy_policy_sha256", `sha256:${"A".repeat(64)}`],
		] as const) {
			const candidate = clone(valid);
			candidate[field] = malformed;
			expect(() => validateProviderCallOriginAssignment(candidate)).toThrow(/canonical|format/i);
		}

		expect(() =>
			assertProviderCallOrigin(valid, new URL("https://evil.invalid/chat/completions"), new Headers()),
		).toThrow(/origin mismatch/i);
		expect(() =>
			assertProviderCallOrigin(valid, new URL("https://api.deepseek.com/chat/not-completions"), new Headers()),
		).toThrow(/path\/query mismatch/i);
		expect(() =>
			assertProviderCallOrigin(valid, new URL("https://api.deepseek.com/chat/completions"), new Headers()),
		).not.toThrow();

		const queryBinding = resolveProviderCallOriginBinding("gemini37-max-workflowz", 0);
		const queryAssignment = assignment(queryBinding);
		const canonicalUrl = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
		expect(() => assertProviderCallOrigin(queryAssignment, new URL(canonicalUrl), new Headers())).not.toThrow();
		expect(() => applyProviderCallAssignedOrigin(queryAssignment, canonicalUrl)).not.toThrow();
		for (const alternate of [
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?%61lt=sse",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=%73se",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse&alt=sse",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?unused=1&alt=sse",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse&unused=1",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse#fragment",
			"https://user@daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]) {
			expect(() => assertProviderCallOrigin(queryAssignment, new URL(alternate), new Headers())).toThrow(
				/origin|path|query/i,
			);
			expect(() => applyProviderCallAssignedOrigin(queryAssignment, alternate)).toThrow(
				/absolute|canonical|origin|path|query/i,
			);
		}
		for (const normalizedAlias of [
			"https://daily-cloudcode-pa.googleapis.com/ignored/../v1internal:streamGenerateContent?alt=sse",
			"https://daily-cloudcode-pa.googleapis.com/%2e/v1internal:streamGenerateContent?alt=sse",
			"https://daily-cloudcode-pa.googleapis.com/v1internal%3AstreamGenerateContent?alt=sse",
		]) {
			expect(() => applyProviderCallAssignedOrigin(queryAssignment, normalizedAlias)).toThrow(
				/canonical|origin|path|query/i,
			);
		}
	});
});
