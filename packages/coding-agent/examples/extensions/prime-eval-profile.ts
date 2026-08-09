import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import PRIME_PROFILE_PROMPT from "./prime-eval-profile.md" with { type: "text" };

const PRIME_PYTHON_PRELUDE = `
if "_PrimeProfileUnsupported" not in globals():
    class _PrimeProfileUnsupported(RuntimeError):
        pass

    def _prime_profile_unsupported(operation):
        raise _PrimeProfileUnsupported(
            f"Prime eval profile does not support {operation}; OMP owns lifecycle and terminal policy"
        )

    _omp_agent = agent

    class _PrimeRlm:
        def run(
            self,
            prompt,
            *,
            agent="task",
            label=None,
            schema=None,
            schema_mode=None,
            isolated=None,
            apply=None,
            merge=None,
            handle=False,
        ):
            return _omp_agent(
                prompt,
                agent=agent,
                label=label,
                schema=schema,
                schema_mode=schema_mode,
                isolated=isolated,
                apply=apply,
                merge=merge,
                handle=handle,
            )

        def schedule(self, *args, **kwargs):
            return _prime_profile_unsupported("schedule")

        def heartbeat(self, *args, **kwargs):
            return _prime_profile_unsupported("heartbeat")

        def goal(self, *args, **kwargs):
            return _prime_profile_unsupported("goal")

        def refine(self, *args, **kwargs):
            return _prime_profile_unsupported("refine")

    def schedule(*args, **kwargs):
        return _prime_profile_unsupported("schedule")

    def heartbeat(*args, **kwargs):
        return _prime_profile_unsupported("heartbeat")

    def goal(*args, **kwargs):
        return _prime_profile_unsupported("goal")

    def refine(*args, **kwargs):
        return _prime_profile_unsupported("refine")

if "rlm" not in globals() or not isinstance(rlm, _PrimeRlm):
    rlm = _PrimeRlm()
`.trim();

const MODULE_DOCSTRING = /^(?:[rRuU])?(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')/;

function lineEnd(source: string, offset: number): number {
	const newline = source.indexOf("\n", offset);
	return newline === -1 ? source.length : newline + 1;
}

function consumeTrivia(source: string, offset: number): number {
	while (offset < source.length) {
		const end = lineEnd(source, offset);
		const line = source.slice(offset, end).trim();
		if (line !== "" && !line.startsWith("#")) break;
		offset = end;
	}
	return offset;
}

function consumeModuleDocstring(source: string, offset: number): number {
	const match = MODULE_DOCSTRING.exec(source.slice(offset));
	if (!match) return offset;
	const literalEnd = offset + match[0].length;
	const end = lineEnd(source, literalEnd);
	const suffix = source.slice(literalEnd, end).trim();
	return suffix === "" || suffix.startsWith("#") ? end : offset;
}

function consumeFutureImport(source: string, offset: number): number {
	if (!/^from[ \t]+__future__[ \t]+import\b/.test(source.slice(offset))) return offset;
	let cursor = offset;
	let parentheses = 0;
	while (cursor < source.length) {
		const end = lineEnd(source, cursor);
		const line = source.slice(cursor, end).split("#", 1)[0] ?? "";
		for (const character of line) {
			if (character === "(") parentheses++;
			else if (character === ")") parentheses--;
		}
		cursor = end;
		if (parentheses <= 0 && !line.trimEnd().endsWith("\\")) return cursor;
	}
	return cursor;
}

function injectPythonPrelude(source: string): string {
	let headerEnd = consumeTrivia(source, 0);
	const docstringEnd = consumeModuleDocstring(source, headerEnd);
	if (docstringEnd !== headerEnd) headerEnd = consumeTrivia(source, docstringEnd);
	while (true) {
		const importEnd = consumeFutureImport(source, headerEnd);
		if (importEnd === headerEnd) break;
		headerEnd = consumeTrivia(source, importEnd);
	}
	return `${source.slice(0, headerEnd)}${PRIME_PYTHON_PRELUDE}\n\n${source.slice(headerEnd)}`;
}

export default function primeEvalProfile(pi: ExtensionAPI) {
	const activate = () => pi.setActiveTools(["eval"]);
	pi.on("session_start", activate);
	pi.on("session_tree", activate);
	pi.on("session_branch", activate);
	pi.on("before_agent_start", event => ({
		systemPrompt: [...event.systemPrompt, PRIME_PROFILE_PROMPT],
	}));
	pi.on("tool_call", event => {
		if (event.toolName !== "eval") return;
		const language = typeof event.input.language === "string" ? event.input.language.toLowerCase() : "py";
		if (language !== "py" && language !== "python") {
			return {
				block: true,
				reason: `Prime eval profile only supports Python, not ${language}`,
			};
		}
		const code = event.input.code;
		if (typeof code !== "string") {
			return { block: true, reason: "Prime eval profile requires Python code" };
		}
		return {
			input: {
				...event.input,
				language: "py",
				code: injectPythonPrelude(code),
			},
		};
	});
}
