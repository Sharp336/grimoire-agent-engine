#!/usr/bin/env bun
/**
 * 为每个 en-settings-*.json 生成对应的 zh-settings-*.json 模板
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LAN_DIR = path.join(os.homedir(), ".omp", "lang");

// 读取所有 en-settings-*.json 文件
const files = fs.readdirSync(LAN_DIR).filter(f => f.startsWith("en-settings-") && f.endsWith(".json"));

console.log(`Found ${files.length} English settings files`);

for (const enFile of files) {
	const enPath = path.join(LAN_DIR, enFile);
	const enData = JSON.parse(fs.readFileSync(enPath, "utf-8"));

	// 生成对应的中文文件名
	const zhFile = enFile.replace("en-settings-", "zh-settings-");
	const zhPath = path.join(LAN_DIR, zhFile);

	// Read existing translations to preserve non-empty values
	let existingZh: Record<string, string> = {};
	try {
		existingZh = JSON.parse(fs.readFileSync(zhPath, "utf-8"));
	} catch {
		/* file doesn't exist yet */
	}

	// Merge: preserve existing non-empty values, use empty for new keys
	const zhData: Record<string, string> = {};
	for (const key of Object.keys(enData)) {
		zhData[key] = existingZh[key] || "";
	}

	fs.writeFileSync(zhPath, JSON.stringify(zhData, null, 2));

	const totalKeys = Object.keys(zhData).length;
	const preservedKeys = Object.values(zhData).filter(v => v !== "").length;
	console.log(`\u2713 ${zhFile}: ${totalKeys} keys (${preservedKeys} preserved)`);
}

console.log("\nDone!");
