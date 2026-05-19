# Read 工具 ZIP 文件名编码修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 Read 工具读取 ZIP 压缩包时对 legacy 文件名和 Info-ZIP Unicode Path extra field 的解码问题。

**架构：** `.zip` 读取改为先解析 central directory metadata，再按 UTF-8 flag、合法 `0x7075`、CP437 的顺序确定 archive entry path。文件内容仍按需用 `fflate.inflateSync()` 解压 method 8，method 0 直接读取。

**技术栈：** Bun、TypeScript、`fflate`、现有 `ReadTool` / `ArchiveReader` 测试框架。

---

## 文件结构

- 修改：`packages/coding-agent/test/tools.test.ts`
  - 扩展 ZIP fixture helper，新增 raw filename、extra field、CP437 和 `0x7075` 行为测试。
- 修改：`packages/coding-agent/src/tools/archive-reader.ts`
  - 新增 ZIP central directory parser、CP437 decoder、`0x7075` parser、按需 ZIP payload reader。
- 修改：`docs/tools/read.md`
  - 更新 Archive 段落，说明 ZIP 文件名解码优先级。
- 修改：`packages/coding-agent/CHANGELOG.md`
  - 在 `[Unreleased] -> Fixed` 增加 Read 工具 ZIP 文件名修复。
- 创建：`docs/superpowers/specs/2026-05-19-read-zip-filename-encoding.md`
  - 保留本次设计规格，供 Issue/PR 引用。

## 任务 1：添加 ZIP 文件名解码回归测试

**文件：**
- 修改：`packages/coding-agent/test/tools.test.ts`

- [ ] **步骤 1：扩展测试 fixture helper**

新增 raw ZIP fixture entry 类型和 helper：

```ts
interface RawZipFixtureEntry {
	rawPath: Buffer;
	content: string;
	flag?: number;
	unicodePath?: string;
	unicodePathCrc?: number;
}

function createRawNameZipArchive(entries: RawZipFixtureEntry[]): Buffer {
	// 复用现有 ZIP header 生成模式，filename bytes 直接使用 rawPath。
	// 如果 unicodePath 存在，写入 0x7075 extra field。
}
```

- [ ] **步骤 2：编写失败测试**

新增测试：

```ts
it("should use ZIP Unicode path extra fields for legacy encoded entry names", async () => {
	const archivePath = path.join(testDir, "legacy-unicode-path.zip");
	fs.writeFileSync(
		archivePath,
		createRawNameZipArchive([
			{
				rawPath: Buffer.from("03-CRAIC2026比赛规则及附件/附件.txt", "gbk"),
				unicodePath: "03-CRAIC2026比赛规则及附件/附件.txt",
				content: "ok\n",
			},
		]),
	);

	const rootResult = await readTool.execute("test-call-zip-unicode-path-root", { path: archivePath });
	expect(getTextOutput(rootResult)).toContain("03-CRAIC2026比赛规则及附件/");

	const fileResult = await readTool.execute("test-call-zip-unicode-path-file", {
		path: `${archivePath}:03-CRAIC2026比赛规则及附件/附件.txt:raw`,
	});
	expect(getTextOutput(fileResult)).toBe("ok\n");
});
```

新增测试：

```ts
it("should ignore stale ZIP Unicode path extra fields", async () => {
	const archivePath = path.join(testDir, "stale-unicode-path.zip");
	fs.writeFileSync(
		archivePath,
		createRawNameZipArchive([
			{ rawPath: Buffer.from("safe.txt", "ascii"), unicodePath: "evil.txt", unicodePathCrc: 0, content: "safe\n" },
		]),
	);

	const result = await readTool.execute("test-call-zip-stale-unicode-path", { path: archivePath });
	const output = getTextOutput(result);
	expect(output).toContain("safe.txt");
	expect(output).not.toContain("evil.txt");
});
```

新增测试：

```ts
it("should decode legacy ZIP entry names with CP437 fallback", async () => {
	const archivePath = path.join(testDir, "cp437.zip");
	fs.writeFileSync(archivePath, createRawNameZipArchive([{ rawPath: Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]), content: "cp437\n" }]));

	const result = await readTool.execute("test-call-zip-cp437", { path: archivePath });
	expect(getTextOutput(result)).toContain("é.txt");
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
bun test packages/coding-agent/test/tools.test.ts --test-name-pattern "ZIP Unicode path|stale ZIP Unicode path|CP437"
```

预期：新增测试失败，输出仍为 mojibake 或找不到中文路径。

## 任务 2：实现 ZIP central directory reader

**文件：**
- 修改：`packages/coding-agent/src/tools/archive-reader.ts`

- [ ] **步骤 1：实现 parser 与 decoder**

新增：

```ts
function parseZipCentralDirectory(bytes: Uint8Array): ZipCentralDirectoryRecord[];
function parseZipExtraFields(bytes: Uint8Array): ZipExtraField[];
function decodeZipEntryPath(record: ZipCentralDirectoryRecord): string | undefined;
function readUnicodePathExtraField(fields: ZipExtraField[], rawName: Uint8Array): string | undefined;
function decodeCp437(bytes: Uint8Array): string;
```

- [ ] **步骤 2：改造 ZIP storage**

把 `ZipStorage` 改为保存 archive bytes 与定位信息，`readFile()` 中按需读取 payload。method 0 直接返回，method 8 使用 `fflate.inflateSync()`。

- [ ] **步骤 3：运行新增测试验证通过**

运行：

```bash
bun test packages/coding-agent/test/tools.test.ts --test-name-pattern "ZIP Unicode path|stale ZIP Unicode path|CP437|archive subdirectories|read .zip subpaths"
```

预期：相关 read/archive 测试通过。

## 任务 3：更新文档和 changelog

**文件：**
- 修改：`docs/tools/read.md`
- 修改：`packages/coding-agent/CHANGELOG.md`

- [ ] **步骤 1：更新 docs/tools/read.md**

Archive 段落说明 ZIP 读取使用 central directory metadata，文件名解码优先级为 UTF-8 flag、合法 `0x7075`、CP437。

- [ ] **步骤 2：更新 changelog**

在 `[Unreleased] -> Fixed` 加：

```markdown
- Fixed ZIP archive entry names with Unicode path extra fields rendering as mojibake in the Read tool.
```

## 任务 4：验证 PR 1

**文件：**
- 所有修改文件

- [ ] **步骤 1：运行 focused test**

```bash
bun test packages/coding-agent/test/tools.test.ts --test-name-pattern "ZIP Unicode path|stale ZIP Unicode path|CP437|archive"
```

预期：0 failure。

- [ ] **步骤 2：运行类型检查**

```bash
bun --cwd=packages/coding-agent run check:types
```

预期：exit 0。

- [ ] **步骤 3：检查工作区 diff**

```bash
git status --short
git diff -- packages/coding-agent/src/tools/archive-reader.ts packages/coding-agent/test/tools.test.ts docs/tools/read.md packages/coding-agent/CHANGELOG.md docs/superpowers/specs/2026-05-19-read-zip-filename-encoding.md
```

预期：只包含 PR 1 范围内变更。
