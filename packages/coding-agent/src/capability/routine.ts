import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface RoutineCommandStep {
	command: string;
	args?: string;
}

export interface RoutineMessageStep {
	message: string;
}

export type RoutineStep = RoutineCommandStep | RoutineMessageStep;

export interface Routine {
	name: string;
	path: string;
	description: string;
	steps: RoutineStep[];
	level: "user";
	_source: SourceMeta;
}

export const routineCapability = defineCapability<Routine>({
	id: "routines",
	displayName: "Routines",
	description: "User-defined sequential slash-command routines",
	key: routine => routine.name,
	toExtensionId: routine => `routine:${routine.name}`,
	validate: routine => {
		if (!routine.name) return "Missing name";
		if (!routine.path) return "Missing path";
		if (!routine.description) return "Missing description";
		if (!Array.isArray(routine.steps) || routine.steps.length === 0) return "Missing steps";
		return undefined;
	},
});
