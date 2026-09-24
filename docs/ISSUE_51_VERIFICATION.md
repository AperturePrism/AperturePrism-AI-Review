# Issue #51 验证结论：缺陷类「建议改动」块缺失

> 验证时间：2026-09-03
> 涉及版本：v1.0.108
> 关联 Issue：[#51 缺陷类审核结果已配置建议改动块，但 bot 实际输出缺少该模块](https://github.com/AperturePrism/AperturePrism-AI-Review/issues/51)

## 一、用户反馈

- 用户称「缺陷类审核结果模块设置有建议改动块，但 bot 实际输出无建议改动模块」。

- Issue 正文仅含一张截图，无代码复现步骤、无报错日志、无源码上下文。

## 二、排查过程

### 1. 结果区块配置核查（代码 + DB）

- DB 中 `issue_result_sections` / `issue_result_sections_bug` / `issue_result_sections_feature` 均未配置，仓库级也无覆盖。

- 未配置时走 `parseIssueResultSections` 默认集（见 `packages/issue-analysis/src/prompt.ts`）：
  `summary / suggested_title / probable_cause / troubleshooting / evidence / suggested_labels / proposed_changes`

- **默认区块本身已包含** **`proposed_changes`（建议改动）**，不存在「配置了却被清空」的情况。

- `applyResultSections`（`analyze.ts`）只会在区块被关闭时清空对应字段；`proposed_changes` 默认开启。

### 2. 评论渲染逻辑核查

- `buildIssueAnalysisComment`（`comment.ts`）仅在 `result.proposedChanges.length > 0` 时渲染「建议修改」段。

- 数组为空 → 该段不渲染。**这是有意的条件渲染**，不是缺失。

### 3. 实跑验证（v1.0.108，手动触发 #51）

- 触发方式：`POST /tasks/manual`（`subjectNumber: 51`）。

- 视觉阶段：`issue_analysis_vision` 使用 `MiniMaxAI/MiniMax-M3`，但该次对 #51 真实截图返回 **400**（`Backend request failed with status 400`，5 次尝试全失败）→ 触发**文本兜底**。

- 文本兜底完成（task `50661669` completed），发布评论。

- **最终评论不含「建议修改」段**，但含摘要/证据/建议标签/建议指派人。

## 三、结论

**#51 属正常行为，非代码缺陷。**

1. 默认结果区块包含 `proposed_changes`，未被清空。
2. 该 Issue 纯为截图、无代码复现、无源码上下文，模型无法生成 `proposedChanges`（数组为空）→ 评论按条件渲染不输出「建议修改」段。
3. 首次 bot 分析失败（`handler_error`）是当时视觉模型（kimi-k3）服务不可用所致，与「建议改动」缺失无关。

## 四、验证过程中暴露的相关问题

| 问题                          | 说明                                       | 处置                                                                |
| --------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| 视觉模型（MiniMax-M3）对真实大图/并发不稳定 | 单测 1×1 图 3/3 OK；真实 issue 截图偶发 400/500/超时 | v1.0.108 已实现「视觉优先 + 60s 快速失败回退文本 + 评论标注视觉未参与」兜底；M3 大多数可用，个别失败自动回退 |

## 五、后续建议（可选）

- 若希望「建议改动」在无可改内容时也有显式说明，可在评论渲染层对 `proposedChanges` 为空且开启该区块时输出一行「本条未识别到可建议改动的代码位置」——需产品决策，非缺陷修复。

- 视觉模型稳定性可关注 newapi 网关侧 M3 的上游配额/限流。

