// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { useSearchParamState } from '../src/hooks/useSearchParamState.js';

const wrapper = (initial = '/') =>
  function Wrapper({ children }) {
    return <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>;
  };

function renderBoth(initial) {
  // Render the hook under test alongside raw useSearchParams so assertions
  // can inspect the actual URL state.
  return renderHook(
    () => ({
      age: useSearchParamState('age', 'all'),
      page: useSearchParamState('page', '1'),
      raw: useSearchParams()[0],
    }),
    { wrapper: wrapper(initial) },
  );
}

describe('useSearchParamState', () => {
  it('returns the default when the param is absent', () => {
    const { result } = renderBoth('/');
    expect(result.current.age[0]).toBe('all');
  });

  it('reads an existing param from the URL (deep link)', () => {
    const { result } = renderBoth('/?age=21%2B');
    expect(result.current.age[0]).toBe('21+');
  });

  it('setting a value writes it to the URL; setting the default removes it', async () => {
    const { result } = renderBoth('/');
    await act(async () => result.current.age[1]('7-13'));
    expect(result.current.age[0]).toBe('7-13');
    expect(result.current.raw.get('age')).toBe('7-13');
    await act(async () => result.current.age[1]('all'));
    expect(result.current.raw.has('age')).toBe(false);
  });

  it('two setters batched in one handler compose instead of clobbering', async () => {
    const { result } = renderBoth('/?page=3');
    await act(async () => {
      result.current.age[1]('21+');
      result.current.page[1]('1'); // reset to default → removed
    });
    expect(result.current.raw.get('age')).toBe('21+');
    expect(result.current.raw.has('page')).toBe(false);
  });

  it('functional updates receive the current value', async () => {
    const { result } = renderBoth('/?page=2');
    await act(async () => result.current.page[1]((p) => String(Number(p) + 1)));
    expect(result.current.page[0]).toBe('3');
  });
});
