// Soul KV-Cache v9.0 - PerfMonitor. Self-tuning GC via query latency tracking.
import { logError } from '../utils';

/** GC parameter recommendation based on current performance */
export interface GCRecommendation {
  maxAgeDays: number;
  maxCount: number;
  aggressive: boolean;
  reason: string;
}

/** Performance snapshot for diagnostics */
export interface PerfSnapshot {
  avgLatencyMs: number;
  p95LatencyMs: number;
  sampleCount: number;
  lastMeasuredAt: string;
}

/** Default GC thresholds */
const DEFAULTS = {
  windowSize: 50,
  slowThresholdMs: 100,
  criticalThresholdMs: 500,
  baseMaxAgeDays: 30,
  baseMaxCount: 50,
  minMaxAgeDays: 7,
  minMaxCount: 15,
} as const;

/**
 * Tracks query latencies in a sliding window and recommends
 * GC parameters based on actual performance degradation.
 *
 * When queries slow down -> GC becomes more aggressive.
 * When queries are fast -> GC stays relaxed, keeping more history.
 */
export class PerfMonitor {
  private readonly _window: number[];
  private readonly _windowSize: number;
  private readonly _slowMs: number;
  private readonly _criticalMs: number;
  private _lastMeasured: string;

  constructor(opts?: {
    windowSize?: number;
    slowThresholdMs?: number;
    criticalThresholdMs?: number;
  }) {
    this._windowSize = opts?.windowSize ?? DEFAULTS.windowSize;
    this._slowMs = opts?.slowThresholdMs ?? DEFAULTS.slowThresholdMs;
    this._criticalMs = opts?.criticalThresholdMs ?? DEFAULTS.criticalThresholdMs;
    this._window = [];
    this._lastMeasured = new Date().toISOString();
  }

  /** Record a query latency measurement (ms) */
  record(latencyMs: number): void {
    this._window.push(latencyMs);
    if (this._window.length > this._windowSize) {
      this._window.shift();
    }
    this._lastMeasured = new Date().toISOString();
  }

  /** Measure and record a function's execution time */
  async measure<T>(fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.record(performance.now() - start);
    }
  }

  /** Get current performance snapshot */
  getSnapshot(): PerfSnapshot {
    if (this._window.length === 0) {
      return { avgLatencyMs: 0, p95LatencyMs: 0, sampleCount: 0, lastMeasuredAt: this._lastMeasured };
    }

    const sorted = [...this._window].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const p95Idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);

    return {
      avgLatencyMs: Math.round((sum / sorted.length) * 100) / 100,
      p95LatencyMs: Math.round((sorted[p95Idx] ?? 0) * 100) / 100,
      sampleCount: sorted.length,
      lastMeasuredAt: this._lastMeasured,
    };
  }

  /**
   * Recommend GC parameters based on current query performance.
   *
   * - Fast queries (< slowThreshold) -> relaxed GC (keep more history)
   * - Slow queries (slowThreshold ~ criticalThreshold) -> moderate GC
   * - Critical queries (> criticalThreshold) -> aggressive GC (3x reduction)
   */
  recommendGC(
    currentMaxAge: number = DEFAULTS.baseMaxAgeDays,
    currentMaxCount: number = DEFAULTS.baseMaxCount,
  ): GCRecommendation {
    const snap = this.getSnapshot();

    if (snap.sampleCount < 5) {
      return {
        maxAgeDays: currentMaxAge,
        maxCount: currentMaxCount,
        aggressive: false,
        reason: `Insufficient samples (${snap.sampleCount}/5). Using defaults.`,
      };
    }

    const p95 = snap.p95LatencyMs;

    if (p95 >= this._criticalMs) {
      return {
        maxAgeDays: Math.max(DEFAULTS.minMaxAgeDays, Math.floor(currentMaxAge / 3)),
        maxCount: Math.max(DEFAULTS.minMaxCount, Math.floor(currentMaxCount / 3)),
        aggressive: true,
        reason: `CRITICAL: p95=${p95}ms (threshold=${this._criticalMs}ms). Reducing retention 3x.`,
      };
    }

    if (p95 >= this._slowMs) {
      const ratio = (p95 - this._slowMs) / (this._criticalMs - this._slowMs);
      const ageFactor = 1 - (ratio * 0.5);
      const countFactor = 1 - (ratio * 0.5);
      return {
        maxAgeDays: Math.max(DEFAULTS.minMaxAgeDays, Math.floor(currentMaxAge * ageFactor)),
        maxCount: Math.max(DEFAULTS.minMaxCount, Math.floor(currentMaxCount * countFactor)),
        aggressive: false,
        reason: `SLOW: p95=${p95}ms (threshold=${this._slowMs}ms). Tightening by ${Math.round(ratio * 50)}%.`,
      };
    }

    return {
      maxAgeDays: currentMaxAge,
      maxCount: currentMaxCount,
      aggressive: false,
      reason: `OK: p95=${p95}ms (threshold=${this._slowMs}ms). No adjustment needed.`,
    };
  }

  /** Reset all recorded latencies */
  reset(): void {
    this._window.length = 0;
  }

  /** Diagnostic: log current perf state */
  logState(label: string): void {
    try {
      const snap = this.getSnapshot();
      const rec = this.recommendGC();
      const msg = `[perf:${label}] avg=${snap.avgLatencyMs}ms p95=${snap.p95LatencyMs}ms n=${snap.sampleCount} → gc(${rec.maxAgeDays}d/${rec.maxCount}ct) ${rec.aggressive ? 'AGGRESSIVE' : 'normal'}`;
      console.error(msg);
    } catch (e) {
      logError('perf-monitor:logState', e);
    }
  }
}
