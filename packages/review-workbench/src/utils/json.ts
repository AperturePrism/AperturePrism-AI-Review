/** 确定性JSON用于内容校验；相同字段换顺序不会改变归档或幂等键。 */
import { WorkbenchError } from "./input.js";

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 40)
    throw new WorkbenchError("json_too_deep", "JSON 数据嵌套超过 40 层");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return (
      "[" + value.map((item) => canonicalJson(item, depth + 1)).join(",") + "]"
    );
  if (typeof value !== "object" || value === null)
    throw new WorkbenchError("invalid_json", "只接受有限的 JSON 数据");
  return (
    "{" +
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, item]) =>
          JSON.stringify(key) + ":" + canonicalJson(item, depth + 1),
      )
      .join(",") +
    "}"
  );
}
