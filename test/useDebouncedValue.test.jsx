// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from '../src/hooks/useDebouncedValue.js';

describe('useDebouncedValue (UI-4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 250));
    expect(result.current).toBe('a');
  });

  it('updates only after the delay, collapsing rapid changes to the latest', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    rerender({ v: 'abc' });
    expect(result.current).toBe('a'); // nothing fired yet
    act(() => { vi.advanceTimersByTime(249); });
    expect(result.current).toBe('a'); // still inside the window
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe('abc'); // one update, to the final value
  });
});
