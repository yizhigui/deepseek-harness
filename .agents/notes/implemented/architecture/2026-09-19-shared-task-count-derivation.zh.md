# Agent Note：所有任务界面共用同一套任务计数推导

Status: implemented

[English](2026-09-19-shared-task-count-derivation.md) | 中文

## Problem

同一个任务集合由两个互不相干的界面渲染 —— 会话计划条（`TodoPanel`）与 `todo_write` 工具行 —— 而第三处，即 Host 侧的工具结果，在执行时另行推导计数。三者各自计算：

- `TodoPanel.progressLabel` 对投影列表做了两次过滤，并以 `length - done - active` 推导 `pending`。
- `planSummary` 对同一列表再次过滤，得出 `completed` 与 `in_progress`，并自带一份 "done" 计数。
- 工具的 `execute` 又对已校验的列表统计一次，用于面向模型的文本。

对同一个集合做三次过滤，就有三次彼此不一致的机会。计划条的 `pending` 是一个余数，会静默吞掉它没有点名的任何状态；因此，经由未校验的模型 JSON 抵达工具行的漂移状态，会被报告为「没有人计划过的待办」。

## Decision

`todoCounts`（`packages/client/ui-primitives/src/todo-counts.ts`）是唯一的推导入口。给定一个集合，它给出 `{ pending, inProgress, completed, other, total }`，各界面只决定如何呈现：

- `TodoPanel.progressLabel` 把它渲染成以「·」连接的片段。
- `planSummary` 直接返回推导结果中的 `done`/`pending`/`total`，只额外补上工具行所需的「进行中条目」子句。
- 工具行保留其紧凑的 `done/total` 头部与并行进行中的后缀。

有两条性质是承重的：

**每个条目只落入一个桶。** `pending` 是扣除 `completed`、`in_progress`、`other` 之后的余数，因此各桶之和恒等于 `total`，基于计数的摘要永远不会描述出与其旁边渲染的行数不同的列表长度。

**生命周期之外的状态归入 `other`，而不是 `pending`。** `TodoItem.status` 是封闭的三态联合，因此第四种状态不可能经由带类型的投影到来；它是经过模型撰写的调用参数抵达工具行的，而那些参数从未经过 schema 校验。把它并入 `pending` 会报告没有人计划过的工作，把它计为 `completed` 则会声称工作已完成。它改为以漂移的形式保持可见。

该模块与共享原子一同存放，而不是放在某个插件里，因为 `ui-conversation` 与 `ui-tool` 都要消费它，而跨插件的值导入在构造上就违反 bundle 纯度 —— 与 `turnActivity` 位于同一处的原因相同。

## Alternatives considered

**从 `ui-tool` 导出该选择器并在 `ui-conversation` 中导入。** 否决：`ui-conversation` 将因此对某个功能插件产生运行时依赖，这是客户端导出纪律所禁止的。

**让工具行完全以 `todos` 投影为准。** 否决：工具行记录的是某次历史调用，读取当前投影会让一行文本在后续回合改写列表后改变含义。

**把待办计数加入工具行的可见文本。** 否决：这是本任务未要求的界面改动；工具行保留其紧凑头部，改以断言来锁定一致性。

## Consequences

生命周期未定义的状态现在报告为 `other`，而不再被并入 `pending`。`planSummary` 新增了 `pending` 字段，而对任何格式良好的列表，计划条的数值保持不变。一致性在整个生命周期上被锁定（`packages/client/ui-tool/tests/task-state-consistency.client.spec.tsx` 针对完全相同的列表渲染工具行与计划条，覆盖「尚未开始、进行中、部分完成、全部完成、并行进行中」；`packages/client/ui-primitives/tests/todo-counts.client.spec.ts` 固定推导本身，包括它不持有任何状态，因此较新的集合总是胜过较旧的集合）。
