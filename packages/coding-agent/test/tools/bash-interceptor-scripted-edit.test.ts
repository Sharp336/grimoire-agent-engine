import { describe, expect, it } from "bun:test";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { checkBashInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";

const tools = ["read", "search", "find", "edit", "write"];

function scriptedEditRules() {
	return DEFAULT_BASH_INTERCEPTOR_RULES.filter(
		r => r.tool === "edit" && (r.pattern.includes("python") || r.pattern.includes("node|nodejs|bun")),
	);
}

describe("default bash interceptor scripted file edits", () => {
	const rules = scriptedEditRules();

	it("blocks python -c open with write mode", () => {
		const result = checkBashInterception("python -c \"open('foo.ts','w').write('x')\"", tools, rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks python -c open().write()", () => {
		const result = checkBashInterception("python -c \"open('foo.ts').write('x')\"", tools, rules);
		expect(result.block).toBe(true);
	});

	it("blocks python -c with open mode keyword", () => {
		const result = checkBashInterception(
			"python -c \"with open('a.ts', mode='w') as f: f.write('x')\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks python -c with open mode w+", () => {
		const result = checkBashInterception(
			"python -c \"with open('a.ts', mode='w+') as f: f.write('x')\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks python -c with open mode r+", () => {
		const result = checkBashInterception(
			"python -c \"with open('a.ts', mode='r+') as f: f.write('x')\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks python -c with open mode r+b", () => {
		const result = checkBashInterception(`python -c "open('src/foo.py','r+b').write(b'x')"`, tools, rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks python -c with open mode rb+", () => {
		const result = checkBashInterception(
			"python -c \"with open('a.ts', mode='rb+') as f: f.write(b'x')\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks multiline python -c Path.write_text", () => {
		const result = checkBashInterception(
			"python -c \"from pathlib import Path\nPath('a.ts').write_text('x')\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks multiline python -c Path.open write mode", () => {
		const result = checkBashInterception(
			"python -c \"from pathlib import Path\nwith Path('a.ts').open('w') as f: f.write('x')\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks python -c Path.write_bytes", () => {
		const result = checkBashInterception(
			"python -c \"from pathlib import Path; Path('a.ts').write_bytes(b'x')\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks python -c after inline env prefix", () => {
		const result = checkBashInterception("PYTHONPATH=. python -c \"open('a.ts','w').write('x')\"", tools, rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks env -S split-string python -c write", () => {
		const result = checkBashInterception("env -S \"python -c \\\"open('a.ts','w').write('x')\\\"\"", tools, rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});
	it("blocks env -u python -c write", () => {
		const result = checkBashInterception("env -u PYTHONPATH python -c \"open('a.ts','w').write('x')\"", tools, rules);
		expect(result.block).toBe(true);
	});

	it("blocks env -C node -e write", () => {
		const result = checkBashInterception(
			"env -C /tmp node -e \"require('fs').writeFileSync('a.ts','')\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
	});
	it("blocks env-wrapped python -c write", () => {
		const result = checkBashInterception("env PYTHONPATH=. python -c \"open('a.ts','w').write('x')\"", tools, rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks usr-bin-env python -c write", () => {
		const result = checkBashInterception("/usr/bin/env python -c \"open('a.ts','w').write('x')\"", tools, rules);
		expect(result.block).toBe(true);
	});

	it("blocks env-wrapped node -e write", () => {
		const result = checkBashInterception("env node -e \"require('fs').writeFileSync('a.ts','')\"", tools, rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks usr-bin-env bun -e write", () => {
		const result = checkBashInterception("/usr/bin/env bun -e \"Bun.write('a.ts', 'x')\"", tools, rules);
		expect(result.block).toBe(true);
	});
	it("blocks node -e writeFileSync", () => {
		const result = checkBashInterception("node -e \"require('fs').writeFileSync('a.ts','')\"", tools, rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks node -e appendFileSync", () => {
		const result = checkBashInterception("node -e \"require('fs').appendFileSync('a.ts','x')\"", tools, rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks node -e after inline env prefix", () => {
		const result = checkBashInterception(
			"NODE_OPTIONS= node -e \"require('fs').writeFileSync('a.ts','')\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks bun -e Bun.write", () => {
		const result = checkBashInterception("bun -e \"await Bun.write('a.ts', 'x')\"", tools, rules);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("does not block python -c read-only open", () => {
		const result = checkBashInterception("python -c \"print(open('a.ts').read())\"", tools, rules);
		expect(result.block).toBe(false);
	});

	it("does not block python -c Path read_text", () => {
		const result = checkBashInterception(
			"python -c \"from pathlib import Path; print(Path('a.ts').read_text())\"",
			tools,
			rules,
		);
		expect(result.block).toBe(false);
	});

	it("does not block python -c sys.stdout.write", () => {
		const result = checkBashInterception("python -c \"import sys; sys.stdout.write('ok')\"", tools, rules);
		expect(result.block).toBe(false);
	});

	it("does not block python -c sys.stdout.writelines", () => {
		const result = checkBashInterception("python -c \"import sys; sys.stdout.writelines(['ok'])\"", tools, rules);
		expect(result.block).toBe(false);
	});

	it("blocks python -c Path.writelines", () => {
		const result = checkBashInterception(
			"python -c \"from pathlib import Path; Path('a.ts').writelines(['x'])\"",
			tools,
			rules,
		);
		expect(result.block).toBe(true);
		expect(result.suggestedTool).toBe("edit");
	});

	it("blocks python -c open().writelines", () => {
		const result = checkBashInterception("python -c \"open('a.ts','w').writelines(['x'])\"", tools, rules);
		expect(result.block).toBe(true);
	});

	it("does not block python -c that only prints", () => {
		const result = checkBashInterception('python -c "print(1)"', tools, rules);
		expect(result.block).toBe(false);
	});
});
