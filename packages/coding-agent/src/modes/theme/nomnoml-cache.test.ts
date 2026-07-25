import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import * as utils from "@oh-my-pi/pi-utils";
import { clearNomnomlCache, resolveNomnomlAscii, resolveNomnomlPng } from "./nomnoml-cache";

const ASCII_CACHE_MAX_ENTRIES = 256;
const PNG_CACHE_MAX_ENTRIES = 64;

describe("nomnoml cache bounds", () => {
	beforeEach(() => {
		clearNomnomlCache();
	});

	afterEach(() => {
		clearNomnomlCache();
	});

	it("evicts the oldest ascii entry once the cap is reached and keeps the newest", () => {
		const render = spyOn(utils, "renderNomnomlAsciiSafe").mockImplementation(source => source);
		for (let i = 0; i < ASCII_CACHE_MAX_ENTRIES; i++) resolveNomnomlAscii(`[N${i}]`);
		expect(render).toHaveBeenCalledTimes(ASCII_CACHE_MAX_ENTRIES);

		// A full-but-not-over cache still serves both ends.
		resolveNomnomlAscii("[N0]");
		resolveNomnomlAscii(`[N${ASCII_CACHE_MAX_ENTRIES - 1}]`);
		expect(render).toHaveBeenCalledTimes(ASCII_CACHE_MAX_ENTRIES);

		resolveNomnomlAscii("[overflow]");
		expect(render).toHaveBeenCalledTimes(ASCII_CACHE_MAX_ENTRIES + 1);

		// The oldest key is gone, the newest two survive.
		resolveNomnomlAscii("[N0]");
		expect(render).toHaveBeenCalledTimes(ASCII_CACHE_MAX_ENTRIES + 2);
		resolveNomnomlAscii("[overflow]");
		resolveNomnomlAscii(`[N${ASCII_CACHE_MAX_ENTRIES - 1}]`);
		expect(render).toHaveBeenCalledTimes(ASCII_CACHE_MAX_ENTRIES + 2);

		render.mockRestore();
	});

	it("keys ascii entries per width so one source at many widths still respects the cap", () => {
		const render = spyOn(utils, "renderNomnomlAsciiSafe").mockImplementation(source => source);
		for (let width = 1; width <= ASCII_CACHE_MAX_ENTRIES; width++) resolveNomnomlAscii("[A]", width);
		expect(render).toHaveBeenCalledTimes(ASCII_CACHE_MAX_ENTRIES);

		resolveNomnomlAscii("[A]", ASCII_CACHE_MAX_ENTRIES + 1);
		// Width 1 was evicted by the overflow insert; the newest width is still cached.
		resolveNomnomlAscii("[A]", ASCII_CACHE_MAX_ENTRIES + 1);
		expect(render).toHaveBeenCalledTimes(ASCII_CACHE_MAX_ENTRIES + 1);
		resolveNomnomlAscii("[A]", 1);
		expect(render).toHaveBeenCalledTimes(ASCII_CACHE_MAX_ENTRIES + 2);

		render.mockRestore();
	});

	it("evicts the oldest png entry once the cap is reached and keeps the newest", async () => {
		const render = spyOn(utils, "renderNomnomlSvg").mockReturnValue(null);
		for (let i = 0; i < PNG_CACHE_MAX_ENTRIES; i++) await resolveNomnomlPng(`[P${i}]`);
		expect(render).toHaveBeenCalledTimes(PNG_CACHE_MAX_ENTRIES);

		await resolveNomnomlPng("[overflow]");
		expect(render).toHaveBeenCalledTimes(PNG_CACHE_MAX_ENTRIES + 1);

		await resolveNomnomlPng("[overflow]");
		await resolveNomnomlPng(`[P${PNG_CACHE_MAX_ENTRIES - 1}]`);
		expect(render).toHaveBeenCalledTimes(PNG_CACHE_MAX_ENTRIES + 1);

		await resolveNomnomlPng("[P0]");
		expect(render).toHaveBeenCalledTimes(PNG_CACHE_MAX_ENTRIES + 2);

		render.mockRestore();
	});

	it("never evicts an in-flight png render that another caller is awaiting", async () => {
		// Only the deferred source rasterizes; the filler sources settle as null.
		const render = spyOn(utils, "renderNomnomlSvg").mockImplementation(source =>
			source === "[slow]" ? "<svg/>" : null,
		);
		const { promise, resolve } = Promise.withResolvers<Uint8Array>();
		const raster = spyOn(natives, "renderSvgToPng").mockReturnValue(promise);

		const inFlight = resolveNomnomlPng("[slow]");
		for (let i = 0; i < PNG_CACHE_MAX_ENTRIES + 8; i++) await resolveNomnomlPng(`[F${i}]`);

		// The pending entry survived the eviction sweep, so this dedupes onto it.
		const joined = resolveNomnomlPng("[slow]");
		expect(raster).toHaveBeenCalledTimes(1);

		resolve(new Uint8Array([1, 2, 3]));
		expect(await inFlight).toBe(await joined);
		expect(await inFlight).toBe(Buffer.from([1, 2, 3]).toString("base64"));

		raster.mockRestore();
		render.mockRestore();
	});
});
