interface BunFile {
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  exists(): Promise<boolean>;
  write(data: unknown): Promise<void>;
  size: number;
  type: string | null;
  path: string;
  stat(): Promise<{ size: number; mtimeMs?: number } | null>;
  readable: ReadableStream<Uint8Array>;
  writer: WritableStream<Uint8Array>;
}

interface BunSubprocess<
  In =
    | "pipe"
    | "inherit"
    | "ignore"
    | "null"
    | File
    | BunFile
    | Uint8Array
    | ReadableStream,
  Out =
    | "pipe"
    | "inherit"
    | "ignore"
    | "null"
    | File
    | BunFile
    | Uint8Array
    | WritableStream,
  Err =
    | "pipe"
    | "inherit"
    | "ignore"
    | "null"
    | File
    | BunFile
    | Uint8Array
    | WritableStream,
> {
  pid: number;
  stdin: In extends "pipe" ? WritableStream<Uint8Array> : null;
  stdout: Out extends "pipe" ? ReadableStream<Uint8Array> : null;
  stderr: Err extends "pipe" ? ReadableStream<Uint8Array> : null;
  exited: Promise<number>;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: string | number): void;
  [Symbol.dispose](): void;
}

interface BunShellPromise extends Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  quiet(): BunShellPromise;
  nothrow(): BunShellPromise;
  cwd(dir: string): BunShellPromise;
  env(env: Record<string, string>): BunShellPromise;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  lines(): Promise<string[]>;
}

interface BunArchiveInstance {
  files(): Promise<Map<string, BunFile>>;
}

interface BunArchiveConstructor {
  new (data: Uint8Array | ArrayBuffer): BunArchiveInstance;
  write(
    path: string,
    entries:
      | Record<string, string | File | Uint8Array>
      | Array<{ name: string; data: string | Uint8Array }>,
    options?: { compress?: boolean | "gzip" },
  ): Promise<void>;
}

interface BunGlobInstance {
  scan(options?: BunGlobScanOptions): AsyncIterable<string> & Promise<string[]>;
  match(path: string): boolean;
}

interface BunGlobConstructor {
  new (pattern: string): BunGlobInstance;
}

interface BunGlobScanOptions {
  cwd?: string;
  dot?: boolean;
  absolute?: boolean;
  onlyFiles?: boolean;
  throwErrorOnBrokenSymlink?: boolean;
  signal?: AbortSignal;
}

interface BunHashCallable {
  (input: string | Uint8Array | ArrayBuffer, seed?: number | string): number;
  xxHash64(input: string | Uint8Array, seed?: number): string;
  wyhash(input: string | Uint8Array, seed?: number): string;
}

interface BunPassword {
  hash(
    password: string,
    algorithm?: string | { algorithm: string },
  ): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

interface BunStdin {
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
}

interface BunToml {
  parse(text: string): unknown;
  stringify(obj: unknown): string;
}
interface BunYaml {
  parse(text: string): unknown;
  stringify(obj: unknown, options?: unknown): string;
}
interface BunJsonc {
  parse(text: string): unknown;
}
interface BunJson5 {
  parse(text: string): unknown;
  stringify(obj: unknown, options?: unknown): string;
}

interface BunJsonlParseChunkResult {
  values: unknown[];
  error: Error | null;
  read: number;
  done: boolean;
}

interface BunJsonl {
  parse(text: string): unknown[];
  parseChunk(
    input: Uint8Array | string,
    start?: number,
    stop?: number,
  ): BunJsonlParseChunkResult;
}

interface BunWhichOptions {
  cwd?: string;
  PATH?: string;
}

interface BunSpawnOptions<
  In =
    | "pipe"
    | "inherit"
    | "ignore"
    | "null"
    | File
    | BunFile
    | Uint8Array
    | ReadableStream,
  Out =
    | "pipe"
    | "inherit"
    | "ignore"
    | "null"
    | File
    | BunFile
    | Uint8Array
    | WritableStream,
  Err =
    | "pipe"
    | "inherit"
    | "ignore"
    | "null"
    | File
    | BunFile
    | Uint8Array
    | WritableStream,
> {
  cwd?: string;
  env?: Record<string, string>;
  stdio?: Array<In | Out | Err>;
  stdin?: In;
  stdout?: Out;
  stderr?: Err;
  onExit?(subprocess: BunSubprocess<In, Out, Err>, exitCode: number): void;
  windowsHide?: boolean;
}

type Dict<T> = Record<string, T>;

declare class Buffer extends Uint8Array {
  static from(
    data: ArrayLike<number> | ArrayBuffer | string,
    encoding?: string,
  ): Buffer;
  static alloc(size: number): Buffer;
  static allocUnsafe(size: number): Buffer;
  static concat(list: Uint8Array[], totalLength?: number): Buffer;
  static byteLength(
    data: string | ArrayLike<number> | ArrayBuffer,
    encoding?: string,
  ): number;
  toString(encoding?: string): string;
  equals(other: Uint8Array): boolean;
  copy(
    target: Uint8Array,
    targetStart?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ): number;
}

interface BunSpawnOptionsWritableToIO<T> {
  pipe(): WritableStream<T>;
}

interface BunSocket<T = unknown> {
  write(data: string | Uint8Array): number;
  flush(): void;
  end(): void;
  reload(options: { socket: BunSocketHandlers<T> }): void;
}

interface BunSocketHandlers<T = unknown> {
  open?(socket: BunSocket<T>): void;
  data?(socket: BunSocket<T>, data: Uint8Array): void;
  close?(socket: BunSocket<T>): void;
  error?(socket: BunSocket<T>, error: Error): void;
}

interface BunListenResult {
  port: number;
  hostname: string;
  stop(): void;
}

declare namespace Bun {
  namespace SpawnOptions {
    type WritableToIO<T> = BunSpawnOptionsWritableToIO<T>;
  }
  type WhichOptions = BunWhichOptions;
  type Socket<T = unknown> = BunSocket<T>;
}

declare var Bun: {
  env: Record<string, string>;
  argv: string[];
  version: string;
  stdin: BunStdin;
  hash: BunHashCallable;
  password: BunPassword;
  TOML: BunToml;
  YAML: BunYaml;
  JSONC: BunJsonc;
  JSON5: BunJson5;
  JSONL: BunJsonl;
  Archive: BunArchiveConstructor;
  Glob: BunGlobConstructor;
  semver: { satisfies: Promise<unknown>; order: Promise<unknown> };

  sleep(ms: number): Promise<void>;
  nanoseconds(): bigint;
  which(name: string, options?: BunWhichOptions): string | null;
  file(path: string): BunFile;
  write(
    path: string | URL,
    data:
      | string
      | Uint8Array
      | ArrayBuffer
      | Blob
      | BunFile
      | ReadableStream
      | Response,
  ): Promise<void>;
  serve(options: Record<string, unknown>): BunServer;
  listen(options: {
    hostname?: string;
    port?: number;
    socket: BunSocketHandlers;
  }): BunListenResult;
  connect(options: {
    unix?: string;
    hostname?: string;
    port?: number;
    socket: BunSocketHandlers;
  }): Promise<BunSocket>;
  build(options: {
    entrypoints: string[];
    outdir?: string;
    minify?: boolean;
    naming?: string;
    target?: string | string[];
    define?: Record<string, string>;
    external?: string[];
    sourcemap?: boolean;
  }): Promise<{
    success: boolean;
    outputs: Map<string, unknown>;
    logs: string[];
  }>;
  spawn<In = "pipe", Out = "pipe", Err = "pipe">(
    cmd: string[] | string,
    options?: BunSpawnOptions<In, Out, Err>,
  ): BunSubprocess<In, Out, Err>;
  spawnSync(
    cmd: string[] | string,
    options?: BunSpawnOptions,
  ): {
    stdout: Uint8Array;
    stderr: Uint8Array;
    exitCode: number;
    success: boolean;
  };
  stringWidth(
    str: string,
    options?: { countAnsiEscapeCodes?: boolean },
  ): number;
  wrapAnsi(
    str: string,
    width: number,
    options?: Record<string, unknown>,
  ): string;
  fileURLToPath(url: string | URL): string;
  pathToFileURL(path: string): URL;
  listen(options: Record<string, unknown>): unknown;

  SpawnOptions: typeof Bun.SpawnOptions;
  WhichOptions: BunWhichOptions;

  (strings: TemplateStringsArray, ...values: unknown[]): BunShellPromise;
};
