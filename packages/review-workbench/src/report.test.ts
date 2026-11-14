import { describe, expect, it } from "vitest";
import type { ReportArtifact } from "./types.js";
import { makeHarness, sampleFinding, administrator } from "./test-fixture.js";

describe("可导出的审查报告", () => {
  it("格式来自随程序发布的formats目录，不接受路径或模块URL", async () => {
    const { call } = await makeHarness();
    expect(await call("reports.formats")).toEqual({
      formats: ["csv", "json", "markdown", "sarif"],
    });
    await expect(
      call("reports.render", { format: "../../index" }),
    ).rejects.toMatchObject({ code: "unsupported_format" });
    await expect(
      call("reports.render", { format: "https://evil.invalid/module" }),
    ).rejects.toMatchObject({ code: "unsupported_format" });
  });

  it("JSON报告包含真实发现与门禁，只包含已授权仓库", async () => {
    const { call } = await makeHarness();
    await call("findings.create", sampleFinding);
    await call(
      "findings.create",
      { ...sampleFinding, repository: "private/secret", title: "机密发现" },
      administrator,
    );
    const report = await call<ReportArtifact>("reports.render", {
      format: "json",
    });
    const data = JSON.parse(report.content) as {
      findings: unknown[];
      summary: { gate: { decision: string } };
    };
    expect(data.findings).toHaveLength(1);
    expect(data.summary.gate.decision).toBe("fail");
    expect(report.content).not.toContain("机密发现");
    expect(report.filename).toBe("acme-app-review.json");
  });

  it("CSV对公式、引号和换行进行安全编码", async () => {
    const { call } = await makeHarness();
    await call("findings.create", {
      ...sampleFinding,
      title: '=HYPERLINK("https://evil.invalid")',
      description: '第一行\n第二行,"引用"',
    });
    const report = await call<ReportArtifact>("reports.render", {
      format: "csv",
    });
    expect(report.content.startsWith("\uFEFF")).toBe(true);
    expect(report.content).toContain(
      '"\'=HYPERLINK(""https://evil.invalid"")"',
    );
    expect(report.content).toContain('第一行\n第二行,""引用""');
    expect(report.mimeType).toBe("text/csv; charset=utf-8");
  });

  it("Markdown将HTML和表格分隔符作为文字显示", async () => {
    const { call } = await makeHarness();
    await call("findings.create", {
      ...sampleFinding,
      title: "<script>alert(1)</script> | fake",
    });
    const report = await call<ReportArtifact>("reports.render", {
      format: "markdown",
    });
    expect(report.content).not.toContain("<script>");
    expect(report.content).toContain("&lt;script&gt;");
    expect(report.content).toContain("\\| fake");
    expect(report.content).toContain("## 门禁检查");
  });

  it("SARIF输出标准定位、稳定指纹、严重度和基线状态", async () => {
    const { call } = await makeHarness();
    await call("findings.create", {
      ...sampleFinding,
      path: "src/中文 file.ts",
      endLine: 45,
    });
    await call("baselines.create", {
      name: "主分支",
      reference: "main",
      active: true,
      fromCurrentFindings: true,
    });
    const report = await call<ReportArtifact>("reports.render", {
      format: "sarif",
    });
    const sarif = JSON.parse(report.content) as {
      version: string;
      runs: {
        results: {
          level: string;
          baselineState: string;
          partialFingerprints: Record<string, string>;
          locations: {
            physicalLocation: {
              artifactLocation: { uri: string };
              region: { startLine: number; endLine: number };
            };
          }[];
        }[];
      }[];
    };
    expect(sarif.version).toBe("2.1.0");
    const finding = sarif.runs[0]!.results[0]!;
    expect(finding).toMatchObject({
      level: "error",
      baselineState: "unchanged",
    });
    expect(finding.partialFingerprints["apertureprism/v1"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(finding.locations[0]?.physicalLocation).toMatchObject({
      artifactLocation: { uri: "src/%E4%B8%AD%E6%96%87%20file.ts" },
      region: { startLine: 42, endLine: 45 },
    });
  });

  it("空仓库报告也可解析且明确说明暂无审查发现", async () => {
    const { call } = await makeHarness();
    const markdown = await call<ReportArtifact>("reports.render", {
      format: "markdown",
    });
    expect(markdown.content).toContain("暂无发现记录");
    const json = await call<ReportArtifact>("reports.render", {
      format: "json",
    });
    expect(JSON.parse(json.content)).toMatchObject({
      findings: [],
      summary: { gate: { decision: "warn" } },
    });
  });
});
