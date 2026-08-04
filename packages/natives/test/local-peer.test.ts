import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	connectInheritedBroker,
	connectLocal,
	matchesProcessIdentity,
	NativeLocalListener,
	NativeOwnedFile,
	openExecutable,
	openInheritedBrokerBootstrap,
	openInheritedRuntimeKey,
	openOwnerPrivateFile,
	openOrCreatePrivateDirectory,
	openVerifiedExecutable,
	replaceOwnedFileAtomic,
	verifyPeerDescendant,
} from "../native/index.js";

describe("native local security capabilities", () => {
	it("exports the package-owned opaque bridge", () => {
		expect(typeof NativeOwnedFile.open).toBe("function");
		expect(typeof NativeOwnedFile.createPrivate).toBe("function");
		expect(typeof NativeLocalListener.create).toBe("function");
		expect(typeof connectLocal).toBe("function");
		expect(typeof connectInheritedBroker).toBe("function");
		expect(typeof openInheritedBrokerBootstrap).toBe("function");
		expect(typeof openInheritedRuntimeKey).toBe("function");
		expect(typeof openExecutable).toBe("function");
		expect(typeof openVerifiedExecutable).toBe("function");
		expect(typeof matchesProcessIdentity).toBe("function");
		expect(typeof verifyPeerDescendant).toBe("function");
	});

	it("discovers an executable digest and stable derived version", async () => {
		const executable = await openExecutable(process.execPath);
		try {
			expect(executable.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(executable.version).toBe(`sha256:${executable.sha256}`);
			expect(executable.identity.length).toBeGreaterThan(0);
		} finally {
			executable.close();
		}
	});

	it("keeps reads and cleanup bound to the originally opened file", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-owned-"));
		const target = path.join(root, "bootstrap");
		const replacement = path.join(root, "replacement");
		try {
			await fs.writeFile(target, "original");
			const owned = NativeOwnedFile.open(target);
			await fs.rename(target, `${target}.old`);
			await fs.writeFile(replacement, "replacement");
			await fs.rename(replacement, target);

			expect(new TextDecoder().decode(owned.read())).toBe("original");
			owned.cleanup();
			expect(await fs.readFile(target, "utf8")).toBe("replacement");
			owned.close();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("atomically creates private files beneath a held directory", async () => {
		const pathRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-private-"));
		const root = NativeOwnedFile.open(pathRoot, true);
		try {
			const created = NativeOwnedFile.createPrivate(root, "bootstrap", new TextEncoder().encode("private-proof"));
			expect(new TextDecoder().decode(created.read())).toBe("private-proof");
			expect(() => NativeOwnedFile.createPrivate(root, "../escape", new Uint8Array([1]))).toThrow();
			created.cleanup();
			created.close();
		} finally {
			root.close();
			await fs.rm(pathRoot, { recursive: true, force: true });
		}
	});

	it("atomically publishes and replaces owner-private state", async () => {
		const pathRoot = path.join(os.tmpdir(), `omp-native-replacement-${crypto.randomUUID()}`);
		const root = openOrCreatePrivateDirectory(pathRoot);
		let current: NativeOwnedFile | undefined;
		try {
			current = replaceOwnedFileAtomic(root, "state", new TextEncoder().encode("first"), null);
			expect(new TextDecoder().decode(current.read())).toBe("first");
			const identity = current.identity;
			current.close();
			current = replaceOwnedFileAtomic(root, "state", new TextEncoder().encode("second"), identity);
			expect(new TextDecoder().decode(current.read())).toBe("second");
		} finally {
			current?.close();
			root.close();
			await fs.rm(pathRoot, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform !== "win32")("accepts only singly linked owner-private Windows files", async () => {
		const pathRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-owner-private-"));
		const target = path.join(pathRoot, "runtime-key");
		const alias = path.join(pathRoot, "runtime-key-link");
		const root = NativeOwnedFile.open(pathRoot, true);
		try {
			const created = NativeOwnedFile.createPrivate(root, "runtime-key", new TextEncoder().encode("private-proof"));
			created.close();
			const reopened = openOwnerPrivateFile(target);
			reopened.close();
			await fs.link(target, alias);
			expect(() => openOwnerPrivateFile(target)).toThrow("singly linked");
		} finally {
			root.close();
			await fs.rm(pathRoot, { recursive: true, force: true });
		}
	});

	it("makes consume one-shot and rejects reads after consume", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-consume-"));
		const target = path.join(root, "runtime-key");
		try {
			await fs.writeFile(target, "secret");
			const owned = NativeOwnedFile.open(target);
			owned.consume();
			expect(() => owned.read()).toThrow("consumed");
			expect(() => owned.consume()).toThrow("already consumed");
			owned.close();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("uses an owner-local transport with live peer identity", async () => {
		const listener = NativeLocalListener.create();
		const client = await connectLocal(listener.endpoint);
		const server = await listener.accept();
		try {
			const peer = server.peer;
			expect(peer.pid).toBe(process.pid);
			expect(matchesProcessIdentity(peer, server.currentPeer())).toBe(true);
			await client.write(new TextEncoder().encode("proof"));
			expect(new TextDecoder().decode(await server.read())).toBe("proof");
		} finally {
			await client.close();
			await server.close();
			listener.close();
		}
	});

	it("interrupts an outstanding peer read when the connection closes", async () => {
		const listener = NativeLocalListener.create();
		const client = await connectLocal(listener.endpoint);
		const server = await listener.accept();
		const pending = server.read().then(
			() => {
				throw new Error("native peer read unexpectedly resolved after close");
			},
			error => (error instanceof Error ? error.message : String(error)),
		);
		await server.close();
		await expect(pending).resolves.toContain("closed");
		await client.close();
		listener.close();
	});

	it("interrupts an outstanding accept when the listener closes", async () => {
		const listener = NativeLocalListener.create();
		const pending = listener.accept();
		listener.close();
		await expect(pending).rejects.toThrow("closed");
	});
});
