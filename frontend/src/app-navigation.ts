import type { NavSection } from './types';

export type AppLocation = { inbox: string; section: NavSection; folder: string | null; case: string | null };
const sections: NavSection[] = ['inbox', 'needsMe', 'active', 'waiting', 'scheduled', 'documents', 'completed', 'policies', 'integrations', 'activity'];

export function appLocation(search: string, fallback: AppLocation): AppLocation {
  const params = new URLSearchParams(search);
  if (!['inbox', 'section', 'folder', 'case'].some(key => params.has(key))) return fallback;
  const section = params.get('section') as NavSection;
  return { inbox: params.get('inbox') || fallback.inbox, section: sections.includes(section) ? section : 'inbox', folder: params.get('folder') || null, case: params.get('case') || null };
}

export function appPath(location: AppLocation, preview = false): string {
  const params = new URLSearchParams({ inbox: location.inbox, section: location.section });
  if (preview) params.set('preview', '1');
  if (location.folder) params.set('folder', location.folder);
  if (location.case) params.set('case', location.case);
  return `/app?${params}`;
}

// History is an intent, never authorization. Commit the route and visible view
// only after the selected inbox has passed the caller's existing session checks.
export function createAppNavigation(initial: AppLocation, handlers: {
  cancel: () => void;
  select: (location: AppLocation) => Promise<void>;
  commit: (location: AppLocation) => void;
  write: (location: AppLocation, replace: boolean) => void;
  error: (error: unknown) => void;
}) {
  let current = initial;
  let revision = 0;
  return {
    current: () => current,
    cancel() { revision++; handlers.cancel(); },
    async go(target: AppLocation, mode: 'push' | 'replace' | 'restore' = 'push'): Promise<boolean> {
      const ticket = ++revision;
      handlers.cancel();
      try {
        await handlers.select(target);
        if (ticket !== revision) return false;
        current = target;
        handlers.commit(target);
        if (mode !== 'restore') handlers.write(target, mode === 'replace');
        return true;
      } catch (error) {
        if (ticket !== revision) return false;
        handlers.error(error);
        if (mode === 'restore') handlers.write(current, true);
        return false;
      }
    }
  };
}
