import type { IssueSignals } from "./types.js";
import { cjkNgrams } from "./normalize.js";

/**
 * A minimal SQL executor so this module avoids coupling to a specific driver.
 * Wraps a `postgres` `sql` tag: `sql<string[]>` where the tag is called with a
 * template literal and bound params.
 */
export type SqlTag = (
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<Record<string, unknown>[]>;

export type RecallCandidateRow = {
  id: string;
  repositoryId: string | null;
  issueNumber: number;
  ftsRank: number;
  signalRank: number;
};

export type RecallInput = {
  sql: SqlTag;
  /** Canonical (normalized) lead title used for full-text candidates. */
  leadTitle: string;
  leadBody: string;
  leadSignals: IssueSignals;
  topK: number;
};

/**
 * Persists a normalized issue document for later full-text / signal recall.
 * Upserts on (repositoryId, issueNumber). An optional 1024-d embedding is
 * stored for vector recall; pass null/omit to leave (or clear) it. `contentHash`
 * is a fingerprint of the normalized text+signals so an index worker can skip
 * re-embedding documents whose content has not changed.
 */
export async function indexIssueDocument(
  sql: SqlTag,
  input: {
    repositoryId: string | null;
    issueNumber: number;
    title: string;
    body: string;
    signals: IssueSignals;
    embedding?: number[] | undefined;
    contentHash?: string | null;
  },
): Promise<void> {
  const vec =
    input.embedding === undefined || input.embedding.length === 0
      ? null
      : `[${input.embedding.join(",")}]`;

  if (vec === null) {
    // Preserve any existing embedding when reindexing without a new vector.
    await sql`
      insert into issue_documents
        (repository_id, issue_number, title, body, versions, error_codes, paths, languages, has_stack_trace, has_reproduction, content_hash)
      values
        (${input.repositoryId}, ${input.issueNumber}, ${input.title}, ${input.body},
         ${input.signals.versions}, ${input.signals.errorCodes}, ${input.signals.paths}, ${input.signals.languages},
         ${input.signals.hasStackTrace}, ${input.signals.hasReproduction},
         ${input.contentHash ?? null})
      on conflict (repository_id, issue_number)
      do update set
        title = excluded.title, body = excluded.body,
        versions = excluded.versions, error_codes = excluded.error_codes,
        paths = excluded.paths, languages = excluded.languages,
        has_stack_trace = excluded.has_stack_trace, has_reproduction = excluded.has_reproduction,
        content_hash = excluded.content_hash,
        updated_at = now()`;
    return;
  }

  await sql`
    insert into issue_documents
      (repository_id, issue_number, title, body, versions, error_codes, paths, languages, has_stack_trace, has_reproduction, embedding, content_hash)
    values
      (${input.repositoryId}, ${input.issueNumber}, ${input.title}, ${input.body},
       ${input.signals.versions}, ${input.signals.errorCodes}, ${input.signals.paths}, ${input.signals.languages},
       ${input.signals.hasStackTrace}, ${input.signals.hasReproduction},
       ${vec}::vector, ${input.contentHash ?? null})
    on conflict (repository_id, issue_number)
    do update set
      title = excluded.title, body = excluded.body,
      versions = excluded.versions, error_codes = excluded.error_codes,
      paths = excluded.paths, languages = excluded.languages,
      has_stack_trace = excluded.has_stack_trace, has_reproduction = excluded.has_reproduction,
      embedding = excluded.embedding,
      content_hash = excluded.content_hash,
      updated_at = now()`;
}

/**
 * Returns the stored content hash and embedding presence for a document so an
 * index worker can decide whether re-embedding is necessary. `null` when no
 * document is indexed yet.
 */
export async function getDocumentHash(
  sql: SqlTag,
  input: { repositoryId: string | null; issueNumber: number },
): Promise<{ contentHash: string | null; hasEmbedding: boolean } | null> {
  const rows = await sql`
    select content_hash as "contentHash", (embedding is not null) as "hasEmbedding"
    from issue_documents
    where issue_number = ${input.issueNumber}
      and (repository_id = ${input.repositoryId}::uuid
           or (${input.repositoryId}::uuid is null and repository_id is null))
    limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    contentHash: row.contentHash === null ? null : String(row.contentHash),
    hasEmbedding: Boolean(row.hasEmbedding),
  };
}

/**
 * 上一次索引到的归一化正文（`body` 列存的就是 `normalizedIndexText` 的结果）。
 * 供「编辑后是否值得重新分析」判定使用：拿它与当前正文比较变化幅度。
 *
 * 取 `updated_at` 而非 `indexed_at`：upsert 只刷新前者，后者停留在首次入库
 * 时间，用它判断「快照是否早于本次编辑」会把旧快照误判成新的。
 */
export async function getIndexedIssueText(
  sql: SqlTag,
  input: { repositoryId: string | null; issueNumber: number },
): Promise<{ text: string; updatedAt: Date } | null> {
  const rows = await sql`
    select body as "text", updated_at as "updatedAt"
    from issue_documents
    where issue_number = ${input.issueNumber}
      and (repository_id = ${input.repositoryId}::uuid
           or (${input.repositoryId}::uuid is null and repository_id is null))
    limit 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    text: String(row.text ?? ""),
    updatedAt: new Date(String(row.updatedAt)),
  };
}

/** Empties the index (used by the rebuild operation). */
export async function clearIssueDocuments(sql: SqlTag): Promise<void> {
  await sql`delete from issue_documents`;
}

/**
 * Recalls candidate issues by full text (tsvector @@ websearch_to_tsquery) and
 * by strong-signal overlap (error codes and module paths). Candidates are
 * ranked by full-text rank capped by the number of shared strong signals; the
 * caller still passes them through the evidence/decision layer — recall never
 * decides a duplicate.
 */
export async function recallCandidates(
  input: RecallInput,
): Promise<RecallCandidateRow[]> {
  const { sql, leadTitle, leadBody, leadSignals, topK } = input;
  const leadText = `${leadTitle} ${leadBody}`.trim();
  const rows = await sql`
    select d.id, d.repository_id::text as "repositoryId", d.issue_number as "issueNumber",
      ts_rank(to_tsvector('simple', d.body || ' ' || d.title), websearch_to_tsquery('simple', ${leadText})) as "ftsRank",
      array_length(array_cat(
        (select array_agg(x) from unnest(d.error_codes) x where x = any(${leadSignals.errorCodes})),
        (select array_agg(x) from unnest(d.paths) x where x = any(${leadSignals.paths}))
      ), 1) as "signalRank"
    from issue_documents d
    where to_tsvector('simple', d.body || ' ' || d.title) @@ websearch_to_tsquery('simple', ${leadText})
       or d.error_codes && ${leadSignals.errorCodes}
       or d.paths && ${leadSignals.paths}
    order by "ftsRank" desc
    limit ${topK}`;
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    repositoryId: row.repositoryId === null ? null : String(row.repositoryId),
    issueNumber: Number(row.issueNumber ?? 0),
    ftsRank: Number(row.ftsRank ?? 0),
    signalRank: row.signalRank === null ? 0 : Number(row.signalRank),
  }));
}

export type VectorRecallRow = {
  id: string;
  repositoryId: string | null;
  issueNumber: number;
  /** Cosine distance (0 = identical); lower is more similar. */
  distance: number;
};

/**
 * Recalls candidates by embedding similarity using exact cosine distance
 * (`<=>`). pgvector indexes (hnsw/ivfflat) are capped at 2000 dimensions, so
 * the 1024-d vector is not indexed; an exact sequential scan is
 * used instead, which is fine at typical issue-corpus sizes. Like full-text
 * recall, this only proposes candidates — it never decides a duplicate.
 */
export async function recallCandidatesByVector(input: {
  sql: SqlTag;
  embedding: number[];
  topK: number;
}): Promise<VectorRecallRow[]> {
  const vec = `[${input.embedding.join(",")}]`;
  const rows = await input.sql`
    select d.id, d.issue_number as "issueNumber", d.repository_id::text as "repositoryId",
      (d.embedding <=> ${vec}::vector) as distance
    from issue_documents d
    where d.embedding is not null
    order by distance asc
    limit ${input.topK}`;
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    repositoryId: row.repositoryId === null ? null : String(row.repositoryId),
    issueNumber: Number(row.issueNumber ?? 0),
    distance: Number(row.distance ?? 1),
  }));
}

export type RelatedIssueRow = {
  id: string;
  repositoryId: string | null;
  repositoryFullName: string | null;
  issueNumber: number;
  /** Combined recall score: full-text rank (0..1) plus signal hits. */
  score: number;
  reasons: readonly ("text" | "signal")[];
  /** 索引时的标题/正文，供下游裁决（如 judge 模型）使用，不参与排序。 */
  title: string;
  body: string;
};

/**
 * Read-only RAG recall used by the analysis flow and the /index/related API:
 * full-text + strong-signal candidates joined to repository full names. Only
 * proposes candidates; it never decides a duplicate. Returns an empty array
 * when the index is unavailable (callers degrade gracefully).
 *
 * `repository` optionally restricts recall to a single repository (by
 * owner/name) so analysis never surfaces "related" issues from other projects.
 *
 * `excludeIssueNumber` drops the issue being analyzed from its own results: the
 * analyzed issue is indexed before recall runs, so without this it always
 * recalls itself as the top "related" match. Callers pass `repository` too, so
 * matching on the number alone is enough to identify it.
 */
export async function recallCandidatesWithRepos(
  sql: SqlTag,
  input: {
    title: string;
    body: string;
    signals: IssueSignals;
    topK?: number;
    repository?: { owner: string; name: string } | null;
    excludeIssueNumber?: number | null;
  },
): Promise<RelatedIssueRow[]> {
  const topK = input.topK ?? 5;
  const leadText = `${input.title} ${input.body}`.trim();
  // CJK n-grams from the lead text. `simple` FTS tokenizes a whole Chinese run
  // as one token, and the previous `ilike '%title%'` fallback required one title
  // to literally contain the other — verified on the live database that
  // 「一直连接失败」and「连接bug 仪表盘一直显示连接中断」matched by neither,
  // which is why issues #8 and #9 never recalled each other.
  const grams = cjkNgrams(leadText);
  const gramPattern = grams.length > 0 ? `(${grams.join("|")})` : null;
  const rows = await sql`
    select d.id, d.repository_id::text as "repositoryId",
      r.owner || '/' || r.name as "repositoryFullName",
      d.issue_number as "issueNumber",
      d.title as "title",
      d.body as "body",
      ts_rank(to_tsvector('simple', d.body || ' ' || d.title), websearch_to_tsquery('simple', ${leadText})) as "ftsRank",
      array_length(array_cat(
        (select array_agg(x) from unnest(d.error_codes) x where x = any(${input.signals.errorCodes})),
        (select array_agg(x) from unnest(d.paths) x where x = any(${input.signals.paths}))
      ), 1) as "signalRank",
      ${
        gramPattern === null
          ? sql`0`
          : sql`(select count(*) from regexp_matches(d.title || ' ' || d.body, ${gramPattern}, 'g'))`
      } as "gramRank"
    from issue_documents d
    left join repositories r on r.id = d.repository_id
    where (to_tsvector('simple', d.body || ' ' || d.title) @@ websearch_to_tsquery('simple', ${leadText})
       or d.error_codes && ${input.signals.errorCodes}
       or d.paths && ${input.signals.paths}
       ${
         gramPattern === null
           ? sql``
           : sql`or (d.title || ' ' || d.body) ~ ${gramPattern}`
       })
       ${input.repository ? sql`and r.owner = ${input.repository.owner} and r.name = ${input.repository.name}` : sql``}
       ${
         input.excludeIssueNumber === undefined ||
         input.excludeIssueNumber === null
           ? sql``
           : sql`and d.issue_number <> ${input.excludeIssueNumber}`
       }
    order by "ftsRank" desc, "signalRank" desc, "gramRank" desc
    limit ${topK}`;
  return rows.map((row) => {
    const ftsRank = Number(row.ftsRank ?? 0);
    const signalRank = row.signalRank === null ? 0 : Number(row.signalRank);
    const gramRank = row.gramRank === null ? 0 : Number(row.gramRank);
    const reasons: ("text" | "signal")[] = [];
    // n-gram 命中属于文本证据，和全文命中同一类。
    if (ftsRank > 0 || gramRank > 0) reasons.push("text");
    if (signalRank > 0) reasons.push("signal");
    return {
      id: String(row.id ?? ""),
      repositoryId: row.repositoryId === null ? null : String(row.repositoryId),
      repositoryFullName:
        row.repositoryFullName === null ? null : String(row.repositoryFullName),
      issueNumber: Number(row.issueNumber ?? 0),
      // n-gram 权重最低：它只是召回信号，判定重复仍由证据比较和模型完成。
      score:
        Math.round((ftsRank * 100 + signalRank * 10 + gramRank) * 100) / 100,
      reasons,
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
    };
  });
}
