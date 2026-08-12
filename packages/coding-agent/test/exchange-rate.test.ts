import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { i18n } from "../src/i18n";
import {
	FALLBACK_RATE,
	formatCost,
	getExchangeRate,
	getExchangeRateSync,
	refreshExchangeRate,
	resetCachePath,
	resetRateForTest,
	setCachePath,
	shouldConvertCurrency,
} from "../src/i18n/exchange-rate";

let tempDir: string;
let tempCacheDir: string;
let tempCacheFile: string;

function writeCacheFile(rate: number, ageMs = 0): void {
	fsSync.mkdirSync(tempCacheDir, { recursive: true });
	const cache = { timestamp: Date.now() - ageMs, rate };
	fsSync.writeFileSync(tempCacheFile, JSON.stringify(cache));
}

function removeCacheFile(): void {
	try {
		fsSync.unlinkSync(tempCacheFile);
	} catch {
		// ignore
	}
}

describe("exchange-rate", () => {
	let fetchSpy: Mock<typeof fetch>;
	const originalLang = process.env.OMP_LANG;

	beforeEach(() => {
		// Use temp directory for cache to avoid polluting real ~/.omp/cache
		tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "omp-test-"));
		tempCacheDir = path.join(tempDir, "cache");
		tempCacheFile = path.join(tempCacheDir, "exchange-rate.json");
		setCachePath(tempCacheDir);
		resetRateForTest();
		removeCacheFile(); // Ensure no leftover cache from previous tests

		fetchSpy = vi.spyOn(globalThis, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		resetSettingsForTest();
		removeCacheFile();
		// Clean up temp directory
		try {
			fsSync.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		if (originalLang !== undefined) {
			process.env.OMP_LANG = originalLang;
		} else {
			delete process.env.OMP_LANG;
		}
		resetCachePath();
		// Reset in-memory rate state too so later tests in the same Bun process
		// don't reuse the last test's temp/manual rate (resetCachePath only
		// changes filenames).
		resetRateForTest();
		i18n.reset();
	});

	describe("refreshExchangeRate", () => {
		it("returns user-configured rate and skips fetch", async () => {
			await Settings.init({ inMemory: true, overrides: { "i18n.exchangeRate": 7.5 } });

			const rate = await refreshExchangeRate();

			expect(rate).toBe(7.5);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("fetches from API when no user-configured rate", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ rates: { CNY: 7.1 } }), { status: 200 }));

			const rate = await refreshExchangeRate();

			expect(rate).toBe(7.1);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it("returns current rate on fetch failure", async () => {
			// Prime currentRate via a successful fetch
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ rates: { CNY: 7.3 } }), { status: 200 }));
			await refreshExchangeRate();

			// Now fail the fetch
			fetchSpy.mockRejectedValueOnce(new Error("Network error"));
			const rate = await refreshExchangeRate();

			expect(rate).toBe(7.3);
		});

		it("persists fetched rate to cache file", async () => {
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ rates: { CNY: 7.12 } }), { status: 200 }));

			await refreshExchangeRate();

			const content = fsSync.readFileSync(tempCacheFile, "utf-8");
			const cache = JSON.parse(content) as { rate: number };
			expect(cache.rate).toBe(7.12);
		});
	});

	describe("getExchangeRate", () => {
		it("returns user-configured rate and skips fetch and cache", async () => {
			await Settings.init({ inMemory: true, overrides: { "i18n.exchangeRate": 6.8 } });

			const rate = await getExchangeRate();

			expect(rate).toBe(6.8);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("returns cached rate without fetching when cache is valid", async () => {
			writeCacheFile(7.05);

			const rate = await getExchangeRate();

			expect(rate).toBe(7.05);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("fetches and caches when cache is expired", async () => {
			// Write a cache entry older than 24h TTL
			writeCacheFile(6.5, 25 * 60 * 60 * 1000);
			fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ rates: { CNY: 7.2 } }), { status: 200 }));

			const rate = await getExchangeRate();

			expect(rate).toBe(7.2);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it("falls back to default rate when fetch fails and no cache", async () => {
			fetchSpy.mockRejectedValueOnce(new Error("Network error"));

			const rate = await getExchangeRate();

			expect(rate).toBe(FALLBACK_RATE);
		});
	});

	describe("getExchangeRateSync", () => {
		it("returns a positive number synchronously", () => {
			const rate = getExchangeRateSync();
			expect(rate).toBeTypeOf("number");
			expect(rate).toBeGreaterThan(0);
		});

		it("returns user-configured rate when settings has i18n.exchangeRate", async () => {
			await Settings.init({ inMemory: true, overrides: { "i18n.exchangeRate": 6.5 } });

			const rate = getExchangeRateSync();

			expect(rate).toBe(6.5);
		});
	});

	describe("shouldConvertCurrency", () => {
		it("returns true for zh locale", () => {
			process.env.OMP_LANG = "zh";
			i18n.reset();

			expect(shouldConvertCurrency()).toBe(true);
		});

		it("returns false for en locale", () => {
			process.env.OMP_LANG = "en";
			i18n.reset();

			expect(shouldConvertCurrency()).toBe(false);
		});
	});

	describe("formatCost", () => {
		it("returns USD-only string for en locale", () => {
			process.env.OMP_LANG = "en";
			i18n.reset();

			expect(formatCost(1.5)).toBe("$1.50");
		});

		it("returns USD with CNY conversion for zh locale", async () => {
			process.env.OMP_LANG = "zh";
			i18n.reset();
			await Settings.init({ inMemory: true, overrides: { "i18n.exchangeRate": 7.0 } });

			const result = formatCost(1.5);

			expect(result).toContain("$1.50");
			expect(result).toContain("≈¥10.50");
		});

		it("uses 4 decimal places for very small amounts", () => {
			process.env.OMP_LANG = "en";
			i18n.reset();

			expect(formatCost(0.0012)).toBe("$0.0012");
		});

		it("uses 3 decimal places for sub-dollar amounts", () => {
			process.env.OMP_LANG = "en";
			i18n.reset();

			expect(formatCost(0.5)).toBe("$0.500");
		});
	});
});
