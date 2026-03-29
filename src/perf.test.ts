import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPerfTrace, PerfTrace } from './perf.js';

// Mock the logger to capture debug calls
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { logger } from './logger.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('PerfTrace', () => {
  it('collects marks and flushes as a single debug log', () => {
    const perf = createPerfTrace('test-scope', { requestId: 'req-1' });
    perf.mark('stepA');
    perf.mark('stepB', { count: 42 });
    perf.flush('[PERF:TEST] done');

    expect(logger.debug).toHaveBeenCalledOnce();
    const call = vi.mocked(logger.debug).mock.calls[0];
    const data = call[0] as Record<string, unknown>;
    const message = call[1] as string;

    expect(message).toBe('[PERF:TEST] done');
    expect(data.scope).toBe('test-scope');
    expect(data.requestId).toBe('req-1');
    expect(typeof data.totalMs).toBe('number');
    expect(data.totalMs).toBeGreaterThanOrEqual(0);

    const steps = data.steps as Array<{
      name: string;
      totalMs: number;
      deltaMs: number;
      meta?: Record<string, unknown>;
    }>;
    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe('stepA');
    expect(steps[1].name).toBe('stepB');
    expect(steps[1].meta).toEqual({ count: 42 });
  });

  it('includes flush-time meta in the output', () => {
    const perf = createPerfTrace('scope');
    perf.flush('[PERF] done', { status: 'success' });

    const call = vi.mocked(logger.debug).mock.calls[0];
    const data = call[0] as Record<string, unknown>;
    expect(data.status).toBe('success');
  });

  it('records monotonically increasing totalMs', () => {
    const perf = createPerfTrace('mono');
    perf.mark('a');
    perf.mark('b');
    perf.mark('c');
    perf.flush('[PERF] done');

    const call = vi.mocked(logger.debug).mock.calls[0];
    const steps = (call[0] as Record<string, unknown>).steps as Array<{
      totalMs: number;
    }>;
    expect(steps[0].totalMs).toBeLessThanOrEqual(steps[1].totalMs);
    expect(steps[1].totalMs).toBeLessThanOrEqual(steps[2].totalMs);
  });

  it('deltaMs measures time between consecutive marks', () => {
    const perf = createPerfTrace('delta');
    perf.mark('first');
    perf.mark('second');
    perf.flush('[PERF] done');

    const call = vi.mocked(logger.debug).mock.calls[0];
    const steps = (call[0] as Record<string, unknown>).steps as Array<{
      totalMs: number;
      deltaMs: number;
    }>;
    // deltaMs of first mark equals totalMs (since it's measured from trace start)
    expect(steps[0].deltaMs).toBe(steps[0].totalMs);
    // deltaMs of second mark = totalMs[1] - totalMs[0]
    const expectedDelta = Number(
      (steps[1].totalMs - steps[0].totalMs).toFixed(1),
    );
    expect(steps[1].deltaMs).toBe(expectedDelta);
  });

  it('handles flush with no marks', () => {
    const perf = createPerfTrace('empty');
    perf.flush('[PERF] empty');

    expect(logger.debug).toHaveBeenCalledOnce();
    const call = vi.mocked(logger.debug).mock.calls[0];
    const data = call[0] as Record<string, unknown>;
    expect((data.steps as unknown[]).length).toBe(0);
  });

  it('createPerfTrace is a factory for PerfTrace', () => {
    const perf = createPerfTrace('factory');
    expect(perf).toBeInstanceOf(PerfTrace);
  });
});
