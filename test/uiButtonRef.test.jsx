// @vitest-environment jsdom

import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Button } from '../src/components/ui/button.jsx';

afterEach(() => {
  cleanup();
});

describe('Button ref-as-prop parity', () => {
  it('lands refs on the child element when asChild uses Radix Slot', () => {
    const ref = React.createRef();

    render(
      <Button asChild ref={ref}>
        <a href="/customer-search">Customer search</a>
      </Button>,
    );

    expect(ref.current).toBeInstanceOf(HTMLAnchorElement);
    expect(ref.current?.tagName).toBe('A');
    expect(ref.current?.getAttribute('href')).toBe('/customer-search');
  });
});
