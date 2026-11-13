/**
 * 操作审计和改动身份。只记录业务摘要，源码、密钥和完整模型提示不会进入日志。
 * @example audit(context, 'finding.transition', finding.id, {status:'fixed'});
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  Actor,
  AuditRecord,
  RecordIdentity,
  WorkbenchSnapshot,
} from "./types.js";
import { integer, optionalText } from "./utils/input.js";

export interface CommandContext {
  data: WorkbenchSnapshot;
  actor: Actor;
  repository: string;
  now: string;
}

/** 新主体使用同一身份字段；没有来自浏览器的 id 能覆盖它。 */
export function identity(context: CommandContext): RecordIdentity {
  return {
    id: randomUUID(),
    repository: context.repository,
    createdAt: context.now,
    updatedAt: context.now,
    createdBy: context.actor.userId,
    revision: 1,
  };
}

/** 每次编辑增加版本；未提供乐观锁时仍保留完整修改时间。 */
export function touch(context: CommandContext, record: RecordIdentity): void {
  record.updatedAt = context.now;
  record.revision += 1;
}

function digest(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

/** 哈希链便于发现意外损坏；它不是针对有磁盘写权限攻击者的数字签名。 */
export function audit(
  context: CommandContext,
  action: string,
  target: string,
  details: Record<string, unknown> = {},
): void {
  const previousHash = context.data.audit.at(-1)?.hash ?? "";
  const record = {
    id: randomUUID(),
    repository: context.repository,
    actor: context.actor.userId,
    action,
    target,
    at: context.now,
    details,
    previousHash,
  };
  context.data.audit.push({ ...record, hash: digest(record) });
}

/** 只返回已授权仓库的记录，并支持时间、操作、操作者过滤。 */
export function listAudit(
  context: CommandContext,
  input: Record<string, unknown>,
): { items: AuditRecord[]; total: number } {
  const action = optionalText(input.actionFilter, "actionFilter", 100);
  const actor = optionalText(input.actor, "actor", 200);
  const limit = integer(input.limit, "limit", 1, 500, 100);
  const offset = integer(input.offset, "offset", 0, 1_000_000, 0);
  const records = context.data.audit
    .filter((record) => record.repository === context.repository)
    .filter((record) => !action || record.action === action)
    .filter((record) => !actor || record.actor === actor)
    .reverse();
  return {
    items: records.slice(offset, offset + limit),
    total: records.length,
  };
}

/** 对整条链核验，错误仅返回仓库内的序号，不暴露其它仓库记录。 */
export function verifyAudit(context: CommandContext): {
  valid: boolean;
  checked: number;
  brokenRecordId: string | null;
} {
  let previousHash = "";
  let checked = 0;
  for (const record of context.data.audit) {
    const { hash, ...body } = record;
    const valid = record.previousHash === previousHash && hash === digest(body);
    if (!valid) {
      return {
        valid: false,
        checked,
        brokenRecordId:
          record.repository === context.repository ? record.id : null,
      };
    }
    previousHash = hash;
    if (record.repository === context.repository) checked += 1;
  }
  return { valid: true, checked, brokenRecordId: null };
}
