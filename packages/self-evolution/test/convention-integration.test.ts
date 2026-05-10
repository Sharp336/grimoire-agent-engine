import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { ConventionExtractor } from "../src/convention-extractor";
import { InjectionFormatter } from "../src/injection-formatter";
import { SqliteConventionStore } from "../src/storage/conventions";
import { initSchema } from "../src/storage/db";

describe("Convention extraction + injection pipeline", () => {
	let db: Database;
	let conventionStore: SqliteConventionStore;
	let extractor: ConventionExtractor;
	let formatter: InjectionFormatter;

	beforeEach(() => {
		db = new Database(":memory:");
		initSchema(db);
		conventionStore = new SqliteConventionStore(db);
		extractor = new ConventionExtractor();
		formatter = new InjectionFormatter();
	});

	test("extracts '请记住' declarations with high confidence", () => {
		const trace = makeTrace([
			"请记住：我更喜欢使用 async/await 而不是回调函数",
			"以后请记住，不要修改 .env 文件",
			"这是一个普通的对话",
		]);

		const conventions = extractor.extract(trace);
		expect(conventions.length).toBeGreaterThanOrEqual(2);

		const rememberConventions = conventions.filter(
			c => c.content.includes("async/await") || c.content.includes(".env"),
		);
		expect(rememberConventions.length).toBeGreaterThanOrEqual(2);

		const highConfidence = rememberConventions.filter(c => c.confidence >= 80);
		expect(highConfidence.length).toBe(2);
	});

	test("stores and deduplicates conventions", async () => {
		const trace = makeTrace(["请记住：优先使用 bun 而不是 npm"]);
		const conventions = extractor.extract(trace);
		expect(conventions.length).toBeGreaterThanOrEqual(1);

		await conventionStore.insert(conventions[0]!);
		await conventionStore.insert(conventions[0]!);

		const all = await conventionStore.listAll();
		expect(all.length).toBe(1);
		expect(all[0]!.confidence).toBeGreaterThan(conventions[0]!.confidence);
	});

	test("injects conventions into formatted output", async () => {
		const trace = makeTrace(["请记住：代码注释用中文"]);
		const conventions = extractor.extract(trace);
		for (const c of conventions) await conventionStore.insert(c);

		const stored = await conventionStore.listAll();
		const injection = formatter.formatInjection([], stored, []);

		expect(injection).toContain("## Project Conventions");
		expect(injection).toContain("代码注释用中文");
	});

	test("injects profile + persona alongside conventions", async () => {
		const trace = makeTrace(["请记住：不要修改 package.json"]);
		const conventions = extractor.extract(trace);
		for (const c of conventions) await conventionStore.insert(c);

		const stored = await conventionStore.listAll();
		const profile = {
			toolFrequency: { read: 5 },
			toolTransitions: {},
			intentDistribution: { exploration: 3 },
			avgToolCallsPerSession: 4.5,
			avgFilesModifiedPerSession: 1.2,
			errorRate: 0.1,
			recoveryRate: 0.5,
			preferredLanguages: ["typescript"],
			sessionCount: 3,
			updatedAt: Date.now(),
		};
		const persona = {
			version: "1.0",
			updatedAt: Date.now(),
			basics: {},
			career: { role: "全栈工程师", expertise: ["TypeScript", "React"] },
			interests: { longTerm: [], shortTerm: [], avoid: [], priorities: [] },
			preferences: { communicationStyle: "简洁直接" },
			interaction: {},
			thinking: { workStyle: "快速迭代" },
			constraints: { forbidden: ["不要写废话"] },
		};

		const injection = formatter.formatInjection([], stored, [], profile, persona);

		expect(injection).toContain("## User Profile");
		expect(injection).toContain("全栈工程师");
		expect(injection).toContain("## Project Conventions");
		expect(injection).toContain("不要修改 package.json");
	});
});

function makeTrace(contents: string[]) {
	return {
		sessionId: `test-${Date.now()}`,
		cwd: "/test",
		userPrompt: contents[0] ?? "test",
		startTime: Date.now(),
		endTime: Date.now(),
		toolCallCount: 0,
		errorCount: 0,
		hadRecovery: false,
		completedSuccessfully: true,
		entries: contents.map((content, i) => ({
			type: "user_input" as const,
			timestamp: Date.now() + i,
			content,
		})),
	};
}
