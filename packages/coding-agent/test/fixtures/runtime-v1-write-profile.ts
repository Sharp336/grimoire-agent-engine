import * as fs from "node:fs";
import * as path from "node:path";
import type { SQL } from "bun";
import type { EngineBindingSnapshot } from "../../src/engine/contracts";
import { engineAgentId, engineAgentInstanceId } from "../../src/engine/route";
import { EngineStore } from "../../src/engine/store";
import { SqlSessionStorage } from "../../src/session/sql-session-storage";

// Test-only timing of the real EngineStore/SQLite path. No runtime endpoint or
// timing hook is added to production. Driver overhead includes BEGIN/COMMIT.
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const runDir = path.resolve(args.get("--run-dir") ?? "");
const count = Number(args.get("--events") ?? 1000);
const agents = Number(args.get("--agents") ?? 21);
const concurrency = Number(args.get("--concurrency") ?? 1);
if (
	!args.has("--run-dir") ||
	fs.existsSync(runDir) ||
	!Number.isSafeInteger(count) ||
	count < 1 ||
	count > 10_000 ||
	!Number.isSafeInteger(agents) ||
	agents < 1 ||
	agents > 100 ||
	!Number.isSafeInteger(concurrency) ||
	concurrency < 1 ||
	concurrency > agents
)
	throw new Error("An owned new run directory and bounded dimensions are required");
fs.mkdirSync(runDir, { recursive: true });
let enabled = false;
const timing = { transactions: 0, transactionMs: 0, callbackMs: 0, sqlMs: 0, sqlCalls: 0 };
const statements: Record<string, { count: number; ms: number }> = {};
const createStorage = SqlSessionStorage.create.bind(SqlSessionStorage);
SqlSessionStorage.create = async options => {
	const storage = await createStorage(options);
	const client = options.client as InstanceType<typeof SQL>;
	client.begin = new Proxy(client.begin, {
		apply(begin, receiver, argumentsList) {
			if (!enabled) return Reflect.apply(begin, receiver, argumentsList);
			const values = [...argumentsList] as unknown[];
			const work = values.at(-1) as (sql: InstanceType<typeof SQL>) => Promise<unknown>;
			values[values.length - 1] = async (sql: InstanceType<typeof SQL>) => {
				const started = performance.now();
				const unsafe = sql.unsafe;
				sql.unsafe = new Proxy(unsafe, {
					apply(query, target, queryArguments) {
						const started = performance.now();
						const statement = String(queryArguments[0]);
						const family =
							[
								"engine_agent_seq",
								"engine_event_outbox",
								"engine_runtime_messages",
								"engine_agent_identity",
								"engine_attempts",
							].find(table => statement.includes(table)) ?? "other";
						return Promise.resolve(Reflect.apply(query, target, queryArguments)).finally(() => {
							const ms = performance.now() - started;
							timing.sqlMs += ms;
							timing.sqlCalls++;
							statements[family] ??= { count: 0, ms: 0 };
							const metric = statements[family];
							metric.count++;
							metric.ms += ms;
						});
					},
				});
				try {
					return await work(sql);
				} finally {
					timing.callbackMs += performance.now() - started;
					sql.unsafe = unsafe;
				}
			};
			const started = performance.now();
			return Promise.resolve(Reflect.apply(begin, receiver, values)).finally(() => {
				timing.transactions++;
				timing.transactionMs += performance.now() - started;
			});
		},
	});
	return storage;
};
const store = await EngineStore.open(path.join(runDir, "engine.sqlite"));
const generation = await store.nextEngineGeneration();
const bindings: EngineBindingSnapshot[] = [];
for (let i = 0; i < agents; i++) {
	const agentInstanceRef = `grimoire://tasks/grimoire/write-profile/agents/agent-${i}`;
	const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
	await store.registerAgent({
		agentInstanceId,
		agentInstanceRef,
		principalId: "profile-owner",
		authorityGeneration: 1,
	});
	const binding: EngineBindingSnapshot = {
		agentInstanceId,
		engineAgentId: engineAgentId(agentInstanceId),
		bindingId: `binding-${i}`,
		commandId: `start-${i}`,
		executionId: `execution-${i}`,
		attemptId: `attempt-${i}`,
		engineGeneration: generation,
		bindingGeneration: 1,
		authorityGeneration: 1,
		profileDigest: "profile",
		state: "running",
	};
	await store.commitAttemptTransition(binding, "running", [{ kind: "running" }]);
	bindings.push(binding);
}
const revisions = bindings.map(() => 0);
const elapsed: number[] = [];
const text = "x".repeat(1024);
const append = async (index: number) => {
	const revision = ++revisions[index];
	const started = performance.now();
	await store.appendEvent({
		...bindings[index],
		causationCommandId: `sample-${index}-${revision}`,
		kind: "message_updated",
		payload: {
			mode: revision === 1 ? "snapshot" : "append",
			...(revision === 1 ? { partial: false } : { baseRevision: revision - 1 }),
			messageId: `message-${index}`,
			blockId: "text",
			stream: "assistant",
			contentId: `content-${index}`,
			revision,
			offset: (revision - 1) * 1024,
			endOffset: revision * 1024,
			totalBytes: revision * 1024,
			text,
			status: "streaming",
		},
	});
	elapsed.push(performance.now() - started);
};
enabled = true;
const started = performance.now();
try {
	for (let i = 0; i < count; i += concurrency)
		await Promise.all(Array.from({ length: Math.min(concurrency, count - i) }, (_, n) => append((i + n) % agents)));
} finally {
	enabled = false;
	await store.close();
}
const elapsedMs = performance.now() - started;
elapsed.sort((a, b) => a - b);
const result = {
	sourceHead: (await Bun.$`git rev-parse HEAD`.quiet().text()).trim(),
	count,
	agents,
	concurrency,
	elapsedMs,
	updatesPerSecond: (count * 1000) / elapsedMs,
	...timing,
	transactionOverheadMs: timing.transactionMs - timing.callbackMs,
	projectionCpuMs: timing.callbackMs - timing.sqlMs,
	appendP95Ms: elapsed[Math.floor((elapsed.length - 1) * 0.95)],
	statements,
	durability: "FULL",
	ipc: false,
	fixtureMetricWritesInTimedLoop: false,
};
fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
