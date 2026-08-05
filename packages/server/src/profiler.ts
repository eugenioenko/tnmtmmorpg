import type { World } from './world.ts';

export interface ProfileSnapshot {
  tick: number;
  /** Time to run one tick, averaged over the reporting window. */
  tickDurationMs: number;
  /** System name → cumulative ms in this interval. */
  systemTimings: Record<string, number>;
  entityCount: number;
  chunkCount: number;
  dirtyCount: number;
  sessionCount: number;
  snapshotStats: {
    totalBytes: number;
    avgBytesPerSession: number;
    maxBytesPerSession: number;
    fullCount: number;
    deltaCount: number;
  };
  heapUsedMB: number;
  /** Ticks/sec over the reporting window. */
  avgTickRate: number;
}

/**
 * Tick-level profiler: per-tick duration, cumulative per-system timings,
 * snapshot wire sizes, entity/chunk/session counts and heap usage, reported
 * every N ticks. Every public method is a no-op while disabled, so a server
 * started without `--profile` pays nothing beyond the call itself.
 */
export class Profiler {
  private enabled: boolean;
  private reportIntervalTicks: number;
  // Internal accumulators
  private tickStartTime = 0;
  private systemTimes = new Map<string, number>();
  private snapshotBytes: number[] = [];
  private tickDurations: number[] = [];
  private fullSnapshots = 0;
  private deltaSnapshots = 0;
  private reportStart: number;
  private ticksInWindow = 0;
  // Latest-tick values surfaced in the next report.
  private lastTick = 0;
  private lastEntityCount = 0;
  private lastChunkCount = 0;
  private lastDirtyCount = 0;
  private lastSessionCount = 0;

  constructor(enabled: boolean, reportIntervalTicks: number = 100) {
    this.enabled = enabled;
    this.reportIntervalTicks = reportIntervalTicks;
    this.reportStart = performance.now();
  }

  /** Call at the START of each tick */
  startTick(): void {
    if (!this.enabled) return;
    this.tickStartTime = performance.now();
  }

  /** Call at the END of each tick */
  endTick(tick: number, world: World, sessionCount: number): void {
    if (!this.enabled) return;
    this.tickDurations.push(performance.now() - this.tickStartTime);
    this.ticksInWindow++;
    this.lastTick = tick;
    this.lastEntityCount = world.entityCount;
    this.lastChunkCount = world.chunkCount;
    this.lastDirtyCount = world.dirtyCount;
    this.lastSessionCount = sessionCount;
  }

  /** Record time spent in a system */
  recordSystemTime(name: string, ms: number): void {
    if (!this.enabled) return;
    this.systemTimes.set(name, (this.systemTimes.get(name) ?? 0) + ms);
  }

  /** Record a snapshot size in bytes */
  recordSnapshotSize(bytes: number, isFull: boolean): void {
    if (!this.enabled) return;
    this.snapshotBytes.push(bytes);
    if (isFull) this.fullSnapshots++;
    else this.deltaSnapshots++;
  }

  /**
   * Run fn and record its wall-clock time under `name` (cumulative within the
   * window). When profiling is disabled this is exactly `fn()`.
   */
  timeSystem(name: string, fn: () => void): void {
    if (!this.enabled) {
      fn();
      return;
    }
    const start = performance.now();
    try {
      fn();
    } finally {
      this.recordSystemTime(name, performance.now() - start);
    }
  }

  /** Call every N ticks to get a report, or null if not time yet */
  maybeReport(): ProfileSnapshot | null {
    if (!this.enabled) return null;
    if (this.ticksInWindow < this.reportIntervalTicks) return null;
    return this.buildReport();
  }

  private buildReport(): ProfileSnapshot {
    const elapsedMs = performance.now() - this.reportStart;
    const tickCount = this.tickDurations.length;
    let totalTickMs = 0;
    for (const ms of this.tickDurations) totalTickMs += ms;
    let totalBytes = 0;
    let maxBytes = 0;
    for (const bytes of this.snapshotBytes) {
      totalBytes += bytes;
      if (bytes > maxBytes) maxBytes = bytes;
    }
    const snapshotCount = this.snapshotBytes.length;
    const mem = process.memoryUsage();

    const report: ProfileSnapshot = {
      tick: this.lastTick,
      tickDurationMs: tickCount > 0 ? totalTickMs / tickCount : 0,
      systemTimings: Object.fromEntries(this.systemTimes),
      entityCount: this.lastEntityCount,
      chunkCount: this.lastChunkCount,
      dirtyCount: this.lastDirtyCount,
      sessionCount: this.lastSessionCount,
      snapshotStats: {
        totalBytes,
        avgBytesPerSession: snapshotCount > 0 ? ~~(totalBytes / snapshotCount) : 0,
        maxBytesPerSession: maxBytes,
        fullCount: this.fullSnapshots,
        deltaCount: this.deltaSnapshots,
      },
      heapUsedMB: mem.heapUsed / (1024 * 1024),
      avgTickRate: elapsedMs > 0 ? (tickCount / elapsedMs) * 1000 : 0,
    };

    // Reset the accumulators for the next reporting window.
    this.systemTimes.clear();
    this.snapshotBytes = [];
    this.tickDurations = [];
    this.fullSnapshots = 0;
    this.deltaSnapshots = 0;
    this.ticksInWindow = 0;
    this.reportStart = performance.now();
    return report;
  }
}

/** Render a profile report for the console, systems sorted by total time. */
export function formatProfileReport(r: ProfileSnapshot): string {
  const lines = [
    `\n═══ Profile @ tick ${r.tick} ═══`,
    `Tick rate:    ${r.avgTickRate.toFixed(1)}/s`,
    `Tick time:    ${r.tickDurationMs.toFixed(2)}ms avg`,
    `Heap:         ${r.heapUsedMB.toFixed(1)} MB`,
    `Entities:     ${r.entityCount}`,
    `Chunks:       ${r.chunkCount} (${r.dirtyCount} dirty)`,
    `Sessions:     ${r.sessionCount}`,
    `Snapshots:    ${r.snapshotStats.deltaCount}Δ + ${r.snapshotStats.fullCount}full = ${(r.snapshotStats.totalBytes / 1024).toFixed(1)} KB`,
    `  avg/session: ${r.snapshotStats.avgBytesPerSession} B`,
    `  max/session: ${r.snapshotStats.maxBytesPerSession} B`,
  ];

  // Sort systems by time
  const sorted = Object.entries(r.systemTimings).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    lines.push('Systems:');
    for (const [name, ms] of sorted) {
      lines.push(`  ${name.padEnd(29)} ${ms.toFixed(2)}ms`);
    }
  }

  lines.push('══════════════════════════\n');
  return lines.join('\n');
}
