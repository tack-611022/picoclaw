import { describe, expect, it } from 'vitest';

import { computeNextRun } from './task-utils.js';

describe('computeNextRun', () => {
  it('computes interval schedule', () => {
    const before = Date.now();
    const result = computeNextRun('interval', '60000');
    const after = Date.now();

    expect(result).toBeTruthy();
    const ts = new Date(result!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before + 60000);
    expect(ts).toBeLessThanOrEqual(after + 60000);
  });

  it('computes once schedule', () => {
    const result = computeNextRun('once', '2030-06-15T14:00:00');
    expect(result).toBeTruthy();
    // new Date('2030-06-15T14:00:00') parses as local time → UTC ISO string
    const expected = new Date('2030-06-15T14:00:00').toISOString();
    expect(result).toBe(expected);
  });

  it('rejects once schedule with timezone suffix', () => {
    expect(() => computeNextRun('once', '2030-06-15T14:00:00Z')).toThrow(
      'local timestamp without timezone suffix',
    );
  });

  it('rejects invalid once timestamp', () => {
    expect(() => computeNextRun('once', 'not-a-date')).toThrow(
      'Invalid once schedule timestamp',
    );
  });

  it('rejects non-positive interval', () => {
    expect(() => computeNextRun('interval', '-1')).toThrow(
      'positive integer in milliseconds',
    );
  });

  it('computes cron schedule', () => {
    const result = computeNextRun('cron', '0 9 * * 1-5');
    expect(result).toBeTruthy();
    const ts = new Date(result!).getTime();
    expect(ts).toBeGreaterThan(Date.now());
  });
});
