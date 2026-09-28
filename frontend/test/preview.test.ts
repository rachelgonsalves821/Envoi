import { describe, expect, it } from 'vitest';
import { previewRequested } from '../src/preview';

describe('preview mode', () => {
  it('is available only during development', () => {
    expect(previewRequested('?preview=1', true)).toBe(true);
    expect(previewRequested('?preview=1', false)).toBe(false);
    expect(previewRequested('', true)).toBe(false);
  });
});
