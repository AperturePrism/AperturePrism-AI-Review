import { and, desc, eq, gt, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { hashToken } from "./password.js";

type Database = PostgresJsDatabase<typeof schema>;

export type SessionRow = {
  id: string;
  userLogin: string;
  authMethod: string;
  issuedAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
};

const SESSION_COLUMNS = {
  id: schema.userSessions.id,
  userLogin: schema.userSessions.userLogin,
  authMethod: schema.userSessions.authMethod,
  issuedAt: schema.userSessions.issuedAt,
  expiresAt: schema.userSessions.expiresAt,
  lastSeenAt: schema.userSessions.lastSeenAt,
  revokedAt: schema.userSessions.revokedAt,
  userAgent: schema.userSessions.userAgent,
  ip: schema.userSessions.ip,
} as const;

/**
 * 创建一条会话，token 落库前做 sha256 指纹。返回原始 token（仅此一次，
 * 前端需暂存；DB 中只存指纹）。
 */
export async function createSession(
  db: Database,
  input: {
    userLogin: string;
    token: string;
    authMethod: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
  },
): Promise<SessionRow> {
  const expiry = input.expiresAt;
  const rows = await db
    .insert(schema.userSessions)
    .values({
      userLogin: input.userLogin,
      tokenHash: hashToken(input.token),
      authMethod: input.authMethod,
      expiresAt: expiry,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    })
    .returning(SESSION_COLUMNS);
  const row = rows[0];
  if (!row) throw new Error("createSession: no row returned");
  return row;
}

/** 校验：token 指纹存在且未撤销、未过期。返回有效会话行或 null。 */
export async function findValidSession(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<SessionRow | null> {
  const rows = await db
    .select(SESSION_COLUMNS)
    .from(schema.userSessions)
    .where(eq(schema.userSessions.tokenHash, hashToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

/** 软更新最近活跃时间（best-effort，避免每个请求都写）。 */
export async function touchSession(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(schema.userSessions)
    .set({ lastSeenAt: now })
    .where(eq(schema.userSessions.tokenHash, hashToken(token)));
}

/** 吊销指定 token 的会话（主动登出）。 */
export async function revokeSession(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(schema.userSessions)
    .set({ revokedAt: now })
    .where(eq(schema.userSessions.tokenHash, hashToken(token)))
    .returning({ id: schema.userSessions.id });
  return updated.length > 0;
}

/** 吊销某用户的所有未撤销会话（改密/强制下线）。 */
export async function revokeUserSessions(
  db: Database,
  login: string,
  exceptToken?: string,
  now: Date = new Date(),
): Promise<number> {
  const condition =
    exceptToken === undefined
      ? and(
          eq(schema.userSessions.userLogin, login),
          isNull(schema.userSessions.revokedAt),
        )
      : and(
          eq(schema.userSessions.userLogin, login),
          isNull(schema.userSessions.revokedAt),
          ne(schema.userSessions.tokenHash, hashToken(exceptToken)),
        );
  const updated = await db
    .update(schema.userSessions)
    .set({ revokedAt: now })
    .where(condition)
    .returning({ id: schema.userSessions.id });
  return updated.length;
}

/** 某用户的活跃会话列表（含未过期未撤销），按最近活跃倒序。 */
export async function listUserSessions(
  db: Database,
  login: string,
  now: Date = new Date(),
): Promise<SessionRow[]> {
  return db
    .select(SESSION_COLUMNS)
    .from(schema.userSessions)
    .where(
      and(
        eq(schema.userSessions.userLogin, login),
        isNull(schema.userSessions.revokedAt),
        gt(schema.userSessions.expiresAt, now),
      ),
    )
    .orderBy(desc(schema.userSessions.lastSeenAt));
}

/** 按会话 id 吊销（admin / 本人会话管理）。返回是否命中并撤销。 */
export async function revokeSessionById(
  db: Database,
  sessionId: string,
  login?: string,
  now: Date = new Date(),
): Promise<boolean> {
  const cond =
    login === undefined
      ? eq(schema.userSessions.id, sessionId)
      : and(
          eq(schema.userSessions.id, sessionId),
          eq(schema.userSessions.userLogin, login),
        );
  const updated = await db
    .update(schema.userSessions)
    .set({ revokedAt: now })
    .where(and(cond, isNull(schema.userSessions.revokedAt)))
    .returning({ id: schema.userSessions.id });
  return updated.length > 0;
}

/**
 * 并发上限：超过 maxSessions 时吊销最旧（按 issued_at 升序）的多余会话。
 * 返回被吊销数量。
 */
export async function enforceSessionLimit(
  db: Database,
  login: string,
  maxSessions: number,
  now: Date = new Date(),
): Promise<number> {
  const active = await listUserSessions(db, login, now);
  if (active.length <= maxSessions) return 0;
  const excess = active.slice(maxSessions);
  let revoked = 0;
  for (const row of excess) {
    await revokeSessionById(db, row.id, login, now);
    revoked += 1;
  }
  return revoked;
}

/** 惰性清理：删除所有已过期或已撤销会话（周期调用）。 */
export async function pruneSessions(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(schema.userSessions)
    .where(
      or(
        lte(schema.userSessions.expiresAt, now),
        // 已显式撤销的会话也清理（保留期限由调用方通过 now 控制）。
        isNotNull(schema.userSessions.revokedAt),
      ),
    )
    .returning({ id: schema.userSessions.id });
  return deleted.length;
}
