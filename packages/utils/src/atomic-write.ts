import * as fs from "node:fs/promises";
import { Snowflake } from "./snowflake";

/** Write formatted JSON through a unique temporary file and atomically replace the target. */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const tempPath = `${filePath}.tmp.${process.pid}.${Snowflake.next()}`;
	try {
		await Bun.write(tempPath, `${JSON.stringify(data, null, 2)}\n`);
		try {
			await fs.rename(tempPath, filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			await fs.rm(filePath, { force: true });
			await fs.rename(tempPath, filePath);
		}
	} finally {
		await fs.rm(tempPath, { force: true });
	}
}
