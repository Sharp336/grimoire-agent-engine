import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type CouncilPublicationDurabilityOperation,
	CouncilPublicationError,
	commitStagedCouncilPublication,
	councilPublicationSlug,
	ensureCouncilPlansDirectory,
	publishCouncilPlan,
	publishedCouncilPlanMatches,
	resolveCouncilPublicationTarget,
	resolvePromisedCouncilPublicationTarget,
	stageCouncilPublication,
} from "@oh-my-pi/pi-coding-agent/council/publication";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("council publication targets", () => {
	it("creates bounded lowercase kebab slugs that never end in -plan", () => {
		expect(councilPublicationSlug("  Fix OAuth_2 / Redirect PLAN  ")).toBe("fix-oauth-2-redirect");
		expect(councilPublicationSlug("plan")).toBe("council");
		expect(councilPublicationSlug(`${"Long task ".repeat(20)}plan`).length).toBeLessThanOrEqual(80);
		expect(councilPublicationSlug(`${"Long task ".repeat(20)}plan`)).not.toEndWith("-plan");
	});

	it("rejects promised output paths outside the shared durable slug contract", async () => {
		using temp = TempDir.createSync("@omp-council-invalid-target-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		for (const outputPath of [
			"plans/plan.md",
			"plans/review-plan.md",
			"plans/Review.md",
			"plans/nested/review.md",
			`plans/${"a".repeat(81)}.md`,
		]) {
			await expect(
				publishedCouncilPlanMatches(repoRoot, outputPath, { sha256: "a".repeat(64), bytes: 0 }),
			).rejects.toMatchObject({ code: "INVALID_TARGET" });
		}
	});

	it("syncs the repository root when creating plans and rejects symlink paths", async () => {
		using temp = TempDir.createSync("@omp-council-plans-directory-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const operations: CouncilPublicationDurabilityOperation[] = [];
		await ensureCouncilPlansDirectory(repoRoot, { onDurabilityOperation: operation => operations.push(operation) });
		expect(operations).toEqual(["directory-sync"]);

		const linkedRepo = temp.join("linked-repo");
		const outside = temp.join("outside");
		fs.mkdirSync(linkedRepo);
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(linkedRepo, "plans"));
		await expect(resolveCouncilPublicationTarget(linkedRepo, "task")).rejects.toThrow("not a real directory");

		const repoLink = temp.join("repo-link");
		fs.symlinkSync(repoRoot, repoLink);
		await expect(ensureCouncilPlansDirectory(repoLink)).rejects.toThrow("not a real directory");
	});

	it("resolves a collision suffix once", async () => {
		using temp = TempDir.createSync("@omp-council-target-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(path.join(repoRoot, "plans"), { recursive: true });
		fs.writeFileSync(path.join(repoRoot, "plans", "review-auth.md"), "existing");
		const target = await resolveCouncilPublicationTarget(repoRoot, "Review auth plan");
		expect(target.relativePath).toBe("plans/review-auth-2.md");
		const promised = await resolvePromisedCouncilPublicationTarget(repoRoot, "plans/review-auth.md");
		expect(promised.relativePath).toBe("plans/review-auth.md");
		expect(promised.slug).toBe("review-auth");
	});
});

describe("atomic council publication", () => {
	it("does not expose a final file when interrupted after durable temp staging", async () => {
		using temp = TempDir.createSync("@omp-council-stage-");
		const plansDirectory = temp.join("plans");
		fs.mkdirSync(plansDirectory);
		const finalPath = path.join(plansDirectory, "task.md");
		const staged = await stageCouncilPublication(plansDirectory, "complete plan");

		expect(fs.existsSync(staged.tempPath)).toBeTrue();
		expect(fs.existsSync(finalPath)).toBeFalse();
		fs.unlinkSync(staged.tempPath);
		expect(fs.existsSync(finalPath)).toBeFalse();
	});

	it("removes the staged file without linking when cancellation lands before commit", async () => {
		using temp = TempDir.createSync("@omp-council-stage-abort-");
		const plansDirectory = temp.join("plans");
		fs.mkdirSync(plansDirectory);
		const finalPath = path.join(plansDirectory, "task.md");
		const staged = await stageCouncilPublication(plansDirectory, "complete plan");
		const controller = new AbortController();
		controller.abort();

		await expect(
			commitStagedCouncilPublication(staged, finalPath, { signal: controller.signal }),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fs.existsSync(staged.tempPath)).toBeFalse();
		expect(fs.existsSync(finalPath)).toBeFalse();
	});

	it("orders file sync, hard link, directory sync, then durable temp cleanup", async () => {
		using temp = TempDir.createSync("@omp-council-publication-order-");
		const plansDirectory = temp.join("plans");
		fs.mkdirSync(plansDirectory);
		const finalPath = path.join(plansDirectory, "task.md");
		const operations: CouncilPublicationDurabilityOperation[] = [];
		const durability = {
			onDurabilityOperation: (operation: CouncilPublicationDurabilityOperation) => operations.push(operation),
		};
		const staged = await stageCouncilPublication(plansDirectory, "complete plan", durability);
		await commitStagedCouncilPublication(staged, finalPath, durability);

		expect(operations).toEqual(["file-sync", "link", "directory-sync", "unlink", "directory-sync"]);
		expect(fs.readFileSync(finalPath, "utf8")).toBe("complete plan");
		expect(fs.existsSync(staged.tempPath)).toBeFalse();
	});

	it("publishes a complete no-clobber file", async () => {
		using temp = TempDir.createSync("@omp-council-publish-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const target = await resolveCouncilPublicationTarget(repoRoot, "Review auth");
		const first = await publishCouncilPlan({
			repoRoot,
			outputPath: target.relativePath,
			content: "# Complete plan\n",
			now: "2026-08-05T12:00:00.000Z",
		});
		expect(first.idempotent).toBeFalse();
		expect(first.path).toBe(target.relativePath);
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("# Complete plan\n");
		expect(await publishedCouncilPlanMatches(repoRoot, target.relativePath, first)).toBeTrue();
	});

	it("adopts a matching promised target only with explicit recovery opt-in", async () => {
		using temp = TempDir.createSync("@omp-council-adopt-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const target = await resolveCouncilPublicationTarget(repoRoot, "Resume target");
		const first = await publishCouncilPlan({
			repoRoot,
			outputPath: target.relativePath,
			content: "durable final plan",
			now: "2026-08-05T12:00:00.000Z",
		});
		const resumed = await publishCouncilPlan({
			repoRoot,
			outputPath: target.relativePath,
			content: "this content is not allowed to replace the durable target",
			published: first,
			resume: true,
		});

		expect(resumed).toMatchObject({ idempotent: true, sha256: first.sha256, bytes: first.bytes });
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("durable final plan");
	});

	it("keeps a nonmatching existing target terminal during recovery", async () => {
		using temp = TempDir.createSync("@omp-council-adopt-mismatch-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const target = await resolveCouncilPublicationTarget(repoRoot, "Mismatch target");
		fs.writeFileSync(target.absolutePath, "competitor");
		await expect(
			publishCouncilPlan({
				repoRoot,
				outputPath: target.relativePath,
				content: "our durably referenced plan",
				resume: true,
			}),
		).rejects.toMatchObject({ code: "EEXIST", terminal: true });
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("competitor");
	});

	it("keeps a fresh equal-byte competitor terminal without adoption opt-in", async () => {
		using temp = TempDir.createSync("@omp-council-fresh-equal-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const target = await resolveCouncilPublicationTarget(repoRoot, "Fresh target");
		fs.writeFileSync(target.absolutePath, "same bytes");
		await expect(
			publishCouncilPlan({ repoRoot, outputPath: target.relativePath, content: "same bytes" }),
		).rejects.toMatchObject({ code: "EEXIST", terminal: true });
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("same bytes");
	});

	it("treats a low-level EEXIST race as terminal and durably removes the staged file", async () => {
		using temp = TempDir.createSync("@omp-council-eexist-");
		const repoRoot = temp.join("repo");
		fs.mkdirSync(repoRoot);
		const target = await resolveCouncilPublicationTarget(repoRoot, "Race target");
		const operations: CouncilPublicationDurabilityOperation[] = [];
		const durability = {
			onDurabilityOperation: (operation: CouncilPublicationDurabilityOperation) => operations.push(operation),
		};
		const staged = await stageCouncilPublication(target.plansDirectory, "our plan", durability);
		fs.writeFileSync(target.absolutePath, "winner");
		try {
			await commitStagedCouncilPublication(staged, target.absolutePath, durability);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilPublicationError);
			expect(error).toMatchObject({ code: "EEXIST", terminal: true });
		}
		expect(operations).toEqual(["file-sync", "unlink", "directory-sync"]);
		expect(fs.readFileSync(target.absolutePath, "utf8")).toBe("winner");
		expect(fs.existsSync(staged.tempPath)).toBeFalse();
	});
});
