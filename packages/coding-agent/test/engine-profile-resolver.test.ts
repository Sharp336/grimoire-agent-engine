import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EngineProfileResolver } from "../src/engine/profile-resolver";

const refs = {
	profile: "gctx:2222222222222222",
	untrustedRoute: "gctx:3333333333333333",
	trustedRoute: "gctx:4444444444444444",
	untrustedAccount: "gctx:5555555555555555",
	trustedAccount: "gctx:6666666666666666",
};

describe("EngineProfileResolver", () => {
	it("resolves an exact trusted fallback without ambient model or credentials", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-engine-profile-"));
		const cache = path.join(root, "artifacts");
		await fs.mkdir(cache);
		await artifact(cache, refs.profile, "grimoire.agent_profile.v1", {
			schema: "grimoire.agent_profile.v1",
			status: "active",
			displayName: "Trusted fallback",
			models: [refs.untrustedRoute, refs.trustedRoute],
			requireTrustedProvider: true,
			tools: { mode: "unrestricted" },
		});
		for (const [ref, accountRef] of [
			[refs.untrustedRoute, refs.untrustedAccount],
			[refs.trustedRoute, refs.trustedAccount],
		] as const) {
			await artifact(cache, ref, "grimoire.available_model_route.v1", {
				schema: "grimoire.available_model_route.v1",
				status: "active",
				displayName: "Test",
				providerAccountRef: accountRef,
				model: {
					modelIdentityId: ref === refs.trustedRoute ? "trusted-model-v1" : "untrusted-model-v1",
					providerSurfaceId: ref.slice(5),
					modelId: ref === refs.trustedRoute ? "trusted-model" : "untrusted-model",
					name: "Test",
					contextWindow: 100_000,
					maxOutputTokens: 4_096,
					inputModalities: ["text"],
					supportsReasoning: true,
				},
			});
		}
		await artifact(cache, refs.untrustedAccount, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: "anthropic",
			providerKind: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://untrusted.invalid",
			accountBindingId: "untrusted",
			trusted: false,
			credential: { type: "api_key", key: "untrusted-key" },
		});
		await artifact(cache, refs.trustedAccount, "grimoire.provider_account.v1", {
			schema: "grimoire.provider_account.v1",
			status: "active",
			providerId: "anthropic",
			providerKind: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://trusted.invalid",
			accountBindingId: "trusted",
			trusted: true,
			credential: { type: "api_key", key: "trusted-key" },
		});

		const resolver = new EngineProfileResolver(cache, path.join(root, "credentials"));
		const resolved = await resolver.resolve({
			spawns: "*",
			profileDigest: hash(refs.profile),
			launchProfileRef: refs.profile,
			maxSpawnDepth: 1,
		});
		try {
			expect(resolved.options.model?.id).toBe("trusted-model");
			expect(resolved.options.model?.baseUrl).toBe("https://trusted.invalid");
			expect(resolved.options.restrictToolNames).toBe(false);
			expect(resolved.options.enableMCP).toBe(true);
			expect(resolved.options.enableLsp).toBe(true);
			expect(resolved.options.maxSpawnDepth).toBe(1);
			expect(resolved.options.authStorage?.get("anthropic")).toEqual({ type: "api_key", key: "trusted-key" });
			await resolved.options.authStorage?.set("anthropic", { type: "api_key", key: "rotated-key" });
			const writeback = path.join(root, "credential-writeback", `${refs.trustedAccount.slice(5)}.json`);
			for (let attempt = 0; attempt < 50; attempt++) {
				if (
					await fs.access(writeback).then(
						() => true,
						() => false,
					)
				)
					break;
				await Bun.sleep(10);
			}
			expect(JSON.parse(await fs.readFile(writeback, "utf8"))).toMatchObject({
				schema: "grimoire.engine_credential_writeback.v1",
				artifactRef: refs.trustedAccount,
				baseRevision: 1,
				credential: { type: "api_key", key: "rotated-key" },
			});
		} finally {
			resolved.dispose();
		}

		const reopened = await resolver.resolve({
			spawns: "*",
			profileDigest: hash(refs.profile),
			launchProfileRef: refs.profile,
			maxSpawnDepth: 1,
		});
		try {
			expect(reopened.options.authStorage?.get("anthropic")).toEqual({
				type: "api_key",
				key: "rotated-key",
			});
		} finally {
			reopened.dispose();
		}
	});
});

async function artifact(cache: string, ref: string, kind: string, content: object): Promise<void> {
	await fs.writeFile(
		path.join(cache, `${ref.slice(5)}.json`),
		JSON.stringify({
			schema: "grimoire.client_cached_artifact.v1",
			artifact_ref: ref,
			revision: 1,
			content_hash: hash(ref),
			kind,
			content: JSON.stringify(content),
		}),
	);
}

function hash(ref: string): string {
	return `sha256:${ref.slice(5).padEnd(64, "0")}`;
}
