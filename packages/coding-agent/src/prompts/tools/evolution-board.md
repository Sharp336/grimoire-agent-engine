# evolution_board

查询 omp 功能进化看板，获取当前开发中的功能 Topic 列表或详情。

## 参数
- `action`: 操作类型
  - `list` — 列出所有 Topic
  - `show` — 展示指定 Topic 详情
  - `filter` — 按条件过滤 Topic
  - `add` — 添加新 Topic
- `topicId`: Topic ID（action=show 时必填）
- `filter`: 过滤条件（action=filter 时使用）
  - `status`: 按状态过滤（planned, in-progress, review, testing, shipped, deferred）
  - `module`: 按模块过滤
  - `tag`: 按标签过滤
- `topic`: Topic 参数（action=add 时使用）
  - `name`: Topic 名称（必填）
  - `brief`: Topic 简述（必填）
  - `description`: 详细描述（可选）
  - `status`: 状态（可选，默认 planned）
  - `progress`: 进度百分比 0-100（可选）
  - `modules`: 所属模块列表（可选）
  - `tags`: 标签列表（可选）
  - `notes`: 备注（可选）
  - `references`: 参考链接列表（可选，每项含 name, url, note）

## 使用场景
- 用户问"当前在做什么功能"时，调用 `action=list`
- 用户问"功能看板进度如何"时，调用 `action=list`
- 用户问"某个功能详情"时，调用 `action=show` 并传入 topicId
- 用户想按状态/模块查看时，调用 `action=filter`
- 用户想添加新功能到看板时，调用 `action=add` 并传入 topic 参数
