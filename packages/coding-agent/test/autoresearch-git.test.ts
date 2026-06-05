import { afterEach, describe, expect, it, vi } from "bun:test";

import { ensureAutoresearchBranch } from "../src/autoresearch/git";
import { Settings } from "../src/config/settings";
import type { ExtensionAPI } from "../src/extensibility/extensions";
import * as git from "../src/utils/git";
import * as jj from "../src/utils/jj";

const CWD = "/repo";
const PURE_JJ_AUTORESEARCH_ERROR =
	"Autoresearch branch isolation is not supported in pure jj repositories yet. Use a colocated Git repository or run without branch isolation.";

const api = {} as ExtensionAPI;

function gitRepository(): git.GitRepository {
	return {
		commonDir: `${CWD}/.git`,
		gitDir: `${CWD}/.git`,
		gitEntryPath: `${CWD}/.git`,
		headPath: `${CWD}/.git/HEAD`,
		repoRoot: CWD,
	};
}

describe("autoresearch Git branch isolation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns an error in pure jj repositories before Git status or branch mutation", async () => {
		vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated({ "repository.mode": "jj" }));
		vi.spyOn(jj.repo, "resolve").mockResolvedValue({ repoRoot: CWD, storeDir: `${CWD}/.jj/repo/store` });
		vi.spyOn(git.repo, "resolve").mockResolvedValue(null);
		const status = vi.spyOn(git, "status");
		const checkoutNew = vi.spyOn(git.branch, "checkoutNew");

		const result = await ensureAutoresearchBranch(api, CWD, "measure runtime");

		expect(result).toEqual({ ok: false, error: PURE_JJ_AUTORESEARCH_ERROR });
		expect(status).not.toHaveBeenCalled();
		expect(checkoutNew).not.toHaveBeenCalled();
	});

	it("returns an error when repository mode probing fails before Git status or branch mutation", async () => {
		vi.spyOn(Settings, "init").mockRejectedValue(new Error("settings unavailable"));
		const status = vi.spyOn(git, "status");
		const checkoutNew = vi.spyOn(git.branch, "checkoutNew");

		const result = await ensureAutoresearchBranch(api, CWD, "measure runtime");

		expect(result).toEqual({
			ok: false,
			error: "Unable to resolve repository mode before autoresearch branch isolation: settings unavailable",
		});
		expect(status).not.toHaveBeenCalled();
		expect(checkoutNew).not.toHaveBeenCalled();
	});

	it("allows jj mode with colocated Git to use existing autoresearch Git branch isolation", async () => {
		vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated({ "repository.mode": "jj" }));
		vi.spyOn(jj.repo, "resolve").mockResolvedValue({ repoRoot: CWD, storeDir: `${CWD}/.jj/repo/store` });
		vi.spyOn(git.repo, "resolve").mockResolvedValue(gitRepository());
		vi.spyOn(git.repo, "root").mockResolvedValue(CWD);
		vi.spyOn(git, "status").mockResolvedValue("");
		vi.spyOn(git.show, "prefix").mockResolvedValue("");
		vi.spyOn(git.branch, "current").mockResolvedValue("main");
		vi.spyOn(git.ref, "exists").mockResolvedValue(false);
		const checkoutNew = vi.spyOn(git.branch, "checkoutNew").mockResolvedValue(undefined);

		const result = await ensureAutoresearchBranch(api, CWD, "measure runtime");

		expect(result.ok).toBe(true);
		expect(result.ok ? result.created : false).toBe(true);
		expect(checkoutNew.mock.calls[0]?.[1]).toMatch(/^autoresearch\/measure-runtime-\d{8}$/);
	});
});
