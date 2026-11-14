/**
 * 全局审核规则沿用已有设置键；读取、内容指纹和防覆盖保存集中在这里。
 * @example await saveGlobalReviewRules(db, { content, expectedContentHash });
 */
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { systemSettings } from "./schema.js";

export const GLOBAL_REVIEW_RULES_KEY = "review_rules_global";
export type GlobalReviewRules = {
  content: string;
  contentHash: string;
  updatedAt: string | null;
};

export class GlobalReviewRulesConflict extends Error {
  constructor(readonly currentContentHash: string) {
    super("全局审核规则已更新，请重新读取后再保存");
    this.name = "GlobalReviewRulesConflict";
  }
}

export function globalReviewRulesHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function loadGlobalReviewRules(
  db: DatabaseClient["db"],
): Promise<GlobalReviewRules> {
  const [row] = await db
    .select({
      content: systemSettings.value,
      updatedAt: systemSettings.updatedAt,
    })
    .from(systemSettings)
    .where(eq(systemSettings.key, GLOBAL_REVIEW_RULES_KEY))
    .limit(1);
  const content = row?.content ?? "";
  return {
    content,
    contentHash: globalReviewRulesHash(content),
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/** 相同旧指纹只能成功保存一次；空设置也使用同一个数据库事务锁。 */
export async function saveGlobalReviewRules(
  db: DatabaseClient["db"],
  input: { content: string; expectedContentHash: string },
): Promise<GlobalReviewRules> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${GLOBAL_REVIEW_RULES_KEY}))`,
    );
    const [current] = await tx
      .select({ content: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, GLOBAL_REVIEW_RULES_KEY))
      .for("update")
      .limit(1);
    const oldContent = current?.content ?? "";
    const oldHash = globalReviewRulesHash(oldContent);
    if (oldHash !== input.expectedContentHash.toLowerCase())
      throw new GlobalReviewRulesConflict(oldHash);

    const [saved] = await tx
      .insert(systemSettings)
      .values({
        key: GLOBAL_REVIEW_RULES_KEY,
        value: input.content,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: input.content, updatedAt: new Date() },
        // 兼容旧的通用设置写口：若它在空行检查后插入内容，也不能覆盖新值。
        setWhere: eq(systemSettings.value, oldContent),
      })
      .returning({
        content: systemSettings.value,
        updatedAt: systemSettings.updatedAt,
      });
    if (!saved) {
      const [latest] = await tx
        .select({ content: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, GLOBAL_REVIEW_RULES_KEY))
        .limit(1);
      throw new GlobalReviewRulesConflict(
        globalReviewRulesHash(latest?.content ?? ""),
      );
    }
    return {
      content: saved.content,
      contentHash: globalReviewRulesHash(saved.content),
      updatedAt: saved.updatedAt.toISOString(),
    };
  });
}
