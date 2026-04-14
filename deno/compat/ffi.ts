export const FFIType = {
  void: "void",
  bool: "bool",
  i8: "i8",
  u8: "u8",
  i16: "i16",
  u16: "u16",
  i32: "i32",
  u32: "u32",
  i64: "i64",
  u64: "u64",
  f32: "f32",
  f64: "f64",
  ptr: "ptr",
} as const;

export class CString {
  #data: Uint8Array;
  constructor(data: Uint8Array) {
    this.#data = data;
  }
  toString(): string {
    let end = this.#data.indexOf(0);
    if (end === -1) end = this.#data.length;
    return new TextDecoder().decode(this.#data.subarray(0, end));
  }
  get byteLength(): number {
    return this.#data.byteLength;
  }
  get ptr(): number {
    return 0;
  }
}

export function dlopen(
  _path: string,
  _symbols: Record<string, unknown>,
): never {
  throw new Error(`bun:ffi dlopen is not supported under Deno`);
}

export function ptr(_buffer: ArrayBuffer | ArrayBufferView): null {
  return null;
}
