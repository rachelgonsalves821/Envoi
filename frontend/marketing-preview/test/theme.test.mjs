import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { normalizeTheme, resolveTheme, mountThemeControls } from '../src/scripts/theme.mjs';

const bootstrap = await readFile(new URL('../src/scripts/theme-bootstrap.js', import.meta.url), 'utf8');

function themeHarness({ saved = null, systemDark = false, blockedRead = false, blockedWrite = false, blockedAccess = false } = {}) {
  const root = { dataset: {} };
  const savedValues = new Map(saved === null ? [] : [['envoi-theme', saved]]);
  const storage = {
    getItem(key) { if (blockedRead) throw new Error('Storage blocked'); return savedValues.get(key) ?? null; },
    setItem(key, value) { if (blockedWrite) throw new Error('Storage blocked'); savedValues.set(key, value); }
  };
  const mediaListeners = new Map();
  const browserListeners = new Map();
  const media = { matches: systemDark, addEventListener: (type, callback) => mediaListeners.set(type, callback) };
  const browser = { localStorage: storage, matchMedia: () => media, addEventListener: (type, callback) => browserListeners.set(type, callback) };
  if (blockedAccess) Object.defineProperty(browser, 'localStorage', { get() { throw new Error('Storage access blocked'); } });
  const controls = ['light', 'dark', 'system'].map(value => ({ value, checked: false, listeners: new Map(), addEventListener(type, callback) { this.listeners.set(type, callback); } }));
  const group = { hidden: true };
  const meta = { content: '', setAttribute(name, value) { this[name] = value; } };
  const page = {
    documentElement: root,
    querySelectorAll: selector => selector === '[data-theme-choice]' ? controls : [group],
    querySelector: () => meta
  };
  runInNewContext(bootstrap, { window: browser, document: page });
  return {
    root, savedValues, group, meta, page, browser,
    mount() { mountThemeControls(page, browser); },
    select(value) { const control = controls.find(entry => entry.value === value); control.checked = true; control.listeners.get('change')(); },
    systemChange(dark) { media.matches = dark; mediaListeners.get('change')(); },
    storageChange(value, key = 'envoi-theme') { browserListeners.get('storage')({ key, newValue: value, storageArea: storage }); },
    selected() { return controls.filter(control => control.checked).map(control => control.value); }
  };
}

test('theme preferences are allowlisted and System resolves against the operating system', () => {
  for (const invalid of [null, undefined, 'sepia', '__proto__', '<script>']) assert.equal(normalizeTheme(invalid), 'system');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('pre-paint bootstrap honors saved choices and uses System by default', () => {
  assert.equal(themeHarness({ systemDark: true }).root.dataset.theme, 'dark');
  assert.equal(themeHarness({ saved: 'light', systemDark: true }).root.dataset.theme, 'light');
  assert.equal(themeHarness({ saved: 'dark' }).root.dataset.theme, 'dark');
  assert.equal(themeHarness({ saved: 'invalid', systemDark: true }).root.dataset.themePreference, 'system');
});

test('blocked storage reads do not prevent bootstrap or theme controls', () => {
  const harness = themeHarness({ blockedRead: true, systemDark: true });
  harness.mount();
  assert.equal(harness.root.dataset.theme, 'dark');
  assert.deepEqual(harness.selected(), ['system']);
  assert.equal(harness.group.hidden, false);
});

test('a blocked localStorage property cannot prevent theme selection', () => {
  const harness = themeHarness({ blockedAccess: true, systemDark: true });
  harness.mount();
  assert.equal(harness.root.dataset.theme, 'dark');
  assert.doesNotThrow(() => harness.select('light'));
  assert.equal(harness.root.dataset.theme, 'light');
});

test('Light and Dark persist across page loads and ignore system changes', () => {
  for (const preference of ['light', 'dark']) {
    const harness = themeHarness();
    harness.mount();
    harness.select(preference);
    assert.equal(harness.savedValues.get('envoi-theme'), preference);
    harness.systemChange(preference !== 'dark');
    assert.equal(harness.root.dataset.theme, preference);
    assert.equal(themeHarness({ saved: harness.savedValues.get('envoi-theme') }).root.dataset.theme, preference);
    assert.deepEqual(harness.selected(), [preference]);
  }
});

test('System responds to operating-system theme changes without overwriting the preference', () => {
  const harness = themeHarness({ saved: 'light' });
  harness.mount();
  harness.select('system');
  harness.systemChange(true);
  assert.equal(harness.root.dataset.theme, 'dark');
  assert.equal(harness.savedValues.get('envoi-theme'), 'system');
  assert.equal(harness.meta.content, '#101923');
  harness.systemChange(false);
  assert.equal(harness.root.dataset.theme, 'light');
  assert.equal(harness.meta.content, '#f6f9fc');
});

test('theme changes remain usable if local storage writes are blocked', () => {
  const harness = themeHarness({ blockedWrite: true });
  harness.mount();
  assert.doesNotThrow(() => harness.select('dark'));
  assert.equal(harness.root.dataset.theme, 'dark');
  assert.deepEqual(harness.selected(), ['dark']);
});

test('cross-tab preference changes and storage clearing synchronize without responding to unrelated keys', () => {
  const harness = themeHarness();
  harness.mount();
  harness.storageChange('dark');
  assert.equal(harness.root.dataset.theme, 'dark');
  harness.storageChange('light', 'another-setting');
  assert.equal(harness.root.dataset.theme, 'dark');
  harness.storageChange(null, null);
  assert.equal(harness.root.dataset.themePreference, 'system');
  assert.deepEqual(harness.selected(), ['system']);
});

test('native theme radios support keyboard operation and bootstrap runs in the document head', async () => {
  const control = await readFile(new URL('../src/components/ThemeToggle.astro', import.meta.url), 'utf8');
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  assert.match(control, /<fieldset[^>]+data-theme-control hidden>/);
  assert.match(control, /<legend[^>]*>Color theme/);
  assert.match(control, /type="radio" name="color-theme"/);
  assert.match(control, /\['light', 'dark', 'system'\]/);
  const bootstrapIndex = page.indexOf('<script is:inline set:html={themeBootstrap}>');
  assert.ok(bootstrapIndex >= 0 && bootstrapIndex < page.indexOf('<body>'));
});

function declarations(source) {
  return new Map([...source.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}

test('both theme palettes keep AA contrast for content, actions and status labels', async () => {
  const tokens = await readFile(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
  const light = declarations(tokens);
  for (const [key, value] of declarations(styles.match(/:root \{([\s\S]*?)\}/)[1])) light.set(key, value);
  const darkOverrides = declarations(styles.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\}/)[1]);
  const fallback = declarations(styles.match(/:root:not\(\[data-theme\]\) \{([\s\S]*?)\}/)[1]);
  assert.deepEqual(fallback, darkOverrides);
  for (const [mode, values] of [['light', light], ['dark', new Map([...light, ...darkOverrides])]]) {
    const resolve = name => {
      const value = values.get(name);
      return value.startsWith('var(') ? resolve(value.slice(4, -1)) : value;
    };
    const luminance = hex => {
      const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    for (const [foreground, background] of [['--ink', '--bg'], ['--ink-muted', '--bg-raised'], ['--ink-dim', '--bg-sunken'], ['--accent', '--bg'], ['--agent-b', '--bg-raised'], ['--action-ink', '--action-bg'], ['--on-accent', '--accent'], ['--needs-human-ink', '--needs-human-bg'], ['--confirmed', '--confirmed-bg']]) {
      const first = luminance(resolve(foreground));
      const second = luminance(resolve(background));
      const ratio = (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
      assert.ok(ratio >= 4.5, `${mode}: ${foreground} on ${background}: ${ratio.toFixed(2)}`);
    }
  }
});

test('Team uses the supplied names, roles, portraits and logos without invented biography prose', async () => {
  const team = await readFile(new URL('../src/components/Team.astro', import.meta.url), 'utf8');
  const route = await readFile(new URL('../src/pages/team.astro', import.meta.url), 'utf8');
  const footer = await readFile(new URL('../src/components/Footer.astro', import.meta.url), 'utf8');
  const artwork = await readFile(new URL('../public/team/founder-reference.png', import.meta.url));
  const website = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  assert.match(route, /Astro.redirect\('\/#team', 301\)/);
  assert.match(website, /\{isAbout && <Team \/>\}/);
  assert.ok(website.indexOf('<Team />') > website.indexOf('id="join"'));
  assert.doesNotMatch(website, /href="\/team\/"|page === 'team'/);
  assert.match(team, /id="team"/);
  assert.match(team, /<h2 id="team-title"/);
  assert.doesNotMatch(team, /<h1\b/);
  for (const label of ['Rachel Gonsalves', 'Je Sai Kailash Pulipati', 'CEO, Co-founder', 'CTO, Co-founder']) assert.ok(team.includes(label), label);
  assert.equal([...team.matchAll(/<article\b/g)].length, 2);
  assert.equal([...team.matchAll(/<p\b/g)].length, 2);
  assert.equal([...team.matchAll(/href="\/team\/founder-reference.png"/g)].length, 4);
  assert.match(footer, /href="\/#team">Team/);
  assert.equal(artwork.subarray(1, 4).toString(), 'PNG');
  assert.equal(artwork.readUInt32BE(16), 826);
  assert.equal(artwork.readUInt32BE(20), 477);
});
