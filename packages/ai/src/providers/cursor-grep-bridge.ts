export type CursorGrepExecSourceArgs = {
	pattern?: string;
	path?: string;
	glob?: string;
	caseInsensitive?: boolean;
};

export type CursorGrepOmpArgs = {
	pattern: string;
	path: string;
	case?: false;
};

export const CURSOR_GREP_EMPTY_PATTERN_ERROR =
	"grep requires a non-empty pattern; Cursor sent an empty search pattern";

/** Map Cursor exec-server grep args to omp's grep tool schema. */
export function mapCursorGrepExecArgs(args: CursorGrepExecSourceArgs): {
	ompArgs: CursorGrepOmpArgs;
	error?: string;
} {
	const searchPath = args.glob ? `${args.path || "."}/${args.glob}` : args.path || ".";
	const pattern = args.pattern ?? "";
	if (!pattern.trim()) {
		return {
			ompArgs: { pattern: "", path: searchPath },
			error: CURSOR_GREP_EMPTY_PATTERN_ERROR,
		};
	}
	return {
		ompArgs: {
			pattern,
			path: searchPath,
			...(args.caseInsensitive === true ? { case: false } : {}),
		},
	};
}
