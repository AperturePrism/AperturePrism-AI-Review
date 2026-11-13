import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import {
  findValidSession,
  listUserSessions,
  pruneSessions,
} from "./sessions.js";
import * as schema from "./schema.js";

const now = new Date("2026-11-13T12:00:00.000Z");

function sessionDatabase(rows: unknown[][]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const proxy = drizzle(
    async (sql, params) => {
      queries.push({ sql: sql.replace(/\s+/g, " "), params });
      return { rows };
    },
    { schema },
  );
  return {
    db: proxy as unknown as Parameters<typeof findValidSession>[0],
    queries,
  };
}

function sessionRow(expiresAt: Date, revokedAt: Date | null = null) {
  return [
    "session-1",
    "alice",
    "local",
    "2026-11-12T12:00:00.000Z",
    expiresAt.toISOString(),
    "2026-11-13T11:59:59.000Z",
    revokedAt?.toISOString() ?? null,
    null,
    null,
  ];
}

describe("session expiration boundary", () => {
  it.each([-1, 0])(
    "rejects a token expiring %s milliseconds from now",
    async (delta) => {
      const { db } = sessionDatabase([
        sessionRow(new Date(now.getTime() + delta)),
      ]);
      expect(await findValidSession(db, "token", now)).toBeNull();
    },
  );

  it("still accepts a token strictly before its expiration", async () => {
    const { db } = sessionDatabase([sessionRow(new Date(now.getTime() + 1))]);
    expect((await findValidSession(db, "token", now))?.id).toBe("session-1");
  });

  it("keeps missing and revoked tokens invalid", async () => {
    expect(
      await findValidSession(sessionDatabase([]).db, "missing", now),
    ).toBeNull();
    const { db } = sessionDatabase([
      sessionRow(new Date(now.getTime() + 1), now),
    ]);
    expect(await findValidSession(db, "revoked", now)).toBeNull();
  });

  it("cleans up at the same exclusive boundary used by the active list", async () => {
    const { db, queries } = sessionDatabase([]);
    expect(await pruneSessions(db, now)).toBe(0);
    await listUserSessions(db, "alice", now);
    expect(queries[0]!.sql).toContain('"user_sessions"."expires_at" <= $1');
    expect(queries[0]!.params).toEqual([now.toISOString()]);
    expect(queries[1]!.sql).toContain('"user_sessions"."expires_at" >');
  });
});
