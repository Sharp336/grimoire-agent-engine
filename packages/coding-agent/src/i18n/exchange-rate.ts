/**
 * 汇率转换服务
 *
 * 提供 USD→CNY 汇率查询，用于中文 locale 下成本显示。
 * 使用免费公开 API，缓存 24 小时。
 */

// node:fs sync API needed because getExchangeRateSync() must work in non-async contexts.
// Bun.file().text() is async-only; no sync equivalent exists in Bun.
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { settings } from "../config/settings";
import { getLanguage } from "./index";

// Cache paths - can be overridden for testing
let CACHE_DIR = path.join(os.homedir(), ".omp", "cache");
let CACHE_FILE = path.join(CACHE_DIR, "exchange-rate.json");

/**
 * Override cache paths (for testing only).
 */
export function setCachePath(dir: string): void {
	CACHE_DIR = dir;
	CACHE_FILE = path.join(dir, "exchange-rate.json");
}

/**
 * Reset cache paths to defaults (for testing cleanup).
 */
export function resetCachePath(): void {
	CACHE_DIR = path.join(os.homedir(), ".omp", "cache");
	CACHE_FILE = path.join(CACHE_DIR, "exchange-rate.json");
}

/**
 * Reset in-memory rate state (for test isolation only).
 */
export function resetRateForTest(): void {
	currentRate = FALLBACK_RATE;
	cacheInitialized = false;
	currentRateFromManual = false;
}
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
export const FALLBACK_RATE = 7.24; // fallback USD→CNY
const API_URL = "https://open.er-api.com/v6/latest/USD";

interface ExchangeRateCache {
	timestamp: number;
	rate: number;
}

/** True for a positive finite number — guards cached/user-configured rates. */
function isValidRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Module-level sync cache
let currentRate: number = FALLBACK_RATE;
let cacheInitialized = false;
let currentRateFromManual = false;

/**
 * Synchronously initialize rate from cache file.
 * Lazy-initialized on first access to avoid module-load side effects.
 */
function ensureCacheInitialized(): void {
	if (cacheInitialized) return;
	cacheInitialized = true;
	try {
		const content = fsSync.readFileSync(CACHE_FILE, "utf-8");
		const cache: ExchangeRateCache = JSON.parse(content);
		if (Date.now() - cache.timestamp < CACHE_TTL_MS && isValidRate(cache.rate)) {
			currentRate = cache.rate;
		}
	} catch {
		// cache miss or corrupt, keep fallback
	}
}

export function initCache(): void {
	ensureCacheInitialized();
}

/**
 * Fetch latest USD→CNY rate from API.
 * NOTE: This is zh-specific — hardcoded to CNY.
 */
async function fetchRate(): Promise<number> {
	const resp = await fetch(API_URL, { signal: AbortSignal.timeout(5_000) });
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	const data = (await resp.json()) as { rates?: Record<string, number> };
	const cny = data.rates?.CNY;
	if (typeof cny !== "number" || cny <= 0) throw new Error("Invalid rate");
	return cny;
}

async function loadCachedRate(): Promise<number | null> {
	try {
		const content = await Bun.file(CACHE_FILE).text();
		const cache: ExchangeRateCache = JSON.parse(content);
		if (Date.now() - cache.timestamp < CACHE_TTL_MS && isValidRate(cache.rate)) {
			return cache.rate;
		}
	} catch {
		// cache miss or corrupt
	}
	return null;
}

async function saveCache(rate: number): Promise<void> {
	const cache: ExchangeRateCache = { timestamp: Date.now(), rate };
	await Bun.write(CACHE_FILE, JSON.stringify(cache));
}

/**
 * Get user-configured exchange rate, if set.
 */
function getUserConfiguredRate(): number | undefined {
	try {
		return settings.get("i18n.exchangeRate");
	} catch {
		// Settings not initialized (e.g., `omp stats --summary`)
		return undefined;
	}
}

/**
 * Async fetch latest rate from API and update cache.
 * Updates currentRate on success.
 */
export async function refreshExchangeRate(): Promise<number> {
	const userRate = getUserConfiguredRate();
	if (userRate !== undefined && isValidRate(userRate)) {
		currentRate = userRate;
		currentRateFromManual = true;
		return userRate;
	}
	if (currentRateFromManual) {
		currentRate = FALLBACK_RATE;
		currentRateFromManual = false;
		cacheInitialized = false;
	}

	try {
		const rate = await fetchRate();
		currentRate = rate;
		await saveCache(rate);
		return rate;
	} catch (error) {
		logger.warn("Failed to fetch exchange rate, using fallback", { error });
		logger.warn("Set i18n.exchangeRate in settings to use a manual rate and avoid network calls");
		return currentRate;
	}
}

/**
 * 获取 USD→CNY 汇率（异步版本，向后兼容）。
 * 优先使用用户配置，其次缓存（24h 有效），失败时回退硬编码值。
 */
export async function getExchangeRate(): Promise<number> {
	const userRate = getUserConfiguredRate();
	if (userRate !== undefined && isValidRate(userRate)) {
		currentRate = userRate;
		currentRateFromManual = true;
		return userRate;
	}
	if (currentRateFromManual) {
		currentRate = FALLBACK_RATE;
		currentRateFromManual = false;
		cacheInitialized = false;
	}

	const cached = await loadCachedRate();
	if (cached !== null) {
		currentRate = cached;
		return cached;
	}

	try {
		const rate = await fetchRate();
		currentRate = rate;
		await saveCache(rate);
		return rate;
	} catch (error) {
		if (currentRate !== FALLBACK_RATE) {
			logger.warn("Failed to cache exchange rate, using last known rate", { error });
			return currentRate;
		}
		logger.warn("Failed to fetch exchange rate, using fallback", { error });
		logger.warn("Set i18n.exchangeRate in settings to use a manual rate and avoid network calls");
		return FALLBACK_RATE;
	}
}

/**
 * Sync exchange rate. Returns current cached value.
 */
export function getExchangeRateSync(): number {
	const userRate = getUserConfiguredRate();
	if (userRate !== undefined && isValidRate(userRate)) {
		currentRate = userRate;
		currentRateFromManual = true;
		return userRate;
	}
	// If manual rate was cleared, reset and reload from cache
	if (currentRateFromManual) {
		currentRate = FALLBACK_RATE;
		currentRateFromManual = false;
		cacheInitialized = false;
	}
	ensureCacheInitialized();
	return currentRate;
}

/**
 * 判断当前 locale 是否需要汇率转换（仅中文启用）。
 * NOTE: Currently zh-specific — returns CNY conversion. When adding other
 * languages, this check must be updated to match the target language(s).
 */
export function shouldConvertCurrency(): boolean {
	const lang = getLanguage();
	return lang === "zh";
}

/**
 * 格式化成本，locale 为中文时附加 CNY 换算
 * @returns [usd 字符串，cny 字符串 | null]
 * NOTE: CNY formatting (¥) is zh-specific.
 */
export async function formatCostWithExchange(usdAmount: number): Promise<[string, string | null]> {
	const usd = formatUSDFormat(usdAmount);
	if (!shouldConvertCurrency()) return [usd, null];

	const rate = await getExchangeRate();
	const cnyAmount = usdAmount * rate;
	const cny = `≈¥${cnyAmount.toFixed(2)}`;
	return [usd, cny];
}

/**
 * Sync cost formatter. Returns "$X.XX" for en locale, "$X.XX (≈¥Y.YY)" for zh.
 * Honors user-configured exchange rate via getExchangeRateSync().
 * NOTE: CNY formatting (¥) is zh-specific.
 */

export function formatCost(usdAmount: number, locale?: string): string {
	const usd = formatUSDFormat(usdAmount);
	// If locale is explicitly passed, use it; otherwise detect from i18n
	const effectiveLocale = locale ?? (shouldConvertCurrency() ? "zh" : "en");
	if (effectiveLocale !== "zh") {
		return usd;
	}
	const rate = getExchangeRateSync();
	const cnyAmount = usdAmount * rate;
	return `${usd} (≈¥${cnyAmount.toFixed(2)})`;
}

function formatUSDFormat(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}
