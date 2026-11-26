interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** Windows emits SIGHUP on console close, with a limited cleanup window. */
export async function withTerminationSignals<T>(run: (signal: AbortSignal) => Promise<T>,
  options: { platform?: string; source?: SignalSource } = {}): Promise<T> {
  const source = options.source ?? process;
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if ((options.platform ?? process.platform) === 'win32') signals.push('SIGBREAK');
  const stop = new AbortController();
  const cancel = () => stop.abort();
  for (const signal of signals) source.once(signal, cancel);
  try { return await run(stop.signal); }
  finally { for (const signal of signals) source.removeListener(signal, cancel); }
}
