interface BunStat {
  size: number;
  mtimeMs: number | null;
  atimeMs: number | null;
  ctimeMs: number | null;
  birthtimeMs: number | null;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  dev: number | null;
  ino: number | bigint | null;
  nlink: number | null;
  rdev: number | null;
  blksize: number | null;
  blocks: number | null;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymlink(): boolean;
}

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
  stat(): Promise<BunStat | null>;
  readable: ReadableStream<Uint8Array>;
  writer(): BunFileSink;
  slice(start?: number, end?: number, contentType?: string): BunFile;
  unlink(): Promise<void>;
  get writable(): WritableStream<Uint8Array>;
}

interface BunFileSink {
  write(data: string | Uint8Array): number;
  flush(): number | undefined;
  end(): void;
  ref(): void;
  unref(): void;
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
  stdin: In extends "pipe" ? BunSpawnOptionsWritableToIO<Uint8Array> : null;
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
  scanSync(options?: BunGlobScanOptions): string[];
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
  xxHash32(input: string | Uint8Array, seed?: number): number;
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

interface BunCryptoHasher {
  update(data: string | Uint8Array | ArrayBuffer | Buffer): BunCryptoHasher;
  digest(
    encoding?: "hex" | "base64" | "buffer" | "latin1",
  ): Uint8Array | string;
  digestSync(
    encoding?: "hex" | "base64" | "buffer" | "latin1",
  ): Uint8Array | string;
}

interface BunCryptoHasherConstructor {
  new (algorithm: string): BunCryptoHasher;
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
  signal?: AbortSignal;
  timeout?: number;
}

interface BunServer {
  port: number;
  hostname: string;
  stop(): void;
  ref(): void;
  unref(): void;
}

interface BunSpawnOptionsWritableToIO<T> extends WritableStream<T> {
  write(data: string | Uint8Array): number;
  flush(): number | undefined;
  end(): void;
  ref(): void;
  unref(): void;
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
  static isBuffer(obj: unknown): obj is Buffer;
  toString(encoding?: string): string;
  equals(other: Uint8Array): boolean;
  copy(
    target: Uint8Array,
    targetStart?: number,
    sourceStart?: number,
    sourceEnd?: number,
  ): number;
  readUInt8(offset?: number): number;
  readUInt16LE(offset?: number): number;
  readUInt16BE(offset?: number): number;
  readUInt32LE(offset?: number): number;
  readUInt32BE(offset?: number): number;
  readInt8(offset?: number): number;
  readInt16LE(offset?: number): number;
  readInt16BE(offset?: number): number;
  readInt32LE(offset?: number): number;
  readInt32BE(offset?: number): number;
  readBigUInt64LE(offset?: number): bigint;
  readBigUInt64BE(offset?: number): bigint;
  readBigInt64LE(offset?: number): bigint;
  readBigInt64BE(offset?: number): bigint;
  readFloatLE(offset?: number): number;
  readFloatBE(offset?: number): number;
  readDoubleLE(offset?: number): number;
  readDoubleBE(offset?: number): number;
  writeUInt8(value: number, offset?: number): number;
  writeUInt16LE(value: number, offset?: number): number;
  writeUInt16BE(value: number, offset?: number): number;
  writeUInt32LE(value: number, offset?: number): number;
  writeUInt32BE(value: number, offset?: number): number;
  writeInt8(value: number, offset?: number): number;
  writeInt16LE(value: number, offset?: number): number;
  writeInt16BE(value: number, offset?: number): number;
  writeInt32LE(value: number, offset?: number): number;
  writeInt32BE(value: number, offset?: number): number;
  writeFloatLE(value: number, offset?: number): number;
  writeFloatBE(value: number, offset?: number): number;
  writeDoubleLE(value: number, offset?: number): number;
  writeDoubleBE(value: number, offset?: number): number;
  subarray(start?: number, end?: number): Buffer;
  slice(start?: number, end?: number): Buffer;
}

declare var Buffer: {
  prototype: Buffer;
  new (str: string, encoding?: string): Buffer;
  new (size: number): Buffer;
  new (array: Uint8Array): Buffer;
  new (arrayBuffer: ArrayBuffer): Buffer;
  from(
    data: ArrayLike<number> | ArrayBuffer | string,
    encoding?: string,
  ): Buffer;
  alloc(size: number): Buffer;
  allocUnsafe(size: number): Buffer;
  concat(list: Uint8Array[], totalLength?: number): Buffer;
  byteLength(
    data: string | ArrayLike<number> | ArrayBuffer,
    encoding?: string,
  ): number;
  isBuffer(obj: unknown): obj is Buffer;
  isEncoding(encoding: string): boolean;
  compare(buf1: Uint8Array, buf2: Uint8Array): number;
};

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

interface BunColor {
  (input: string | number, format: string): string | null;
}

declare type Timer = number;

declare namespace NodeJS {
  type Timeout = number;
  type Timer = number;
}

interface BunTimer extends number {
  ref(): BunTimer;
  unref(): BunTimer;
  hasRef(): boolean;
  refresh(): BunTimer;
}

declare var setTimeout: {
  <T extends (...args: any[]) => void>(
    callback: T,
    ms?: number,
    ...args: Parameters<T>
  ): BunTimer;
  (ms?: number): Promise<void>;
};

declare var setInterval: {
  <T extends (...args: any[]) => void>(
    callback: T,
    ms?: number,
    ...args: Parameters<T>
  ): BunTimer;
};

declare var clearTimeout: (id: BunTimer | number | undefined) => void;
declare var clearInterval: (id: BunTimer | number | undefined) => void;

declare namespace Bun {
  namespace SpawnOptions {
    type WritableToIO<T> = BunSpawnOptionsWritableToIO<T>;
  }
  type WhichOptions = BunWhichOptions;
  type Socket<T = unknown> = BunSocket<T>;
  type FileSink = BunFileSink;
  type Server = BunServer;
  type BunFile = BunFile;
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
  color: BunColor;

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

  SpawnOptions: typeof Bun.SpawnOptions;
  WhichOptions: BunWhichOptions;
  CryptoHasher: BunCryptoHasherConstructor;

  stripANSI(text: string): string;
  inspect(
    value: unknown,
    options?: { depth?: number; colors?: boolean },
  ): string;
  gc(major?: boolean): void;
  generateHeapSnapshot(format?: string): object;

  (strings: TemplateStringsArray, ...values: unknown[]): BunShellPromise;
};
