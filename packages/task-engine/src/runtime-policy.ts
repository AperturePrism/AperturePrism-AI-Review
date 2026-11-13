/**
 * 执行配置：可选环境变量只在这个边界解析，任务算法不自行读取环境。
 *
 * @example
 * const policy = loadTaskRuntimePolicy({ TASK_QUEUE_POLICY_JSON: '{"agingIntervalMs":60000,"maxActivePerRepository":2}' });
 *
 * 不设置环境变量时保持 v1.2 的静态优先级和调用方指定的重试间隔。
 */
import { parseQueuePolicy, type QueuePolicy } from "./queue.js";
import { parseRetryPolicy, type RetryPolicy } from "./retry.js";

export type TaskRuntimePolicy = { queue?: QueuePolicy; retry?: RetryPolicy };

/** 从 JSON 对象读取策略；拼错字段直接报错，避免管理员以为限额已经生效。 */
function readPolicy(
  text: string,
  name: string,
  allowed: readonly string[],
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`${name} must be valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError(`${name} must be a JSON object`);
  for (const key of Object.keys(parsed))
    if (!allowed.includes(key))
      throw new TypeError(`${name} contains unknown field ${key}`);
  return parsed as Record<string, unknown>;
}

/** @returns 已校验的可选策略；返回对象不引用环境变量或调用方可变对象。 */
export function loadTaskRuntimePolicy(
  env: Record<string, string | undefined> = process.env,
): TaskRuntimePolicy {
  const result: TaskRuntimePolicy = {};
  const queue = env.TASK_QUEUE_POLICY_JSON?.trim();
  const retry = env.TASK_RETRY_POLICY_JSON?.trim();
  if (queue)
    result.queue = parseQueuePolicy(
      readPolicy(queue, "TASK_QUEUE_POLICY_JSON", [
        "agingIntervalMs",
        "maxAgingBoost",
        "maxActivePerRepository",
        "maxActiveTotal",
        "roundRobin",
        "allowedTaskTypes",
      ]),
    );
  if (retry)
    result.retry = parseRetryPolicy(
      readPolicy(retry, "TASK_RETRY_POLICY_JSON", [
        "baseDelayMs",
        "maxDelayMs",
        "multiplier",
        "jitterRatio",
        "maxElapsedMs",
        "stopCategories",
      ]),
    );
  return result;
}
