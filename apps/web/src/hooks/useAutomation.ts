/** 自动化页面分页读取；仓库切换中止旧请求，写入结果通过显式刷新重新读取。 */
import { useCallback, useEffect, useState } from "react";
import { automation, type AutomationRows } from "../lib/automation";
export function useAutomationRows<K extends keyof AutomationRows>(
  collection: K,
  repository: string,
  state = "",
) {
  const [items, setItems] = useState<AutomationRows[K][]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [offset, setOffset] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => setOffset(0), [repository, collection, state]);
  useEffect(() => {
    const active = new AbortController();
    setLoading(true);
    setError(null);
    setItems([]);
    automation
      .list(
        collection,
        repository,
        { limit: 50, offset, ...(state ? { state } : {}) },
        active.signal,
      )
      .then((data) => {
        if (!active.signal.aborted) {
          setItems(data.items);
          setTotal(data.total);
        }
      })
      .catch((reason) => {
        if (!active.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : "读取自动化记录失败",
          );
      })
      .finally(() => {
        if (!active.signal.aborted) setLoading(false);
      });
    return () => active.abort();
  }, [collection, repository, state, offset, revision]);
  return {
    items,
    total,
    loading,
    error,
    refresh,
    offset,
    previous: () => setOffset((value) => Math.max(0, value - 50)),
    next: () => setOffset((value) => value + 50),
    hasPrevious: offset > 0,
    hasNext: offset + items.length < total,
  };
}
