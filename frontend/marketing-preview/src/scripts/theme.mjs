export const themeStorageKey = 'envoi-theme';

export function normalizeTheme(preference) {
  return ['light', 'dark', 'system'].includes(preference) ? preference : 'system';
}

export function resolveTheme(preference, systemDark) {
  const normalized = normalizeTheme(preference);
  return normalized === 'system' ? systemDark ? 'dark' : 'light' : normalized;
}

export function mountThemeControls(page, browser) {
  const listeners = new AbortController();
  const root = page.documentElement;
  const media = browser.matchMedia('(prefers-color-scheme: dark)');
  const controls = [...page.querySelectorAll('[data-theme-choice]')];
  let storage;
  try { storage = browser.localStorage; } catch {}
  let preference = normalizeTheme(root.dataset.themePreference);
  const apply = (nextPreference, persist = false) => {
    preference = normalizeTheme(nextPreference);
    const theme = resolveTheme(preference, media.matches);
    root.dataset.themePreference = preference;
    root.dataset.theme = theme;
    for (const control of controls) control.checked = control.value === theme;
    page.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101923' : '#f6f9fc');
    if (persist) {
      try { storage?.setItem(themeStorageKey, preference); } catch {}
    }
  };
  apply(preference);
  for (const control of controls) {
    control.addEventListener('change', () => {
      if (control.checked) apply(control.value, true);
    }, { signal: listeners.signal });
  }
  for (const group of page.querySelectorAll('[data-theme-control]')) group.hidden = false;
  media.addEventListener('change', () => apply(preference), { signal: listeners.signal });
  browser.addEventListener('storage', event => {
    if (event.storageArea && storage && event.storageArea !== storage) return;
    if (event.key === themeStorageKey || event.key === null) apply(event.newValue);
  }, { signal: listeners.signal });
  return () => listeners.abort();
}
