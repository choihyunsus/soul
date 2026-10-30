// PerfMonitor unit tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PerfMonitor } from '../lib/kv-cache/perf-monitor';

describe('PerfMonitor', () => {
  it('should return empty snapshot when no data recorded', () => {
    const pm = new PerfMonitor();
    const snap = pm.getSnapshot();
    assert.equal(snap.sampleCount, 0);
    assert.equal(snap.avgLatencyMs, 0);
    assert.equal(snap.p95LatencyMs, 0);
  });

  it('should track latency recordings', () => {
    const pm = new PerfMonitor();
    pm.record(10);
    pm.record(20);
    pm.record(30);
    const snap = pm.getSnapshot();
    assert.equal(snap.sampleCount, 3);
    assert.equal(snap.avgLatencyMs, 20);
  });

  it('should enforce sliding window size', () => {
    const pm = new PerfMonitor({ windowSize: 3 });
    pm.record(100);
    pm.record(200);
    pm.record(300);
    pm.record(10); // pushes out 100
    const snap = pm.getSnapshot();
    assert.equal(snap.sampleCount, 3);
    // [200, 300, 10] -> avg = 170
    assert.ok(Math.abs(snap.avgLatencyMs - 170) < 1);
  });

  it('should return default GC with insufficient samples', () => {
    const pm = new PerfMonitor();
    pm.record(5);
    pm.record(5);
    const rec = pm.recommendGC(30, 50);
    assert.equal(rec.aggressive, false);
    assert.equal(rec.maxAgeDays, 30);
    assert.equal(rec.maxCount, 50);
    assert.ok(rec.reason.includes('Insufficient'));
  });

  it('should not adjust GC when queries are fast', () => {
    const pm = new PerfMonitor({ slowThresholdMs: 100 });
    for (let i = 0; i < 10; i++) pm.record(20);
    const rec = pm.recommendGC(30, 50);
    assert.equal(rec.aggressive, false);
    assert.equal(rec.maxAgeDays, 30);
    assert.equal(rec.maxCount, 50);
    assert.ok(rec.reason.includes('OK'));
  });

  it('should tighten GC when queries are slow', () => {
    const pm = new PerfMonitor({ slowThresholdMs: 100, criticalThresholdMs: 500 });
    for (let i = 0; i < 10; i++) pm.record(300);
    const rec = pm.recommendGC(30, 50);
    assert.equal(rec.aggressive, false);
    assert.ok(rec.maxAgeDays < 30, `Expected maxAgeDays < 30, got ${rec.maxAgeDays}`);
    assert.ok(rec.maxCount < 50, `Expected maxCount < 50, got ${rec.maxCount}`);
    assert.ok(rec.reason.includes('SLOW'));
  });

  it('should trigger aggressive GC when queries are critical', () => {
    const pm = new PerfMonitor({ slowThresholdMs: 100, criticalThresholdMs: 500 });
    for (let i = 0; i < 10; i++) pm.record(600);
    const rec = pm.recommendGC(30, 50);
    assert.equal(rec.aggressive, true);
    assert.equal(rec.maxAgeDays, 10); // 30 / 3
    assert.ok(rec.maxCount <= 17, `Expected maxCount <= 17, got ${rec.maxCount}`);
    assert.ok(rec.reason.includes('CRITICAL'));
  });

  it('should respect minimum thresholds in aggressive mode', () => {
    const pm = new PerfMonitor({ slowThresholdMs: 100, criticalThresholdMs: 500 });
    for (let i = 0; i < 10; i++) pm.record(1000);
    const rec = pm.recommendGC(15, 20);
    assert.ok(rec.maxAgeDays >= 7, `Min maxAgeDays should be 7, got ${rec.maxAgeDays}`);
    assert.ok(rec.maxCount >= 15, `Min maxCount should be 15, got ${rec.maxCount}`);
  });

  it('should reset recorded data', () => {
    const pm = new PerfMonitor();
    for (let i = 0; i < 20; i++) pm.record(50);
    pm.reset();
    const snap = pm.getSnapshot();
    assert.equal(snap.sampleCount, 0);
  });

  it('should calculate p95 correctly', () => {
    const pm = new PerfMonitor({ windowSize: 100 });
    // 95 fast queries + 5 slow
    for (let i = 0; i < 95; i++) pm.record(10);
    for (let i = 0; i < 5; i++) pm.record(500);
    const snap = pm.getSnapshot();
    assert.ok(snap.p95LatencyMs >= 10, `p95 should be >= 10, got ${snap.p95LatencyMs}`);
    assert.ok(snap.avgLatencyMs < 500, `Avg should be < 500, got ${snap.avgLatencyMs}`);
  });

  it('measure() should record and return result', async () => {
    const pm = new PerfMonitor();
    const result = await pm.measure(async () => {
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(pm.getSnapshot().sampleCount, 1);
  });
});
