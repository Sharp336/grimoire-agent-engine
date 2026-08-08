import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder } from "../../src/modes/rpc/rpc-frame";

export type RpcProcessFrame = Record<string, unknown>;

export interface IsolatedRpcProcessRoot {
	root: string;
	home: string;
	cwd: string;
	sessionDir: string;
	env: Record<string, string>;
}

export async function createIsolatedRpcProcessRoot(prefix: string): Promise<IsolatedRpcProcessRoot> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	const home = path.join(root, "home");
	const cwd = path.join(root, "workspace");
	const sessionDir = path.join(root, "sessions");
	const xdgConfig = path.join(root, "xdg-config");
	const xdgData = path.join(root, "xdg-data");
	const xdgCache = path.join(root, "xdg-cache");
	const agentDir = path.join(home, ".omp", "agent");
	await Promise.all(
		[home, cwd, sessionDir, xdgConfig, xdgData, xdgCache, agentDir].map(directory =>
			fs.promises.mkdir(directory, { recursive: true }),
		),
	);
	return {
		root,
		home,
		cwd,
		sessionDir,
		env: {
			HOME: home,
			ANTHROPIC_API_KEY: "",
			XDG_CONFIG_HOME: xdgConfig,
			XDG_DATA_HOME: xdgData,
			XDG_CACHE_HOME: xdgCache,
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
			NO_COLOR: "1",
		},
	};
}

export async function removeIsolatedRpcProcessRoot(root: IsolatedRpcProcessRoot): Promise<void> {
	await fs.promises.rm(root.root, { recursive: true, force: true });
}

interface FrameWaiter {
	from: number;
	predicate(frame: RpcProcessFrame): boolean;
	resolve(frame: RpcProcessFrame): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

/** A strict, bounded JSONL harness for one native OMP RPC process. */
export class RawRpcProcess {
	readonly logicalFrames: RpcProcessFrame[] = [];
	readonly physicalFrames: RpcProcessFrame[] = [];
	readonly root: IsolatedRpcProcessRoot;
	readonly mode: "rpc" | "rpc-ui";
	readonly binaryPath: string;
	readonly child: ptree.ChildProcess<"pipe">;
	readonly #decoder = new RpcFrameDecoder();
	readonly #waiters = new Set<FrameWaiter>();
	readonly #stderrPromise: Promise<string>;
	readonly #stdoutPromise: Promise<void>;
	#stderr = "";
	#closed = false;

	private constructor(
		binaryPath: string,
		mode: "rpc" | "rpc-ui",
		root: IsolatedRpcProcessRoot,
		args: readonly string[],
		extraEnv: Readonly<Record<string, string>>,
		useDefaultModel: boolean,
	) {
		this.binaryPath = binaryPath;
		this.mode = mode;
		this.root = root;
		this.child = ptree.spawn(
			[
				binaryPath,
				"--mode",
				mode,
				...(useDefaultModel ? ["--provider", "anthropic", "--model", "claude-sonnet-4-5"] : []),
				"--session-dir",
				root.sessionDir,
				...args,
			],
			{
				cwd: root.cwd,
				env: { ...Bun.env, ...root.env, ...extraEnv },
				stdin: "pipe",
				stderr: "full",
			},
		);
		this.#stderrPromise = new Response(this.child.stderr as ReadableStream<Uint8Array>).text();
		this.#stdoutPromise = this.#collectStdout();
		void this.#stdoutPromise.catch(() => {});
	}

	static async start(
		binaryPath: string,
		options: {
			args?: readonly string[];
			mode?: "rpc" | "rpc-ui";
			env?: Readonly<Record<string, string>>;
			prefix?: string;
			useDefaultModel?: boolean;
			prepare?: (root: IsolatedRpcProcessRoot) => void | Promise<void>;
		} = {},
	): Promise<RawRpcProcess> {
		const root = await createIsolatedRpcProcessRoot(options.prefix ?? "omp-rpc-v3-process-");
		let process: RawRpcProcess | undefined;
		try {
			await options.prepare?.(root);
			process = new RawRpcProcess(
				binaryPath,
				options.mode ?? "rpc",
				root,
				options.args ?? [],
				options.env ?? {},
				options.useDefaultModel ?? true,
			);
			await process.waitFor(frame => frame.type === "ready", { description: "RPC ready frame", timeoutMs: 15_000 });
			return process;
		} catch (error) {
			if (process) await process.dispose();
			else await removeIsolatedRpcProcessRoot(root);
			throw error;
		}
	}

	get stderr(): string {
		return this.#stderr;
	}

	write(frame: Readonly<Record<string, unknown>>): void {
		if (this.#closed) throw new Error("Cannot write to a closed RPC process");
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	async flush(): Promise<void> {
		await this.child.stdin.flush();
	}

	/** Close the client input stream while retaining captured output for disconnect assertions. */
	endInput(): void {
		if (this.#closed) return;
		this.child.stdin.end();
	}

	async request(
		frame: Readonly<Record<string, unknown>> & { id: string },
		timeoutMs = 10_000,
	): Promise<RpcProcessFrame> {
		const from = this.logicalFrames.length;
		this.write(frame);
		await this.child.stdin.flush();
		return this.waitFor(candidate => candidate.type === "response" && candidate.id === frame.id, {
			from,
			description: `response ${frame.id} (${String(frame.type)})`,
			timeoutMs,
		});
	}

	async waitFor(
		predicate: (frame: RpcProcessFrame) => boolean,
		options: { from?: number; timeoutMs?: number; description?: string } = {},
	): Promise<RpcProcessFrame> {
		const from = options.from ?? 0;
		for (let index = from; index < this.logicalFrames.length; index++) {
			const frame = this.logicalFrames[index];
			if (frame && predicate(frame)) return frame;
		}
		const timeoutMs = options.timeoutMs ?? 10_000;
		const { promise, resolve, reject } = Promise.withResolvers<RpcProcessFrame>();
		const waiter: FrameWaiter = {
			from,
			predicate,
			resolve,
			reject,
			// A hung external process emits no deterministic signal; this timer is only a failure bound.
			timer: setTimeout(() => {
				this.#waiters.delete(waiter);
				reject(
					new Error(
						`Timed out after ${timeoutMs}ms waiting for ${options.description ?? "RPC frame"}. ` +
							`Last frames: ${JSON.stringify(this.logicalFrames.slice(-8))}. Stderr: ${this.#stderr}`,
					),
				);
			}, timeoutMs),
		};
		this.#waiters.add(waiter);
		return promise;
	}

	async waitForExit(timeoutMs = 10_000): Promise<number> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = Promise.withResolvers<never>();
		try {
			timer = setTimeout(
				() => timeout.reject(new Error(`RPC process did not exit within ${timeoutMs}ms. Stderr: ${this.#stderr}`)),
				timeoutMs,
			);
			const exitCode = await Promise.race([this.child.exited, timeout.promise]);
			await this.#stdoutPromise;
			this.#stderr = await this.#stderrPromise;
			return exitCode;
		} finally {
			clearTimeout(timer);
		}
	}

	async dispose(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("RPC process disposed"));
		}
		this.#waiters.clear();
		try {
			this.child.stdin.end();
		} catch {
			// The process may already have closed stdin.
		}
		// Give graceful stdin teardown a bounded OS-level window before killing the process tree.
		const exited = await Promise.race([
			this.child.exited.then(
				() => true,
				() => true,
			),
			Bun.sleep(250).then(() => false),
		]);
		if (!exited) this.child.kill();
		await this.child.exited.catch(() => {});
		await this.#stdoutPromise.catch(() => {});
		this.#stderr = await this.#stderrPromise.catch(error => `Failed to read stderr: ${String(error)}`);
		await removeIsolatedRpcProcessRoot(this.root);
	}

	async #collectStdout(): Promise<void> {
		try {
			for await (const value of readJsonl<unknown>(this.child.stdout as ReadableStream<Uint8Array>)) {
				if (!isRecord(value)) throw new Error(`RPC stdout frame is not an object: ${JSON.stringify(value)}`);
				this.physicalFrames.push(value);
				const logical = this.#decoder.push(value);
				if (!logical) continue;
				if (!isRecord(logical)) throw new Error(`Decoded RPC frame is not an object: ${JSON.stringify(logical)}`);
				this.logicalFrames.push(logical);
				for (const waiter of Array.from(this.#waiters)) {
					if (this.logicalFrames.length <= waiter.from || !waiter.predicate(logical)) continue;
					clearTimeout(waiter.timer);
					this.#waiters.delete(waiter);
					waiter.resolve(logical);
				}
			}
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			for (const waiter of this.#waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
			this.#waiters.clear();
			throw error;
		}
	}
}
