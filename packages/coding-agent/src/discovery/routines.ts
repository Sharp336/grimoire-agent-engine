import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type Routine, routineCapability } from "../capability/routine";
import type { LoadContext, LoadResult } from "../capability/types";
import { parseRoutineFile } from "../extensibility/routines";
import { loadFilesFromDir } from "./helpers";

const PROVIDER_ID = "native-routines";
const DISPLAY_NAME = "OMP Routines";
const PRIORITY = 100;

async function loadRoutines(ctx: LoadContext): Promise<LoadResult<Routine>> {
	return await loadFilesFromDir<Routine>(ctx, path.join(getAgentDir(), "routines"), PROVIDER_ID, "user", {
		extensions: ["yaml"],
		transform: (name, content, path, source) => parseRoutineFile({ name, content, path, source }),
		recursive: false,
	});
}

registerProvider<Routine>(routineCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load user routines from ~/.omp/agent/routines/*.yaml",
	priority: PRIORITY,
	load: loadRoutines,
});
