import { dlopen, FFIType, ptr, read, toBuffer } from "bun:ffi";
import { $envExact } from "@oh-my-pi/pi-utils";

const WINCRED_REF = /^wincred:\/\/([A-Za-z0-9][A-Za-z0-9._~-]{0,254})$/;
const WINDOWS_GENERIC_CREDENTIAL = 1;
const MAX_CREDENTIAL_BYTES = 65_536;

export type WindowsCredentialReader = (target: string) => string | undefined;

/** Resolve Engine credential values without ever replacing the persisted opaque ref. */
export function createEngineCredentialValueResolver(
	readWindowsCredential: WindowsCredentialReader = readGenericWindowsCredential,
): (value: string) => Promise<string | undefined> {
	return async value => {
		if (value.startsWith("wincred://")) {
			const match = WINCRED_REF.exec(value);
			return match ? readWindowsCredential(match[1]!) : undefined;
		}
		return $envExact(value) || value;
	};
}

/** Read one exact generic credential through the Windows Credential Manager API. */
export function readGenericWindowsCredential(target: string): string | undefined {
	if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) return undefined;
	if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/.test(target)) return undefined;

	try {
		const library = dlopen("Advapi32.dll", {
			CredReadW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
			CredFree: { args: [FFIType.ptr], returns: FFIType.void },
		});
		try {
			const wideTarget = Buffer.from(`${target}\0`, "utf16le");
			const output = new BigUint64Array(1);
			if (!library.symbols.CredReadW(ptr(wideTarget), WINDOWS_GENERIC_CREDENTIAL, 0, ptr(output))) {
				return undefined;
			}
			const recordAddress = output[0]!;
			const recordPointer = Number(recordAddress);
			if (!recordPointer) return undefined;
			try {
				if (read.u32(recordPointer, 4) !== WINDOWS_GENERIC_CREDENTIAL) return undefined;
				const byteLength = read.u32(recordPointer, 32);
				const blobPointer = read.ptr(recordPointer, 40);
				if (!blobPointer || byteLength < 1 || byteLength > MAX_CREDENTIAL_BYTES) return undefined;
				const raw = Buffer.from(toBuffer(blobPointer, 0, byteLength));
				try {
					const encoding = raw.includes(0) ? "utf-16" : "utf-8";
					const value = new TextDecoder(encoding, { fatal: true }).decode(raw);
					return value.trim() && !value.includes("\0") ? value : undefined;
				} finally {
					raw.fill(0);
				}
			} finally {
				library.symbols.CredFree(recordAddress);
			}
		} finally {
			library.close();
		}
	} catch {
		return undefined;
	}
}
