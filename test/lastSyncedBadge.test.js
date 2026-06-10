import { describe, it, expect } from 'vitest';
import { humanAge } from '../src/components/shared/LastSyncedBadge.jsx';

describe('humanAge (LastSyncedBadge)', () => {
  it('null input → null (renders "Never synced")', () => {
    expect(humanAge(null)).toBe(null);
  });
  it('under a minute → "just now"', () => {
    expect(humanAge(30_000)).toBe('just now');
  });
  it('minutes', () => {
    expect(humanAge(5 * 60_000)).toBe('5 min ago');
  });
  it('hours under 48', () => {
    expect(humanAge(3 * 3_600_000)).toBe('3h ago');
    expect(humanAge(47 * 3_600_000)).toBe('47h ago');
  });
  it('days from 48h', () => {
    expect(humanAge(49 * 3_600_000)).toBe('2 days ago');
  });
  it('negative clock skew clamps to "just now", not a future age', () => {
    expect(humanAge(-60_000)).toBe('just now');
  });
});
