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

export type DurationSummary = DurationBucket & {
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** 分位数只看最近这些样本；count 与 totalMs 覆盖启动以来全部调用。 */
  sampled: number;
};

export type MetricsOptions = {
  maxNames?: number;
  durationSamples?: number;
  histogramBoundsMs?: readonly number[];
  now?: () => Date;
};

type DurationHistory = {
  samples: number[];
  min: number;
  max: number;
  buckets: number[];
};

const DEFAULT_BOUNDS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
];

export class MetricsRegistry {
  private counters = new Map<string, number>();
  private durations = new Map<string, DurationBucket>();
  private gauges = new Map<string, number>();
  private since: Date;
  private readonly maxNames: number;
  private readonly sampleLimit: number;
  private readonly bounds: readonly number[];
  private readonly now: () => Date;
  private histories = new Map<string, DurationHistory>();

  constructor(options: MetricsOptions = {}) {
    this.maxNames = options.maxNames ?? 2_000;
    this.sampleLimit = options.durationSamples ?? 512;
    for (const [name, value] of Object.entries({
      maxNames: this.maxNames,
      durationSamples: this.sampleLimit,
    })) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError(`${name} must be a positive integer`);
    }
    this.bounds = [...(options.histogramBoundsMs ?? DEFAULT_BOUNDS_MS)];
    if (
      !this.bounds.length ||
      this.bounds.some(
        (bound, index) =>
          !Number.isFinite(bound) ||
          bound < 0 ||
          (index > 0 && bound <= this.bounds[index - 1]!),
      )
    )
      throw new RangeError(
        "histogram bounds must be finite, non-negative, and strictly increasing",
      );
    this.now = options.now ?? (() => new Date());
    this.since = this.now();
  }

  increment(name: string, by = 1): void {
    this.admit(name, "counter");
    if (!Number.isFinite(by) || by < 0)
      throw new RangeError("counter increment must be finite and non-negative");
    if (!Number.isFinite((this.counters.get(name) ?? 0) + by))
      throw new RangeError("counter overflow");
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  recordDuration(name: string, ms: number): void {
    this.admit(name, "duration");
    if (!Number.isFinite(ms) || ms < 0)
      throw new RangeError("duration must be finite and non-negative");
    const current = this.durations.get(name) ?? { count: 0, totalMs: 0 };
    if (!Number.isFinite(current.totalMs + ms))
      throw new RangeError("duration total overflow");
    this.durations.set(name, {
      count: current.count + 1,
      totalMs: current.totalMs + ms,
    });
    const history = this.histories.get(name) ?? {
      samples: [],
      min: ms,
      max: ms,
      buckets: this.bounds.map(() => 0),
    };
    history.samples.push(ms);
    if (history.samples.length > this.sampleLimit) history.samples.shift();
    history.min = Math.min(history.min, ms);
    history.max = Math.max(history.max, ms);
    this.bounds.forEach((bound, index) => {
      if (ms <= bound) history.buckets[index]! += 1;
    });
    this.histories.set(name, history);
  }

  setGauge(name: string, value: number): void {
    this.admit(name, "gauge");
    if (!Number.isFinite(value)) throw new RangeError("gauge must be finite");
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
    for (const [key, value] of this.durations) durations[key] = value;
    const gauges: Record<string, number> = {};
    for (const [key, value] of this.gauges) gauges[key] = value;
    return {
      counters,
      durations,
      gauges,
      since: this.since.toISOString(),
    };
  }

  /** 只排序一份有限样本副本，读取统计不会改变采集顺序。 */
  durationSummary(name: string): DurationSummary | null {
    const current = this.durations.get(name);
    const history = this.histories.get(name);
    if (!current || !history) return null;
    const sorted = [...history.samples].sort((left, right) => left - right);
    const quantile = (fraction: number) =>
      sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
    return {
      ...current,
      minMs: history.min,
      maxMs: history.max,
      p50Ms: quantile(0.5),
      p95Ms: quantile(0.95),
      p99Ms: quantile(0.99),
      sampled: sorted.length,
    };
  }

  /** Prometheus 标准文本；时长换成秒，桶使用累计计数且覆盖全部历史。 */
  prometheus(prefix = "apertureprism"): string {
    const lines: string[] = [];
    const used = new Set<string>();
    const metricName = (name: string) => {
      const cleaned = `${prefix}_${name}`.replace(/[^a-zA-Z0-9_:]/g, "_");
      return /^[a-zA-Z_:]/.test(cleaned) ? cleaned : `_${cleaned}`;
    };
    const claim = (name: string) => {
      if (used.has(name))
        throw new Error(`metric names collide after normalization: ${name}`);
      used.add(name);
    };
    for (const [name, value] of [...this.counters].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const base = metricName(name);
      const metric = base.endsWith("_total") ? base : `${base}_total`;
      claim(metric);
      lines.push(`# TYPE ${metric} counter`, `${metric} ${value}`);
    }
    for (const [name, value] of [...this.gauges].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const metric = metricName(name);
      claim(metric);
      lines.push(`# TYPE ${metric} gauge`, `${metric} ${value}`);
    }
    for (const [name, value] of [...this.durations].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const metric = `${metricName(name.replace(/(?:[._]ms)$/, ""))}_seconds`;
      for (const suffix of ["", "_bucket", "_sum", "_count"])
        claim(`${metric}${suffix}`);
      const history = this.histories.get(name)!;
      lines.push(`# TYPE ${metric} histogram`);
      this.bounds.forEach((bound, index) =>
        lines.push(
          `${metric}_bucket{le="${bound / 1_000}"} ${history.buckets[index]}`,
        ),
      );
      lines.push(
        `${metric}_bucket{le="+Inf"} ${value.count}`,
        `${metric}_sum ${value.totalMs / 1_000}`,
        `${metric}_count ${value.count}`,
      );
    }
    return lines.length ? `${lines.join("\n")}\n` : "";
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.durations.clear();
    this.histories.clear();
    this.since = this.now();
  }

  private admit(name: string, kind: "counter" | "gauge" | "duration"): void {
    if (!name.trim() || name.length > 200)
      throw new RangeError("metric name must contain 1 to 200 characters");
    const existing = this.counters.has(name)
      ? "counter"
      : this.gauges.has(name)
        ? "gauge"
        : this.durations.has(name)
          ? "duration"
          : null;
    if (existing && existing !== kind)
      throw new Error(`metric ${name} already uses type ${existing}`);
    if (
      !existing &&
      this.counters.size + this.gauges.size + this.durations.size >=
        this.maxNames
    )
      throw new RangeError("metric name capacity exceeded");
  }
}

/** 全局共享实例：api / workers 各自进程独立累计。 */
export const metrics = new MetricsRegistry();
