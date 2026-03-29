import { performance } from 'perf_hooks';

import { logger } from './logger.js';

interface PerfStep {
  name: string;
  totalMs: number;
  deltaMs: number;
  meta?: Record<string, unknown>;
}

function roundMs(value: number): number {
  return Number(value.toFixed(1));
}

/**
 * Lightweight performance trace collector.
 *
 * Collects named marks with high-resolution timestamps and flushes
 * them as a single structured debug log entry. All output goes through
 * `logger.debug()` — marks and flush are no-ops when LOG_LEVEL is above
 * debug, so runtime overhead in production is near-zero (only a
 * `performance.now()` call per mark, which is sub-microsecond).
 *
 * Usage:
 *   const perf = createPerfTrace('agentRun', { conversationId: '...' });
 *   perf.mark('stepA');
 *   // ... work ...
 *   perf.mark('stepB', { count: 42 });
 *   perf.flush('[PERF:AGENT] execution complete');
 */
export class PerfTrace {
  private readonly startedAt: number;
  private lastMarkAt: number;
  private readonly steps: PerfStep[] = [];

  constructor(
    private readonly scope: string,
    private readonly baseMeta: Record<string, unknown> = {},
  ) {
    this.startedAt = performance.now();
    this.lastMarkAt = this.startedAt;
  }

  /**
   * Record a named checkpoint. Each mark captures:
   * - totalMs: time since trace creation
   * - deltaMs: time since the previous mark (or creation)
   *
   * When logger level is above debug, the timestamp is still recorded
   * (performance.now() is < 1 us) but no log output is produced until
   * flush() — keeping the overhead negligible.
   */
  mark(name: string, meta?: Record<string, unknown>): void {
    const now = performance.now();
    this.steps.push({
      name,
      totalMs: roundMs(now - this.startedAt),
      deltaMs: roundMs(now - this.lastMarkAt),
      ...(meta ? { meta } : {}),
    });
    this.lastMarkAt = now;
  }

  /**
   * Emit all collected steps as a single structured debug log entry.
   * No-op when logger level is above debug.
   */
  flush(message: string, meta: Record<string, unknown> = {}): void {
    const totalMs = roundMs(performance.now() - this.startedAt);
    logger.debug(
      {
        scope: this.scope,
        totalMs,
        steps: this.steps,
        ...this.baseMeta,
        ...meta,
      },
      message,
    );
  }
}

export function createPerfTrace(
  scope: string,
  baseMeta: Record<string, unknown> = {},
): PerfTrace {
  return new PerfTrace(scope, baseMeta);
}
