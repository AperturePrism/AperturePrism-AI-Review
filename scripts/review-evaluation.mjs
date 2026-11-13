#!/usr/bin/env node
/**
 * 离线审查评估 CLI；只读取人工标签和已有预测，不调用模型或 GitHub。
 * 先构建：npm run build -w @apertureprism/review-evaluation
 * 示例：node scripts/review-evaluation.mjs example --output-dir /tmp/review-example
 * 评估：node scripts/review-evaluation.mjs compare --dataset cases.jsonl --run candidate.json --baseline baseline.json
 */
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const HELP = `AperturePrism 离线审查实验台

使用：node scripts/review-evaluation.mjs COMMAND [选项]

COMMAND:
  validate   校验数据集、计算版本并检查跨 train/validation/test 泄漏
  evaluate   用人工标签评分一份已有预测
  compare    与已有基线比较，固定 seed 做成对 Bootstrap
  example    在指定目录创建小型可运行示例，包含数据集/预测/运行清单/门禁

选项：
  --dataset FILE         一行一个案例的 JSONL
  --dataset-id ID        报告中的数据集名称，默认 review-dataset
  --run FILE             候选运行清单 JSON，记录模型、策略、数据集 hash 和预测相对路径
  --baseline FILE        对照运行清单 JSON，compare 必填
  --split NAME           all/train/validation/test，默认 all
  --line-tolerance N     同规则同文件行号容忍度，默认 3
  --minimum-confidence N 忽略低于该置信度的预测，范围 0..1
  --aliases FILE         规则别名 JSON 对象，可迁移规则标识而不改标签
  --gate FILE            门禁策略 JSON；未提供时仍检查缺失、失败与数据泄漏
  --samples N            Bootstrap 次数，100..20000，默认 2000
  --seed N               固定随机种子，默认 4632
  --confidence N         区间置信水平，默认 0.95
  --currency CODE        费用货币标识，如 USD；未提供则费用币种显示未知
  --input-price N        每百万输入 token 的整数微单位价格
  --output-price N       每百万输出 token 的整数微单位价格
  --format NAME          json/markdown/csv/workbench，默认 json；workbench 可导入 evaluations.create
  --output FILE          写报告；省略时输出到 stdout
  --output-dir DIR       example 的输出目录
  --overwrite           允许覆盖指定输出文件
  --help                 显示帮助

退出码：0 通过；1 输入或运行错误；2 门禁失败或检测到跨划分泄漏。
所有命令离线运行；不会产生任何真实模型调用或模型费用。
`;

const VALUE_FLAGS = new Set([
  "dataset",
  "dataset-id",
  "run",
  "baseline",
  "split",
  "line-tolerance",
  "minimum-confidence",
  "aliases",
  "gate",
  "samples",
  "seed",
  "confidence",
  "currency",
  "input-price",
  "output-price",
  "format",
  "output",
  "output-dir",
]);

function argumentsOf(argv) {
  if (argv.includes("--help") || argv.includes("-h") || !argv.length)
    return { help: true, command: null, values: new Map(), overwrite: false };
  const [command, ...rest] = argv;
  if (!["validate", "evaluate", "compare", "example"].includes(command))
    throw new Error(`未知命令：${command}`);
  const values = new Map();
  let overwrite = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--overwrite") {
      if (overwrite) throw new Error("--overwrite 不能重复");
      overwrite = true;
      continue;
    }
    if (!argument.startsWith("--") || !VALUE_FLAGS.has(argument.slice(2)))
      throw new Error(`未知选项：${argument}`);
    const key = argument.slice(2);
    if (values.has(key)) throw new Error(`${argument} 不能重复`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少值`);
    values.set(key, value);
    index += 1;
  }
  return { help: false, command, values, overwrite };
}

/** 固定大小逐块读取，文件在读取期间增长也不能绕过总容量上限。 */
async function boundedText(filename, limit = 64 * 1_048_576) {
  const handle = await open(filename, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`输入必须是普通文件：${filename}`);
    if (info.size > limit)
      throw new Error(`输入文件超过 ${limit} 字节上限：${filename}`);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, limit - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error(`输入文件超过字节上限：${filename}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    await handle.close();
  }
}

async function jsonFile(filename) {
  const text = await boundedText(filename, 1_048_576);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`不是有效 JSON 文件：${filename}`);
  }
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`请提供 --${key}`);
  return value;
}

function numberOption(values, key) {
  if (!values.has(key)) return undefined;
  const value = Number(values.get(key));
  if (!Number.isFinite(value)) throw new Error(`--${key} 必须是有限数字`);
  return value;
}

async function loadRun(api, filename) {
  const path = resolve(filename);
  const raw = api.inputObject(await jsonFile(path));
  api.rejectUnknownFields(raw, [
    "version",
    "id",
    "model",
    "policyVersion",
    "datasetHash",
    "predictions",
  ]);
  if (raw.version !== 1) throw new Error("运行清单 version 必须为 1");
  const predictions = api.inputText(raw.predictions, "predictions", 4_096);
  return api.parsePredictionJsonl(
    await boundedText(resolve(dirname(path), predictions)),
    {
      id: raw.id,
      model: raw.model,
      policyVersion: raw.policyVersion,
      datasetHash: raw.datasetHash,
    },
  );
}

async function outputReport(content, parsed) {
  const filename = parsed.values.get("output");
  if (!filename) {
    process.stdout.write(content);
    return;
  }
  await writeFile(resolve(filename), content, {
    encoding: "utf8",
    flag: parsed.overwrite ? "w" : "wx",
  });
  process.stderr.write(`已写入报告：${resolve(filename)}\n`);
}

async function createExample(api, parsed) {
  const directory = resolve(required(parsed.values, "output-dir"));
  await mkdir(directory, { recursive: true });
  const labels = [
    {
      version: 1,
      id: "auth-boundary",
      repository: "example/review",
      revision: "revision-a",
      split: "test",
      input: "diff --git a/src/api.ts b/src/api.ts\n+return db.rows();",
      expected: [
        {
          id: "auth-1",
          ruleId: "missing-authorization",
          path: "src/api.ts",
          startLine: 12,
          severity: "high",
          label: "positive",
        },
      ],
    },
    {
      version: 1,
      id: "clean-change",
      repository: "example/review",
      revision: "revision-b",
      split: "test",
      input:
        "diff --git a/src/title.ts b/src/title.ts\n+const title = 'Review';",
      expected: [],
    },
  ];
  const datasetText =
    labels.map((item) => JSON.stringify(item)).join("\n") + "\n";
  const dataset = api.parseDatasetJsonl(datasetText, { id: "review-example" });
  const goodFinding = {
    id: "p-auth",
    ruleId: "missing-authorization",
    path: "src/api.ts",
    startLine: 13,
    severity: "high",
    confidence: 0.9,
  };
  const baseline = [
    {
      version: 1,
      caseId: "auth-boundary",
      findings: [],
      durationMs: 100,
      inputTokens: 30,
      outputTokens: 5,
      costMicros: 4,
    },
    {
      version: 1,
      caseId: "clean-change",
      findings: [],
      durationMs: 80,
      inputTokens: 20,
      outputTokens: 3,
      costMicros: 3,
    },
  ];
  const candidate = [
    {
      version: 1,
      caseId: "auth-boundary",
      findings: [goodFinding],
      durationMs: 110,
      inputTokens: 30,
      outputTokens: 8,
      costMicros: 5,
    },
    {
      version: 1,
      caseId: "clean-change",
      findings: [],
      durationMs: 70,
      inputTokens: 20,
      outputTokens: 3,
      costMicros: 3,
    },
  ];
  const manifest = (id) => ({
    version: 1,
    id,
    model: `example-${id}`,
    policyVersion: "example-v1",
    datasetHash: dataset.hash,
    predictions: `${id}.jsonl`,
  });
  const files = new Map([
    ["cases.jsonl", datasetText],
    [
      "baseline.jsonl",
      baseline.map((item) => JSON.stringify(item)).join("\n") + "\n",
    ],
    [
      "candidate.jsonl",
      candidate.map((item) => JSON.stringify(item)).join("\n") + "\n",
    ],
    ["baseline.json", JSON.stringify(manifest("baseline"), null, 2) + "\n"],
    ["candidate.json", JSON.stringify(manifest("candidate"), null, 2) + "\n"],
    [
      "gate.json",
      JSON.stringify(
        {
          minF1: 0.8,
          maxMissingCases: 0,
          maxFailedCases: 0,
          maxF1Regression: 0,
        },
        null,
        2,
      ) + "\n",
    ],
  ]);
  if (!parsed.overwrite)
    for (const filename of files.keys()) {
      try {
        await stat(join(directory, filename));
        throw new Error(`文件已存在：${filename}；使用 --overwrite 才会覆盖`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  for (const [filename, content] of files)
    await writeFile(join(directory, filename), content, {
      encoding: "utf8",
      flag: parsed.overwrite ? "w" : "wx",
    });
  process.stdout.write(
    JSON.stringify(
      { directory, datasetHash: dataset.hash, files: [...files.keys()] },
      null,
      2,
    ) + "\n",
  );
}

async function main() {
  const parsed = argumentsOf(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  let api;
  try {
    api = await import(
      new URL("../packages/review-evaluation/dist/index.js", import.meta.url)
    );
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND")
      throw new Error(
        "请先执行 npm run build -w @apertureprism/review-evaluation",
      );
    throw error;
  }
  if (parsed.command === "example") {
    await createExample(api, parsed);
    return;
  }
  const dataset = api.parseDatasetJsonl(
    await boundedText(resolve(required(parsed.values, "dataset"))),
    { id: parsed.values.get("dataset-id") ?? "review-dataset" },
  );
  if (parsed.command === "validate") {
    const leakage = api.inspectDatasetLeakage(dataset);
    await outputReport(
      JSON.stringify(
        {
          id: dataset.id,
          version: dataset.version,
          hash: dataset.hash,
          cases: dataset.cases.length,
          splits: Object.fromEntries(
            ["train", "validation", "test"].map((split) => [
              split,
              dataset.cases.filter((item) => item.split === split).length,
            ]),
          ),
          leakage,
        },
        null,
        2,
      ) + "\n",
      parsed,
    );
    if (!leakage.clean) process.exitCode = 2;
    return;
  }
  const options = {
    split: parsed.values.get("split") ?? "all",
    ...(parsed.values.has("line-tolerance")
      ? { lineTolerance: numberOption(parsed.values, "line-tolerance") }
      : {}),
    ...(parsed.values.has("minimum-confidence")
      ? { minimumConfidence: numberOption(parsed.values, "minimum-confidence") }
      : {}),
    ...(parsed.values.has("aliases")
      ? { ruleAliases: await jsonFile(resolve(parsed.values.get("aliases"))) }
      : {}),
    ...(parsed.values.has("currency")
      ? { currency: parsed.values.get("currency") }
      : {}),
  };
  if (parsed.values.has("input-price") || parsed.values.has("output-price")) {
    required(parsed.values, "input-price");
    required(parsed.values, "output-price");
    options.price = {
      currency: required(parsed.values, "currency"),
      inputMicrosPerMillion: numberOption(parsed.values, "input-price") ?? 0,
      outputMicrosPerMillion: numberOption(parsed.values, "output-price") ?? 0,
    };
  }
  const run = await loadRun(api, required(parsed.values, "run"));
  const result = api.evaluateReviewRun(dataset, run, options);
  let comparison;
  if (parsed.command === "compare") {
    const baseline = api.evaluateReviewRun(
      dataset,
      await loadRun(api, required(parsed.values, "baseline")),
      options,
    );
    comparison = api.compareReviewEvaluations(baseline, result, {
      ...(parsed.values.has("seed")
        ? { seed: numberOption(parsed.values, "seed") }
        : {}),
      ...(parsed.values.has("samples")
        ? { samples: numberOption(parsed.values, "samples") }
        : {}),
      ...(parsed.values.has("confidence")
        ? { confidence: numberOption(parsed.values, "confidence") }
        : {}),
    });
  }
  const policy = parsed.values.has("gate")
    ? api.parseReviewGatePolicy(
        await jsonFile(resolve(parsed.values.get("gate"))),
      )
    : {};
  const gate = api.evaluateReviewGate(result, policy, {
    dataset,
    ...(comparison ? { comparison } : {}),
  });
  const format = parsed.values.get("format") ?? "json";
  const report =
    format === "workbench"
      ? JSON.stringify(api.workbenchEvaluationInput(result), null, 2) + "\n"
      : api.renderReviewEvaluation(result, {
          format,
          gate,
          ...(comparison ? { comparison } : {}),
        });
  await outputReport(report, parsed);
  if (!gate.passed) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(
    `review-evaluation: ${error instanceof Error ? error.message : "运行失败"}\n`,
  );
  process.exitCode = 1;
});
