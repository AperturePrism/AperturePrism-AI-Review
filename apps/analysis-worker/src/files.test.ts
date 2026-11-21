import { describe, expect, it, vi } from "vitest";
import type { IssueContext } from "../../../packages/issue-analysis/src/index.js";
import { preloadTargetFiles } from "./files.js";

vi.mock("./runtime.js", () => ({ logger: { warn: vi.fn() } }));

const source = "apps/web/src/theme.tsx";
const code = "export const theme = 'light';";
const context = (body: string): IssueContext => ({
  repository: { owner: "owner", name: "repo" },
  installationId: "42",
  issue: {
    number: 7,
    title: "增加功能",
    body,
    state: "open",
    author: null,
    htmlUrl: "",
    createdAt: "",
    updatedAt: "",
    labels: ["enhancement"],
  },
  comments: [],
  images: [],
  degraded: [],
  estimatedTokens: 10,
});

const entry = (path: string, type: "dir" | "file") => ({
  name: path.split("/").at(-1) ?? path,
  path,
  type,
});

function repository(files: Record<string, string | null>) {
  const listings = new Map([
    ["", [entry("apps", "dir"), entry("node_modules", "dir")]],
    ["apps", [entry("apps/web", "dir")]],
    ["apps/web", [entry("apps/web/src", "dir")]],
    ["apps/web/src", Object.keys(files).map((path) => entry(path, "file"))],
  ]);
  return {
    listDirectory: vi.fn(
      async ({ path }: { path: string }) => listings.get(path) ?? [],
    ),
    getFileContents: vi.fn(async ({ path }: { path: string }) => {
      const content = files[path];
      return content == null ? null : { content };
    }),
  };
}

describe("preloadTargetFiles", () => {
  it("reads an explicitly named TSX file rather than a truncated .ts path", async () => {
    const reader = repository({ [source]: code });
    await expect(
      preloadTargetFiles(reader, context(`请改 ${source}`), new AbortController().signal),
    ).resolves.toEqual([{ path: source, content: code }]);
    expect(reader.getFileContents).toHaveBeenCalledOnce();
    expect(reader.getFileContents.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ path: source }),
    );
    expect(reader.listDirectory).not.toHaveBeenCalled();
  });

  it("falls back from a missing path and an empty ranked result to a nested source pick", async () => {
    const ranked = "apps/web/src/toggle.ts";
    const reader = repository({ [ranked]: "  \n", [source]: code });
    const picker = vi.fn(async () => ["not-in-inventory.ts", source, source]);
    await expect(
      preloadTargetFiles(
        reader,
        context("希望增加 toggle；参考旧版本 old.ts"),
        new AbortController().signal,
        picker,
      ),
    ).resolves.toEqual([{ path: source, content: code }]);
    expect(reader.listDirectory.mock.calls.map(([args]) => args.path)).toEqual([
      "",
      "apps",
      "apps/web",
      "apps/web/src",
    ]);
    expect(picker).toHaveBeenCalledExactlyOnceWith(
      [source],
      expect.anything(),
      expect.anything(),
    );
    expect(
      reader.getFileContents.mock.calls.map(([args]) => args.path),
    ).toEqual(["old.ts", ranked, source]);
  });

  it("offers nested source for a feature with no path keywords without guessing a file", async () => {
    const reader = repository({ [source]: code });
    const picker = vi.fn(async () => []);
    await expect(
      preloadTargetFiles(
        reader,
        context("希望支持切换外观"),
        new AbortController().signal,
        picker,
      ),
    ).resolves.toEqual([]);
    expect(picker).toHaveBeenCalledExactlyOnceWith(
      [source],
      expect.anything(),
      expect.anything(),
    );
    expect(reader.getFileContents).not.toHaveBeenCalled();
  });

  it("caps both queued directory visits and candidate files", async () => {
    const reader = {
      getFileContents: vi.fn(async () => null),
      listDirectory: vi.fn(async ({ path }: { path: string }) => {
        if (!path)
          return Array.from({ length: 450 }, (_, i) =>
            entry(`module-${i}`, "dir"),
          );
        if (path !== "module-398") return [];
        return Array.from({ length: 250 }, (_, i) =>
          entry(`${path}/${i}.ts`, "file"),
        );
      }),
    };
    const picker = vi.fn(async () => []);
    await preloadTargetFiles(
      reader,
      context("希望支持切换外观"),
      new AbortController().signal,
      picker,
    );
    expect(reader.listDirectory).toHaveBeenCalledTimes(400);
    expect(picker.mock.calls[0]?.[0]).toHaveLength(200);
  });
});
