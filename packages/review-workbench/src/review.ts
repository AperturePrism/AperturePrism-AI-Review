/**
 * 实际审查交付的持久账本：排序、幂等导入与完整审查后的状态收口。
 * @example syncReview(context,{source:'pr:42',reference:'head-sha',deliveryKey:'attempt-id',findings:[]});
 */
import { createHash, randomUUID } from "node:crypto";
import { audit, type CommandContext } from "./audit.js";
import { importFindings, transitionFinding } from "./finding.js";
import { evaluateGate } from "./gate.js";
import { array, boolean, object, text, WorkbenchError } from "./utils/input.js";
import { canonicalJson } from "./utils/json.js";

/** 工作进程一次写入实际审查结果；解析失败或越权不会留下一半发现。 */
export function syncReview(
  context: CommandContext,
  input: Record<string, unknown>,
): unknown {
  const source = text(input.source, "source", 200); // 同一个PR或扫描主体的交付共享来源。
  const reference = text(input.reference, "reference", 500); // 保存本次实际审查的提交或任务引用。
  const sourceSequence =
    input.sourceSequence === undefined
      ? undefined
      : text(input.sourceSequence, "sourceSequence", 50);
  if (sourceSequence !== undefined && !/^[1-9]\d{0,49}$/.test(sourceSequence))
    throw new WorkbenchError(
      "invalid_sequence",
      "sourceSequence 必须是不超过 50 位的正整数字符串",
    );
  if (sourceSequence !== undefined) {
    // 工作进程完成顺序不等于提交顺序；旧head晚到不能把新head的修复状态覆盖掉。
    const latest = context.data.reviews
      .filter(
        (record) =>
          record.repository === context.repository &&
          record.source === source &&
          record.sourceSequence !== undefined,
      )
      .reduce<(typeof context.data.reviews)[number] | null>(
        (current, record) =>
          !current ||
          BigInt(record.sourceSequence!) > BigInt(current.sourceSequence!)
            ? record
            : current,
        null,
      );
    if (latest && BigInt(sourceSequence) < BigInt(latest.sourceSequence!))
      return {
        items: [],
        imported: 0,
        resolved: 0,
        gate: latest.gate,
        ignored: true,
        replayed: false,
      };
  }
  const incoming = array(input.findings, "findings", 10_000).map((value) => ({
    ...object(value, "finding"),
    source,
    reference,
  }));
  const key = // SQL outbox重试沿用同一交付键，人工新一轮审查使用新键。
    input.deliveryKey === undefined
      ? JSON.stringify([source, reference])
      : text(input.deliveryKey, "deliveryKey", 300);
  const payloadHash = createHash("sha256") // 相同键若换了内容要报冲突，不能假装成功。
    .update(
      canonicalJson({
        source,
        reference,
        findings: incoming,
        resolveMissing: input.resolveMissing ?? false,
        ...(sourceSequence === undefined ? {} : { sourceSequence }),
      }),
    )
    .digest("hex");
  const previous = context.data.reviews.find(
    (record) => record.repository === context.repository && record.key === key,
  );
  if (previous) {
    if (previous.payloadHash !== payloadHash)
      throw new WorkbenchError(
        "idempotency_conflict",
        "相同审查交付键不能对应不同结果",
        409,
      );
    return {
      // 返回当前人工处置状态，绝不因交付重放再次重开已修复问题。
      items: previous.findingIds.map((id) =>
        context.data.findings.find((finding) => finding.id === id)!,
      ),
      imported: previous.imported,
      resolved: previous.resolved,
      gate: previous.gate,
      replayed: true,
    };
  }
  const imported = importFindings(context, { findings: incoming }); // 导入和交付账本由同一事务提交。
  const seen = new Set(imported.items.map((item) => item.fingerprint)); // 指纹比行号稳定，可抵抗代码插入导致的行移位。
  let resolved = 0; // 只有宿主明确声明完整审查时才收口消失的发现。
  if (boolean(input.resolveMissing, "resolveMissing", false)) {
    for (const finding of context.data.findings) {
      if (
        finding.repository !== context.repository ||
        finding.source !== source ||
        seen.has(finding.fingerprint) ||
        !["open", "acknowledged"].includes(finding.status)
      )
        continue;
      transitionFinding(context, {
        id: finding.id,
        status: "fixed",
        reason: `完整审查 ${reference} 不再报告此发现`,
      });
      resolved += 1;
    }
  }
  const gate = evaluateGate(context, input); // 门禁读到的是本次导入后的完整一致状态。
  context.data.reviews.push({
    id: randomUUID(),
    repository: context.repository,
    key,
    source,
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    reference,
    payloadHash,
    receivedAt: context.now,
    findingIds: imported.items.map((item) => item.id),
    imported: imported.imported,
    resolved,
    gate,
  });
  audit(context, "review.synced", source, {
    reference,
    imported: imported.imported,
    resolved,
    gate: gate.decision,
  });
  return { ...imported, resolved, gate, replayed: false };
}
