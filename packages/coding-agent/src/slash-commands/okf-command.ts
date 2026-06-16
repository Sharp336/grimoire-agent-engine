/**
 * `/okf` slash command — manage the OKF knowledge bundle.
 *
 * Subcommands: view, list, stats, diagnose, reindex, visualize, enrich.
 */

import * as path from "node:path";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { buildGraph, loadConcept, loadSummaries, renderIndex, resolveBundleRoot, walkBundle } from "../okf/bundle";
import { OkfDocumentError, validate } from "../okf/document";
import { buildCodebaseEnrichmentPrompt } from "../okf/enrichment/codebase";
import { getOkfSessionState } from "../okf/state";
import { SqliteOkfStore } from "../okf/store/store-sqlite";
import { generateViewer } from "../okf/viewer/generator";
import okfEnrichmentDispatch from "../prompts/okf/enrichment-dispatch.md" with { type: "text" };
import { commandConsumed, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const okfCommand: SlashCommandSpec = {
	name: "okf",
	description: "Manage the OKF (Open Knowledge Format) knowledge bundle",
	acpDescription: "Manage OKF knowledge",
	acpInputHint: "<subcommand>",
	subcommands: [
		{ name: "view", description: "Show the OKF bundle index listing" },
		{ name: "list", description: "List all concepts with type and description" },
		{ name: "stats", description: "Show concept count, broken links, and store info" },
		{ name: "diagnose", description: "Run OKF conformance check (spec §9)" },
		{ name: "reindex", description: "Rebuild the search index from the on-disk bundle" },
		{ name: "visualize", description: "Generate a self-contained HTML graph viewer" },
		{ name: "enrich", description: "Author/update concepts from the codebase" },
	],
	allowArgs: true,
	handle: async (command, runtime) => {
		const verb = (command.args.trim().split(/\s+/)[0] ?? "").toLowerCase() || "view";
		const cwd = runtime.cwd;
		const bundleDir = runtime.settings.get("okf.bundleDir") as string | undefined;
		const root = resolveBundleRoot(cwd, bundleDir);
		const okfState = getOkfSessionState(runtime.session);

		switch (verb) {
			case "view": {
				const index = await renderIndex(root);
				await runtime.output(index);
				return commandConsumed();
			}
			case "list": {
				const summaries = await loadSummaries(root, { autoUpdate: false });
				if (summaries.length === 0) {
					await runtime.output("No OKF concepts in the bundle.");
					return commandConsumed();
				}
				const lines = summaries.map(s => `- ${s.type}: ${s.id} — ${s.description}`);
				await runtime.output(`OKF concepts (${summaries.length}):\n\n${lines.join("\n")}`);
				return commandConsumed();
			}
			case "stats": {
				const summaries = await loadSummaries(root, { autoUpdate: false });
				const { graph, brokenLinks } = await buildGraph(root);
				const types = new Map<string, number>();
				for (const s of summaries) types.set(s.type, (types.get(s.type) ?? 0) + 1);
				const typeLines = [...types.entries()]
					.sort((a, b) => a[0].localeCompare(b[0]))
					.map(([t, n]) => `  ${t}: ${n}`);
				const typeBlock = typeLines.length > 0 ? typeLines.join("\n") : "  (none)";
				await runtime.output(
					`OKF Bundle Stats\n  Bundle: ${root}\n  Concepts: ${summaries.length}\n  Links: ${graph.edges.length}\n  Broken links: ${brokenLinks.length}\n  Types:\n${typeBlock}`,
				);
				return commandConsumed();
			}
			case "diagnose": {
				const ids = await walkBundle(root);
				if (ids.length === 0) {
					await runtime.output("OKF bundle is empty — no concepts to diagnose.");
					return commandConsumed();
				}
				const issues: string[] = [];
				for (const id of ids) {
					try {
						validate(await loadConcept(root, id), id);
					} catch (error) {
						issues.push(`  ✗ ${id}: ${error instanceof OkfDocumentError ? error.message : String(error)}`);
					}
				}
				await runtime.output(
					issues.length === 0
						? `OKF conformance check: all ${ids.length} concepts pass §9.`
						: `OKF conformance check: ${issues.length} issue(s) out of ${ids.length}:\n\n${issues.join("\n")}`,
				);
				return commandConsumed();
			}
			case "reindex": {
				if (okfState) {
					const count = await okfState.reindex();
					await runtime.output(`OKF reindex: ${count} concept(s) indexed; stale entries removed.`);
					return commandConsumed();
				}
				// Fallback: session hasn't started the OKF layer — temp SQLite store.
				const store = new SqliteOkfStore(path.join(root, "okf.db"));
				try {
					const ids = new Set(await walkBundle(root));
					const summaries = await loadSummaries(root, { autoUpdate: false });
					let indexed = 0;
					for (const id of ids) {
						try {
							const summary = summaries.find(s => s.id === id);
							if (summary) {
								await store.upsert(summary, (await loadConcept(root, id)).body);
								indexed++;
							}
						} catch {
							// Skip concepts that fail to load.
						}
					}
					const existing = await store.list({ limit: 10000 });
					for (const item of existing) {
						if (!ids.has(item.id)) await store.delete(item.id);
					}
					await runtime.output(`OKF reindex: ${indexed}/${ids.size} concepts indexed; stale entries removed.`);
				} finally {
					await store.close();
				}
				return commandConsumed();
			}
			case "visualize": {
				const { graph, brokenLinks } = await buildGraph(root);
				if (graph.nodes.length === 0) {
					await runtime.output("OKF bundle is empty — nothing to visualise.");
					return commandConsumed();
				}
				const html = generateViewer(graph, { title: "OKF Knowledge Graph" });
				const outArg = command.args.trim().split(/\s+/).slice(1).join(" ");
				let outPath: string;
				if (outArg) {
					const resolved = path.resolve(runtime.cwd, outArg);
					const cwdAbs = path.resolve(runtime.cwd);
					if (resolved !== cwdAbs && !resolved.startsWith(`${cwdAbs}${path.sep}`)) {
						return usage("OKF visualize: output path must be inside the working directory.", runtime);
					}
					outPath = resolved;
				} else {
					outPath = path.join(root, "okf-graph.html");
				}
				await Bun.write(outPath, html);
				await runtime.output(
					`OKF graph viewer: ${outPath} (${graph.nodes.length} nodes, ${graph.edges.length} edges${brokenLinks.length > 0 ? `, ${brokenLinks.length} broken links` : ""}).`,
				);
				return commandConsumed();
			}
			case "enrich": {
				const focus = command.args.trim().split(/\s+/).slice(1).join(" ");
				const assignment = buildCodebaseEnrichmentPrompt({ cwd, focus: focus || undefined });
				const dispatch = prompt.render(okfEnrichmentDispatch, { assignment });
				try {
					runtime.session.setForcedToolChoice("task");
				} catch (error) {
					return usage(
						`Could not start OKF enrichment agent: ${error instanceof Error ? error.message : String(error)}`,
						runtime,
					);
				}
				await runtime.output("OKF enrichment: spawning a codebase-walking task subagent…");
				return { prompt: dispatch };
			}
			default:
				return usage("Usage: /okf <view|list|stats|diagnose|reindex|visualize|enrich>", runtime);
		}
	},
};
