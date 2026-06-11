import { ToolError } from "../tools/tool-errors";
import { EVAL_SOURCE_WRITE_BLOCKED_MESSAGE } from "./eval-write-guard";

const CHILD_PROCESS_IDS = new Set(["child_process", "node:child_process"]);

function throwEvalSubprocessBlocked(): never {
	throw new ToolError(EVAL_SOURCE_WRITE_BLOCKED_MESSAGE);
}

function wrapChildProcessModule<T extends object>(mod: T): T {
	const handler: ProxyHandler<object> = {
		get(target, prop, receiver) {
			if (
				prop === "spawn" ||
				prop === "spawnSync" ||
				prop === "exec" ||
				prop === "execSync" ||
				prop === "execFile" ||
				prop === "execFileSync" ||
				prop === "fork"
			) {
				return () => throwEvalSubprocessBlocked();
			}
			return Reflect.get(target, prop, receiver);
		},
	};
	return new Proxy(mod, handler) as T;
}

/** When source-write blocking is on, block subprocess APIs that can mutate project files. */
export function guardChildProcessModule<T extends object>(mod: T, guardActive: boolean): T {
	if (!guardActive) return mod;
	return wrapChildProcessModule(mod);
}

export function isChildProcessModuleId(id: string): boolean {
	return CHILD_PROCESS_IDS.has(id);
}

export function createBlockedBunSpawn(): () => never {
	return () => throwEvalSubprocessBlocked();
}

/** When guard is active, route Bun/Node getBuiltinModule through guarded builtins. */
export function guardProcessGetBuiltinModule(
	processObj: NodeJS.Process,
	guardActive: boolean,
	wrapBuiltin: (specifier: string, mod: unknown) => unknown,
): NodeJS.Process {
	if (!guardActive) return processObj;
	const proc = processObj as NodeJS.Process & {
		getBuiltinModule?: (id: string) => unknown;
	};
	if (typeof proc.getBuiltinModule !== "function") {
		return processObj;
	}
	const real = proc.getBuiltinModule.bind(proc);
	return new Proxy(processObj, {
		get(target, prop, receiver) {
			if (prop === "getBuiltinModule") {
				return (specifier: string) => wrapBuiltin(specifier, real(specifier));
			}
			return Reflect.get(target, prop, receiver);
		},
	}) as NodeJS.Process;
}
