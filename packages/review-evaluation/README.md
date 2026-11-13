# 离线审查实验台

这个包比较人工标签和已经生成的模型预测，完成精确率、召回率、F1、严重度加权、成对模型对照和回归门禁。所有命令离线运行，不调用模型，不访问 GitHub，不执行案例中的代码。

先构建并运行完整示例：

```sh
npm run build -w @apertureprism/review-evaluation
node scripts/review-evaluation.mjs example --output-dir /tmp/review-example
node scripts/review-evaluation.mjs validate --dataset /tmp/review-example/cases.jsonl
node scripts/review-evaluation.mjs compare --dataset /tmp/review-example/cases.jsonl --run /tmp/review-example/candidate.json --baseline /tmp/review-example/baseline.json --gate /tmp/review-example/gate.json --currency USD --format markdown --output /tmp/review-example/report.md
```

`example` 只创建两个明确标注的演示案例，用来检查命令接线；它们不是模型实测成绩。已有输出文件默认不覆盖，确实需要替换时加 `--overwrite`。命令可从任意工作目录启动，预测路径相对于运行清单的位置解析。

## 文件位置

| 要修改的内容 | 文件 |
|---|---|
| 人工案例、JSONL 边界、版本指纹、划分泄漏 | `src/dataset.ts` |
| 已有预测的结构与用量校验 | `src/prediction.ts` |
| 同一问题的匹配、规则别名、行号容忍 | `src/matching.ts` |
| 单次评分、严重度、成本和延迟 | `src/score.ts` |
| 对照实验与固定 seed Bootstrap | `src/comparison.ts` |
| CI 通过/失败规则 | `src/gate.ts` |
| JSON、Markdown、CSV 报告 | `src/report.ts` |
| 工作台导入格式 | `src/workbench.ts` |
| CLI 参数和本地文件 | `../../scripts/review-evaluation.mjs` |

## 人工标签 JSONL

一行一个案例，格式如下。多个案例应使用不同 id，重复输入和同仓库同修订会被报告；跨 train/validation/test 的重复默认使门禁失败。

```json
{"version":1,"id":"auth-boundary","repository":"example/review","revision":"revision-a","split":"test","input":"原始 diff 和审查上下文","expected":[{"id":"auth-1","ruleId":"missing-authorization","path":"src/api.ts","startLine":12,"endLine":14,"severity":"high","label":"positive"}]}
```

`severity` 支持 critical/high/medium/low/info；`label` 为 positive 或 negative。positive 是人工确认应报告的问题，negative 是人工确认的已知误报。没有预期问题的干净案例使用空 expected 数组。负标签不会被算成真发现，命中仍计为误报。

数据集版本是规范化内容的 SHA-256：案例行序、对象字段序和 CRLF 换行不会改变版本，输入或标签变化会改变。排序使用固定字符顺序，机器系统语言不会改变版本。默认限制总输入 64 MiB、单行 2 MiB、案例 20,000 个、每案例 500 条发现。路径必须在仓库内，未知字段、重复 id、无效行号和不支持的版本会给出行号错误，诊断不会回显上下文正文。

## 预测与运行清单

预测文件同样一行一个案例：

```json
{"version":1,"caseId":"auth-boundary","findings":[{"id":"p-1","ruleId":"missing-authorization","path":"src/api.ts","startLine":13,"severity":"high","confidence":0.9}],"durationMs":120,"inputTokens":400,"outputTokens":90,"costMicros":20}
```

失败结果使用空 findings 并填写 `errorCategory`。缺少某个案例会产生漏报和 missing case，不能借跳过难题提高分数。一次 run 不允许重复案例；重跑应建新 run。用量必须是非负安全整数，延迟允许小数毫秒。`costMicros` 可以省略，未知费用不会被当作免费。

运行清单固定预测所使用的数据集版本：

```json
{"version":1,"id":"candidate-a","model":"candidate-model","policyVersion":"review-v2","datasetHash":"填写 validate 命令输出的 64 位 hash","predictions":"candidate-a.jsonl"}
```

CLI 不会用当前数据集 hash 替换清单中的旧 hash。版本不匹配、未知 caseId 或不同数据集之间对照都会明确失败。

## 分数含义

默认要求规则和路径一致，行范围允许相差 3 行。区间相交时距离为 0。使用一对一最大匹配，重复预测只给一次真阳性，其余计误报。规则迁移可用 `--aliases aliases.json` 明确指定，别名循环会被拒绝；`--minimum-confidence` 可以测试发布阈值。

微平均 F1 由总体 TP/FP/FN 计算。严重度加权默认 critical=16、high=8、medium=4、low=2、info=1，漏掉严重问题因此会有更大影响。严重度预测准确率和混淆矩阵另外保留，不能只看发现是否匹配。没有正例也没有预测时指标未定义并输出 null，干净案例是否完整执行由 perfect/missing/failed 字段表达。

对照使用同一批案例的成对 Bootstrap，不把同案例中互相关联的多条发现当成独立样本。默认 2,000 次、seed=4632、95% 区间，可通过 CLI 修改。少于 20 个案例、部分抽样指标未定义或费用币种不明会留下明确限制。区间只表达这份标签的抽样不确定性，不保证其他仓库效果。默认限制最多抽取 2,000 万个案例实例，避免误把大型数据集跑成长时间计算。

费用用整数微单位计算；例如一百万微美元等于一美元。预测没有费用时可以显式提供 `--currency USD --input-price 1000000 --output-price 2000000`，价格是每百万 token 的整数微单位。两个价格都要给，避免不小心把输出价当免费。延迟提供最近秩 p50/p95/p99。

## 门禁与报告

门禁策略是 JSON，例如：

```json
{"minCases":100,"minPrecision":0.85,"minRecall":0.75,"minF1":0.8,"minCriticalRecall":1,"maxFalsePositives":20,"maxMissingCases":0,"maxFailedCases":0,"maxP95Ms":30000,"maxF1Regression":0.01,"maxConfidenceRegression":0.03,"requireCleanSplits":true}
```

默认检查至少一个案例、缺失数为 0、失败数为 0、没有跨划分泄漏。配置的指标没有数据时会失败并写明原因，未知成本不会通过费用上限。回归阈值需要 compare 命令的基线；`maxConfidenceRegression` 使用 F1 变化区间的下界。

退出码：0 通过，1 输入或运行错误，2 门禁失败或数据泄漏。即使门禁失败，报告仍会写出供人检查。`--format` 支持 json/markdown/csv/workbench；报告默认省略原始 input 和模型 message，CSV 会转义公式开头字符。workbench 格式可通过工作台 CLI 的 `evaluations.create --input` 导入。工作台额外比较执行完成标签，其案例级指标与离线发现 F1 不同，导入 note 中会写清。

```sh
npx vitest run packages/review-evaluation
npm run typecheck -w @apertureprism/review-evaluation
```

测试会实际创建临时目录、运行 CLI、生成报告并检查退出码；也覆盖固定 seed 对照、匹配顺序不变性、重复发现、标签泄漏、版本过期和输出覆盖保护。
