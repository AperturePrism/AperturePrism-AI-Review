import { MAX_GLOBAL_REVIEW_RULES_CHARS } from "../../../packages/config/src/index.js";
import {
  ensureRepoRulesDir,
  EXAMPLE_RULES_FILE,
  fetchRepoRules,
  type GitHubClient,
  type RepoRulesOptions,
} from "../../../packages/github-adapter/src/index.js";
import type { IssueContext } from "../../../packages/issue-analysis/src/index.js";
import type { createLogger } from "../../../packages/observability/src/index.js";
import type { PrReviewContext } from "../../../packages/pr-review/src/index.js";

export interface ReviewRulesServices {
  loadGlobalRules: () => Promise<string | undefined>;
  repoRulesEnabled: (repositoryFullName: string) => Promise<boolean>;
  fetchExternalRules: (
    repositoryFullName: string,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  logger: Pick<ReturnType<typeof createLogger>, "warn">;
}

/** Global rules are independent of the repository directory/URL switch.
 * Each optional source fails open without discarding the other sources. */
export function createReviewRulesLoader(services: ReviewRulesServices) {
  return async function loadReviewRules(
    github: GitHubClient | undefined,
    repositoryFullName: string,
    repository: RepoRulesOptions,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    let globalRules: string | undefined;
    try {
      // Bound legacy/manual DB writes too, not only validated settings API writes.
      const raw = await services.loadGlobalRules();
      const bounded = raw?.slice(0, MAX_GLOBAL_REVIEW_RULES_CHARS);
      if (bounded?.trim()) globalRules = bounded;
    } catch (error) {
      services.logger.warn(
        { err: error, repo: repositoryFullName },
        "global review rules read failed; skipping",
      );
    }

    const sections: string[] = globalRules
      ? [`## 全局审核规则（适用于所有仓库，与仓库规则叠加）\n${globalRules}`]
      : [];
    const enabled = await services
      .repoRulesEnabled(repositoryFullName)
      .catch(() => true);
    if (!enabled)
      return sections.length > 0 ? sections.join("\n\n") : undefined;

    let localRules: string | undefined;
    if (github) {
      try {
        localRules = await fetchRepoRules(github, repository, signal);
      } catch (error) {
        services.logger.warn(
          { err: error, repo: repositoryFullName },
          "repository review rules read failed; skipping",
        );
      }
    }
    if (localRules?.trim()) sections.push(localRules);

    try {
      const externalRules = await services.fetchExternalRules(
        repositoryFullName,
        signal,
      );
      if (externalRules?.trim()) {
        sections.push(
          `## 外部链接审核规则（repo_rules_url 抓取，与目录规则同等效力）\n${externalRules}`,
        );
      }
    } catch (error) {
      services.logger.warn(
        { err: error, repo: repositoryFullName },
        "external review rules read failed; skipping",
      );
    }

    if (github && localRules === undefined) {
      // Preserve first-analysis example seeding; failure never suppresses rules.
      try {
        if (await ensureRepoRulesDir(github, repository, signal)) {
          services.logger.warn(
            { repo: repositoryFullName, file: EXAMPLE_RULES_FILE },
            "seeded example review rules on first analysis",
          );
        }
      } catch {
        services.logger.warn(
          { repo: repositoryFullName },
          "seed rules directory skipped",
        );
      }
    }
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  };
}

export function withIssueReviewRules(
  context: IssueContext,
  repoRules: string | undefined,
): IssueContext {
  return repoRules ? { ...context, repoRules } : context;
}

/** Both the standard reviewer and expert team consume `rendered`. */
export function withPrReviewRules(
  context: PrReviewContext,
  repoRules: string | undefined,
): PrReviewContext {
  return repoRules
    ? { ...context, repoRules, rendered: { ...context.rendered, repoRules } }
    : context;
}
