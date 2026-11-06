// A new selection supersedes an older read. The caller keeps its current
// workspace mounted and commits only the latest authorized snapshot.
export function createWorkspaceSwitch<T>() {
  let active: AbortController | null = null;
  return {
    cancel() {
      active?.abort();
      active = null;
    },
    async load(id: string, read: (id: string, signal: AbortSignal) => Promise<T>, verify: (value: T, id: string) => void): Promise<T | null> {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      try {
        const value = await read(id, controller.signal);
        if (controller.signal.aborted || active !== controller) return null;
        verify(value, id);
        return controller.signal.aborted || active !== controller ? null : value;
      } catch (error) {
        if (controller.signal.aborted || active !== controller) return null;
        throw error;
      } finally {
        if (active === controller) active = null;
      }
    }
  };
}
