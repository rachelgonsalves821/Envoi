import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { FailureScreen, LoadingScreen } from '../src/App';

it('offers sign-out while checking and while retrying a failed check', () => {
  const onLogout = vi.fn();
  const loading = renderToStaticMarkup(createElement(LoadingScreen, { checking: true, onLogout }));
  expect(loading).toContain('Checking your session'); expect(loading).toContain('Sign out');
  const failure = renderToStaticMarkup(createElement(FailureScreen, { message: 'Timed out', onRetry: vi.fn(), onLogout }));
  expect(failure).toContain('Retry loading'); expect(failure).toContain('Sign out');
});
