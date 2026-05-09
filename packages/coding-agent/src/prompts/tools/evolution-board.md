# evolution_board

查询 omp 功能进化看板，获取当前开发中的功能 Topic 列表或详情。

## 参数
- `action`: 操作类型
  - `list` — 列出所有 Topic
  - `show` — 展示指定 Topic 详情
  - `filter` — 按条件过滤 Topic
- `topicId`: Topic ID（action=show 时必填）
- `filter`: 过滤条件（action=filter 时使用）
  - `status`: 按状态过滤（planned, in-progress, review, testing, shipped, deferred）
  - `module`: 按模块过滤
  - `tag`: 按标签过滤

## 使用场景
- 用户问"当前在做什么功能"时，调用 `action=list`
- 用户问"功能看板进度如何"时，调用 `action=list`
- 用户问"某个功能详情"时，调用 `action=show` 并传入 topicId
- 用户想按状态/模块查看时，调用 `action=filter`
