(() => {
  let preference = 'system';
  try {
    const saved = window.localStorage.getItem('envoi-theme');
    if (['light', 'dark', 'system'].includes(saved)) preference = saved;
  } catch {}
  const root = document.documentElement;
  root.dataset.themePreference = preference;
  root.dataset.theme = preference === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : preference;
})();
