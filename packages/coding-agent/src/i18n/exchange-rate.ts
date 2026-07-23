/**
 * 汇率转换服务
 *
 * 提供 USD→CNY 汇率查询，用于中文 locale 下成本显示。
 * 使用免费公开 API，缓存 24 小时。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { logger } from "@oh-my-pi/pi-utils";
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

async function fetchRate(): Promise<number> {
	const resp = await fetch(API_URL);
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
 * 获取 USD→CNY 汇率。
 * 优先使用缓存（24h 有效），失败时回退硬编码值。
 */
export async function getExchangeRate(): Promise<number> {
	const cached = await loadCachedRate();
	if (cached !== null) return cached;

	try {
		const rate = await fetchRate();
		await saveCache(rate);
		return rate;
	} catch (error) {
		logger.warn("Failed to fetch exchange rate, using fallback", { error });
		return FALLBACK_RATE;
	}
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
 * @returns [usd 字符串, cny 字符串 | null]
 */
export async function formatCostWithExchange(usdAmount: number): Promise<[string, string | null]> {
	const usd = formatUSDFormat(usdAmount);
	if (!shouldConvertCurrency()) return [usd, null];

	const rate = await getExchangeRate();
	const cnyAmount = usdAmount * rate;
	const cny = `≈¥${cnyAmount.toFixed(2)}`;
	return [usd, cny];
}

function formatUSDFormat(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}
