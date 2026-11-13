# 模型调用

现有 `routeModelInvocation(adapters, input)` 调用方式继续有效。默认对同一个 adapters Map 共享并发控制：全局最多 32 次、每个账号最多 4 次，最多排队 1024 次。账号的不同模型共享账号席位，熔断状态按完整候选项分别保存。

`src/index.ts` 是调用主线；账号席位和熔断找 `traffic.ts`，费用找 `budget.ts`，显式复用找 `cache.ts`，SSE 协议找 `stream.ts`，近期健康判断与主动探测找 `health.ts`。这些状态仅覆盖当前进程，跨 worker 的硬限额应使用数据库统一预留。

```ts
import { configureModelTraffic, getModelTraffic, modelHealthReport, routeModelInvocation } from "./src/index.js";

configureModelTraffic(adapters, {
  maxConcurrent: 16,
  maxPerAccount: 2,
  queueTimeoutMs: 15_000,
  circuit: { failureThreshold: 5, cooldownMs: 30_000 },
});

const result = await routeModelInvocation(adapters, {
  candidates,
  request,
  deadlineMs: 30_000,
  retryPolicy: { maxAttemptsPerCandidate: 2, baseDelayMs: 200, maxDelayMs: 2000, jitterRatio: 1 },
  signal,
});

const health = modelHealthReport(candidates, getModelTraffic(adapters));
```

只有连接失败、超时和供应商 5xx 累计到熔断阈值。调用者取消、认证错误、模型不存在、输入溢出和结构错误交给路由正常分类处理。冷却结束只放一个半开探测。管理端手动解除熔断后，旧请求的迟到结果不会覆盖新的状态。

同一轮调用共享截止时间，排队和重试也扣除预算。即便自定义适配器忽略 AbortSignal，路由仍会按截止时间返回；上游实际是否继续执行取决于供应商和适配器的取消实现。某账号的 Retry-After 放不进剩余时间时，会继续尝试后续候选项。

## 费用预留

```ts
import { ModelBudget, ModelTraffic } from "./src/index.js";

const budget = new ModelBudget({ maxCostMicros: 5_000_000, maxRequests: 1000 });
const traffic = new ModelTraffic({
  budget,
  prices: [{ candidate, price: { currency: "USD", inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 } }],
});
const result = await routeModelInvocation(adapters, { ...input, traffic });
```

金额用整数微单位记录：1 USD = 1,000,000 微美元。输入和输出乘积使用 BigInt，相加后只向上取整一次。发送前同步预留，成功后按供应商返回的 token 数结算；重复结算返回同一收据。未知的失败账单不会伪造为已知费用。

默认输入预留按 UTF-8 字节估算，图片单独预留余量；这不是特定模型的 tokenizer。可以注入 `estimateUsage`，并给请求明确的 `maxOutputTokens`。供应商实际用量超出估算时仍记录真实账单，后续请求会被超额状态阻止。账本不混合货币；修改限额不清除旧账，仍有预留时禁止重置计费周期。

## 显式复用

```ts
import { ModelResponseCache } from "./src/index.js";

const cache = new ModelResponseCache({ ttlMs: 10_000, maxEntries: 200, maxBytes: 8_000_000 });
await routeModelInvocation(adapters, { ...input, cache, cacheScope: "tenant-7:policy-v2" });
```

`cacheScope` 必须包含租户和有效策略版本，权限或策略变化后换 scope 或主动失效。默认路由不开缓存；有副作用的工具调用和需要独立随机采样的请求应保留默认行为。一个订阅者取消不会中断其他订阅者，全部订阅者离开才取消共享请求。缓存命中或合并订阅者的新增用量为 0，原始用量放在 `result.cache.reusedUsage`，避免重复计费统计。

## 流式与诊断

`createOpenAICompatibleAdapter({ provider, baseUrl, resolveApiKey, stream: true })` 会真实请求 SSE，并合并碎片化的文本、工具参数和最终 usage。默认要求 `[DONE]`，连接中途断开、工具身份不完整或输出 token 耗尽会失败。普通 JSON、错误页和 SSE 都在读取过程中限制容量。网关错误正文默认不写入错误消息，可在受控排障时显式开启 `includeErrorDetail`。

`modelHealthReport` 只读近期样本，没有观察的候选项显示 unknown。`probeModelCandidates` 会真实调用模型并消耗供应商额度，因此不会自动执行。调用遥测只有账号、类别、数量和时间；不保存提示词、代码或模型正文。通用指标输出可使用 `metrics.prometheus()`，日志入口会递归清理凭据。

验证：

```sh
npx vitest run packages/model-router packages/observability
npm run typecheck -w @apertureprism/model-router
```

测试包含本地 HTTP socket 断流、原生 fetch 取消、真实截止时间及中文/emoji 在每个字节位置分片的 SSE 回归。
