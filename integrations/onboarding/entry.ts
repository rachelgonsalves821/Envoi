import { runLocalLink } from './cli';
const stop = new AbortController();
process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
try {
  await runLocalLink(process.argv.slice(2), stop.signal, { write: result => process.stdout.write(`${JSON.stringify(result)}\n`) });
} catch {
  if (!stop.signal.aborted) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: '1', state: 'needs_help', reachability: 'not_verified_closed_app', nextAction: 'Setup could not finish. Preserve the private saved state and retry the same connection. Choose --runtime hermes or --runtime openclaw if both are installed.' })}\n`);
    process.exitCode = 1;
  }
}
