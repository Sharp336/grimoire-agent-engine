import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import type { GhToolDetails } from "./gh";
import {
	appendRepoFlag,
	buildTextResult,
	normalizeBlock,
	normalizeOptionalString,
	normalizePrIdentifierList,
	parseLinkedIssueUrl,
	parsePositiveDecimalInt,
	pushLine,
	requireNonEmpty,
} from "./gh-common";
import type { GithubInput } from "./gh-types";
import { githubIssueJsonWithStateReasonFallback } from "./gh-view";
import { invalidateAllIssueViews } from "./github-cache";
import { ToolError, throwIfAborted } from "./tool-errors";

const GH_ISSUE_HIERARCHY_MAX_DEPTH = 8;
const GH_ISSUE_HIERARCHY_MAX_DESCENDANT_PREFLIGHTS = 100;
const GITHUB_HOST_QUALIFIED_REPO_OPS: ReadonlySet<string> = new Set([
	"repo_view",
	"issue_create",
	"issue_state",
	"pr_create",
	"pr_checkout",
]);

interface ParsedRepositorySelector {
	repo: string;
	host?: string;
}

function parseRepositorySelector(value: string): ParsedRepositorySelector | undefined {
	const segments = value.split("/");
	if (segments.length !== 2 && segments.length !== 3) return undefined;

	const hostQualified = segments.length === 3;
	const host = hostQualified ? segments[0]! : "github.com";
	const owner = segments.at(-2)!;
	const repo = segments.at(-1)!;
	const parsed = parseLinkedIssueUrl(`https://${host}/${owner}/${repo}/issues/1`);
	if (!parsed) return undefined;
	return hostQualified ? { host: parsed.host, repo: parsed.repo } : { repo: parsed.repo };
}

export function assertRepositorySelectorSupportedForOperation(op: string, value: string | undefined): void {
	if (!value) return;
	const parsed = parseRepositorySelector(value);
	if (parsed?.host && !GITHUB_HOST_QUALIFIED_REPO_OPS.has(op)) {
		throw new ToolError(`repo host qualification is not supported for ${op}; pass owner/repo instead`);
	}
}

interface NormalizedIssueReference {
	value: string;
	key: string;
	issueNumber: number;
	url?: URL;
}

interface GhIssueMutationLink {
	id?: string;
	number?: number;
	url?: string;
}

interface GhIssueMutationSubIssues {
	nodes?: GhIssueMutationLink[];
	totalCount?: number;
}

interface GhIssueMutationView {
	id?: string;
	parent?: GhIssueMutationLink | null;
	subIssues?: GhIssueMutationSubIssues;
	number?: number;
	url?: string;
}

type PreflightedIssueMutationView = GhIssueMutationView & { id: string };

function normalizeIssueReference(value: string, label: string): NormalizedIssueReference {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		throw new ToolError(`${label} must be a positive issue number or canonical HTTP(S) issue URL`);
	}

	const issueNumber = parsePositiveDecimalInt(normalized);
	if (issueNumber !== undefined) {
		return {
			value: String(issueNumber),
			key: `number:${issueNumber}`,
			issueNumber,
		};
	}

	const parsed = parseLinkedIssueUrl(normalized);
	if (!parsed) {
		throw new ToolError(`${label} must be a positive issue number or canonical HTTP(S) issue URL`);
	}

	const url = new URL(normalized);
	return {
		value: normalized,
		key: `url:${url.host.toLowerCase()}/${parsed.repo.toLowerCase()}#${parsed.issueNumber}`,
		issueNumber: parsed.issueNumber,
		url,
	};
}

function normalizeSubIssueReferences(values: string[] | undefined): NormalizedIssueReference[] {
	if (!values) return [];

	const deduped = new Map<string, NormalizedIssueReference>();
	for (const [index, value] of values.entries()) {
		const reference = normalizeIssueReference(value, `subIssues[${index}]`);
		if (!deduped.has(reference.key)) {
			deduped.set(reference.key, reference);
		}
	}
	const references = [...deduped.values()];
	const numberCount = references.filter(reference => !reference.url).length;
	const urlCount = references.length - numberCount;
	if (numberCount > 100 || urlCount > 100) {
		throw new ToolError("subIssues must contain at most 100 direct children");
	}
	return references;
}

function issueReferenceTargetKey(
	reference: NormalizedIssueReference,
	target: { origin: string; repo: string },
): string {
	if (!reference.url || reference.url.origin !== target.origin) return reference.key;
	const parsed = parseLinkedIssueUrl(reference.value);
	return parsed?.repo.toLowerCase() === target.repo.toLowerCase() ? `number:${reference.issueNumber}` : reference.key;
}

function dedupeSubIssueReferencesForTarget(
	references: readonly NormalizedIssueReference[],
	target: { origin: string; repo: string },
): NormalizedIssueReference[] {
	const deduped = new Map<string, NormalizedIssueReference>();
	for (const reference of references) {
		const key = issueReferenceTargetKey(reference, target);
		if (!deduped.has(key)) deduped.set(key, reference);
	}
	if (deduped.size > 100) {
		throw new ToolError("subIssues must contain at most 100 direct children");
	}
	return [...deduped.values()];
}

function issueViewArgs(
	reference: NormalizedIssueReference,
	repo: string | undefined,
	includeParent: boolean,
	includeSubIssues: boolean,
): string[] {
	const args = ["issue", "view", reference.value];
	if (!reference.url) appendRepoFlag(args, repo);
	const fields = ["id"];
	if (includeParent) fields.push("parent");
	if (includeSubIssues) fields.push("subIssues");
	fields.push("number", "url");
	args.push("--json", fields.join(","));
	return args;
}

interface IssueCreateTarget {
	origin: string;
	host: string;
	repo: string;
}

async function resolveIssueCreateTarget(
	session: ToolSession,
	repo: string | undefined,
	signal: AbortSignal | undefined,
): Promise<IssueCreateTarget> {
	const args = ["repo", "view"];
	if (repo) args.push(repo);
	args.push("--json", "url");
	const view = await git.github.json<{ url?: string }>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const value = normalizeOptionalString(view.url);
	let url: URL;
	try {
		url = new URL(value ?? "");
	} catch {
		throw new ToolError("Could not determine the canonical URL for the issue creation repository");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new ToolError("Could not determine the canonical URL for the issue creation repository");
	}
	const repoPath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
	const parsedRepo = parseLinkedIssueUrl(`${url.origin}${repoPath}/issues/1`);
	if (!parsedRepo || parsedRepo.host !== url.host.toLowerCase()) {
		throw new ToolError("Could not determine the canonical URL for the issue creation repository");
	}
	return { origin: url.origin, host: url.host, repo: parsedRepo.repo };
}

function assertIssueReferenceOrigin(value: string | URL | undefined, target: IssueCreateTarget, label: string): void {
	const rawValue = value instanceof URL ? value.toString() : value;
	if (!rawValue || !parseLinkedIssueUrl(rawValue)) {
		throw new ToolError(`Could not determine the canonical URL for ${label}`);
	}
	const origin = new URL(rawValue).origin;
	if (origin !== target.origin) {
		throw new ToolError(`${label} belongs to ${origin}, but the issue creation repository is on ${target.origin}`);
	}
}

async function assertIssueHierarchyMutationAvailable(
	session: ToolSession,
	target: IssueCreateTarget,
	signal: AbortSignal | undefined,
): Promise<void> {
	const args = ["api", "graphql", "--hostname", target.host];
	args.push("-f", 'query=query IssueHierarchyMutationCapability { __type(name: "Mutation") { fields { name } } }');
	const response = await git.github.json<{
		data?: { __type?: { fields?: Array<{ name?: string }> } };
	}>(session.cwd, args, signal, { repoProvided: true });
	if (!response.data?.__type?.fields?.some(field => field.name === "addSubIssue")) {
		throw new ToolError(`GitHub host ${target.host} does not support issue hierarchy mutations`);
	}
}

interface PreflightIssueReferenceOptions {
	includeParent: boolean;
	includeSubIssues: boolean;
	requireNoParent: boolean;
}

async function preflightIssueReference(
	session: ToolSession,
	reference: NormalizedIssueReference,
	repo: string | undefined,
	label: string,
	options: PreflightIssueReferenceOptions,
	signal: AbortSignal | undefined,
): Promise<PreflightedIssueMutationView> {
	const view = await git.github.json<GhIssueMutationView>(
		session.cwd,
		issueViewArgs(reference, repo, options.includeParent, options.includeSubIssues),
		signal,
		{ repoProvided: Boolean(repo) || Boolean(reference.url) },
	);
	const id = normalizeOptionalString(view.id);
	if (!id) {
		throw new ToolError(`Could not determine the node ID for ${label} ${reference.value}`);
	}
	if (
		options.includeParent &&
		(!Object.hasOwn(view, "parent") ||
			view.parent === undefined ||
			(view.parent !== null && typeof view.parent !== "object"))
	) {
		throw new ToolError(`Could not safely determine whether ${label} ${reference.value} already has a parent`);
	}
	if (options.requireNoParent && view.parent !== null) {
		throw new ToolError(`${label} ${reference.value} already has a parent; set replaceParent=true to move it`);
	}
	return { ...view, id };
}

interface RequestedParentHierarchy {
	depth: number;
	issueIds: ReadonlySet<string>;
}

function throwIssueHierarchyDepthExceeded(): never {
	throw new ToolError(
		`Attaching the created issue would exceed GitHub's maximum issue hierarchy depth of ${GH_ISSUE_HIERARCHY_MAX_DEPTH} levels`,
	);
}

async function inspectRequestedParentHierarchy(
	session: ToolSession,
	target: IssueCreateTarget,
	parent: PreflightedIssueMutationView,
	subIssues: readonly PreflightedIssueMutationView[],
	signal: AbortSignal | undefined,
): Promise<RequestedParentHierarchy> {
	const childIds = new Set(subIssues.map(child => child.id));
	const visitedIds = new Set([parent.id]);
	let current = parent;
	for (let depth = 0; depth < 100; depth++) {
		if (
			!Object.hasOwn(current, "parent") ||
			current.parent === undefined ||
			(current.parent !== null && typeof current.parent !== "object")
		) {
			throw new ToolError("Could not safely inspect the requested parent's ancestor chain");
		}
		const ancestor = current.parent;
		if (ancestor === null) return { depth: visitedIds.size, issueIds: visitedIds };

		const ancestorId = normalizeOptionalString(ancestor.id);
		const ancestorUrl = normalizeOptionalString(ancestor.url);
		if (!ancestorId || !ancestorUrl) {
			throw new ToolError("Could not safely inspect the requested parent's ancestor chain");
		}
		if (childIds.has(ancestorId)) {
			throw new ToolError("subIssues cannot contain an ancestor of parent");
		}
		if (visitedIds.has(ancestorId)) {
			throw new ToolError("The requested parent already belongs to a cyclic issue hierarchy");
		}
		visitedIds.add(ancestorId);
		if (visitedIds.size + 1 > GH_ISSUE_HIERARCHY_MAX_DEPTH) throwIssueHierarchyDepthExceeded();

		const ancestorReference = normalizeIssueReference(ancestorUrl, "parent ancestor");
		assertIssueReferenceOrigin(ancestorReference.url, target, "parent ancestor");
		const ancestorView = await preflightIssueReference(
			session,
			ancestorReference,
			undefined,
			"parent ancestor",
			{ includeParent: true, includeSubIssues: false, requireNoParent: false },
			signal,
		);
		assertIssueReferenceOrigin(ancestorView.url, target, "parent ancestor");
		if (ancestorView.id !== ancestorId) {
			throw new ToolError("GitHub returned an unexpected node ID while inspecting the parent's ancestor chain");
		}
		current = ancestorView;
	}
	throw new ToolError("The requested parent's ancestor chain exceeds the safe traversal limit");
}

function requireCompleteSubIssueLinks(view: GhIssueMutationView, label: string): readonly GhIssueMutationLink[] {
	const connection = view.subIssues;
	if (
		!connection ||
		typeof connection !== "object" ||
		!Array.isArray(connection.nodes) ||
		typeof connection.totalCount !== "number" ||
		!Number.isSafeInteger(connection.totalCount) ||
		connection.totalCount < 0 ||
		connection.totalCount > 100 ||
		connection.totalCount !== connection.nodes.length
	) {
		throw new ToolError(`Could not safely inspect the descendant hierarchy for ${label}`);
	}
	return connection.nodes;
}

interface SubIssueMeasurement {
	height: number;
	nestedRequestedRootIds: ReadonlySet<string>;
}
interface CachedIssueMutationView {
	reference: NormalizedIssueReference;
	view: PreflightedIssueMutationView;
}

async function orderRequestedSubIssueHierarchiesSafely(
	session: ToolSession,
	target: IssueCreateTarget,
	subIssues: readonly PreflightedIssueMutationView[],
	parentHierarchy: RequestedParentHierarchy,
	replaceParent: boolean,
	signal: AbortSignal | undefined,
): Promise<readonly PreflightedIssueMutationView[]> {
	if (subIssues.length === 0) return subIssues;

	const maximumSubIssueHeight = GH_ISSUE_HIERARCHY_MAX_DEPTH - (parentHierarchy.depth + 1);
	if (maximumSubIssueHeight < 1) throwIssueHierarchyDepthExceeded();

	const requestedRootIds = new Set(subIssues.map(child => child.id));
	const requestedRootDescendants = new Map<string, Set<string>>();
	const viewCache = new Map<string, CachedIssueMutationView>();
	for (const child of subIssues) {
		const url = normalizeOptionalString(child.url);
		if (!url) throw new ToolError(`Could not determine the canonical URL for requested sub-issue ${child.id}`);
		const reference = normalizeIssueReference(url, "requested sub-issue");
		assertIssueReferenceOrigin(reference.url, target, "requested sub-issue");
		viewCache.set(child.id, { reference, view: child });
	}

	const measurementCache = new Map<string, SubIssueMeasurement>();
	const activeIds = new Set<string>();
	let descendantPreflightCount = 0;
	const loadDescendant = async (id: string, reference: NormalizedIssueReference): Promise<CachedIssueMutationView> => {
		const cached = viewCache.get(id);
		if (cached) {
			if (cached.reference.key !== reference.key) {
				throw new ToolError("GitHub returned conflicting URLs for the same sub-issue descendant");
			}
			return cached;
		}
		if (descendantPreflightCount >= GH_ISSUE_HIERARCHY_MAX_DESCENDANT_PREFLIGHTS) {
			throw new ToolError(
				`The requested sub-issue hierarchy exceeds the safe preflight limit of ${GH_ISSUE_HIERARCHY_MAX_DESCENDANT_PREFLIGHTS} descendant issues`,
			);
		}
		descendantPreflightCount++;

		const view = await preflightIssueReference(
			session,
			reference,
			undefined,
			"sub-issue descendant",
			{ includeParent: false, includeSubIssues: true, requireNoParent: false },
			signal,
		);
		assertIssueReferenceOrigin(view.url, target, "sub-issue descendant");
		if (view.id !== id) {
			throw new ToolError("GitHub returned an unexpected node ID while inspecting sub-issue descendants");
		}
		const returnedUrl = normalizeOptionalString(view.url);
		if (!returnedUrl) throw new ToolError("Could not determine the canonical URL for a sub-issue descendant");
		const returnedReference = normalizeIssueReference(returnedUrl, "sub-issue descendant");
		if (returnedReference.key !== reference.key) {
			throw new ToolError("GitHub returned an unexpected canonical URL while inspecting sub-issue descendants");
		}
		const loaded = { reference: returnedReference, view };
		viewCache.set(id, loaded);
		return loaded;
	};

	const measureSubtree: (entry: CachedIssueMutationView, allowedHeight: number) => Promise<SubIssueMeasurement> =
		async (entry, allowedHeight) => {
			const cachedMeasurement = measurementCache.get(entry.view.id);
			if (cachedMeasurement) {
				if (cachedMeasurement.height > allowedHeight) throwIssueHierarchyDepthExceeded();
				return cachedMeasurement;
			}
			if (activeIds.has(entry.view.id)) {
				throw new ToolError("The requested sub-issue hierarchy contains a cycle");
			}

			activeIds.add(entry.view.id);
			try {
				const links = requireCompleteSubIssueLinks(entry.view, entry.reference.value);
				if (links.length > 0 && allowedHeight <= 1) throwIssueHierarchyDepthExceeded();

				let height = 1;
				const nestedRequestedRootIds = new Set<string>();
				for (const link of links) {
					if (!link || typeof link !== "object") {
						throw new ToolError(`Could not safely inspect the descendant hierarchy for ${entry.reference.value}`);
					}
					const descendantId = normalizeOptionalString(link.id);
					const descendantUrl = normalizeOptionalString(link.url);
					if (!descendantId || !descendantUrl) {
						throw new ToolError(`Could not safely inspect the descendant hierarchy for ${entry.reference.value}`);
					}
					if (activeIds.has(descendantId)) {
						throw new ToolError("The requested sub-issue hierarchy contains a cycle");
					}
					if (parentHierarchy.issueIds.has(descendantId)) {
						throw new ToolError("A requested sub-issue descendant cannot contain parent or one of its ancestors");
					}

					const descendantReference = normalizeIssueReference(descendantUrl, "sub-issue descendant");
					assertIssueReferenceOrigin(descendantReference.url, target, "sub-issue descendant");
					if (requestedRootIds.has(descendantId)) {
						const requestedRoot = viewCache.get(descendantId);
						if (!requestedRoot || requestedRoot.reference.key !== descendantReference.key) {
							throw new ToolError("GitHub returned conflicting URLs for the same requested sub-issue");
						}
						if (replaceParent) {
							nestedRequestedRootIds.add(descendantId);
							continue;
						}
						throw new ToolError("Requested subIssues overlap in the existing issue hierarchy");
					}

					const descendant = await loadDescendant(descendantId, descendantReference);
					const descendantMeasurement = await measureSubtree(descendant, allowedHeight - 1);
					height = Math.max(height, descendantMeasurement.height + 1);
					for (const nestedRootId of descendantMeasurement.nestedRequestedRootIds) {
						nestedRequestedRootIds.add(nestedRootId);
					}
				}
				const measurement = { height, nestedRequestedRootIds };
				measurementCache.set(entry.view.id, measurement);
				return measurement;
			} finally {
				activeIds.delete(entry.view.id);
			}
		};

	for (const child of subIssues) {
		const entry = viewCache.get(child.id);
		if (!entry) throw new ToolError(`Could not inspect requested sub-issue ${child.id}`);
		const measurement = await measureSubtree(entry, maximumSubIssueHeight);
		requestedRootDescendants.set(child.id, new Set(measurement.nestedRequestedRootIds));
	}

	const orderedSubIssues: PreflightedIssueMutationView[] = [];
	const orderedRootIds = new Set<string>();
	const activeRootIds = new Set<string>();
	const appendRootAfterNestedRoots = (rootId: string): void => {
		if (orderedRootIds.has(rootId)) return;
		if (activeRootIds.has(rootId)) {
			throw new ToolError("The requested sub-issue hierarchy contains a cycle");
		}
		activeRootIds.add(rootId);
		for (const nestedRootId of requestedRootDescendants.get(rootId) ?? []) {
			appendRootAfterNestedRoots(nestedRootId);
		}
		activeRootIds.delete(rootId);
		orderedRootIds.add(rootId);
		const root = viewCache.get(rootId);
		if (!root) throw new ToolError(`Could not inspect requested sub-issue ${rootId}`);
		orderedSubIssues.push(root.view);
	};
	for (const child of subIssues) appendRootAfterNestedRoots(child.id);
	return orderedSubIssues;
}

type IssueStateReason = "completed" | "not_planned";
type ObservedIssueStateReason = IssueStateReason | "duplicate";

interface GhIssueStateView {
	number?: number;
	state?: string;
	stateReason?: string | null;
	url?: string;
}

interface IssueStateTarget {
	issueNumber: number;
	state: "open" | "closed";
	stateReason?: ObservedIssueStateReason;
	url: string;
}

interface IssueStateFailure {
	target: IssueStateTarget;
	reason: unknown;
}
const ISSUE_STATE_CONCURRENCY = 6;

async function settleIssueStateBatch<TInput, TOutput>(
	items: readonly TInput[],
	run: (item: TInput, index: number) => Promise<TOutput>,
): Promise<PromiseSettledResult<TOutput>[]> {
	const settled = new Array<PromiseSettledResult<TOutput>>(items.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			try {
				settled[index] = { status: "fulfilled", value: await run(items[index]!, index) };
			} catch (reason) {
				settled[index] = { status: "rejected", reason };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(ISSUE_STATE_CONCURRENCY, items.length) }, worker));
	return settled;
}

function normalizeIssueStateNumbers(value: string | string[] | undefined): number[] {
	if (value === undefined) {
		throw new ToolError("issue must be a positive issue number or a non-empty array of positive issue numbers");
	}
	const values = typeof value === "string" ? [value] : value;
	const deduped = new Set<number>();
	for (const [index, entry] of values.entries()) {
		const issueNumber = parsePositiveDecimalInt(normalizeOptionalString(entry));
		if (issueNumber === undefined) {
			const label = typeof value === "string" ? "issue" : `issue[${index}]`;
			throw new ToolError(`${label} must be a positive issue number`);
		}
		deduped.add(issueNumber);
	}
	if (deduped.size === 0) {
		throw new ToolError("issue must contain at least one positive issue number");
	}
	if (deduped.size > 100) {
		throw new ToolError("issue must contain at most 100 unique issue numbers");
	}
	return [...deduped];
}

async function preflightIssueStateTarget(
	session: ToolSession,
	repo: string | undefined,
	issueNumber: number,
	signal: AbortSignal | undefined,
): Promise<IssueStateTarget> {
	const expectedRepo = repo === undefined ? undefined : parseRepositorySelector(repo);
	const args = ["issue", "view", String(issueNumber)];
	appendRepoFlag(args, repo);
	args.push("--json", "number,state,stateReason,url");
	const view = await githubIssueJsonWithStateReasonFallback<GhIssueStateView>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	if (view.number !== issueNumber) {
		throw new ToolError(`GitHub returned an unexpected issue number while preflighting #${issueNumber}`);
	}
	const url = normalizeOptionalString(view.url);
	const parsedUrl = parseLinkedIssueUrl(url);
	if (
		!url ||
		!parsedUrl ||
		parsedUrl.issueNumber !== issueNumber ||
		(repo !== undefined &&
			(!expectedRepo ||
				parsedUrl.repo.toLowerCase() !== expectedRepo.repo.toLowerCase() ||
				(expectedRepo.host !== undefined && parsedUrl.host !== expectedRepo.host)))
	) {
		throw new ToolError(
			`GitHub did not return a canonical same-repository issue URL while preflighting #${issueNumber}; pull requests are not supported`,
		);
	}
	const state = normalizeOptionalString(view.state)?.toLowerCase();
	if (state !== "open" && state !== "closed") {
		throw new ToolError(`GitHub returned an unknown state while preflighting issue #${issueNumber}`);
	}
	const rawStateReason = normalizeOptionalString(view.stateReason)?.toLowerCase();
	const stateReason =
		rawStateReason === "completed" || rawStateReason === "not_planned" || rawStateReason === "duplicate"
			? rawStateReason
			: undefined;
	return {
		issueNumber,
		state,
		stateReason,
		url,
	};
}

function formatIssueStateResult(options: {
	repo?: string;
	state: "open" | "closed";
	stateReason?: IssueStateReason;
	requestedStateReason?: IssueStateReason;
	updated: IssueStateTarget[];
	skipped: IssueStateTarget[];
	failures: IssueStateFailure[];
}): string {
	const desired = options.state.toUpperCase();
	const lines = [`# Issue State Reconciliation: ${desired}`, ""];
	pushLine(lines, "Repository", options.repo);
	if (options.updated.length > 0) {
		lines.push("", `## Updated (${options.updated.length})`);
		for (const target of options.updated) {
			const reason = options.stateReason ? ` (state reason: ${options.stateReason})` : "";
			lines.push(`- #${target.issueNumber} → ${desired}${reason} — ${target.url}`);
		}
	}
	if (options.skipped.length > 0) {
		lines.push("", `## Already ${desired} (${options.skipped.length})`);
		for (const target of options.skipped) {
			const reason =
				target.stateReason && options.requestedStateReason && target.stateReason !== options.requestedStateReason
					? ` (state reason: ${target.stateReason}; requested: ${options.requestedStateReason}, unchanged)`
					: target.stateReason
						? ` (state reason: ${target.stateReason})`
						: "";
			lines.push(`- #${target.issueNumber}${reason} — ${target.url}`);
		}
	}
	if (options.failures.length > 0) {
		lines.push("", `## Failed (${options.failures.length})`);
		for (const failure of options.failures) {
			const message = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
			lines.push(`- #${failure.target.issueNumber}: ${message}`);
		}
	}
	return lines.join("\n").trim();
}

async function executeIssueState(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const issueNumbers = normalizeIssueStateNumbers(params.issue);
	const desiredState = params.state;
	if (desiredState !== "open" && desiredState !== "closed") {
		throw new ToolError("state must be 'open' or 'closed'");
	}
	if (desiredState === "open" && params.stateReason !== undefined) {
		throw new ToolError("stateReason is valid only when state is 'closed'");
	}
	const stateReason = desiredState === "closed" ? (params.stateReason ?? "completed") : undefined;
	const requestedStateReason = desiredState === "closed" ? params.stateReason : undefined;

	let anyPreflightSucceeded = false;
	try {
		const preflightSettled = await settleIssueStateBatch(issueNumbers, issueNumber =>
			preflightIssueStateTarget(session, repo, issueNumber, signal),
		);
		const targets: IssueStateTarget[] = [];
		const preflightFailures: Array<{ issueNumber: number; reason: unknown }> = [];
		for (const [index, result] of preflightSettled.entries()) {
			if (result.status === "fulfilled") {
				targets.push(result.value);
				anyPreflightSucceeded = true;
			} else {
				preflightFailures.push({ issueNumber: issueNumbers[index]!, reason: result.reason });
			}
		}
		throwIfAborted(signal);
		if (preflightFailures.length > 0) {
			if (preflightFailures.length === 1) throw preflightFailures[0]!.reason;
			const lines = preflightFailures.map(failure => {
				const message = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
				return `- #${failure.issueNumber}: ${message}`;
			});
			throw new ToolError(
				`issue_state preflight failed for ${preflightFailures.length} targets:\n${lines.join("\n")}`,
			);
		}
		if (desiredState === "closed" && requestedStateReason !== undefined) {
			const unknownReasonTargets = targets.filter(
				target => target.state === "closed" && target.stateReason === undefined,
			);
			if (unknownReasonTargets.length > 0) {
				throw new ToolError(
					`Could not safely determine the current state reason for ${unknownReasonTargets
						.map(target => `#${target.issueNumber}`)
						.join(", ")}; update GitHub CLI before reconciling already-closed issues`,
				);
			}
		}

		const skipped = targets.filter(target => target.state === desiredState);
		const toUpdate = targets.filter(target => target.state !== desiredState);
		if (toUpdate.length === 0) {
			return buildTextResult(
				formatIssueStateResult({
					repo,
					state: desiredState,
					stateReason,
					requestedStateReason,
					updated: [],
					skipped,
					failures: [],
				}),
				targets.length === 1 ? targets[0]?.url : undefined,
				{ repo, status: "noop" },
			);
		}

		const mutationSettled = await settleIssueStateBatch(toUpdate, target => {
			const args = ["issue", desiredState === "closed" ? "close" : "reopen", String(target.issueNumber)];
			appendRepoFlag(args, repo);
			if (desiredState === "closed") {
				args.push("--reason", stateReason === "not_planned" ? "not planned" : "completed");
			}
			return git.github.text(session.cwd, args, signal, { repoProvided: Boolean(repo) });
		});
		throwIfAborted(signal);
		const updated: IssueStateTarget[] = [];
		const failures: IssueStateFailure[] = [];
		for (const [index, result] of mutationSettled.entries()) {
			const target = toUpdate[index]!;
			if (result.status === "fulfilled") updated.push(target);
			else failures.push({ target, reason: result.reason });
		}
		if (failures.length > 0 && updated.length === 0 && skipped.length === 0) {
			if (failures.length === 1) throw failures[0]!.reason;
			const lines = failures.map(failure => {
				const message = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
				return `- #${failure.target.issueNumber}: ${message}`;
			});
			throw new ToolError(`all ${failures.length} issue state changes failed:\n${lines.join("\n")}`);
		}

		return buildTextResult(
			formatIssueStateResult({
				repo,
				state: desiredState,
				stateReason,
				requestedStateReason,
				updated,
				skipped,
				failures,
			}),
			targets.length === 1 ? targets[0]?.url : undefined,
			{ repo, status: failures.length > 0 ? "partial" : "updated" },
		);
	} finally {
		if (anyPreflightSucceeded) {
			// A live preflight may reveal an out-of-band child state change, and
			// changing a child can update parent summaries across repositories.
			invalidateAllIssueViews();
		}
	}
}

async function withGhBodyArgument<T>(
	args: string[],
	body: string | undefined,
	tempPrefix: string,
	run: (bodyArgs: string[]) => Promise<T>,
): Promise<T> {
	let bodyDir: string | undefined;
	try {
		if (body !== undefined && body.length > 0) {
			// Route through a temp file so multi-KB bodies stay clear of argv
			// length limits and shell-quoting hazards on uncommon platforms.
			bodyDir = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
			const bodyFile = path.join(bodyDir, "body.md");
			await Bun.write(bodyFile, body);
			args.push("--body-file", bodyFile);
		} else {
			// Avoid gh dropping into an interactive editor when no body is given.
			args.push("--body", "");
		}
		return await run(args);
	} finally {
		if (bodyDir) {
			await fs.rm(bodyDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

function extractCreatedIssueReference(output: string): NormalizedIssueReference | undefined {
	for (const line of output.split("\n")) {
		const candidate = normalizeOptionalString(line);
		if (!candidate) continue;
		try {
			const reference = normalizeIssueReference(candidate, "created issue URL");
			if (reference.url) return reference;
		} catch {
			// `gh issue create` normally prints only the URL. Ignore any other
			// informational lines so extraction remains host-agnostic.
		}
	}
	return undefined;
}

function extractSourceUrl(output: string): string | undefined {
	for (const line of output.split("\n")) {
		const candidate = normalizeOptionalString(line);
		if (!candidate) continue;
		try {
			const url = new URL(candidate);
			if (url.protocol === "http:" || url.protocol === "https:") return candidate;
		} catch {
			// Keep looking for a URL-only stdout line.
		}
	}
	return undefined;
}

function formatIssueCreateResult(options: {
	title: string;
	output: string;
	created?: NormalizedIssueReference;
	hierarchyAttached: boolean;
	warning?: string;
}): string {
	const header = options.created
		? `# Created Issue #${options.created.issueNumber}: ${options.title}`
		: `# Created Issue: ${options.title}`;
	const lines = [header, ""];
	pushLine(lines, "URL", options.created?.value);
	if (options.hierarchyAttached) pushLine(lines, "Hierarchy", "attached");
	if (options.warning) {
		lines.push("", `WARNING: ${options.warning}`);
		const rawOutput = normalizeBlock(options.output);
		if (rawOutput) {
			lines.push("", "Raw creation output:");
			for (const line of rawOutput.split("\n")) lines.push(`    ${line}`);
		}
	}
	return lines.join("\n").trimEnd();
}

interface AddSubIssueRelation {
	parentId: string;
	childId: string;
	replaceParent: boolean;
}

interface GhGraphqlMutationResponse {
	errors?: Array<{ message?: string }>;
}

function buildAddSubIssuesGraphqlArgs(relations: AddSubIssueRelation[], createdHost: string): string[] {
	const declarations: string[] = [];
	const mutations: string[] = [];
	const args = ["api", "graphql", "--hostname", createdHost];

	for (const [index, relation] of relations.entries()) {
		const parentVariable = `parentId${index}`;
		const childVariable = `childId${index}`;
		declarations.push(`$${parentVariable}: ID!`, `$${childVariable}: ID!`);
		mutations.push(
			`r${index}: addSubIssue(input: {issueId: $${parentVariable}, subIssueId: $${childVariable}, replaceParent: ${relation.replaceParent}}) { issue { id } subIssue { id } }`,
		);
	}

	const query = `mutation AddSubIssues(${declarations.join(", ")}) {\n${mutations.map(line => `  ${line}`).join("\n")}\n}`;
	args.push("-f", `query=${query}`);
	for (const [index, relation] of relations.entries()) {
		args.push("-f", `parentId${index}=${relation.parentId}`, "-f", `childId${index}=${relation.childId}`);
	}
	return args;
}

async function executeIssueCreate(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const title = requireNonEmpty(params.title, "title");
	const parent = params.parent === undefined ? undefined : normalizeIssueReference(params.parent, "parent");
	const normalizedSubIssues = normalizeSubIssueReferences(params.subIssues);
	const replaceParent = params.replaceParent ?? false;
	const assignees = normalizePrIdentifierList(params.assignee);
	const labels = normalizePrIdentifierList(params.label);

	if (replaceParent && normalizedSubIssues.length === 0) {
		throw new ToolError("replaceParent=true requires at least one subIssues entry");
	}
	if (parent && normalizedSubIssues.some(reference => reference.key === parent.key)) {
		throw new ToolError("The same existing issue cannot be both parent and subIssues");
	}
	const hierarchyRequested = Boolean(parent) || normalizedSubIssues.length > 0;
	const target = hierarchyRequested ? await resolveIssueCreateTarget(session, repo, signal) : undefined;
	const subIssues = target ? dedupeSubIssueReferencesForTarget(normalizedSubIssues, target) : normalizedSubIssues;
	if (
		parent &&
		target &&
		subIssues.some(
			reference => issueReferenceTargetKey(reference, target) === issueReferenceTargetKey(parent, target),
		)
	) {
		throw new ToolError("The same existing issue cannot be both parent and subIssues");
	}
	if (target) {
		if (parent?.url) assertIssueReferenceOrigin(parent.url, target, "parent");
		for (const [index, reference] of subIssues.entries()) {
			if (reference.url) assertIssueReferenceOrigin(reference.url, target, `subIssues[${index}]`);
		}
		await assertIssueHierarchyMutationAvailable(session, target, signal);
	}

	let preflightedParent: (GhIssueMutationView & { id: string }) | undefined;
	if (parent && target) {
		preflightedParent = await preflightIssueReference(
			session,
			parent,
			repo,
			"parent",
			{ includeParent: true, includeSubIssues: false, requireNoParent: false },
			signal,
		);
		assertIssueReferenceOrigin(preflightedParent.url, target, "parent");
	}
	const preflightedSubIssues: PreflightedIssueMutationView[] = [];
	const preflightedChildIds = new Set<string>();
	let attachmentSubIssues: readonly PreflightedIssueMutationView[] = preflightedSubIssues;
	if (target) {
		for (const [index, reference] of subIssues.entries()) {
			const child = await preflightIssueReference(
				session,
				reference,
				repo,
				`subIssues[${index}]`,
				{ includeParent: true, includeSubIssues: true, requireNoParent: !replaceParent },
				signal,
			);
			assertIssueReferenceOrigin(child.url, target, `subIssues[${index}]`);
			if (preflightedParent?.id === child.id) {
				throw new ToolError("The same existing issue cannot be both parent and subIssues");
			}
			if (!preflightedChildIds.has(child.id)) {
				if (preflightedChildIds.size >= 100) {
					throw new ToolError("subIssues must resolve to at most 100 direct children");
				}
				preflightedChildIds.add(child.id);
				preflightedSubIssues.push(child);
			}
		}
		const parentHierarchy = preflightedParent
			? await inspectRequestedParentHierarchy(session, target, preflightedParent, preflightedSubIssues, signal)
			: { depth: 0, issueIds: new Set<string>() };
		if (parentHierarchy.depth + 1 > GH_ISSUE_HIERARCHY_MAX_DEPTH) throwIssueHierarchyDepthExceeded();
		attachmentSubIssues = await orderRequestedSubIssueHierarchiesSafely(
			session,
			target,
			preflightedSubIssues,
			parentHierarchy,
			replaceParent,
			signal,
		);
	}

	const createArgs = ["issue", "create"];
	appendRepoFlag(createArgs, repo);
	createArgs.push("--title", title);
	for (const assignee of assignees) createArgs.push("--assignee", assignee);
	for (const label of labels) createArgs.push("--label", label);
	const output = await withGhBodyArgument(createArgs, params.body, "gh-issue-body-", bodyArgs =>
		git.github.text(session.cwd, bodyArgs, signal, { repoProvided: Boolean(repo) }),
	);

	const created = extractCreatedIssueReference(output);
	const sourceUrl = created?.value ?? extractSourceUrl(output);
	if (!created) {
		return buildTextResult(
			formatIssueCreateResult({
				title,
				output,
				hierarchyAttached: false,
				warning: hierarchyRequested
					? "The issue remains created, but hierarchy attachment failed because its canonical URL could not be determined."
					: "The issue remains created, but its canonical URL could not be determined.",
			}),
			sourceUrl,
			{ status: "partial" },
		);
	}

	if (!hierarchyRequested) {
		return buildTextResult(
			formatIssueCreateResult({ title, output, created, hierarchyAttached: false }),
			created.value,
			{ status: "created" },
		);
	}

	let hierarchyMutationAttempted = false;
	try {
		if (!target) throw new ToolError("Could not determine the issue creation repository host");
		assertIssueReferenceOrigin(created.value, target, "created issue");
		const createdView = await preflightIssueReference(
			session,
			created,
			undefined,
			"created issue",
			{ includeParent: false, includeSubIssues: false, requireNoParent: false },
			signal,
		);
		const relations: AddSubIssueRelation[] = [];
		if (preflightedParent) {
			relations.push({ parentId: preflightedParent.id, childId: createdView.id, replaceParent: false });
		}
		for (const child of attachmentSubIssues) {
			relations.push({ parentId: createdView.id, childId: child.id, replaceParent });
		}

		const mutationArgs = buildAddSubIssuesGraphqlArgs(relations, target.host);
		hierarchyMutationAttempted = true;
		try {
			const response = await git.github.json<GhGraphqlMutationResponse>(session.cwd, mutationArgs, signal, {
				repoProvided: true,
			});
			if (Array.isArray(response.errors) && response.errors.length > 0) {
				const messages = response.errors
					.map(error => normalizeOptionalString(error.message))
					.filter((message): message is string => message !== undefined);
				throw new ToolError(
					messages.length > 0
						? `GitHub GraphQL mutation failed: ${messages.join("; ")}`
						: "GitHub GraphQL mutation failed",
				);
			}
		} finally {
			// A combined mutation can apply some aliases before another fails,
			// and relations may span repositories. Conservatively drop all issue views.
			invalidateAllIssueViews();
		}
		return buildTextResult(
			formatIssueCreateResult({ title, output, created, hierarchyAttached: true }),
			created.value,
			{ status: "created" },
		);
	} catch (error) {
		return buildTextResult(
			formatIssueCreateResult({
				title,
				output,
				created,
				hierarchyAttached: false,
				warning: hierarchyMutationAttempted
					? `The issue remains created, but hierarchy attachment failed. Some requested relationships may already have been applied; inspect the issue hierarchy before retrying attachments and do not retry issue creation. ${
							error instanceof Error ? error.message : String(error)
						}`
					: `The issue remains created, but hierarchy attachment failed. ${
							error instanceof Error ? error.message : String(error)
						}`,
			}),
			created.value,
			{ status: "partial" },
		);
	}
}

export { buildAddSubIssuesGraphqlArgs, executeIssueCreate, executeIssueState };
