/**
 * `/okf` slash command — manage the OKF knowledge bundle.
 *
 * Subcommands: view, list, stats, diagnose, reindex, visualize, enrich.
 */

import * as path from "node:path";
import { buildGraph, getBundleRoot, loadConcept, loadSummaries, renderIndex, walkBundle } from "../okf/bundle";
import { OkfDocumentError, validate } from "../okf/document";
import { buildCodebaseEnrichmentPrompt } from "../okf/enrichment/codebase";
import { SqliteOkfStore } from "../okf/store/store-sqlite";
import { generateViewer } from "../okf/viewer/generator";
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
		const root = getBundleRoot(cwd);

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
				const typeLines = [...types.entries()].map(([t, n]) => `  ${t}: ${n}`).join("\n");
				await runtime.output(
					`OKF Bundle Stats\n  Bundle: ${root}\n  Concepts: ${summaries.length}\n  Links: ${graph.edges.length}\n  Broken links: ${brokenLinks.length}\n  Types:\n${typeLines}`,
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
				const store = new SqliteOkfStore(path.join(root, "okf.db"));
				try {
					const ids = await walkBundle(root);
					const summaries = await loadSummaries(root, { autoUpdate: false });
					let indexed = 0;
					for (const id of ids) {
						try {
							const concept = await loadConcept(root, id);
							const summary = summaries.find(s => s.id === id);
							if (summary) {
								await store.upsert(summary, concept.body);
								indexed++;
							}
						} catch {
							// Skip concepts that fail to load.
						}
					}
					await runtime.output(`OKF reindex: ${indexed}/${ids.length} concepts indexed.`);
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
				const outPath = outArg || path.join(root, "okf-graph.html");
				await Bun.write(outPath, html);
				await runtime.output(
					`OKF graph viewer: ${outPath} (${graph.nodes.length} nodes, ${graph.edges.length} edges${brokenLinks.length > 0 ? `, ${brokenLinks.length} broken links` : ""}).`,
				);
				return commandConsumed();
			}
			case "enrich": {
				const focus = command.args.trim().split(/\s+/).slice(1).join(" ");
				const prompt = buildCodebaseEnrichmentPrompt({ cwd, focus: focus || undefined });
				await runtime.output(
					"OKF enrichment: starting codebase-walking agent. Use the spawned task to author concepts.\n\n" +
						"Prompt for the enrichment subagent:\n```\n" +
						prompt +
						"\n```",
				);
				return commandConsumed();
			}
			default:
				return usage("Usage: /okf <view|list|stats|diagnose|reindex|visualize|enrich>", runtime);
		}
	},
};
