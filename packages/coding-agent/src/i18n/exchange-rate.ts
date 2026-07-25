/**
 * 汇率转换服务
 *
 * 提供 USD→CNY 汇率查询，用于中文 locale 下成本显示。
 * 使用免费公开 API，缓存 24 小时。
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { settings } from "../config/settings";
import { getLanguage } from "./index";

const CACHE_DIR = path.join(os.homedir(), ".omp", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "exchange-rate.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const FALLBACK_RATE = 7.24; // fallback USD→CNY
const API_URL = "https://open.er-api.com/v6/latest/USD";

interface ExchangeRateCache {
	timestamp: number;
	rate: number;
}

// Module-level sync cache
let currentRate: number = FALLBACK_RATE;
let cacheInitialized = false;

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
		if (Date.now() - cache.timestamp < CACHE_TTL_MS) {
			currentRate = cache.rate;
		}
	} catch {
		// cache miss or corrupt, keep fallback
	}
}

export function initCache(): void {
	ensureCacheInitialized();
}

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
		if (Date.now() - cache.timestamp < CACHE_TTL_MS) {
			return cache.rate;
		}
	} catch {
		// cache miss or corrupt
	}
	return null;
}

async function saveCache(rate: number): Promise<void> {
	const cache: ExchangeRateCache = { timestamp: Date.now(), rate };
	await fs.mkdir(CACHE_DIR, { recursive: true });
	await Bun.write(CACHE_FILE, JSON.stringify(cache));
}

/**
 * Get user-configured exchange rate, if set.
 */
function getUserConfiguredRate(): number | undefined {
	return settings.get("i18n.exchangeRate");
}

/**
 * Async fetch latest rate from API and update cache.
 * Updates currentRate on success.
 */
export async function refreshExchangeRate(): Promise<number> {
	const userRate = getUserConfiguredRate();
	if (userRate !== undefined && userRate > 0) {
		currentRate = userRate;
		return userRate;
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
	if (userRate !== undefined && userRate > 0) {
		currentRate = userRate;
		return userRate;
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
	if (userRate !== undefined && userRate > 0) {
		currentRate = userRate;
		return userRate;
	}
	ensureCacheInitialized();
	return currentRate;
}

/**
 * 判断当前 locale 是否需要汇率转换（非 en 时启用）
 */
export function shouldConvertCurrency(): boolean {
	const lang = getLanguage();
	return lang !== "en";
}

/**
 * 格式化成本，locale 为中文时附加 CNY 换算
 * @returns [usd 字符串，cny 字符串 | null]
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
 */

export function formatCost(usdAmount: number): string {
	const usd = formatUSDFormat(usdAmount);
	if (!shouldConvertCurrency()) {
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
