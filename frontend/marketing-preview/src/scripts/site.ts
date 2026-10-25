import { advancePlayback, createPlaybackState, playbackDelay, selectScenario, acceptedWaitlistResponse } from './playback.mjs';
import { mountThemeControls } from './theme.mjs';

mountThemeControls(document, window);

const productAnchors = new Set(['#your-view', '#oversight', '#principles', '#features-title', '#demo-title', '#conversations']);
if (location.hash === '#oversight') {
  location.replace('/product/#feature-4');
} else if (document.documentElement.dataset.page === 'about' && (productAnchors.has(location.hash) || location.hash.startsWith('#feature-'))) {
  location.replace(`/product/${location.hash}`);
}

const header = document.querySelector<HTMLElement>('[data-header]');
const updateHeader = () => header?.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', updateHeader, { passive: true });
updateHeader();

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const thread = document.querySelector<HTMLElement>('[data-thread]');
if (thread) {
  const tabs = [...thread.querySelectorAll<HTMLButtonElement>('[data-scenario]')];
  const panels = [...thread.querySelectorAll<HTMLElement>('[data-panel]')];
  const playback = thread.querySelector<HTMLButtonElement>('[data-playback]')!;
  let activeIndex = 0;
  let state = createPlaybackState(panels[0].querySelectorAll('[data-step]').length, reducedMotion.matches);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inView = false;
  let hovered = false;
  let focused = false;

  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const render = () => {
    panels.forEach((panel, panelIndex) => {
      panel.hidden = panelIndex !== activeIndex;
      tabs[panelIndex].setAttribute('aria-selected', String(panelIndex === activeIndex));
      tabs[panelIndex].tabIndex = panelIndex === activeIndex ? 0 : -1;
    });
    const steps = [...panels[activeIndex].querySelectorAll<HTMLElement>('[data-step]')];
    steps.forEach((step, stepIndex) => {
      const pending = stepIndex >= state.visibleCount;
      step.classList.toggle('pending', pending);
      step.classList.toggle('is-newest', stepIndex === state.visibleCount - 1);
      if (pending) step.setAttribute('aria-hidden', 'true'); else step.removeAttribute('aria-hidden');
      step.querySelectorAll<HTMLAnchorElement>('a').forEach(link => { link.tabIndex = pending ? -1 : 0; });
    });
    const stopped = state.paused || state.manual || state.reducedMotion;
    playback.setAttribute('aria-pressed', String(stopped));
    playback.setAttribute('aria-label', stopped ? 'Play conversation animation' : 'Pause conversation animation');
    playback.querySelector<HTMLElement>('[data-pause-icon]')!.hidden = stopped;
    playback.querySelector<HTMLElement>('[data-play-icon]')!.hidden = !stopped;
    playback.querySelector<HTMLElement>('[data-playback-label]')!.textContent = state.reducedMotion ? 'Static view' : stopped ? 'Play' : 'Pause';
    playback.disabled = state.reducedMotion;
  };
  const schedule = () => {
    clearTimer();
    if (!inView || hovered || focused || document.hidden || state.paused || state.manual || state.reducedMotion) return;
    const complete = state.visibleCount === state.stepCount;
    timer = setTimeout(() => {
      if (complete) {
        activeIndex = (activeIndex + 1) % panels.length;
        state = createPlaybackState(panels[activeIndex].querySelectorAll('[data-step]').length);
        panels[activeIndex].querySelector('.thread-messages')!.scrollTop = 0;
      } else {
        state = advancePlayback(state);
      }
      render();
      const list = panels[activeIndex].querySelector<HTMLElement>('.thread-messages')!;
      const newest = list.querySelector<HTMLElement>('.is-newest');
      if (newest && newest.offsetTop + newest.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTo({ top: newest.offsetTop + newest.offsetHeight - list.clientHeight + 20, behavior: 'smooth' });
      }
      schedule();
    }, playbackDelay(state));
  };
  const choose = (index: number) => {
    activeIndex = index;
    state = selectScenario(panels[index].querySelectorAll('[data-step]').length, reducedMotion.matches);
    panels[index].querySelector('.thread-messages')!.scrollTop = 0;
    render();
    schedule();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => choose(index));
    tab.addEventListener('keydown', event => {
      let nextIndex = index;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      choose(nextIndex);
      tabs[nextIndex].focus();
    });
  });
  playback.addEventListener('click', () => {
    if (state.manual || state.paused) {
      state = createPlaybackState(state.stepCount, reducedMotion.matches);
      panels[activeIndex].querySelector('.thread-messages')!.scrollTop = 0;
    } else state = { ...state, paused: true };
    render();
    schedule();
  });
  thread.addEventListener('mouseenter', () => { hovered = true; schedule(); });
  thread.addEventListener('mouseleave', () => { hovered = false; schedule(); });
  thread.addEventListener('focusin', () => { focused = true; schedule(); });
  thread.addEventListener('focusout', () => queueMicrotask(() => { focused = thread.contains(document.activeElement); schedule(); }));
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', () => {
    state = reducedMotion.matches ? selectScenario(state.stepCount, true) : createPlaybackState(state.stepCount);
    render();
    schedule();
  });
  const observer = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; schedule(); }, { threshold: .2 });
  observer.observe(thread);
  render();
}

const ambientObserver = new IntersectionObserver(entries => entries.forEach(entry => entry.target.classList.toggle('in-view', entry.isIntersecting)), { threshold: .2 });
document.querySelectorAll('.handshake, .receipt-stage, [data-agents-banner]').forEach(element => ambientObserver.observe(element));
document.querySelectorAll<HTMLElement>('[data-agents-banner]').forEach(banner => {
  const toggle = banner.querySelector<HTMLButtonElement>('[data-banner-toggle]')!;
  toggle.addEventListener('click', () => {
    const paused = banner.dataset.paused !== 'true';
    banner.dataset.paused = String(paused);
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? 'Play agent logo animation' : 'Pause agent logo animation');
    toggle.querySelector<HTMLElement>('[data-banner-pause-icon]')!.hidden = paused;
    toggle.querySelector<HTMLElement>('[data-banner-play-icon]')!.hidden = !paused;
  });
});
const updateVisibility = () => document.body.classList.toggle('page-hidden', document.hidden);
document.addEventListener('visibilitychange', updateVisibility);
updateVisibility();

document.querySelectorAll<HTMLFormElement>('[data-waitlist]').forEach(form => {
  form.querySelector<HTMLButtonElement>('[data-submit]')!.type = 'submit';
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const status = form.querySelector<HTMLElement>('.form-status')!;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    status.className = 'form-status';
    if (form.dataset.enabled !== 'true') {
      status.textContent = 'Preview only. Your email has not been submitted.';
      return;
    }
    button.disabled = true;
    button.querySelector('span')!.textContent = 'Joining…';
    status.textContent = 'Sending your request…';
    const input = new FormData(form);
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: String(input.get('email') || '').trim(), company: String(input.get('company') || '') }),
        signal: AbortSignal.timeout(10000)
      });
      const payload = await response.json().catch(() => null);
      if (!acceptedWaitlistResponse(response.ok, payload)) throw new Error(response.status === 429 ? 'Please wait a little before trying again.' : 'We couldn’t save your email. Please try again.');
      status.textContent = 'You’re on the list. We’ll be in touch when an invitation is ready.';
      status.classList.add('success');
      form.reset();
    } catch (error) {
      status.textContent = error instanceof Error && error.name !== 'TimeoutError' ? error.message : 'The request timed out. Please try again.';
      status.classList.add('error');
    } finally {
      button.disabled = false;
      button.querySelector('span')!.textContent = 'Join the waitlist';
    }
  });
});

const inboxRows = [...document.querySelectorAll<HTMLButtonElement>('[data-inbox-row]')];
const details = [...document.querySelectorAll<HTMLElement>('[data-inbox-detail]')];
const selectInboxRow = (selected: HTMLButtonElement) => {
  inboxRows.forEach(row => { row.classList.toggle('active', row === selected); row.setAttribute('aria-pressed', String(row === selected)); });
  details.forEach(detail => { detail.hidden = detail.dataset.inboxDetail !== selected.dataset.inboxRow; });
};
inboxRows.forEach(row => row.addEventListener('click', () => selectInboxRow(row)));
const filters = [...document.querySelectorAll<HTMLButtonElement>('[data-inbox-filter]')];
filters.forEach(filter => filter.addEventListener('click', () => {
  filters.forEach(button => { button.classList.toggle('active', button === filter); button.setAttribute('aria-pressed', String(button === filter)); });
  inboxRows.forEach(row => { row.hidden = filter.dataset.inboxFilter !== 'all' && row.dataset.inboxState !== filter.dataset.inboxFilter; });
  const visibleRows = inboxRows.filter(row => !row.hidden);
  if (!visibleRows.some(row => row.getAttribute('aria-pressed') === 'true') && visibleRows[0]) selectInboxRow(visibleRows[0]);
}));
