import * as os from "node:os";
import * as path from "node:path";
import type { UserPersona } from "./types";

export interface PersonaStore {
	load(): Promise<UserPersona | undefined>;
	save(persona: UserPersona): Promise<void>;
}

export class FilePersonaStore implements PersonaStore {
	readonly #filePath: string;

	constructor(filePath?: string) {
		this.#filePath = filePath ?? path.join(os.homedir(), ".omp", "persona.json");
	}

	async load(): Promise<UserPersona | undefined> {
		try {
			const text = await Bun.file(this.#filePath).text();
			return JSON.parse(text) as UserPersona;
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code === "ENOENT") return undefined;
			throw err;
		}
	}

	async save(persona: UserPersona): Promise<void> {
		await Bun.write(this.#filePath, JSON.stringify(persona, null, 2));
	}
}
