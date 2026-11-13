import { describe, expect, it } from "vitest";
import {
  batchTaskKey,
  parseBatchRequest,
  stableTaskJson,
  type BatchRequest,
} from "./batch.js";

const request: BatchRequest = {
  key: "release-1",
  label: "版本审查",
  items: [
    {
      key: "pr-1",
      task: {
        taskType: "pr_review",
        subjectNumber: 1,
        subjectRevision: "rev-1",
        policyVersion: "v1",
        payload: { repository: "owner/repo", number: 1 },
      },
    },
    {
      key: "pr-2",
      task: {
        taskType: "pr_review",
        subjectNumber: 2,
        subjectRevision: "rev-2",
        policyVersion: "v1",
        payload: { repository: "owner/repo", number: 2 },
      },
    },
  ],
};

describe("batch identity and input", () => {
  it("creates stable task keys and isolates batch/item delimiter characters", () => {
    expect(batchTaskKey("release", "pr-1")).toBe(
      batchTaskKey(" release ", " pr-1 "),
    );
    expect(batchTaskKey("a:b", "c")).not.toBe(batchTaskKey("a", "b:c"));
    expect(batchTaskKey("release", "pr-1")).toMatch(
      /^batch:[0-9a-f]{64}:[0-9a-f]{64}$/,
    );
  });
  it("treats equivalent JSON objects and item orders as one request", () => {
    const original = parseBatchRequest(request);
    const reordered = parseBatchRequest({
      ...request,
      items: [...request.items]
        .reverse()
        .map((item) => ({
          ...item,
          task: {
            ...item.task,
            payload: {
              number: item.task.subjectNumber,
              repository: "owner/repo",
            },
          },
        })),
    });
    expect(original.requestHash).toBe(reordered.requestHash);
  });
  it("detects changed content under the same business key", () => {
    const changed = parseBatchRequest({
      ...request,
      items: request.items.map((item) => ({
        ...item,
        task: { ...item.task, policyVersion: "v2" },
      })),
    });
    expect(changed.requestHash).not.toBe(
      parseBatchRequest(request).requestHash,
    );
  });
  it("normalizes human entered key, label and revision", () => {
    const result = parseBatchRequest({
      key: " release ",
      label: " label ",
      items: [
        {
          key: " item ",
          task: {
            ...request.items[0]!.task,
            subjectRevision: " rev ",
            policyVersion: " policy ",
          },
        },
      ],
    });
    expect(result).toMatchObject({
      key: "release",
      label: "label",
      items: [
        {
          key: "item",
          task: { subjectRevision: "rev", policyVersion: "policy" },
        },
      ],
    });
  });
  it("rejects duplicate normalized item keys before creating any task", () => {
    expect(() =>
      parseBatchRequest({
        ...request,
        items: [request.items[0]!, { ...request.items[1]!, key: " pr-1 " }],
      }),
    ).toThrow("duplicate batch item key");
  });
  it.each([
    { ...request, key: " " },
    { ...request, items: [] },
    { ...request, label: "x".repeat(201) },
    { ...request, now: new Date("bad") },
    {
      ...request,
      items: [
        {
          ...request.items[0]!,
          task: { ...request.items[0]!.task, subjectNumber: 0 },
        },
      ],
    },
    {
      ...request,
      items: [
        {
          ...request.items[0]!,
          task: { ...request.items[0]!.task, maxAttempts: 101 },
        },
      ],
    },
    {
      ...request,
      items: [
        {
          ...request.items[0]!,
          task: { ...request.items[0]!.task, priority: 2_147_483_648 },
        },
      ],
    },
    {
      ...request,
      items: [
        {
          ...request.items[0]!,
          task: { ...request.items[0]!.task, policyVersion: " " },
        },
      ],
    },
  ])("rejects invalid batch boundary %o", (input) => {
    expect(() => parseBatchRequest(input)).toThrow();
  });
});

describe("stable task JSON", () => {
  it("sorts nested keys and retains array order", () => {
    expect(stableTaskJson({ z: { b: 2, a: 1 }, a: [3, 2, 1] })).toBe(
      '{"a":[3,2,1],"z":{"a":1,"b":2}}',
    );
  });
  it("accepts shared object references without mistaking them for cycles", () => {
    const shared = { value: 1 };
    expect(stableTaskJson({ a: shared, b: shared })).toBe(
      '{"a":{"value":1},"b":{"value":1}}',
    );
  });
  it("rejects actual cycles and non JSON values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableTaskJson(cyclic)).toThrow("cycles");
    for (const value of [
      undefined,
      () => 1,
      new Date(),
      NaN,
      Infinity,
      BigInt(1),
    ])
      expect(() => stableTaskJson(value)).toThrow();
  });
});
