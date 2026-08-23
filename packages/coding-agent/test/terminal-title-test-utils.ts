import * as ffi from "bun:ffi";
import { spyOn } from "bun:test";

/**
 * Controls the fake `kernel32.dll` console-title implementation installed for a
 * test. `set()` calls are recorded in {@link titles}; {@link current} is what
 * `GetConsoleTitleW` reports back, and a successful `set()` updates it so the
 * console retains the write like the real one does. Point tests can overwrite
 * `current` directly to simulate an external attached process hijacking the
 * shared console title mid-session.
 */
export interface WindowsConsoleTitleMock {
	readonly titles: string[];
	current: string;
	succeeds: boolean;
	restore(): void;
}

function readWideTitle(pointer: ffi.Pointer): string {
	let title = "";
	for (let offset = 0; ; offset += Uint16Array.BYTES_PER_ELEMENT) {
		const unit = ffi.read.u16(pointer, offset);
		if (unit === 0) return title;
		title += String.fromCharCode(unit);
	}
}

/** Installs a type-safe `kernel32.dll` FFI double until {@link WindowsConsoleTitleMock.restore} runs. */
export function mockWindowsConsoleTitle(): WindowsConsoleTitleMock {
	let setCallback: ffi.JSCallback | undefined;
	let getCallback: ffi.JSCallback | undefined;
	const mock: WindowsConsoleTitleMock = {
		titles: [],
		current: "",
		succeeds: false,
		restore() {
			dlopenSpy.mockRestore();
			setCallback?.close();
			getCallback?.close();
		},
	};
	const dlopenSpy = spyOn(ffi, "dlopen").mockImplementation((_name, symbols) => {
		setCallback = new ffi.JSCallback(
			(pointer: ffi.Pointer) => {
				if (!mock.succeeds) return false;
				const title = readWideTitle(pointer);
				mock.titles.push(title);
				mock.current = title;
				return true;
			},
			{ args: [ffi.FFIType.ptr], returns: ffi.FFIType.bool },
		);
		getCallback = new ffi.JSCallback(
			(pointer: ffi.Pointer, sizeChars: number) => {
				if (sizeChars <= 0) return 0;
				const capped = mock.current.slice(0, sizeChars - 1);
				ffi.toBuffer(pointer, 0, sizeChars * 2).write(`${capped}\0`, "utf16le");
				return capped.length;
			},
			{ args: [ffi.FFIType.ptr, ffi.FFIType.u32], returns: ffi.FFIType.u32 },
		);
		for (const name of ["SetConsoleTitleW", "GetConsoleTitleW"] as const) {
			const definition: unknown = Reflect.get(symbols, name);
			if (!definition || typeof definition !== "object") throw new Error(`${name} binding missing`);
			Reflect.set(definition, "ptr", name === "SetConsoleTitleW" ? setCallback.ptr : getCallback.ptr);
		}
		return ffi.linkSymbols(symbols);
	});
	return mock;
}
