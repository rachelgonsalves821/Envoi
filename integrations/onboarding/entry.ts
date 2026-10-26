import { runLocalLink } from './cli';
const stop = new AbortController();
process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
try {
  const result = await runLocalLink(process.argv.slice(2), stop.signal, { write: result => process.stdout.write(`${JSON.stringify(result)}\n`) });
  if (process.argv[2] === 'task' && result.state === 'needs_help') process.exitCode = 1;
} catch {
  if (!stop.signal.aborted) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: '1', state: 'needs_help', reachability: 'not_verified_closed_app', nextAction: process.argv[2] === 'task'
      ? 'The task could not finish. Keep the connector running in its original terminal, check status, and retry the same task ID if one was shown. Use an interactive terminal and the matching Envoi origin and runtime.'
      : 'Setup could not finish. Preserve the private saved state and retry the same connection. Choose --runtime hermes or --runtime openclaw if both are installed.' })}\n`);
    process.exitCode = 1;
  }
}
