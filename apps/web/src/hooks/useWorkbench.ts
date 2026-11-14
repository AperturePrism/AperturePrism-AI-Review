/**
 * 工作台页面的请求生命周期：仓库切换取消旧请求，写入完成后显式刷新。
 * @example const findings = useWorkbenchCollection('findings', repository);
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  explainWorkbenchError,
  workbench,
  type WorkbenchCollection,
  type WorkbenchRecords,
} from "../lib/workbench";

export function useWorkbenchCollection<K extends WorkbenchCollection>(
  collection: K,
  repository: string,
) {
  const [items, setItems] = useState<WorkbenchRecords[K][]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const pageLock = useRef(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    generation.current += 1;
    pageLock.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setPageError(null);
    setItems([]);
    setTotal(0);
    workbench
      .list(collection, repository, controller.signal, {
        limit: 100,
        offset: 0,
      })
      .then((result) => {
        if (!controller.signal.aborted) {
          setItems(result.items);
          setTotal(result.total);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(explainWorkbenchError(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [collection, repository, revision]);
  const hasMore = items.length < total;
  const loadMore = async () => {
    if (pageLock.current || loading || !hasMore) return;
    pageLock.current = true;
    setLoadingMore(true);
    setPageError(null);
    const requestedGeneration = generation.current;
    try {
      const result = await workbench.list(
        collection,
        repository,
        active.current?.signal,
        { limit: 100, offset: items.length },
      );
      if (
        requestedGeneration !== generation.current ||
        active.current?.signal.aborted
      )
        return;
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.id));
        return [
          ...previous,
          ...result.items.filter((item) => !seen.has(item.id)),
        ];
      });
      setTotal(result.total);
    } catch (reason) {
      if (
        requestedGeneration === generation.current &&
        !active.current?.signal.aborted
      )
        setPageError(explainWorkbenchError(reason));
    } finally {
      if (requestedGeneration === generation.current) {
        pageLock.current = false;
        setLoadingMore(false);
      }
    }
  };
  return {
    items,
    total,
    loading,
    error,
    refresh,
    hasMore,
    loadingMore,
    pageError,
    loadMore,
  };
}

/** 写入期间禁用重复提交；卸载后不更新界面，也不重复执行已送达的写入。 */
export function useWorkbenchMutation(onSuccess?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (
    action: () => Promise<unknown>,
    success: string,
  ): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      if (mounted.current) {
        setMessage(success);
        onSuccess?.();
      }
      return true;
    } catch (reason) {
      if (mounted.current) setError(explainWorkbenchError(reason));
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return {
    busy,
    error,
    message,
    run,
    clear: () => {
      setError(null);
      setMessage(null);
    },
  };
}
