import type { IncomingMessage } from "node:http";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  where: vi.fn(),
  limit: vi.fn(),
  isAdmin: vi.fn(),
  readOnly: vi.fn(),
  login: vi.fn(),
  canAccess: vi.fn(),
}));
vi.mock("./identity.js", () => ({
  isAdminRequest: mocks.isAdmin,
  isReadOnlyRequest: mocks.readOnly,
  sessionLogin: mocks.login,
  canAccessRepo: mocks.canAccess,
}));
vi.mock("./runtime.js", () => ({
  database: {
    db: {
      select: () => ({
        from: () => ({
          where: (query: unknown) => {
            mocks.where(query);
            return { limit: mocks.limit };
          },
        }),
      }),
    },
  },
  logger: { error: vi.fn() },
}));
import { workbenchActor } from "./workbench.js";
beforeEach(() => {
  mocks.isAdmin.mockReset().mockResolvedValue(false);
  mocks.readOnly.mockReset().mockResolvedValue(false);
  mocks.login.mockReset().mockReturnValue("member");
  mocks.canAccess.mockReset().mockResolvedValue(true);
  mocks.where.mockReset();
  mocks.limit
    .mockReset()
    .mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]);
});
describe("shared workbench and automation actor", () => {
  it("looks up canonical GitHub names using literal lowercase comparisons", async () => {
    const actor = await workbenchActor({} as IncomingMessage);
    expect(await actor.canAccessRepository("AperturePrism/My_Repo", true)).toBe(
      true,
    );
    const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0]![0]);
    expect(query.sql).toContain('lower("repositories"."owner")');
    expect(query.sql).toContain('lower("repositories"."name")');
    expect(query.params).toEqual(["apertureprism", "my_repo"]);
    expect(query.sql.toLowerCase()).not.toContain("ilike");
    expect(mocks.canAccess).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-0000-0000-000000000001",
      "manage",
    );
  });
  it("keeps read-only restrictions even beside repository management grants", async () => {
    mocks.readOnly.mockResolvedValue(true);
    const actor = await workbenchActor({} as IncomingMessage);
    expect(actor.isReadOnly).toBe(true);
    expect(await actor.canAccessRepository("owner/repo", true)).toBe(false);
    expect(mocks.where).not.toHaveBeenCalled();
  });
  it("uses the same session user id for approvals and workbench audit", async () => {
    const actor = await workbenchActor({} as IncomingMessage);
    expect(actor.userId).toBe("member");
  });
});
