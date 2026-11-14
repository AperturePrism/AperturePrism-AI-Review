/**
 * 请求额度：每个命名来源有独立的一分钟窗口，持续占用的内存有硬上限。
 * 调用：rateLimited('api:127.0.0.1', 120, Date.now())。
 * webhook 与 WebUI 用不同前缀，互相不会消耗对方的调用额度。
 */
const RATE_WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;
const rateBuckets = new Map<string, { used: number; startedAt: number }>();

/** 返回 true 表示该来源已经用完本窗口的额度；limit<=0 表示关闭限流。 */
export function rateLimited(key: string, limit: number, now: number): boolean {
  if (limit <= 0) return false;
  const current = rateBuckets.get(key);
  if (current && now - current.startedAt < RATE_WINDOW_MS) {
    if (current.used >= limit) return true;
    current.used += 1;
    return false;
  }
  if (rateBuckets.size >= MAX_BUCKETS) {
    for (const [source, bucket] of rateBuckets) {
      if (now - bucket.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(source);
    }
    // 全是活跃窗口时拒绝新的来源，而不是逐出旧计数让攻击者循环拿到新额度。
    if (rateBuckets.size >= MAX_BUCKETS && !current) return true;
  }
  rateBuckets.set(key, { used: 1, startedAt: now });
  return false;
}
