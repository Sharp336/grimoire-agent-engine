import { NIKOFLOW_DEPTHS, type NikoflowDepth } from "../nikoflow/state";

export type ParsedNikoflowArgs = { depth: NikoflowDepth; autonomous: boolean; argv: string[] } | { error: string };

const ROLE_FLAGS: Record<string, string> = {
	"--exec": "--model",
	"--architect": "--plan",
	"--qa": "--nikoflow-qa",
};

function parseDepth(value: string | undefined): NikoflowDepth | undefined {
	const normalized = value?.toLowerCase();
	return normalized && NIKOFLOW_DEPTHS.includes(normalized as NikoflowDepth)
		? (normalized as NikoflowDepth)
		: undefined;
}

export function normalizeNikoflowCommandArgs(argv: string[]): ParsedNikoflowArgs {
	let depth: NikoflowDepth = "standard";
	let autonomous = false;
	let sawPositional = false;
	const rest: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		const equalsIndex = arg.indexOf("=");
		const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
		const mappedFlag = ROLE_FLAGS[flag];
		if (mappedFlag) {
			const value = equalsIndex === -1 ? argv[index + 1] : arg.slice(equalsIndex + 1);
			if (!value) return { error: `Missing value for ${flag}` };
			rest.push(mappedFlag, value);
			if (equalsIndex === -1) index += 1;
			continue;
		}
		if (!sawPositional) {
			const positionalDepth = parseDepth(arg);
			if (positionalDepth) {
				depth = positionalDepth;
				sawPositional = true;
				continue;
			}
		}
		if (arg === "--depth") {
			const next = argv[index + 1];
			const parsed = parseDepth(next);
			if (!parsed) return { error: `Invalid Nikoflow depth: ${next ?? ""}` };
			depth = parsed;
			sawPositional = true;
			index += 1;
			continue;
		}
		if (arg.startsWith("--depth=")) {
			const parsed = parseDepth(arg.slice("--depth=".length));
			if (!parsed) return { error: `Invalid Nikoflow depth: ${arg.slice("--depth=".length)}` };
			depth = parsed;
			sawPositional = true;
			continue;
		}
		if (arg === "--batch") {
			autonomous = true;
			continue;
		}
		sawPositional = true;
		rest.push(arg);
	}

	return { depth, autonomous, argv: rest };
}
