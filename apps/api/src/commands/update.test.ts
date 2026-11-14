import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../update.js", () => ({
  handleUpdateStatus: vi.fn(),
  handleUpdateHistory: vi.fn(),
  handleUpdateApply: vi.fn(),
}));
vi.mock("../runtime.js", () => ({ database: { db: {} } }));
vi.mock("../identity.js", () => ({ audit: vi.fn() }));

import { audit } from "../identity.js";
import { database } from "../runtime.js";
import {
  handleUpdateApply,
  handleUpdateHistory,
  handleUpdateStatus,
} from "../update.js";
import { dispatch } from "../utils/routes.js";
import { routes } from "./update.js";

function request(path: string, method = "GET"): IncomingMessage {
  return { url: path, method } as IncomingMessage;
}

function response(): ServerResponse {
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

beforeEach(() => vi.clearAllMocks());

describe("modular update routes preserve runtime confirmation", () => {
  it("passes the database to status so pending updates survive API restarts", async () => {
    const output = response();
    await dispatch(routes, request("/update/status"), output, "request-1", {
      isAdmin: async () => false,
    });
    expect(handleUpdateStatus).toHaveBeenCalledExactlyOnceWith(
      output,
      "request-1",
      database.db,
    );
  });

  it("passes the database to administrator history reconciliation", async () => {
    const output = response();
    await dispatch(routes, request("/update/history"), output, "request-2", {
      isAdmin: async () => true,
    });
    expect(handleUpdateHistory).toHaveBeenCalledExactlyOnceWith(
      output,
      "request-2",
      database.db,
    );
  });

  it.each([
    ["/update/history", "GET"],
    ["/update/apply", "POST"],
  ])("keeps %s restricted to administrators", async (path, method) => {
    const output = response();
    await dispatch(routes, request(path, method), output, "request-3", {
      isAdmin: async () => false,
    });
    expect(output.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(handleUpdateHistory).not.toHaveBeenCalled();
    expect(handleUpdateApply).not.toHaveBeenCalled();
  });

  it("keeps the database and audit callback on administrator apply", async () => {
    const input = request("/update/apply", "POST");
    const output = response();
    vi.mocked(handleUpdateApply).mockImplementationOnce(
      async (_request, _response, _id, _isAdmin, _db, onAudit) => {
        onAudit?.({ target: "v1.2.18", backupBefore: true });
      },
    );
    await dispatch(routes, input, output, "request-4", {
      isAdmin: async () => true,
    });
    expect(handleUpdateApply).toHaveBeenCalledExactlyOnceWith(
      input,
      output,
      "request-4",
      true,
      database.db,
      expect.any(Function),
    );
    expect(audit).toHaveBeenCalledExactlyOnceWith(
      input,
      "update.apply",
      undefined,
      { target: "v1.2.18", backupBefore: true },
    );
  });

  it("does not invoke the updater for an unsupported method", async () => {
    const output = response();
    await dispatch(
      routes,
      request("/update/apply", "GET"),
      output,
      "request-5",
      {
        isAdmin: async () => true,
      },
    );
    expect(output.writeHead).toHaveBeenCalledWith(405, expect.anything());
    expect(handleUpdateApply).not.toHaveBeenCalled();
  });
});
