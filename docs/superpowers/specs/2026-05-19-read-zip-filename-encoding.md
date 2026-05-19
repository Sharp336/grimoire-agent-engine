# Read 工具 ZIP 文件名编码修复规格

## 背景

Read 工具支持直接读取 `.zip`、`.tar`、`.tar.gz` 和 `.tgz` 压缩包。当前 `.zip` 读取路径在 `packages/coding-agent/src/tools/archive-reader.ts` 中依赖 `fflate.unzipSync(bytes)`，该 API 返回 `{ [decodedName]: Uint8Array }`，文件名在返回前已经被 `fflate` 解码。

这种实现会丢失 ZIP central directory 中对可靠文件名解码必需的元数据：

- 原始 filename bytes；
- general purpose bit flag；
- extra fields，特别是 Info-ZIP Unicode Path extra field (`0x7075`)；
- local header offset、compressed size、compression method 等条目定位信息。

用户样例 `03-CRAIC2026比赛规则及附件.zip` 可复现该问题。Read 工具当前输出：

```text
03-CRAIC2026±ÈÈü¹æÔò¼°¸½¼þ/
```

期望输出：

```text
03-CRAIC2026比赛规则及附件/
```

该压缩包的 central directory 中：

- UTF-8 flag 未设置；
- filename 主字段是 GBK/CP936 字节；
- extra fields 包含合法 `0x7075`，其中保存了 UTF-8 文件名，并且 CRC32 校验匹配。

## 目标

以方案 B 为主线修复 Read 工具 ZIP 文件名解码：在 Read 工具自己的 ZIP 读取层解析 central directory 元数据，按 ZIP 规范和常见实现处理文件名，同时继续复用 `fflate` 做 deflate payload 解压。

目标包括：

1. 修复带合法 `0x7075` 的 legacy ZIP 文件名乱码。
2. 保持 UTF-8 ZIP 现有行为不回退。
3. 按 ZIP 历史默认编码 CP437 处理无 UTF-8 flag、无合法 `0x7075` 的条目。
4. 不引入新的 archive 依赖栈。
5. 为无 `0x7075` 的 GBK/Shift_JIS 等 legacy ZIP 预留显式 fallback encoding 扩展点，但不在核心修复中做自动猜测。

## 非目标

本规格不要求：

- 自动识别 GBK、Shift_JIS、Big5、EUC-KR 等本地编码；
- 在输出层修复 mojibake 字符串；
- 重写 ZIP 写入工具；
- 完整实现 ZIP64；
- 支持所有 ZIP compression method；
- 用 `yauzl`、`jszip` 或 `iconv-lite` 替换当前实现。

## 现状与根因

`fflate` 0.8.2 的 ZIP header 解码逻辑等价于：

```js
strFromU8(filenameBytes, !(generalPurposeBitFlag & 2048))
```

也就是说：

- bit 11 (`0x800`) 设置时，按 UTF-8 解码；
- bit 11 未设置时，按 Latin-1 / binary string 解码。

这不是 ZIP legacy filename 的通用处理方案。ZIP 历史默认编码是 CP437；部分工具会在未设置 UTF-8 flag 时写入本地代码页字节，并通过 `0x7075` extra field 保存 UTF-8 路径。`fflate.unzipSync()` 不解析 `0x7075`，且返回值已经丢失 raw filename bytes，Read 工具无法在调用点补救。

## 规范依据

ZIP 文件名解码应遵循以下优先级：

1. general purpose bit 11 / EFS (`0x800`) 设置时，filename 和 comment 必须按 UTF-8 解码。
2. bit 11 未设置时，如果存在 Info-ZIP Unicode Path extra field (`0x7075`)，且满足：
   - Version 为 `1`；
   - NameCRC32 等于 raw filename bytes 的 CRC32；
   - UnicodeName 是合法 UTF-8；

   则使用该 UnicodeName。
3. 否则按 ZIP 历史默认编码 CP437 解码。
4. 对无 UTF-8 flag、无合法 `0x7075` 的本地代码页 ZIP，只能通过显式用户配置选择 fallback encoding，不做自动猜测。

`yauzl` 可作为保守实现参考：它从 central directory 读取 metadata，支持 CP437/UTF-8，并在 `0x7075` CRC 校验通过后覆盖 `entry.fileName`。`jszip` 也支持 `0x7075`，并把自定义 filename decode 作为外部选项。

## 推荐架构

### 1. ZIP central directory reader

在 `packages/coding-agent/src/tools/archive-reader.ts` 内部新增轻量 ZIP central directory 解析逻辑。Read 工具外部行为和 `ArchiveReader` 公共接口保持不变。

现有接口继续成立：

```ts
export class ArchiveReader {
	getNode(subPath?: string): ArchiveNode | undefined;
	listDirectory(subPath?: string): ArchiveDirectoryEntry[];
	readFile(subPath: string): Promise<ExtractedArchiveFile>;
}
```

`.tar` 和 `.tar.gz` 继续使用 `Bun.Archive`。`.zip` 改为：

```ts
async function readZipEntries(bytes: Uint8Array): Promise<ArchiveIndexEntry[]> {
	const records = parseZipCentralDirectory(bytes);
	return records.flatMap(record => zipRecordToArchiveIndexEntry(bytes, record));
}
```

### 2. ZIP entry 记录

内部记录应包含足够信息以支持路径解码和按需读取 payload：

```ts
interface ZipCentralDirectoryRecord {
	rawName: Uint8Array;
	extraFields: ZipExtraField[];
	generalPurposeBitFlag: number;
	compressionMethod: number;
	crc32: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}

interface ZipExtraField {
	id: number;
	data: Uint8Array;
}
```

`ZipStorage` 应从「已解压 bytes」改为「archive bytes + 条目定位信息」：

```ts
interface ZipStorage {
	type: "zip";
	archiveBytes: Uint8Array;
	compressionMethod: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
}
```

这样目录列表无需提前解压所有文件，内存行为比当前 `unzipSync()` 更好。

### 3. 文件名解码

新增纯函数：

```ts
function decodeZipEntryPath(record: ZipCentralDirectoryRecord): string | undefined;
```

解码顺序：

1. 如果 `(record.generalPurposeBitFlag & 0x800) !== 0`，使用 fatal UTF-8 decoder 解码 `rawName`。失败时抛出清晰 `ToolError`，不要静默跳过条目。
2. 否则检查 `0x7075` extra field。只有 Version 为 `1` 且 CRC32 匹配时，才使用 UnicodeName。
3. 否则使用内置 CP437 解码表。

解码之后必须继续调用现有 `normalizeArchiveEntryPath()`：

- 将 `\` 归一为 `/`；
- 删除空段和 `.`；
- 拒绝 `..`；
- 空路径不生成文件条目。

路径安全校验必须作用于最终解码后的路径，而不是 raw bytes 或 mojibake 字符串。

### 4. `0x7075` 处理

新增函数：

```ts
function readUnicodePathExtraField(
	fields: ZipExtraField[],
	rawName: Uint8Array,
): string | undefined;
```

行为：

- 查找 id 为 `0x7075` 的 extra field；
- 长度小于 5 时忽略；
- 第 1 个字节不是 `1` 时忽略；
- 读取后续 4 字节 little-endian CRC32；
- 对 raw filename bytes 计算 CRC32；
- CRC 不匹配时忽略；
- 剩余 bytes 使用 fatal UTF-8 decoder 解码；
- UTF-8 解码失败时忽略该 extra field，并回退 CP437。

推荐行为是忽略无效 `0x7075`，回退 CP437。这样与 `yauzl` / `jszip` 的保守策略一致。

### 5. CP437 解码

Bun 当前 `TextDecoder` 不支持 `cp437` label，因此需要内置 CP437 映射表。实现应是无依赖、确定性的纯函数：

```ts
function decodeCp437(bytes: Uint8Array): string;
```

ASCII 字节 `0x00` 到 `0x7f` 可直接映射。`0x80` 到 `0xff` 使用 128 项表。

### 6. ZIP payload 读取

`ArchiveReader.readFile()` 遇到 `ZipStorage` 时按需读取 payload：

1. 根据 `localHeaderOffset` 验证 local file header signature (`0x04034b50`)；
2. 读取 local filename length 和 local extra length；
3. 定位 compressed payload 起点；
4. 校验 payload range 不越界；
5. compression method 为 `0` 时直接返回 slice；
6. compression method 为 `8` 时使用 `fflate.inflateSync()` 解压；
7. 其他 method 抛出 `ToolError`，说明 unsupported ZIP compression method。

不需要在列表阶段解压所有 entry。

### 7. ZIP64 边界

第一阶段不实现 ZIP64。遇到需要 ZIP64 metadata 才能解析的 sentinel 值时，抛出清晰错误：

```text
ZIP64 archives are not supported by the read tool yet
```

触发条件包括：

- EOCD entry count、central directory size 或 offset 为 ZIP64 sentinel；
- central directory entry 的 compressed size、uncompressed size 或 local header offset 为 `0xffffffff`。

这比错误读取或部分读取更安全，也避免 PR 范围扩大。

## PR 拆分策略

采用一个 Issue + 两个同时打开的 stacked PR。

### Issue

Issue 追踪完整问题：Read 工具 ZIP 文件名解码不完整。内容包括：

- 用户可见症状；
- `fflate.unzipSync()` 丢失 raw metadata 的根因；
- ZIP 文件名解码规范；
- 方案 B 作为推荐实现；
- 方案 C（`yauzl` / `jszip`）作为 alternative；
- legacy fallback encoding 作为后续增强。

### PR 1：核心规范修复

Base：`main`

建议分支：

```text
fix/read-zip-central-directory-names
```

建议标题：

```text
fix(read): decode ZIP entry names from central directory metadata
```

范围：

- 自建 ZIP central directory parser；
- 支持 UTF-8 flag；
- 支持合法 `0x7075`；
- 支持 CP437 fallback；
- method 0 / method 8 payload 读取；
- 测试、文档、changelog。

不包含：

- fallback encoding 设置；
- 自动 locale 猜测；
- 新依赖；
- ZIP64 支持。

该 PR 必须能独立合并，并解决用户样例。

### PR 2：显式 legacy fallback encoding

Base：PR 1 分支 `fix/read-zip-central-directory-names`，不是 `main`。

建议分支：

```text
feat/read-zip-filename-encoding
```

建议标题：

```text
feat(read): support explicit legacy ZIP filename encoding
```

范围：

- 增加显式设置项，例如 `read.archive.filenameEncoding`；
- 仅在无 UTF-8 flag、无合法 `0x7075` 时使用；
- 支持运行时 `TextDecoder` 可用的常见编码白名单；
- 测试 GBK 等无 `0x7075` legacy ZIP 的显式配置读取；
- 更新文档。

PR 描述顶部必须说明：

```markdown
Stacked on #<PR1>. Review only commits after #<PR1>.
```

PR 1 合并后，PR 2 rebase 到 `origin/main`，并把 base 改回 `main`。

## 方案 C 的 Issue 表述

Issue 中应提及但不采用方案 C：

- `yauzl` 是规范行为参考，特别是 central directory 解析、CP437/UTF-8 和 `0x7075` CRC 校验；
- `jszip` 展示了 `0x7075` + 用户自定义 decode hook 的策略；
- 当前 Read 工具有自己的 archive abstraction，且只需要补 ZIP metadata 解码；
- 引入新 archive stack 会扩大 PR 面积，增加 bundle/compile/runtime 风险；
- 因此第一阶段采用本地 central directory parser，payload 解压继续复用 `fflate`。

## 测试要求

### PR 1 测试

在 `packages/coding-agent/test/tools.test.ts` 中扩展现有手写 ZIP fixture helper，新增以下行为测试：

1. **UTF-8 ZIP 行为保持不变**
   - 使用现有 `createZipArchive()`；
   - 断言中文或 ASCII UTF-8 路径可以正常 list/read。

2. **合法 `0x7075` 被采用**
   - 构造 raw filename bytes 为 GBK，但 extra field `0x7075` 保存 UTF-8 名称；
   - 断言 root listing 出现中文目录；
   - 断言可通过中文路径读取文件内容。

3. **CRC 不匹配的 `0x7075` 被忽略**
   - 构造 raw name 为 `safe.txt`；
   - extra field UnicodeName 为 `evil.txt`，但 CRC 不匹配；
   - 断言 listing 不出现 `evil.txt`；
   - 断言出现 fallback 解码后的 `safe.txt`。

4. **CP437 fallback**
   - 构造无 UTF-8 flag、无 `0x7075` 的 CP437 文件名；
   - 断言 list/read 使用 CP437 解码结果。

5. **现有 archive tests 不回退**
   - `.tar`、`.tar.gz`、`.tgz`、`.zip` 既有 subpath 测试继续通过。

### PR 2 测试

如果实现 fallback encoding 设置，新增：

1. 无配置时，无 UTF-8 flag、无 `0x7075` 的 GBK raw name 不被自动识别为中文。
2. 配置 `read.archive.filenameEncoding = "gbk"` 时，GBK raw name 可按中文路径 list/read。
3. UTF-8 flag 和合法 `0x7075` 的优先级高于 fallback encoding。
4. 不支持的 encoding 被拒绝或产生清晰错误。

## 文档与 Changelog

### `docs/tools/read.md`

更新 Archives 段落，说明：

- `.zip` 条目名从 central directory metadata 解码；
- 解码优先级为 UTF-8 flag、Info-ZIP Unicode Path extra field、CP437；
- 文件内容仍按文本 UTF-8 读取，非 UTF-8 内容仍会被视为 binary archive entry；
- 如果 PR 2 加配置，再说明 legacy fallback encoding 是显式 opt-in。

### `packages/coding-agent/CHANGELOG.md`

PR 1 在 `[Unreleased] -> Fixed` 增加：

```markdown
- Fixed ZIP archive entry names with Unicode path extra fields rendering as mojibake in the Read tool.
```

PR 2 如果实现配置，在 `[Unreleased] -> Added` 增加：

```markdown
- Added an explicit Read tool fallback encoding option for legacy ZIP entry names.
```

## 验证命令

PR 1 至少运行：

```bash
bun test packages/coding-agent/test/tools.test.ts
bun --cwd=packages/coding-agent run check:types
```

如果修改配置 schema 或跨包类型，运行：

```bash
bun check
```

如果 PR 2 修改设置文档或生成项，按仓库规则运行相应生成/检查命令。

## 验收标准

PR 1 验收：

- 用户样例 ZIP 根目录显示 `03-CRAIC2026比赛规则及附件/`；
- 样例 ZIP 子目录显示正确中文文件名；
- 可通过正确中文路径读取 archive entry；
- bad CRC `0x7075` 不被信任；
- CP437 fallback 行为确定；
- 无新直接依赖；
- tar/tgz 行为不变；
- 文档和 changelog 已更新；
- 指定测试和类型检查通过。

PR 2 验收：

- legacy fallback encoding 仅在显式配置时生效；
- UTF-8 flag 和合法 `0x7075` 优先级不受配置影响；
- 配置支持的编码列表明确；
- 不做自动猜测；
- 文档和测试覆盖配置行为。

## 风险与缓解

### 风险：自写 ZIP parser 引入边界 bug

缓解：只解析 central directory 的必要字段；payload 解压仍复用 `fflate`；遇到 ZIP64 或不支持 method 时抛清晰错误，不做部分猜测。

### 风险：路径穿越

缓解：所有解码结果继续走 `normalizeArchiveEntryPath()`，拒绝 `..`，并保持现有 parent directory 补全逻辑。

### 风险：legacy encoding 自动猜测误伤

缓解：PR 1 不做自动猜测；PR 2 仅提供显式 opt-in fallback encoding。

### 风险：stacked PR 审查混乱

缓解：PR 2 base 指向 PR 1 分支，PR 描述顶部注明依赖关系；PR 1 合并后 PR 2 rebase 并 retarget 到 `main`。
