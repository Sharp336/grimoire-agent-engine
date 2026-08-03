import { expect, test } from "bun:test";
import { type ChatGptWebRuntimeConfig, encodeJson } from "../src/config";
import { createNativeBrowserHost, createNativeSecureConfigHost } from "../src/runtime/native-secure-host";

const fullConfig: ChatGptWebRuntimeConfig = Object.freeze({
	mode: "full",
	tunnelId: `tunnel_${"a".repeat(32)}`,
	runtimeKeyConfigured: true,
});

const owner = {
	version: 1 as const,
	ownerNonce: "o".repeat(64),
	process: { pid: 42, processStartIdentity: "native-process-start" },
	profileGeneration: "g".repeat(64),
};
const executable = {
	identity: "native-executable",
	sha256: "a".repeat(64),
	version: "125.0.1",
};

function nativeFile(
	identity: string,
	directory: boolean,
	bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): Record<string, unknown> {
	return {
		identity,
		directory,
		read: () => bytes,
		consume: () => undefined,
		cleanup: () => undefined,
		close: () => undefined,
	};
}

function nativeModule(): Record<string, unknown> {
	const root = nativeFile("root", true);
	const lock = nativeFile("lock", false);
	const ownership = nativeFile("ownership", false, encodeJson(owner));
	const profile = nativeFile("profile", true);
	const marker = nativeFile(
		"marker",
		false,
		encodeJson({
			version: 1,
			authenticated: true,
			verifiedAt: "2026-08-02T12:00:00.000Z",
			proAvailable: true,
			profileGeneration: owner.profileGeneration,
			profileIdentity: profile.identity,
			executable,
			ownerFence: owner.ownerNonce,
		}),
	);
	const children = new Map<string, Record<string, unknown>>([
		["ownership", ownership],
		["browser-profile", profile],
		["verification.json", marker],
	]);
	const freshExecutable = () => ({ ...executable, close: () => undefined });
	const module = {
		NativeOwnedFile: {
			createPrivate: (_root: unknown, name: string, bytes: Uint8Array<ArrayBufferLike>) =>
				nativeFile(name, false, bytes),
		},
		NativeLaunchEnvironment: {
			browserChild: () => Object.freeze({}),
		},
		openPrivateDirectory: () => root,
		openOrCreatePrivateDirectory: () => root,
		acquireOwnedFileLock: () => lock,
		currentProcessIdentity: () => owner.process,
		isProcessIdentityLive: () => false,
		openOwnedChild: (_parent: unknown, name: string) => children.get(name) ?? null,
		openOrCreateOwnedDirectory: () => profile,
		openOwnerPrivateFile: () => nativeFile("owner-private", false),
		matchesOwnedChild: (_parent: unknown, _name: string, identity: string) =>
			[...children.values()].some(file => file.identity === identity),
		openVerifiedExecutableMatching: async () => freshExecutable(),
		openExecutable: async () => freshExecutable(),
		replaceOwnedFileAtomic: (_root: unknown, name: string, bytes: Uint8Array<ArrayBufferLike>) =>
			nativeFile(name, false, bytes),
		removeOwnedFileAtomic: () => undefined,
		removeOwnedTreeAtomic: () => undefined,
		launchVerifiedBrowser: async () => ({
			process: { wait: async () => ({}), terminate: async () => undefined, close: () => undefined },
			pipe: { read: async () => new Uint8Array(), write: async () => undefined, close: async () => undefined },
		}),
	};
	return module;
}

test("low-level native browser host accepts full-mode profile authority", async () => {
	const module = nativeModule();
	const secureHost = createNativeSecureConfigHost(module);
	expect(secureHost).not.toBeNull();
	const host = await createNativeBrowserHost(module, secureHost!, fullConfig);
	expect(host).not.toBeNull();
	await host!.close();
});
