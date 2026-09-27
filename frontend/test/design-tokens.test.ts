import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function rgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex: string) {
  const channels = rgb(hex).map(channel => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('Quiet Authority token guardrails', () => {
  it.each([
    ['primary light text', '#171918', '#F7F6F2', 4.5],
    ['supporting light text', '#69706B', '#F7F6F2', 4.5],
    ['primary action', '#FFFFFF', '#3158DB', 4.5],
    ['accent link', '#2447C6', '#F7F6F2', 4.5],
    ['primary dark text', '#F2F1ED', '#17181A', 4.5]
  ])('%s meets WCAG AA', (_label, foreground, background, minimum) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(minimum);
  });

  it('keeps raw color values out of component code and application CSS', () => {
    const application = readFileSync(`${root}/frontend/src/App.tsx`, 'utf8');
    const styles = readFileSync(`${root}/frontend/src/styles/app.css`, 'utf8');
    expect(application).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
