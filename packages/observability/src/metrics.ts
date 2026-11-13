/**
 * 进程内轻量指标注册表：计数器 / 时长计量（次数 + 总和 → 均值）/ 量规。
 *
 * 零外部依赖，进程内存里累计；WebUI「运维」页直接读快照，未来若要接入
 * Prometheus 只需把 snapshot() 渲染成文本格式。跨进程的实时量规（如队列
 * 深度）由调用方按需查询后 setGauge 注入。
 */

export type DurationBucket = {
  count: number;
  totalMs: number;
};

export type MetricsSnapshot = {
  counters: Record<string, number>;
  durations: Record<string, DurationBucket>;
  gauges: Record<string, number>;
  since: string;
};

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private durations = new Map<string, DurationBucket>();
  private gauges = new Map<string, number>();
  private readonly since = new Date();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  recordDuration(name: string, ms: number): void {
    const current = this.durations.get(name) ?? { count: 0, totalMs: 0 };
    this.durations.set(name, {
      count: current.count + 1,
      totalMs: current.totalMs + ms,
    });
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** 以数组批量累加（如任务结果按 outcome 分组）。 */
  bumpCounters(entries: readonly [string, number][]): void {
    for (const [name, by] of entries) this.increment(name, by);
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) counters[key] = value;
    const durations: Record<string, DurationBucket> = {};
    for (const [key, value] of this.durations) durations[key] = { ...value };
    const gauges: Record<string, number> = {};
    for (const [key, value] of this.gauges) gauges[key] = value;
    return {
      counters,
      durations,
      gauges,
      since: this.since.toISOString(),
    };
  }
}

/** 全局共享实例：api / workers 各自进程独立累计。 */
export const metrics = new MetricsRegistry();
