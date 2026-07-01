import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as capability from "../../capability";
import type { SSHHost } from "../../capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../capability/types";
import * as fileTransfer from "../../ssh/file-transfer";
import type { ToolSession } from "..";
import { CopyTool } from "../copy";

const SOURCE: SourceMeta = {
	provider: "ssh-json",
	providerName: "SSH Config",
	path: "/test/ssh.json",
	level: "user",
};

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: { get: () => undefined },
	} as unknown as ToolSession;
}

function mockHosts(hosts: SSHHost[] = []): void {
	const result: CapabilityResult<SSHHost> = {
		items: hosts,
		all: hosts,
		warnings: [],
		providers: hosts.length ? ["ssh-json"] : [],
	};
	vi.spyOn(capability, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-copy-tool-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("CopyTool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("copies local regular files byte-exact without UTF-8 decoding", async () => {
		await withTempDir(async dir => {
			const bytes = new Uint8Array([0x00, 0xff, 0x61, 0x0a, 0x80]);
			await Bun.write(path.join(dir, "input.bin"), bytes);

			const result = await new CopyTool(makeSession(dir)).execute("copy-call", {
				source: "input.bin",
				destination: "nested/output.bin",
			});

			const copied = await Bun.file(path.join(dir, "nested/output.bin")).bytes();
			expect(Array.from(copied)).toEqual(Array.from(bytes));
			expect(result.details).toMatchObject({ bytes: bytes.length });
		});
	});

	it("rejects local directory endpoints instead of recursing", async () => {
		await withTempDir(async dir => {
			await fs.mkdir(path.join(dir, "source-dir"));
			await Bun.write(path.join(dir, "file.bin"), new Uint8Array([1]));
			await fs.mkdir(path.join(dir, "dest-dir"));
			const tool = new CopyTool(makeSession(dir));

			await expect(
				tool.execute("copy-source-dir", { source: "source-dir", destination: "out.bin" }),
			).rejects.toThrow(/source is not a regular file/);
			await expect(tool.execute("copy-dest-dir", { source: "file.bin", destination: "dest-dir" })).rejects.toThrow(
				/destination is a directory/,
			);
		});
	});

	it("copies ssh sources to ssh destinations as raw bytes", async () => {
		mockHosts([
			{ _source: SOURCE, name: "src", host: "src.example" },
			{ _source: SOURCE, name: "dst", host: "dst.example" },
		]);
		const bytes = new Uint8Array([0, 255, 42]);
		const statSpy = vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		const readSpy = vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({ bytes, truncated: false });
		const writeSpy = vi.spyOn(fileTransfer, "writeRemoteFile").mockResolvedValue(undefined);

		await new CopyTool(makeSession("/workspace")).execute("copy-ssh", {
			source: "ssh://src/tmp/in.bin",
			destination: "ssh://dst/var/out.bin",
			timeout: 9,
		});

		expect(statSpy).toHaveBeenCalledTimes(1);
		expect(statSpy.mock.calls[0]?.[0]).toMatchObject({ name: "src", host: "src.example" });
		expect(statSpy.mock.calls[0]?.[1]).toBe("/tmp/in.bin");
		expect(readSpy.mock.calls[0]?.[2]).toMatchObject({ maxBytes: 64 * 1024 * 1024, timeoutMs: 9000 });
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(writeSpy.mock.calls[0]?.[0]).toMatchObject({ name: "dst", host: "dst.example" });
		expect(writeSpy.mock.calls[0]?.[1]).toBe("/var/out.bin");
		expect(writeSpy.mock.calls[0]?.[2]).toEqual(bytes);
		expect(writeSpy.mock.calls[0]?.[3]).toMatchObject({ timeoutMs: 9000 });
	});

	it("rejects remote directory sources before reading", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		const readSpy = vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new Uint8Array([1]),
			truncated: false,
		});

		await expect(
			new CopyTool(makeSession("/workspace")).execute("copy-remote-dir", {
				source: "ssh://host/tmp/dir",
				destination: "out.bin",
			}),
		).rejects.toThrow(/source is a directory/);
		expect(readSpy).not.toHaveBeenCalled();
	});
});
