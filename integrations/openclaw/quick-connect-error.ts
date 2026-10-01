/** Only trusted, locally authored diagnostics may be printed by the setup CLI. */
export class QuickConnectError extends Error {
  constructor(message: string) { super(message); this.name = 'QuickConnectError'; }
}
