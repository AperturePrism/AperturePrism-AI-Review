import { describe, expect, it } from "vitest";
import { parseFindingImport } from "../lib/finding-import";
function sarif(results: unknown[], run: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Review",
            rules: [{ id: "AUTH", properties: { "security-severity": "9.2" } }],
          },
        },
        results,
        ...run,
      },
    ],
  });
}
function result(input: Record<string, unknown> = {}) {
  return {
    ruleId: "AUTH",
    level: "warning",
    message: { text: "缺少权限检查\n非管理员可更新账号" },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: "src/auth.ts" },
          region: { startLine: 12, endLine: 15 },
        },
      },
    ],
    ...input,
  };
}
describe("SARIF 导入边界", () => {
  it("保留位置、标题、说明、来源与引用", () => {
    const preview = parseFindingImport(sarif([result()]), "sarif", " main ");
    expect(preview.findings).toEqual([
      {
        title: "缺少权限检查",
        description: "缺少权限检查\n非管理员可更新账号",
        ruleId: "AUTH",
        path: "src/auth.ts",
        line: 12,
        endLine: 15,
        severity: "medium",
        confidence: 1,
        source: "Review",
        reference: "main",
        tags: ["sarif-import"],
      },
    ]);
  });
  it("通过 ruleIndex 获取规则 ID 与安全级别", () => {
    const preview = parseFindingImport(
      sarif([result({ ruleId: undefined, ruleIndex: 0 })]),
      "sarif",
    );
    expect(preview.findings[0]).toMatchObject({
      ruleId: "AUTH",
      severity: "critical",
    });
  });
  it("AperturePrism 导出可保留原始精度和稳定指纹", () => {
    const preview = parseFindingImport(
      sarif([
        result({
          properties: {
            severity: "low",
            confidence: 0.83,
            reference: "commit",
          },
          partialFingerprints: { "apertureprism/v1": "stable-fingerprint" },
        }),
      ]),
      "sarif",
    );
    expect(preview.findings[0]).toMatchObject({
      severity: "low",
      confidence: 0.83,
      reference: "commit",
      fingerprint: "stable-fingerprint",
    });
  });
  it("不同工具指纹不冒充本工作台稳定指纹", () => {
    const preview = parseFindingImport(
      sarif([
        result({
          partialFingerprints: { primaryLocationLineHash: "different-tool" },
        }),
      ]),
      "sarif",
    );
    expect(preview.findings[0]).not.toHaveProperty("fingerprint");
  });
  it("位置可以引用 run artifacts 索引", () => {
    const content = sarif(
      [
        result({
          locations: [
            {
              physicalLocation: {
                artifactLocation: { index: 0 },
                region: { startLine: 4 },
              },
            },
          ],
        }),
      ],
      { artifacts: [{ location: { uri: "src/a%20b.ts" } }] },
    );
    expect(parseFindingImport(content, "sarif").findings[0]).toMatchObject({
      path: "src/a b.ts",
      line: 4,
      endLine: 4,
    });
  });
  it("位置缺失只列入跳过提示，不能伪造文件位置", () => {
    const preview = parseFindingImport(
      sarif([result(), result({ locations: [] })]),
      "sarif",
    );
    expect(preview.findings).toHaveLength(1);
    expect(preview.skipped).toBe(1);
    expect(preview.warnings[0]).toContain("没有文件位置");
  });
  it("外部抑制不会自动变成本仓库批准的抑制规则", () => {
    const preview = parseFindingImport(
      sarif([
        result({ suppressions: [{ kind: "external", status: "accepted" }] }),
      ]),
      "sarif",
    );
    expect(preview.findings).toHaveLength(1);
    expect(preview.findings[0]).not.toHaveProperty("status");
    expect(preview.warnings[0]).toContain("不会自动转为");
  });
  it("拒绝绝对路径、URL、路径穿越、控制符和编码穿越", () => {
    for (const path of [
      "/etc/passwd",
      "file:///etc/passwd",
      "C:\\private\\token",
      "../secret",
      "src/../../secret",
      "src/%2e%2e/secret",
      "src/%00token",
      "http://example/a",
    ]) {
      const content = sarif([
        result({
          locations: [
            { physicalLocation: { artifactLocation: { uri: path } } },
          ],
        }),
      ]);
      expect(() => parseFindingImport(content, "sarif"), path).toThrow(
        "相对文件路径",
      );
    }
  });
  it("拒绝负行号、倒置范围和超出概率范围的置信度", () => {
    expect(() =>
      parseFindingImport(
        sarif([
          result({
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "a.ts" },
                  region: { startLine: -1 },
                },
              },
            ],
          }),
        ]),
        "sarif",
      ),
    ).toThrow("正整数");
    expect(() =>
      parseFindingImport(
        sarif([
          result({
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "a.ts" },
                  region: { startLine: 4, endLine: 2 },
                },
              },
            ],
          }),
        ]),
        "sarif",
      ),
    ).toThrow("结束行");
    expect(() =>
      parseFindingImport(
        sarif([result({ properties: { confidence: 1.5 } })]),
        "sarif",
      ),
    ).toThrow("置信度");
  });
  it("同指纹或同规则路径标题的重复结果只导入一次", () => {
    const preview = parseFindingImport(
      sarif([result(), result(), result({ message: { text: "另一个问题" } })]),
      "sarif",
    );
    expect(preview.findings).toHaveLength(2);
    expect(preview.skipped).toBe(1);
  });
  it("拒绝不受支持的版本和畸形 JSON", () => {
    expect(() =>
      parseFindingImport('{"version":"1.0","runs":[]}', "sarif"),
    ).toThrow("2.1.0");
    expect(() => parseFindingImport("{", "sarif")).toThrow("合法 JSON");
    expect(() => parseFindingImport("null", "sarif")).toThrow("对象");
  });
});
describe("工作台 JSON 导入", () => {
  const finding = {
    title: "测试发现",
    ruleId: "R1",
    path: "src/a.ts",
    line: 1,
    severity: "high",
    confidence: 0.8,
  };
  it("支持对象数组和报告对象中的 findings", () => {
    const array = parseFindingImport(JSON.stringify([finding]), "json");
    const object = parseFindingImport(
      JSON.stringify({ findings: [finding] }),
      "json",
    );
    expect(array).toEqual(object);
    expect(array.findings[0]).toMatchObject({
      ...finding,
      description: "",
      endLine: 1,
      source: "json-import",
      reference: "",
      tags: [],
    });
  });
  it("输入完成后一次验证，不留下半份预览", () => {
    expect(() =>
      parseFindingImport(
        JSON.stringify([finding, { ...finding, path: "../secret" }]),
        "json",
      ),
    ).toThrow();
    expect(() =>
      parseFindingImport(JSON.stringify([{ ...finding, title: " " }]), "json"),
    ).toThrow("title");
    expect(() =>
      parseFindingImport(
        JSON.stringify([{ ...finding, severity: "invented" }]),
        "json",
      ),
    ).toThrow("级别");
  });
  it("拒绝超过二兆字节的导入文本", () => {
    expect(() =>
      parseFindingImport(" ".repeat(2 * 1024 * 1024 + 1), "json"),
    ).toThrow("2 MiB");
  });
});
