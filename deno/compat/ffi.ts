export {
  dlopen,
  FFIType,
  JSCallback,
  ptr,
  suffix,
  toArrayBuffer,
} from "@lu-zero/bun-compat/bun";
export { defineEnum, defineStruct } from "@lu-zero/bun-compat/ffi-structs";

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
