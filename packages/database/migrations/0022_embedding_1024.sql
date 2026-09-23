-- 嵌入模型从 nvidia/nemotron-3-embed-1b（2048 维）切换为
-- cf-free.binbim.locker 的 text-embedding-3-small（BGE-M3，1024 维）。
-- 旧向量维度放不进新列，且模型已变：先清空 embedding 与 content_hash
-- （content_hash 清空让 index-worker 全量重建索引），再 ALTER 列类型。
UPDATE "issue_documents" SET "embedding" = NULL, "content_hash" = NULL;
ALTER TABLE "issue_documents" ALTER COLUMN "embedding" TYPE vector(1024);
